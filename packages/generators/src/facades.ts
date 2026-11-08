import type { GenContext, Generator } from "./assets";
import { VoxelModel } from "./voxel";

/**
 * Street-facing building typologies (D-055): row houses and blocks whose front
 * faces their street (the `front` hint, from the pipeline), so a city reads by
 * its ordinary fabric. Everything stays inside the footprint and nothing
 * overhangs: bays are drawn by recessing the rest of the front, cornices sit on
 * the wall below them, and windows go only on exposed faces.
 */

/** The 8 grid directions, in 45° steps from +x (y grows south). */
const DIRS: readonly [number, number][] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

/** A footprint seen from its street. */
export interface Facade {
  sx: number;
  sy: number;
  /** Steps back from the front wall (0 on it), -1 outside the footprint. */
  depth: Int16Array;
  /** Position along the front (0 … width-1), -1 outside. */
  along: Int16Array;
  width: number;
  maxDepth: number;
  front: readonly [number, number];
}

/** Which way a footprint faces: the hint, else its narrow side toward +y. */
function frontDir(mask: { sx: number; sy: number }, hint?: number): number {
  if (hint !== undefined && hint >= 0 && hint < 8) return hint;
  return mask.sx <= mask.sy ? 2 : 0;
}

export function facadeOf(mask: { sx: number; sy: number; on: Uint8Array }, front: number): Facade {
  const { sx, sy, on } = mask;
  const [fx, fy] = DIRS[front]!;
  const inMask = (x: number, y: number) => x >= 0 && y >= 0 && x < sx && y < sy && on[y * sx + x] === 1;
  const cells: [number, number][] = [];
  for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) if (on[y * sx + x]) cells.push([x, y]);
  // front-most first: a voxel's depth is its front neighbour's plus one
  cells.sort((a, b) => b[0] * fx + b[1] * fy - (a[0] * fx + a[1] * fy));
  const depth = new Int16Array(sx * sy).fill(-1);
  const along = new Int16Array(sx * sy).fill(-1);
  let maxDepth = 0;
  for (const [x, y] of cells) {
    const d = inMask(x + fx, y + fy) ? depth[(y + fy) * sx + x + fx]! + 1 : 0;
    depth[y * sx + x] = d;
    maxDepth = Math.max(maxDepth, d);
  }
  // along: left to right as seen from the street
  const lx = fy;
  const ly = -fx;
  let lo = Infinity;
  let hi = -Infinity;
  for (const [x, y] of cells) {
    const a = x * lx + y * ly;
    lo = Math.min(lo, a);
    hi = Math.max(hi, a);
  }
  for (const [x, y] of cells) along[y * sx + x] = x * lx + y * ly - lo;
  return { sx, sy, depth, along, width: cells.length ? hi - lo + 1 : 0, maxDepth, front: [fx, fy] };
}

const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

/**
 * Materials of a facade generator: a paint scheme (body, trim, accent), a roof,
 * glass and lit glass.
 *
 * A scheme is the variants that share a name: `wall.blue`, `trim.blue` and
 * `accent.blue` go together. When the trim or accent role names the same
 * variants as the wall (its list is as long; the lists are sorted by name, so
 * they line up), it comes from the body's scheme; otherwise it is picked on
 * its own. A variant listed twice (`wall.white`, `wall.white2`) is twice as
 * likely. The roof is picked from its own variants: light tar and gravel,
 * white coating or warm gravel on a flat roof.
 */
function palette(ctx: GenContext, m: VoxelModel) {
  const { rand, ramp, ramps } = ctx;
  const bodies = ramps("wall");
  const k = Math.floor(rand() * bodies.length);
  const body = m.material(bodies[k]!);
  const scheme = (role: string, fallback: number) => {
    const xs = ramps(role);
    if (!xs.length) return fallback;
    return m.material(xs.length === bodies.length ? xs[k]! : pick(rand, xs));
  };
  const trim = scheme("trim", body);
  const roofs = ramps("roof");
  const roof = m.material(roofs.length ? pick(rand, roofs) : ramp("roof"));
  const glass = m.material(ramp("window"));
  const lits = ramps("lit");
  const lit = lits.length ? m.material(pick(rand, lits)) : glass;
  const accent = scheme("accent", roof);
  const litFraction = ctx.param("litFraction", 0.3);
  return { body, trim, roof, glass, lit, accent, pane: () => (rand() < litFraction ? lit : glass) };
}

/** Fill the footprint to height H with `body`, a roof skin on top. */
function massing(m: VoxelModel, f: Facade, H: number, body: number, roof: number): void {
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      if (f.depth[y * f.sx + x]! < 0) continue;
      for (let z = 0; z < H - 1; z++) m.set(x, y, z, body);
      m.set(x, y, H - 1, roof);
    }
}

/** Visit the voxel columns of the front (depth d), with their position along it. */
function eachFront(f: Facade, d: number, fn: (x: number, y: number, a: number) => void): void {
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) if (f.depth[y * f.sx + x] === d) fn(x, y, f.along[y * f.sx + x]!);
}

/** Paint `mat` on (x, y, z) only if it shows toward the street (its front neighbour is empty). */
function onFace(m: VoxelModel, f: Facade, x: number, y: number, z: number, mat: number): void {
  if (!m.get(x, y, z)) return;
  // a diagonal front shows through its axis neighbours
  const [fx, fy] = f.front;
  const open = (fx !== 0 && !m.get(x + fx, y, z)) || (fy !== 0 && !m.get(x, y + fy, z));
  if (open) m.set(x, y, z, mat);
}

/** Windows on every exposed side wall face except the front (rear and detached sides). */
function sideWindows(m: VoxelModel, f: Facade, H: number, fh: number, pane: () => number, every = 2): void {
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      const d = f.depth[y * f.sx + x]!;
      if (d <= 0) continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        if (dx === -f.front[0] && dy === -f.front[1]) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < f.sx && ny < f.sy && f.depth[ny * f.sx + nx]! >= 0) continue;
        if ((x + y) % every !== 0) continue;
        for (let z = 1; z < H - 1; z++) {
          const zf = z % fh;
          // a window per floor: wall at the floor line and, on taller floors, a lintel
          if (zf === 0 || (fh >= 3 && zf === fh - 1)) continue;
          if (!m.get(nx, ny, z) && m.get(x, y, z)) m.set(x, y, z, pane());
        }
      }
    }
}

/** A parapet's height above the roof line at position a of a front W wide (0 is a plain parapet). */
type Profile = (a: number, W: number) => number;

/** Stucco parapets, by seed: raised in the middle, a small pediment, end piers, stepped, curved. */
const PARAPETS: Record<string, Profile> = {
  flat: () => 0,
  raised: (a, W) => (Math.abs(a - (W - 1) / 2) / (W / 2) <= 0.6 ? 1 : 0),
  pediment: (a, W) => {
    const t = Math.abs(a - (W - 1) / 2) / (W / 2);
    return t < 0.45 ? Math.round((W >= 8 ? 2 : 1) * (1 - t / 0.45)) : 0;
  },
  pylons: (a, W) => (Math.abs(a - (W - 1) / 2) / (W / 2) >= 0.8 ? (W >= 8 ? 2 : 1) : 0),
  stepped: (a, W) => {
    const t = Math.abs(a - (W - 1) / 2) / (W / 2);
    return t <= 0.3 ? 2 : t <= 0.6 ? 1 : 0;
  },
  curved: (a, W) => {
    if (W < 7) return PARAPETS.raised!(a, W);
    const t = Math.abs(a - (W - 1) / 2) / (W / 2) / 0.7;
    return t < 1 ? Math.round(2 * Math.sqrt(1 - t * t)) : 0;
  },
};
const PARAPET_ODDS: [string, number][] = [
  ["flat", 0.22],
  ["raised", 0.2],
  ["pediment", 0.16],
  ["stepped", 0.16],
  ["curved", 0.14],
  ["pylons", 0.12],
];

/**
 * The stucco rows of the Sunset and the Richmond (type 2, 1920s–50s "junior
 * fives") and their mid-century successors (type 3). Across the front: an
 * entry stair in a recess on one side, a white garage door at the street, and
 * over it the living room's big window, most often in a box, canted or curved
 * bay. The bay is drawn by stepping the rest of the upper front back (no
 * overhang); a canted or curved bay has glazed sides, and where it projects
 * two voxels its corners are cut. On top, a parapet whose profile varies by
 * seed (raised, a small pediment, end piers, stepped, curved, plain), with a
 * white coping on most; a short red-tiled pent roof on a minority (mostly the
 * 1920s Mediterranean ones) and now and then a storybook gable. A light well
 * halfway back on one lot line breaks each long roof, so from above a row
 * reads as houses side by side. Mid-century
 * fronts keep a flat fascia, a band of sliding windows or a box bay, and
 * sometimes a brick or stone veneer at the street.
 */
function stuccoRow(ctx: GenContext, f: Facade, type: number, H: number, fh: number, year: number): VoxelModel {
  const { rand } = ctx;
  const W = f.width;
  const [fx, fy] = f.front;
  const mid = type === 3;
  const walk = W >= 9; // room for detail: about a 25-foot lot at the walking scale
  // Mediterranean revival belongs to the 1920s and 30s: a tiled pent roof, or a storybook gable
  const tiled = !mid && W >= 4 && rand() < (year < 1932 ? 0.3 : year < 1942 ? 0.14 : 0.05);
  const storybook = !mid && !tiled && W >= 4 && year < 1942 && rand() < 0.05;
  const gable = storybook ? Math.max(1, Math.min(Math.floor(W / 2), Math.round(W * 0.4))) : 0;
  const m = new VoxelModel(f.sx, f.sy, H + Math.max(gable, 3) + 2);
  const p = palette(ctx, m);
  const eaves = ctx.ramps("eave");
  const tile = eaves.length ? m.material(eaves[0]!) : p.roof;
  massing(m, f, H, p.body, p.roof);

  // the plan across the front: the entry on one side, the garage, the bay over it
  const entryW = W >= 9 ? 3 : W >= 7 ? 2 : W >= 4 ? 1 : 0;
  const entryLeft = rand() < 0.5;
  const zs = entryLeft ? entryW : 0;
  const Z = W - entryW;
  const gW = Math.max(1, Z <= 4 ? Math.min(3, Z) : Z <= 6 ? Z - 2 : Math.round(Z * 0.55));
  const g0 = zs + Math.floor((Z - gW) / 2);
  const bW = walk ? Math.min(Z, gW + 2) : gW;
  const b0 = g0 - Math.floor((bW - gW) / 2);
  const inEntry = (a: number) => (entryLeft ? a < entryW : a >= W - entryW);
  const inGarage = (a: number) => a >= g0 && a < g0 + gW;
  const inBay = (a: number) => a >= b0 && a < b0 + bW;
  const bayEdge = (a: number) => a === b0 || a === b0 + bW - 1;
  const doorW = entryW >= 3 ? 2 : Math.min(1, entryW);
  const isDoor = (a: number) => inEntry(a) && (entryLeft ? a >= entryW - doorW : a < W - entryW + doorW);
  const roll = rand();
  const bay = mid
    ? roll < 0.4
      ? "box"
      : "flat"
    : W < 4 || bW < 2
      ? "flat"
      : roll < 0.15
        ? "flat"
        : roll < 0.45
          ? "box"
          : roll < 0.75
            ? "canted"
            : "curved";
  const glazedSides = bay === "canted" || bay === "curved";
  const deep = walk && f.maxDepth >= 10 ? 2 : 1;
  const bayDepth = bay === "flat" || f.maxDepth < 4 ? 0 : deep;
  const entryDepth = entryW > 0 && f.maxDepth >= 4 ? deep : 0;
  // how far the front stands back at a column and height: the bay keeps the
  // street line, the rest of the upper front steps back, and the entry is a
  // recess from the first step up
  const back = (a: number, z: number): number => {
    if (inEntry(a)) return z >= 1 ? Math.max(entryDepth, z >= fh ? bayDepth : 0) : 0;
    if (inBay(a)) return z >= fh && bayDepth >= 2 && glazedSides && bayEdge(a) ? 1 : 0;
    return z >= fh ? bayDepth : 0;
  };
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      const i = y * f.sx + x;
      const d = f.depth[i]!;
      const a = f.along[i]!;
      if (d < 0) continue;
      // the stair: a step per voxel of depth into the entry recess
      for (let z = 0; z < H; z++) if (d < back(a, z) && !(inEntry(a) && z <= d)) m.set(x, y, z, 0);
      // a parapet on one lot line: rows of light flat roofs read as separate houses
      if (d > 0 && a === 0 && W >= 3 && m.get(x, y, H - 1)) m.set(x, y, H, p.body);
    }
  // a light well on the other lot line, halfway back, from the main floor up:
  // from above, a row reads as houses side by side rather than one long block
  if (f.maxDepth >= 8 && W >= 4) {
    const wd = walk ? 2 : 1;
    const d0 = Math.round(f.maxDepth * 0.45);
    const d1 = d0 + Math.max(2, Math.round(f.maxDepth * 0.15));
    for (let y = 0; y < f.sy; y++)
      for (let x = 0; x < f.sx; x++) {
        const i = y * f.sx + x;
        const d = f.depth[i]!;
        const a = f.along[i]!;
        if (d < d0 || d >= d1) continue;
        if (a >= W - wd) for (let z = fh; z < H; z++) m.set(x, y, z, 0);
        else if (a === W - wd - 1 && d === d0 + 1)
          // a window onto it
          for (let z = fh + 1; z < H - 1; z++) if ((z - fh) % fh !== 0 && (fh < 4 || (z - fh) % fh !== fh - 1)) m.set(x, y, z, p.pane());
      }
  }
  const fronts: [number, number, number][] = [];
  eachFront(f, 0, (x, y, a) => fronts.push([x, y, a]));
  /** Paint the front-most voxel of column a at height z (if it faces the street). */
  const paint = (a: number, z: number, mat: number, k = back(a, z)) => {
    for (const [x, y, aa] of fronts) if (aa === a) onFace(m, f, x - k * fx, y - k * fy, z, mat);
  };
  const setFront = (a: number, z: number, mat: number, k = back(a, z)) => {
    for (const [x, y, aa] of fronts) if (aa === a && m.get(x - k * fx, y - k * fy, z - 1)) m.set(x - k * fx, y - k * fy, z, mat);
  };

  // mid-century: a brick or stone veneer at the street on some
  const veneer = mid && rand() < 0.35;
  const gTop = fh >= 5 ? fh - 2 : fh >= 3 ? fh - 1 : fh; // the garage door's height
  const floorsUp = Math.max(1, Math.floor((H - 1 - fh) / fh) + 1);
  for (let a = 0; a < W; a++) {
    // the ground floor
    for (let z = 0; z < fh && z < H - 1; z++) {
      if (inGarage(a) && z < gTop) paint(a, z, p.trim);
      else if (inEntry(a)) {
        for (let d = 0; d < entryDepth; d++) if (z <= d) paint(a, z, p.trim, d); // the steps
        if (isDoor(a) && z >= entryDepth && z < Math.max(entryDepth + 1, fh >= 5 ? fh - 1 : fh)) paint(a, z, p.accent);
      } else if (veneer) paint(a, z, p.accent);
    }
    // the floors above: the bay's windows, a small window over the entry
    for (let z = fh; z < H - 1; z++) {
      const zf = (z - fh) % fh;
      const lintel = fh >= 4 && zf === fh - 1;
      const sill = fh >= 4 && zf === 0;
      if (inBay(a) || (bay === "flat" && !inEntry(a) && a > 0 && a < W - 1)) {
        if (sill) paint(a, z, bay === "flat" ? p.body : p.trim);
        else if (lintel) continue;
        else if (mid && bay === "flat") paint(a, z, a % 4 === 0 && walk ? p.trim : p.pane());
        else if (bay === "box" && bayEdge(a) && walk) paint(a, z, p.trim); // the bay's corner posts
        else paint(a, z, p.pane());
      } else if (inEntry(a) && !sill && !lintel) {
        // a small window over the entry, in the middle of the recess
        const mid0 = entryLeft ? Math.floor((entryW - 1) / 2) : W - entryW + Math.floor(entryW / 2);
        const zw = fh >= 4 ? zf >= 1 && zf <= fh - 2 : z === fh + 1 || (floorsUp === 1 && H - 2 === fh);
        if (a === mid0 && zw) paint(a, z, p.pane());
      }
    }
    // a canted or curved bay's glazed sides show where the front beside it steps back
    if (glazedSides && bayEdge(a))
      for (let z = fh; z < H - 1; z++) {
        const zf = (z - fh) % fh;
        if (fh >= 4 && (zf === 0 || zf === fh - 1)) continue;
        for (const [x, y, aa] of fronts) {
          if (aa !== a) continue;
          const k = back(a, z);
          const wx = x - k * fx;
          const wy = y - k * fy;
          if (m.get(wx, wy, z)) m.set(wx, wy, z, p.pane());
        }
      }
    // the ledge where the upper front steps back: a white cap
    for (const [x, y, aa] of fronts) {
      if (aa !== a) continue;
      for (let k = back(a, fh - 1); k < back(a, fh); k++)
        if (m.get(x - k * fx, y - k * fy, fh - 1) && !m.get(x - k * fx, y - k * fy, fh)) m.set(x - k * fx, y - k * fy, fh - 1, p.trim);
    }
  }

  // the top: the wall up to the roof line, then the parapet, a tile pent roof or a gable
  const coping = mid || rand() < 0.65 ? p.trim : p.body;
  let r = rand();
  let style = "flat";
  for (const [name, odds] of PARAPET_ODDS) {
    if (r < odds) {
      style = name;
      break;
    }
    r -= odds;
  }
  const profile = PARAPETS[style]!;
  for (let a = 0; a < W; a++) {
    const k = back(a, H - 1);
    setFront(a, H - 1, mid ? p.trim : p.body, k); // a mid-century fascia
    if (mid || gable) continue;
    if (tiled) {
      // a short pent roof of red tile sloping back from the parapet
      setFront(a, H, tile, k);
      setFront(a, H, tile, k + 1);
      if (walk) setFront(a, H + 1, tile, k + 1);
      continue;
    }
    const h = W >= 4 ? profile(a, W) : 0;
    for (let z = H; z <= H + h; z++) setFront(a, z, z === H + h ? coping : p.body, k);
  }
  if (gable > 0) {
    // a storybook gable: a short, steep tiled roof running back from the street, its end on the front
    for (let y = 0; y < f.sy; y++)
      for (let x = 0; x < f.sx; x++) {
        const i = y * f.sx + x;
        const a = f.along[i]!;
        const d = f.depth[i]! - back(a, H - 1);
        if (f.depth[i]! < 0 || d < 0 || d > Math.max(2, Math.floor(W / 2)) || !m.get(x, y, H - 1)) continue;
        const rise = Math.min(gable, Math.min(a, W - 1 - a) + 1);
        for (let z = H; z < H + rise; z++) m.set(x, y, z, d === 0 ? (z === H + rise - 1 ? tile : p.body) : tile);
      }
  }
  // a roof deck on some wide, deep lots (the walking scale): a stair penthouse
  // by the far lot line and a rail around the deck in front of it
  if (W >= 8 && f.maxDepth >= 12 && gable === 0 && rand() < 0.3) roofDeck(m, f, H, fh, p);
  // side walls are mostly blank: party walls, with a window here and there where they show
  sideWindows(m, f, H, fh, p.pane, 4);
  return m;
}

/** A roof deck: a stair penthouse by the far lot line and a rail around the deck in front of it. */
function roofDeck(m: VoxelModel, f: Facade, H: number, fh: number, p: ReturnType<typeof palette>): void {
  const W = f.width;
  const pw = Math.max(2, Math.floor(W / 4));
  const d0 = Math.floor(f.maxDepth * 0.45);
  const ph = Math.max(2, Math.min(3, Math.floor(fh / 2)));
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      const i = y * f.sx + x;
      const a = f.along[i]!;
      const d = f.depth[i]!;
      if (d < 0 || !m.get(x, y, H - 1)) continue; // (not over a light well)
      if (a >= W - 1 - pw && a < W - 1 && d >= d0 && d < d0 + 3) {
        for (let z = H; z < H + ph; z++) m.set(x, y, z, z === H + ph - 1 ? p.roof : p.body);
        if (d === d0 && a === W - 1 - pw) onFace(m, f, x, y, H, p.accent); // its door
      } else if (d >= d0 - 5 && d < d0 && a >= 2 && a < W - 1 && (d === d0 - 5 || a === 2 || a === W - 2)) m.set(x, y, H, p.trim);
    }
}

/** The row-house form of an era (params.type -1): Victorian, Edwardian, stucco or mid-century. */
function eraType(year: number | undefined): number {
  if (year === undefined) return 3;
  return year < 1906 ? 0 : year < 1920 ? 1 : year < 1950 ? 2 : 3;
}

/**
 * Row houses on narrow lots. params.type:
 * - 0 Victorian: a bay window, a false front with a cornice over a coloured
 *   frieze, now and then a Queen Anne gable.
 * - 1 Edwardian: a wider bay, a heavy cornice with dentils.
 * - 2 stucco (the Sunset and the Richmond, see stuccoRow): a white garage
 *   door, an entry stair in a recess beside it, a box, canted or curved bay
 *   over the garage, a parapet profiled by seed, a light well; a tiled pent
 *   roof or a storybook gable on a minority.
 * - 3 mid-century (stuccoRow too): the same plan with a band of sliding
 *   windows or a box bay, a flat fascia, sometimes a veneer at the street.
 * - -1: the form of the era it was built in (hints.year), for detached houses.
 *
 * Painted-lady colouring comes from the scheme (see palette): a body paint,
 * trim at every floor line, on the bay posts, window hoods and the cornice,
 * and an accent on the frieze, the aprons under the bay windows and the door.
 * Victorians and Edwardians often have a garage under the bay and, on corner
 * lots, a corner store under the flats. Flat roofs are light; a parapet on
 * one lot line sets each house off from the next. Dark slate is kept for
 * gables.
 */
export const rowhouse: Generator = (ctx) => {
  const { rand, param, mask, hints } = ctx;
  if (!mask) throw new Error("rowhouse needs a footprint");
  const t = param("type", 0);
  const type = t >= 0 ? t : eraType(hints?.year);
  const year = hints?.year ?? (type === 3 ? 1965 : type === 2 ? 1935 : 1900);
  const f = facadeOf(mask, frontDir(mask, hints?.front));
  const W = f.width;
  // neighbours differ by a voxel or so, so a row reads as separate lots; a
  // stucco row was built as one, so its roof line stays even (parapets vary)
  const jitter = type >= 2 ? 1.2 : 2.2;
  const H = Math.max(3, Math.min(60, Math.round((ctx.heightVox ?? 8) + (rand() - 0.5) * jitter)));
  let floors = Math.max(1, Math.min(6, hints?.floors ?? Math.round(H / 4)));
  // the roll counts storeys over a garage or a raised basement
  if (floors < 2 && H >= (type >= 2 ? 5 : 6)) floors = 2;
  const fh = Math.max(2, Math.floor(H / floors));
  if (type >= 2) return stuccoRow(ctx, f, type, H, fh, year);
  // most Victorian rows are flat-roofed behind false fronts; Queen Annes add a gable
  const queenAnne = type === 0 && W >= 4 && rand() < (year >= 1888 ? 0.3 : 0.1);
  const gable = queenAnne ? Math.max(1, Math.min(Math.floor(W / 2), Math.round(W * 0.4))) : 0;
  const m = new VoxelModel(f.sx, f.sy, H + gable + 4);
  const p = palette(ctx, m);
  rand(); // (a draw the stucco coping once took: Victorians and Edwardians keep their seeds)
  massing(m, f, H, p.body, p.roof);
  const gables = ctx.ramps("gable");
  const gableRoof = gables.length ? m.material(pick(rand, gables)) : p.roof;
  // a parapet on one lot line: rows of light flat roofs read as separate houses
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      const i = y * f.sx + x;
      if (f.depth[i]! > 0 && f.along[i] === 0 && W >= 3) m.set(x, y, H, p.body);
    }

  // the bay: on one side of the front, the rest of the front stepped back a voxel
  const bayShare = type === 1 ? 0.55 : 0.45;
  const bayW = W >= 3 ? Math.max(1, Math.round(W * bayShare)) : 0;
  const bayLeft = rand() < 0.5;
  const inBay = (a: number) => (bayLeft ? a < bayW : a >= W - bayW);
  const bayFrom = floors < 2 ? fh : type === 0 && floors >= 3 ? fh : 0;
  const recess = f.maxDepth >= 4 && bayW > 0;
  if (recess)
    eachFront(f, 0, (x, y, a) => {
      if (!inBay(a)) for (let z = bayFrom; z < H; z++) m.set(x, y, z, 0);
    });
  const wallAt = (x: number, y: number, a: number, z: number) =>
    recess && !inBay(a) && z >= bayFrom ? [x - f.front[0], y - f.front[1]] : [x, y];
  // a garage under the bay on some
  const garage = W >= 5 && rand() < 0.45;
  const doorAt = bayLeft ? Math.min(W - 1, bayW + Math.floor((W - bayW) / 2)) : Math.max(0, Math.floor((W - bayW) / 2) - 1);
  // a corner store under the flats: shop windows and a sign band (no lettering)
  const cornerStore = hints?.corner === true && W >= 4 && rand() < 0.5;
  // the windows beside the bay on a wide front: pairs between posts
  const n0 = bayLeft ? bayW : 0;
  const besideBay = (a: number) => a === doorAt || (W >= 8 && !inBay(a) && (a - n0) % 3 !== 0);
  const bayEdge = (a: number) => a === (bayLeft ? bayW - 1 : W - bayW) || a === (bayLeft ? 0 : W - 1);
  // window rows stop under the frieze and cornice
  const zTop = H - 2;

  for (let k = 0; k < floors; k++) {
    const z0 = k * fh;
    const ground = k === 0;
    eachFront(f, 0, (x, y, a) => {
      // the string course: trim along every floor line
      if (k > 0) {
        const [sx, sy] = wallAt(x, y, a, z0);
        onFace(m, f, sx!, sy!, z0, p.trim);
      }
      for (let z = z0 + 1; z < Math.min(zTop, z0 + fh); z++) {
        const [wx, wy] = wallAt(x, y, a, z);
        const zf = z - z0;
        const top = zf === fh - 1 && fh >= 3; // the lintel row
        if (ground) {
          if (cornerStore) {
            if (top) onFace(m, f, wx!, wy!, z, p.accent);
            else onFace(m, f, wx!, wy!, z, a === doorAt ? p.accent : a % 3 === 0 ? p.trim : p.pane());
          } else if (garage && inBay(a) && !top) {
            onFace(m, f, wx!, wy!, z, p.accent); // the garage door
          } else if (a === doorAt && !top) onFace(m, f, wx!, wy!, z, p.accent); // the front door
          else if (!garage && inBay(a) && !top) onFace(m, f, wx!, wy!, z, p.pane());
          continue;
        }
        if (top) {
          // hoods over the windows; at the driving scale a Victorian's bay carries its accent here
          if (type === 0 && inBay(a)) onFace(m, f, wx!, wy!, z, fh >= 5 ? p.trim : p.accent);
          else if (type === 1 && fh >= 5 && (inBay(a) || besideBay(a))) onFace(m, f, wx!, wy!, z, p.trim);
          continue;
        }
        if (fh >= 5 && zf === 1) {
          // aprons under the windows: a Victorian bay's panels in the accent
          if (type === 0 && inBay(a)) onFace(m, f, wx!, wy!, z, p.accent);
          continue;
        }
        if (inBay(a)) onFace(m, f, wx!, wy!, z, bayEdge(a) && bayW >= 3 ? p.trim : p.pane());
        else if (besideBay(a)) onFace(m, f, wx!, wy!, z, p.pane());
      }
    });
  }

  // the top: a frieze and cornice under a false front
  eachFront(f, 0, (x, y, a) => {
    const [wx, wy] = wallAt(x, y, a, H - 1);
    if (H >= 6) m.set(wx!, wy!, H - 3, (a + (bayLeft ? 0 : 1)) % 2 === 0 && type === 1 ? p.trim : p.accent);
    m.set(wx!, wy!, H - 2, p.trim);
    m.set(wx!, wy!, H - 1, p.trim);
  });
  if (gable > 0) {
    // a short pitched roof running back from the street, its gable end on the front
    for (let y = 0; y < f.sy; y++)
      for (let x = 0; x < f.sx; x++) {
        const i = y * f.sx + x;
        const a = f.along[i]!;
        const back = recess && !inBay(a) ? 1 : 0;
        const d = f.depth[i]! - back;
        if (f.depth[i]! < 0 || d < 0 || d > Math.max(2, Math.floor(W / 2))) continue;
        const rise = Math.min(gable, Math.min(a, W - 1 - a) + 1);
        for (let z = H; z < H + rise; z++) m.set(x, y, z, d === 0 ? (z === H + rise - 1 ? gableRoof : p.body) : gableRoof);
      }
    for (let y = 0; y < f.sy; y++)
      for (let x = 0; x < f.sx; x++) {
        const i = y * f.sx + x;
        const a = f.along[i]!;
        const back = recess && !inBay(a) ? 1 : 0;
        if (f.depth[i]! - back === 0 && gable >= 2 && Math.abs(a - (W - 1) / 2) < 1) onFace(m, f, x, y, H, p.pane());
      }
  } else {
    // the false front: a parapet with a raised centre (a pediment) above the flat roof
    eachFront(f, 0, (x, y, a) => {
      const [wx, wy] = wallAt(x, y, a, H);
      m.set(wx!, wy!, H, p.trim);
      if (W >= 5 && Math.abs(a - (W - 1) / 2) <= W / 6 && m.get(wx!, wy!, H)) m.set(wx!, wy!, H + 1, p.trim);
    });
  }
  // a roof deck on some wide, deep lots (the walking scale)
  if (W >= 8 && f.maxDepth >= 12 && gable === 0 && rand() < 0.3) roofDeck(m, f, H, fh, p);
  // side walls are mostly blank: party walls, with a window here and there where they show
  sideWindows(m, f, H, fh, p.pane, 4);
  return m;
};

/**
 * Blocks on wider lots. params.type: 0 apartments with stacked bays and a
 * cornice, 1 historic commercial (storefronts, paired windows, cornice),
 * 2 Chinatown (balconies, a green tile eave), 3 a pier shed (arched bulkhead,
 * low gable), 4 a warehouse (window grid, sawtooth roof), 5 a plain modern
 * block (ribbon windows).
 */
export const block: Generator = (ctx) => {
  const { rand, param, mask, hints } = ctx;
  if (!mask) throw new Error("block needs a footprint");
  const type = param("type", 0);
  const f = facadeOf(mask, frontDir(mask, hints?.front));
  const W = f.width;
  const H = Math.max(3, Math.min(120, Math.round(ctx.heightVox ?? 10)));
  const floors = Math.max(1, Math.min(30, hints?.floors ?? Math.round(H / 4)));
  const fh = Math.max(2, Math.floor(H / floors));
  const pierGable = type === 3 ? Math.max(1, Math.min(4, Math.floor(W / 4))) : 0;
  const m = new VoxelModel(f.sx, f.sy, H + Math.max(pierGable, 5) + 3);
  const p = palette(ctx, m);
  massing(m, f, H, p.body, p.roof);

  const bayEvery = W >= 12 ? 5 : 3;
  const recessFront = type === 0 && f.maxDepth >= 4 && W >= 4;
  const isBay = (a: number) => a % bayEvery >= 1 && a % bayEvery <= Math.min(2, bayEvery - 1) && a < W - 1;
  if (recessFront)
    eachFront(f, 0, (x, y, a) => {
      if (!isBay(a)) for (let z = fh; z < H; z++) m.set(x, y, z, 0);
    });
  const wallAt = (x: number, y: number, a: number) =>
    recessFront && !isBay(a) ? [x - f.front[0], y - f.front[1]] : [x, y];

  eachFront(f, 0, (x, y, a) => {
    const [wx, wy] = wallAt(x, y, a);
    for (let z = 1; z < H - 1; z++) {
      const k = Math.floor(z / fh);
      const zf = z - k * fh;
      if (zf === 0) continue; // floor lines stay wall
      const ground = k === 0;
      if (type === 3) {
        // the bulkhead: a tall arch in the middle third, piers either side
        const mid = Math.abs(a - (W - 1) / 2) <= Math.max(1, W / 6);
        if (mid && z < H - 2) onFace(m, f, wx!, wy!, z, z >= H - 3 ? p.trim : p.accent);
        else if (z === H - 2 && a % 2 === 0) onFace(m, f, wx!, wy!, z, p.pane());
        continue;
      }
      if (ground && (type === 1 || type === 2)) {
        // storefronts between piers
        onFace(m, f, wx!, wy!, z, a % 4 === 0 ? p.trim : z === fh - 1 ? p.trim : p.pane());
        continue;
      }
      if (type === 4) {
        if (a % 3 !== 0 && zf !== fh - 1) onFace(m, f, wx!, wy!, z, p.glass);
        continue;
      }
      const lintel = fh >= 3 && zf === fh - 1;
      if (type === 5) {
        // ribbon windows
        if (!lintel) onFace(m, f, wx!, wy!, z, p.pane());
        continue;
      }
      if (type === 0) {
        // the bays glazed floor to floor; one window between them
        if (isBay(a) ? !lintel : (W < 6 || a % bayEvery === 0) && !lintel && zf === Math.max(1, Math.floor(fh / 2)))
          onFace(m, f, wx!, wy!, z, p.pane());
        continue;
      }
      // historic commercial and Chinatown: paired windows between piers
      if (a % 3 !== 0 && !lintel) onFace(m, f, wx!, wy!, z, p.pane());
      if (type === 2 && zf === 1 && a % 3 === 0) onFace(m, f, wx!, wy!, z, p.trim); // balcony posts
    }
  });
  if (type === 2) {
    // balconies: a red rail at the foot of every floor; signs hung down the front
    for (let k = 1; k < floors; k++)
      eachFront(f, 0, (x, y) => {
        if (k * fh + 1 < H - 2) onFace(m, f, x, y, k * fh + 1, p.trim);
      });
    const signs = ctx.ramps("sign");
    if (signs.length && W >= 3)
      eachFront(f, 0, (x, y, a) => {
        if (a === 1 || (W >= 9 && a === W - 2))
          for (let z = fh; z < Math.min(H - 3, 3 * fh); z++) onFace(m, f, x, y, z, m.material(signs[(a + z) % signs.length]!));
      });
    // a jade tile eave with upturned corners
    const eaves = ctx.ramps("eave");
    const eave = eaves.length ? m.material(eaves[0]!) : p.roof;
    eachFront(f, 0, (x, y, a) => {
      m.set(x, y, H - 2, eave);
      m.set(x, y, H - 1, eave);
      if (a === 0 || a === W - 1) m.set(x, y, H, eave);
    });
    // a pagoda roof on some: two tiers of jade on red posts, near the front
    if (W >= 5 && f.maxDepth >= 5 && rand() < 0.35) {
      const pw = Math.max(3, Math.min(W - 2, Math.round(W * 0.5)));
      const a0 = Math.floor((W - pw) / 2);
      for (let y = 0; y < f.sy; y++)
        for (let x = 0; x < f.sx; x++) {
          const i = y * f.sx + x;
          const a = f.along[i]!;
          const d = f.depth[i]!;
          if (d < 1 || d > pw || a < a0 || a >= a0 + pw) continue;
          const da = Math.min(a - a0, a0 + pw - 1 - a);
          const dd = Math.min(d - 1, pw - d);
          const ring = Math.min(da, dd);
          m.set(x, y, H, ring === 0 ? p.trim : eave);
          m.set(x, y, H + 1, eave);
          if (ring >= 1) m.set(x, y, H + 2, eave);
          if (ring >= 1 && ring <= 1) m.set(x, y, H + 3, eave);
          if (ring >= 2) for (let z = H + 2; z < H + 5; z++) m.set(x, y, z, eave);
        }
    }
  } else if (type === 0 || type === 1) {
    // the cornice
    eachFront(f, 0, (x, y, a) => {
      const [wx, wy] = wallAt(x, y, a);
      m.set(wx!, wy!, H - 2, p.trim);
      m.set(wx!, wy!, H - 1, p.trim);
    });
  }
  if (type === 3) {
    // a low gable along the shed
    for (let y = 0; y < f.sy; y++)
      for (let x = 0; x < f.sx; x++) {
        const i = y * f.sx + x;
        if (f.depth[i]! < 0) continue;
        const a = f.along[i]!;
        const rise = Math.min(pierGable, Math.floor(Math.min(a, W - 1 - a) / 2) + 1);
        for (let z = H; z < H + rise; z++) m.set(x, y, z, f.depth[i] === 0 && z < H + rise - 1 ? p.body : p.roof);
      }
  }
  if (type === 4 && f.maxDepth >= 4) {
    // sawtooth roof: teeth across the depth, glazed on their steep side
    for (let y = 0; y < f.sy; y++)
      for (let x = 0; x < f.sx; x++) {
        const i = y * f.sx + x;
        const d = f.depth[i]!;
        if (d < 0) continue;
        const t = d % 4;
        for (let z = H; z < H + t; z++) m.set(x, y, z, t > 0 && z === H + t - 1 && d % 4 === 3 ? p.glass : p.roof);
      }
  }
  sideWindows(m, f, H, fh, p.pane, type === 4 ? 3 : 2);
  return m;
};

export const FACADE_GENERATORS: Record<string, Generator> = { rowhouse, block };
