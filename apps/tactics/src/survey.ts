import { Boards, CELL_TREES, CELL_WATER, readCells, type Board, type OpenedWorld } from "@pixelworlds/engine";
import { arenaFromBoard, hiddenFrom, type Arena } from "@pixelworlds/tactics";

/**
 * The map survey (docs/tactics/map-survey.md, D-174): every 8 × 8 board
 * position in a city, at both cell sizes, scored for its interactables (water,
 * fire, topples, leaps, height bands, chokepoints), how it reads (hidden share
 * from its clearest side, terracing, how much of the city in front is cut
 * away) and its character (a landmark in view, the city's own building types,
 * richness, age and contrast); the city split into character zones (a plain
 * grid where the data can't tell places apart); each zone's best elected into
 * a pool of sites. The coarse pass reads a raster of the city; each zone's best
 * few are scored again on the arena the game itself builds. Runs in Node
 * (`tools/survey-sites.mjs`) or a page.
 */

export const SIZE = 8;

/** An object of the world as its file has it (its place in the file is its index). */
export interface ObjectRecord {
  g: string;
  x: number;
  y: number;
  hm?: number;
  yr?: number;
  rs?: string;
  fc?: string;
  id?: string;
}

export interface SurveyOptions {
  /** Every object of the world, in its file's order. */
  objects: readonly ObjectRecord[];
  /** Each object group's inverse document frequency across the cities: ln(cities ÷ cities having it). */
  idf: ReadonlyMap<string, number>;
  /** How many cities the frequencies were taken over (the largest an idf can be is its log). */
  cities: number;
  /** Named places (neighbourhood centres, cells). */
  places?: readonly { name: string; x: number; y: number }[];
  /** Candidate stride (world cells, default 4) and board cell sizes (default 1 and 2). */
  step?: number;
  cellSizes?: readonly number[];
  /** Each zone's best this many are scored again on the real arena (default 4). */
  fine?: number;
  /** The least score a site is elected with (default 0.4). */
  floor?: number;
  onProgress?: (msg: string) => void;
}

export interface Terms {
  hidden: number;
  terraced: number;
  clearance: number;
  water: number;
  fire: number;
  topples: number;
  leaps: number;
  bands: number;
  chokepoints: number;
  landmark: number;
  signature: number;
  richness: number;
  age: number;
}

export interface Site {
  x0: number;
  y0: number;
  cell: number;
  /** The diagonal the clearest side's camera looks from (a world cell across each way, toward it). */
  toward: [number, number];
  zone: number;
  name: string;
  /** The named place it's in or near, if any. */
  area?: string;
  lon?: number;
  lat?: number;
  score: number;
  parts: { readability: number; interactables: number; character: number };
  terms: Terms;
  facts: { buildings: number; hiddenCells: number; water: number; burnable: number; cut: number; landmark?: string; typology: string };
}

export interface SurveyResult {
  world: string;
  zoning: "character" | "grid";
  zones: number;
  candidates: number;
  passed: number;
  sites: Site[];
  /** The named places (the old hand-picked sites): the best position passing the gates round each, and where it ranks of all that pass (0 the best, 1 the worst). */
  references: { name: string; score: number | null; rank: number | null }[];
}

/** The weights of each part and term (doc: Scores). */
export const WEIGHTS = {
  parts: { readability: 0.35, interactables: 0.35, character: 0.3 },
  readability: { hidden: 0.45, terraced: 0.3, clearance: 0.25 },
  interactables: { water: 0.15, fire: 0.15, topples: 0.2, leaps: 0.15, bands: 0.2, chokepoints: 0.15 },
  character: { landmark: 0.3, signature: 0.3, richness: 0.25, age: 0.15 },
};

const DIAGONALS: readonly (readonly [number, number])[] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const BURNABLE = new Set(["forest", "woodland", "scrub", "grass", "lawn", "yard", "farmland"]);
const PARK = new Set(["forest", "woodland", "scrub", "grass", "lawn"]);
const A_WATER = 1;
const A_BURNS = 2;
const TILE = 16;
/** How alike a tile must be to its zone to join it (cosine of their vectors). */
const SIMILAR = 0.75;
const BUCKET = 8;
const LEAP_M = 6;
/** World cells a board keeps from the world's edge: the view looks on past it, and the world stops there. */
const MARGIN = 16;
const clamp = (v: number) => Math.max(0, Math.min(1, v));

/** What the survey needs of a board's arena: the coarse one it makes from the raster, or the game's own. */
interface Ground {
  w: number;
  h: number;
  flags: Uint8Array;
  height: Float32Array;
  roof: Float32Array;
  struct: Int16Array;
  structures: { cells: number[]; topple: number }[];
}

export async function surveyCity(w: OpenedWorld, opts: SurveyOptions): Promise<SurveyResult> {
  const say = opts.onProgress ?? (() => {});
  const m = w.world.manifest;
  const W = m.cellsX;
  const H = m.cellsY;
  const mps = m.scale.metersPerStep;
  const mpc = m.scale.metersPerCell;
  const surfaces = m.surfaces as Record<string, string>;
  await w.query.ensure(0, 0, W, H);

  // ---- the raster: what walls each world cell and how high, water, what burns, parks
  const cells = readCells(w.query, { x0: 0, y0: 0, w: W, h: H });
  const wall = new Int32Array(W * H).fill(-1);
  const top = Float32Array.from(cells.height);
  for (const [i, list] of cells.objects)
    for (const o of list)
      if (o.wall && (wall[i]! < 0 || o.top > top[i]!)) {
        wall[i] = o.index;
        top[i] = o.top;
      }
  const water = new Uint8Array(W * H);
  const burn = new Uint8Array(W * H);
  const park = new Uint8Array(W * H);
  const wallCells = new Map<number, number>();
  let maxTop = 0;
  for (let i = 0; i < W * H; i++) {
    const s = surfaces[String(cells.surface[i])] ?? "";
    water[i] = cells.flags[i]! & CELL_WATER ? 1 : 0;
    burn[i] = BURNABLE.has(s) || cells.flags[i]! & CELL_TREES ? 1 : 0;
    park[i] = PARK.has(s) ? 1 : 0;
    if (wall[i]! >= 0) wallCells.set(wall[i]!, (wallCells.get(wall[i]!) ?? 0) + 1);
    maxTop = Math.max(maxTop, top[i]!);
  }
  say(`raster ${W}×${H}: ${wallCells.size} buildings`);

  // ---- objects by where they stand
  const BW = Math.ceil(W / BUCKET);
  const buckets: number[][] = Array.from({ length: BW * Math.ceil(H / BUCKET) }, () => []);
  opts.objects.forEach((o, i) => {
    const bx = Math.floor(o.x / BUCKET);
    const by = Math.floor(o.y / BUCKET);
    if (bx >= 0 && by >= 0 && bx < BW && o.y < H) buckets[by * BW + bx]!.push(i);
  });
  const objectsIn = (x0: number, y0: number, x1: number, y1: number): number[] => {
    const out: number[] = [];
    for (let by = Math.max(0, Math.floor(y0 / BUCKET)); by <= Math.min(Math.ceil(H / BUCKET) - 1, Math.floor((y1 - 1) / BUCKET)); by++)
      for (let bx = Math.max(0, Math.floor(x0 / BUCKET)); bx <= Math.min(BW - 1, Math.floor((x1 - 1) / BUCKET)); bx++)
        for (const i of buckets[by * BW + bx]!) {
          const o = opts.objects[i]!;
          if (o.x >= x0 && o.x < x1 && o.y >= y0 && o.y < y1) out.push(i);
        }
    return out;
  };
  const groupsInCity = new Set(opts.objects.map((o) => o.g));
  const landmarks = w.query.landmarks();

  // ---- character zones
  const zoning = characterZones(W, H, opts.objects, water, park);
  say(`${zoning.mode} zones: ${zoning.count} (${zoning.note})`);

  // ---- the coarse pass: every position
  const step = opts.step ?? 4;
  const sizes = opts.cellSizes ?? [1, 2];
  type Candidate = Omit<Site, "name" | "area" | "lon" | "lat">;
  const byZone = new Map<number, Candidate[]>();
  let candidates = 0;
  let passed = 0;
  for (const cell of sizes) {
    const span = SIZE * cell;
    for (let y0 = MARGIN; y0 + span + MARGIN <= H; y0 += step)
      for (let x0 = MARGIN; x0 + span + MARGIN <= W; x0 += step) {
        candidates++;
        const g = coarseGround(x0, y0, cell);
        const c = score(x0, y0, cell, g, null);
        if (!c) continue;
        passed++;
        const zone = zoning.zoneAt(x0 + span / 2, y0 + span / 2);
        let list = byZone.get(zone);
        if (!list) byZone.set(zone, (list = []));
        list.push({ ...c, zone });
      }
  }
  say(`${candidates} positions, ${passed} pass the gates`);

  // ---- the fine pass and the election: zones with the best first claim their ground
  const boards = new Boards(w);
  const fine = opts.fine ?? 4;
  const floor = opts.floor ?? 0.4;
  const elected: Site[] = [];
  const zones = [...byZone].map(([zone, list]) => ({ zone, list: list.sort((p, q) => q.score - p.score) })).sort((p, q) => q.list[0]!.score - p.list[0]!.score);
  for (const { zone, list } of zones) {
    const rescored: Candidate[] = [];
    for (const c of list.slice(0, fine)) {
      const board = await boards.add({ x0: c.x0, y0: c.y0, w: SIZE, h: SIZE, cell: c.cell });
      const a = arenaFromBoard(board, w.query, surfaces, { metersPerCell: mpc });
      boards.remove(board);
      const again = score(c.x0, c.y0, c.cell, a, board);
      if (again) rescored.push({ ...again, zone });
    }
    rescored.sort((p, q) => q.score - p.score);
    let quota = 1 + Math.floor(zoning.size(zone) / 8);
    for (const c of rescored) {
      if (quota <= 0 || c.score < floor) break;
      const span = SIZE * c.cell;
      const near = elected.some((e) => Math.hypot(e.x0 + (SIZE * e.cell) / 2 - c.x0 - span / 2, e.y0 + (SIZE * e.cell) / 2 - c.y0 - span / 2) < 1.5 * Math.max(span, SIZE * e.cell));
      if (near) continue;
      elected.push(named(c));
      quota--;
    }
  }
  elected.sort((p, q) => q.score - p.score);
  say(`${elected.length} sites elected`);
  // the named places as references: the best round each, ranked among every position that passed
  const all = [...byZone.values()].flat().map((c) => c.score).sort((p, q) => q - p);
  const references = (opts.places ?? []).map((p) => {
    let best: number | null = null;
    for (const list of byZone.values())
      for (const c of list) if (Math.hypot(c.x0 + (SIZE * c.cell) / 2 - p.x, c.y0 + (SIZE * c.cell) / 2 - p.y) <= 12 && (best === null || c.score > best)) best = c.score;
    const rank = best === null ? null : all.findIndex((s) => s <= best!) / Math.max(1, all.length - 1);
    return { name: p.name, score: best, rank };
  });
  return { world: m.id, zoning: zoning.mode, zones: zoning.count, candidates, passed, sites: elected, references };

  // ------------------------------------------------------------------ the parts

  /** A board's arena from the raster: each board cell's majority building, its roof, water and what burns. */
  function coarseGround(x0: number, y0: number, cell: number): Ground {
    const n = SIZE * SIZE;
    const g: Ground = { w: SIZE, h: SIZE, flags: new Uint8Array(n), height: new Float32Array(n), roof: new Float32Array(n), struct: new Int16Array(n).fill(-1), structures: [] };
    const ids = new Map<number, number>();
    const half = (cell * cell) / 2;
    const count = new Map<number, number>();
    for (let k = 0; k < n; k++) {
      const bx = x0 + (k % SIZE) * cell;
      const by = y0 + Math.floor(k / SIZE) * cell;
      let ground = 0;
      let wet = 0;
      let burns = 0;
      let roof = 0;
      count.clear();
      for (let dy = 0; dy < cell; dy++)
        for (let dx = 0; dx < cell; dx++) {
          const i = (by + dy) * W + bx + dx;
          ground += cells.height[i]!;
          wet += water[i]!;
          burns += burn[i]!;
          if (wall[i]! >= 0) count.set(wall[i]!, (count.get(wall[i]!) ?? 0) + 1);
          roof = Math.max(roof, top[i]!);
        }
      g.height[k] = ground / (cell * cell);
      let best = -1;
      let most = 0;
      for (const [o, c] of count) if (c > most) [best, most] = [o, c];
      if (best >= 0 && most >= half) {
        let id = ids.get(best);
        if (id === undefined) {
          ids.set(best, (id = g.structures.length));
          g.structures.push({ cells: [], topple: 0 });
        }
        g.struct[k] = id;
        g.structures[id]!.cells.push(k);
        g.roof[k] = roof;
      } else {
        g.roof[k] = g.height[k]!;
        if (wet >= half) g.flags[k]! |= A_WATER;
      }
      if (burns >= half) g.flags[k]! |= A_BURNS;
    }
    // how far each topples: its height in board cells, at most 4
    for (const s of g.structures) {
      const k = s.cells[0]!;
      s.topple = Math.min(4, Math.floor(((g.roof[k]! - g.height[k]!) * mps) / (cell * mpc)));
    }
    return g;
  }

  /** A position's gates and scores on an arena (the coarse one, or the game's with its board); null where it fails a gate. */
  function score(x0: number, y0: number, cell: number, g: Ground | Arena, board: Board | null): Omit<Candidate, "zone"> | null {
    const n = SIZE * SIZE;
    const isWater = (k: number) => g.struct[k]! < 0 && !!(g.flags[k]! & A_WATER);
    const open = (k: number) => g.struct[k]! < 0 && !isWater(k);
    const buildings = g.structures.length;
    if (buildings < 5 || buildings > 14) return null;
    let openN = 0;
    let wet = 0;
    let burnable = 0;
    for (let k = 0; k < n; k++) {
      if (open(k)) openN++;
      if (isWater(k)) wet++;
      if (g.struct[k]! < 0 && g.flags[k]! & A_BURNS) burnable++;
    }
    if (openN < 0.3 * n || openN > 0.7 * n || wet > 0.25 * n) return null;
    // the open ground one region
    if (largestRegion(open) < 0.85 * openN) return null;
    // hidden from each side: the clearest
    const b = board ?? ({ origin: [x0, y0], cell, w: SIZE, h: SIZE } as unknown as Board);
    const a = g as unknown as Arena;
    let toward = DIAGONALS[0]!;
    let hiddenCells = Infinity;
    for (const d of DIAGONALS) {
      const hid = hiddenFrom(b, a, d).reduce((s, v) => s + v, 0);
      if (hid < hiddenCells) [toward, hiddenCells] = [d, hid];
    }
    if (hiddenCells > 0.3 * n) return null;
    const [tx, ty] = toward;

    // readability
    const hidden = clamp((0.3 - hiddenCells / n) / 0.15);
    const stand = Array.from({ length: n }, (_, k) => g.roof[k]!);
    const back = Array.from({ length: n }, (_, k) => -((k % SIZE) * tx + Math.floor(k / SIZE) * ty));
    const terraced = clamp((spearman(stand, back) + 1) / 2);
    const cut = cutAway(x0, y0, cell, stand, toward, !board);
    const clearance = clamp(1 - cut / (n * cell * cell));

    // interactables
    const waterT = wet === 0 ? 0 : wet <= 12 ? 1 : clamp(1 - (wet - 12) / 10);
    const fire = burnable >= 3 && burnable <= 16 ? 1 : burnable < 3 ? burnable / 3 : clamp(1 - (burnable - 16) / 16);
    let topples = 0;
    let leaps = 0;
    const bands = new Set<number>();
    for (const s of g.structures) {
      const k0 = s.cells[0]!;
      const metres = (g.roof[k0]! - g.height[k0]!) * mps;
      bands.add(metres <= 6 ? 0 : metres <= 15 ? 1 : metres <= 40 ? 2 : 3);
      if (s.topple < 2) continue;
      // something of another building in its fall, any way it may go
      const id = g.struct[k0]!;
      const onto = s.cells.some((k) =>
        [[0, -1], [1, 0], [0, 1], [-1, 0]].some(([dx, dy]) => {
          for (let r = 1; r <= s.topple; r++) {
            const i = (k % SIZE) + dx! * r;
            const j = Math.floor(k / SIZE) + dy! * r;
            if (i < 0 || j < 0 || i >= SIZE || j >= SIZE) return false;
            const o = g.struct[j * SIZE + i]!;
            if (o >= 0 && o !== id) return true;
          }
          return false;
        }),
      );
      if (onto) topples++;
    }
    let chokepoints = 0;
    for (let k = 0; k < n; k++) {
      const i = k % SIZE;
      const j = Math.floor(k / SIZE);
      const at = (di: number, dj: number) => i + di >= 0 && j + dj >= 0 && i + di < SIZE && j + dj < SIZE && open((j + dj) * SIZE + i + di);
      if (g.struct[k]! >= 0) {
        // a roof a street from another as high: a leap (east and south, so each pair once)
        for (const [di, dj] of [[1, 0], [0, 1]] as const) {
          if (i + 2 * di >= SIZE || j + 2 * dj >= SIZE) continue;
          const mid = (j + dj) * SIZE + i + di;
          const far = (j + 2 * dj) * SIZE + i + 2 * di;
          if (g.struct[mid]! >= 0 || g.struct[far]! < 0 || g.struct[far] === g.struct[k]) continue;
          if (g.roof[mid]! < Math.min(g.roof[k]!, g.roof[far]!) && Math.abs(g.roof[k]! - g.roof[far]!) * mps <= LEAP_M) leaps++;
        }
        continue;
      }
      if (!open(k)) continue;
      const ns = [at(0, -1), at(1, 0), at(0, 1), at(-1, 0)];
      if (ns.filter(Boolean).length === 2 && ((ns[0] && ns[2]) || (ns[1] && ns[3]))) chokepoints++;
    }

    // character
    const span = SIZE * cell;
    const cx = x0 + span / 2;
    const cy = y0 + span / 2;
    let landmark = 0;
    let landmarkId: string | undefined;
    for (const l of landmarks) {
      const vx = l.x - cx;
      const vy = l.y - cy;
      const d = Math.hypot(vx, vy);
      const inside = l.x >= x0 && l.x < x0 + span && l.y >= y0 && l.y < y0 + span;
      const behind = d > 0 && (-(vx * tx + vy * ty) / (d * Math.SQRT2)) >= Math.cos((25 * Math.PI) / 180);
      const s = inside ? 0.6 : behind && d <= 60 ? 1 - (0.4 * d) / 60 : d < span * 0.75 + 8 ? 0.8 : d < 100 ? 0.4 * (1 - d / 100) : 0;
      if (s > landmark) [landmark, landmarkId] = [s, l.id];
    }
    const here = objectsIn(x0 - 2, y0 - 2, x0 + span + 2, y0 + span + 2).map((i) => opts.objects[i]!);
    const maxIdf = Math.log(opts.cities);
    let sw = 0;
    let ss = 0;
    const groups = new Map<string, number>();
    const roofs = new Set<string>();
    const colours = new Set<string>();
    const heights: number[] = [];
    let dated = 0;
    let old = 0;
    for (const o of here) {
      const kind = o.g.split(".")[0];
      const weight = kind === "building" ? 1 : kind === "prop" ? 0.5 : kind === "landmark" ? 1 : 0.25;
      sw += weight;
      ss += weight * (opts.idf.get(o.g) ?? 0);
      groups.set(o.g, (groups.get(o.g) ?? 0) + 1);
      if (kind !== "building") continue;
      if (o.rs) roofs.add(o.rs);
      if (o.fc) colours.add(o.fc);
      if (o.hm) heights.push(o.hm);
      if (o.yr) {
        dated++;
        if (o.yr < 1930) old++;
      }
    }
    const signature = sw ? clamp(ss / sw / maxIdf) : 0;
    let entropy = 0;
    for (const c of groups.values()) {
      const p = c / here.length;
      entropy -= p * Math.log(p);
    }
    const richness = clamp(0.6 * (groupsInCity.size > 1 ? entropy / Math.log(Math.min(groupsInCity.size, 24)) : 0) + 0.2 * Math.min(1, (roofs.size - 1) / 3) + 0.2 * Math.min(1, colours.size / 6));
    heights.sort((p, q) => p - q);
    const contrast = heights.length ? clamp((heights[heights.length - 1]! - heights[Math.floor(heights.length / 2)]!) / 60) : 0;
    const age = clamp(0.5 * (dated ? old / dated : 0) + 0.5 * contrast);
    let typology = "";
    let most = 0;
    for (const [grp, c] of groups) if (grp.startsWith("building.") && c > most) [typology, most] = [grp, c];

    const terms: Terms = { hidden, terraced, clearance, water: waterT, fire, topples: Math.min(1, topples / 2), leaps: Math.min(1, leaps / 3), bands: (bands.size - 1) / 3, chokepoints: Math.min(1, chokepoints / 3), landmark, signature, richness, age };
    const part = <K extends keyof typeof WEIGHTS>(k: K) => Object.entries(WEIGHTS[k]).reduce((s, [t, wt]) => s + wt * terms[t as keyof Terms], 0);
    const parts = { readability: part("readability"), interactables: part("interactables"), character: part("character") };
    const total = WEIGHTS.parts.readability * parts.readability + WEIGHTS.parts.interactables * parts.interactables + WEIGHTS.parts.character * parts.character;
    return {
      x0,
      y0,
      cell,
      toward: [tx, ty],
      score: total,
      parts,
      terms,
      facts: { buildings, hiddenCells, water: wet, burnable, cut, ...(landmarkId ? { landmark: landmarkId } : {}), typology },
    };
  }

  /**
   * The world cells of buildings outside the board cut away to see it from a
   * side (D-168): those standing above the view rays from its cells. Rays from
   * every cell (from the front edges alone in the coarse pass).
   */
  function cutAway(x0: number, y0: number, cell: number, stand: readonly number[], [tx, ty]: readonly [number, number], quick: boolean): number {
    const span = SIZE * cell;
    const objects = new Set<number>();
    for (let k = 0; k < SIZE * SIZE; k++) {
      const i = k % SIZE;
      const j = Math.floor(k / SIZE);
      if (quick && i !== (tx > 0 ? SIZE - 1 : 0) && j !== (ty > 0 ? SIZE - 1 : 0)) continue;
      const px = x0 + (i + 0.5) * cell;
      const py = y0 + (j + 0.5) * cell;
      for (let t = 0.5; ; t += quick ? 0.75 : 0.4) {
        const z = stand[k]! + 2 * t;
        if (z > maxTop) break;
        const x = px + tx * t;
        const y = py + ty * t;
        if (x < 0 || y < 0 || x >= W || y >= H) break;
        if (x >= x0 && x < x0 + span && y >= y0 && y < y0 + span) continue;
        const wi = Math.floor(y) * W + Math.floor(x);
        if (wall[wi]! >= 0 && top[wi]! > z) objects.add(wall[wi]!);
      }
    }
    let area = 0;
    for (const o of objects) area += wallCells.get(o) ?? 1;
    return area;
  }

  function named(c: Candidate): Site {
    const span = SIZE * c.cell;
    const cx = c.x0 + span / 2;
    const cy = c.y0 + span / 2;
    const ll = w.query.cellToLonLat(cx, cy);
    let area: string | undefined;
    let nearest = 80;
    for (const p of opts.places ?? []) {
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d < nearest) [area, nearest] = [p.name, d];
    }
    const l = c.facts.landmark ? landmarks.find((x) => x.id === c.facts.landmark) : undefined;
    const name =
      l && Math.hypot(l.x - cx, l.y - cy) <= 30
        ? `by ${/^the /i.test(titleOf(l.id)) ? "" : "the "}${titleOf(l.id)}`
        : area && nearest <= 40
          ? area
          : `${typologyOf(c.facts.typology)}${area ? ` near ${area}` : ""}`;
    return { ...c, name, ...(area ? { area } : {}), ...(ll ? { lon: +ll[0].toFixed(5), lat: +ll[1].toFixed(5) } : {}) };
  }
}

/** The largest 4-connected region of an 8 × 8 board's cells that pass. */
function largestRegion(pass: (k: number) => boolean): number {
  const seen = new Uint8Array(SIZE * SIZE);
  let best = 0;
  for (let s = 0; s < SIZE * SIZE; s++) {
    if (seen[s] || !pass(s)) continue;
    let size = 0;
    const queue = [s];
    seen[s] = 1;
    while (queue.length) {
      const k = queue.pop()!;
      size++;
      const i = k % SIZE;
      for (const nk of [k - SIZE, k + SIZE, i > 0 ? k - 1 : -1, i < SIZE - 1 ? k + 1 : -1])
        if (nk >= 0 && nk < SIZE * SIZE && !seen[nk] && pass(nk)) {
          seen[nk] = 1;
          queue.push(nk);
        }
    }
    best = Math.max(best, size);
  }
  return best;
}

/** Spearman's rank correlation (ties share their mean rank); 0 where either side is flat. */
export function spearman(a: readonly number[], b: readonly number[]): number {
  const rank = (v: readonly number[]) => {
    const order = v.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(v.length);
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
      for (let k = i; k <= j; k++) r[order[k]![1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i]! - ma) * (rb[i]! - mb);
    da += (ra[i]! - ma) ** 2;
    db += (rb[i]! - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/**
 * The city split into character zones (doc: Character zones): 160 m tiles,
 * each a vector of its building types' shares, its water, park and emptiness;
 * each seen with its neighbours; grown from the most built tile into zones of
 * tiles alike (cosine 0.75, up to 16 tiles), zones of a tile or two then
 * joining the neighbouring zone most like them. A plain grid of 4 × 4 tiles where the data can't tell places
 * apart: fewer than three building types with a real share of the city, or
 * zoning that comes out as one zone or mostly single tiles.
 */
export function characterZones(
  W: number,
  H: number,
  objects: readonly ObjectRecord[],
  water: Uint8Array,
  park: Uint8Array,
): { mode: "character" | "grid"; count: number; note: string; zoneAt(x: number, y: number): number; size(zone: number): number } {
  const TW = Math.ceil(W / TILE);
  const TH = Math.ceil(H / TILE);
  const groups = new Map<string, number>();
  const counts = Array.from({ length: TW * TH }, () => new Map<string, number>());
  let buildings = 0;
  for (const o of objects) {
    if (!o.g.startsWith("building")) continue;
    const t = Math.floor(o.y / TILE) * TW + Math.floor(o.x / TILE);
    if (t < 0 || t >= TW * TH) continue;
    counts[t]!.set(o.g, (counts[t]!.get(o.g) ?? 0) + 1);
    groups.set(o.g, (groups.get(o.g) ?? 0) + 1);
    buildings++;
  }
  const dims = [...groups.keys()];
  const vec = counts.map((cnt, t) => {
    const n = [...cnt.values()].reduce((s, c) => s + c, 0);
    const tx = (t % TW) * TILE;
    const ty = Math.floor(t / TW) * TILE;
    let wet = 0;
    let green = 0;
    let all = 0;
    for (let y = ty; y < Math.min(H, ty + TILE); y++)
      for (let x = tx; x < Math.min(W, tx + TILE); x++) {
        all++;
        wet += water[y * W + x]!;
        green += park[y * W + x]!;
      }
    const v = [...dims.map((d) => (n ? (cnt.get(d) ?? 0) / n : 0)), wet / all, green / all, n < 5 && wet / all < 0.3 && green / all < 0.3 ? 1 : 0];
    const len = Math.hypot(...v) || 1;
    return { v: v.map((x) => x / len), n };
  });
  // each tile seen with its neighbours (3 × 3), so a tile's few buildings don't decide its character alone
  const raw = vec.map((t) => t.v);
  for (let t = 0; t < TW * TH; t++) {
    const tx = t % TW;
    const ty = Math.floor(t / TW);
    const v = raw[t]!.map((x) => 2 * x);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || tx + dx < 0 || ty + dy < 0 || tx + dx >= TW || ty + dy >= TH) continue;
        raw[(ty + dy) * TW + tx + dx]!.forEach((x, i) => (v[i]! += x));
      }
    vec[t]!.v = v;
  }
  const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0) / ((Math.hypot(...a) || 1) * (Math.hypot(...b) || 1));
  const zone = new Int32Array(TW * TH).fill(-1);
  const sizes: number[] = [];
  const order = [...vec.keys()].sort((p, q) => vec[q]!.n - vec[p]!.n);
  for (const seed of order) {
    if (zone[seed]! >= 0) continue;
    const id = sizes.length;
    const sum = [...vec[seed]!.v];
    zone[seed] = id;
    let size = 1;
    const queue = [seed];
    while (queue.length && size < 16) {
      const t = queue.shift()!;
      const tx = t % TW;
      for (const nt of [t - TW, t + TW, tx > 0 ? t - 1 : -1, tx < TW - 1 ? t + 1 : -1]) {
        if (nt < 0 || nt >= TW * TH || zone[nt]! >= 0 || size >= 16) continue;
        if (cos(vec[nt]!.v, sum) < SIMILAR) continue;
        zone[nt] = id;
        size++;
        vec[nt]!.v.forEach((x, i) => (sum[i]! += x));
        queue.push(nt);
      }
    }
    sizes.push(size);
  }
  // zones of a tile or two join the neighbouring zone most like them, if it has room
  const sums = sizes.map(() => new Array<number>(vec[0]!.v.length).fill(0));
  for (let t = 0; t < TW * TH; t++) vec[t]!.v.forEach((x, i) => (sums[zone[t]!]![i]! += x));
  for (let t = 0; t < TW * TH; t++) {
    const z = zone[t]!;
    if (sizes[z]! > 2) continue;
    const tx = t % TW;
    let best = -1;
    let like = -Infinity;
    for (const nt of [t - TW, t + TW, tx > 0 ? t - 1 : -1, tx < TW - 1 ? t + 1 : -1]) {
      if (nt < 0 || nt >= TW * TH) continue;
      const nz = zone[nt]!;
      if (nz === z || sizes[nz]! + sizes[z]! > 20) continue;
      const c = cos(sums[z]!, sums[nz]!);
      if (c > like) [best, like] = [nz, c];
    }
    if (best < 0) continue;
    for (let u = 0; u < TW * TH; u++)
      if (zone[u] === z) {
        zone[u] = best;
        vec[u]!.v.forEach((x, i) => (sums[best]![i]! += x));
      }
    sizes[best]! += sizes[z]!;
    sizes[z] = 0;
  }
  // numbered again, without the emptied
  const renumber = new Map<number, number>();
  const kept: number[] = [];
  for (let t = 0; t < TW * TH; t++) {
    let r = renumber.get(zone[t]!);
    if (r === undefined) {
      renumber.set(zone[t]!, (r = kept.length));
      kept.push(sizes[zone[t]!]!);
    }
    zone[t] = r;
  }
  sizes.splice(0, sizes.length, ...kept);
  const real = [...groups.values()].filter((c) => c >= 0.05 * buildings).length;
  const singles = sizes.filter((s) => s === 1).length;
  const note = `${real} building types with a real share, ${sizes.length} zones grown, ${singles} of them single tiles, mean ${(sizes.reduce((s, x) => s + x, 0) / sizes.length).toFixed(1)} tiles`;
  if (real >= 3 && sizes.length >= 4 && singles <= 0.6 * sizes.length)
    return {
      mode: "character",
      count: sizes.length,
      note,
      zoneAt: (x, y) => zone[Math.min(TH - 1, Math.floor(y / TILE)) * TW + Math.min(TW - 1, Math.floor(x / TILE))]!,
      size: (z) => sizes[z] ?? 1,
    };
  const GW = Math.ceil(TW / 4);
  return {
    mode: "grid",
    count: GW * Math.ceil(TH / 4),
    note,
    zoneAt: (x, y) => Math.floor(y / (TILE * 4)) * GW + Math.floor(x / (TILE * 4)),
    size: () => 16,
  };
}

/** A landmark's registry id as a name: `flatiron-building` → "Flatiron Building". */
export const titleOf = (id: string) =>
  id
    .replace(/-(north|south|east|west)$/, "")
    .replace(/(^|-)(\w)/g, (_, s: string, c: string) => `${s ? " " : ""}${c.toUpperCase()}`)
    .replace(/\b(Ntt|Icc|Sf)\b/g, (x) => x.toUpperCase());

/** A building group as a kind of place: `building.brownstone` → "brownstone blocks". */
export const typologyOf = (g: string) => {
  const t = g.split(".")[1] ?? "city";
  return t === "tower" ? "towers" : `${t.replace(/_/g, " ")} blocks`;
};
