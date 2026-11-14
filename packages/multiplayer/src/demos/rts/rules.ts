import type { WorldEdits, WorldQuery } from "pixelworld/engine";

/**
 * Fogfront's rules, the same on the server (game.ts, server.ts) and in the
 * page (client.ts): D-121. Two guilds, the Kiln and the Tide, race for glim
 * on the Presidio's meadows (San Francisco's driving level, 25 m cells):
 * runners carry it from seeps to their hearth, a lodge trains wardens, and a
 * side whose hearth falls loses. The map is a grid of cells read once from
 * the world's queries (`buildGrid`): water, the level's buildings and the
 * match's block; a step to a neighbour climbs at most `MAX_CLIMB`; roads are
 * quicker and woods slower (and can't be built on). Paths are A* on those
 * cells (`findPath`). The level's buildings have hit points: wardens knock
 * them down, the world's edits take them out of every page's view, and their
 * cells open (D-124).
 */

/** The driving level the match is on. */
export const RTS_WORLD = "/sf/";
/** The play area (cells of the level): the Presidio, from Baker Beach's bluffs to Crissy Field. */
export const MAP = { x0: 118, y0: 168, w: 132, h: 82 };
/** The server's fixed step (s): orders, movement and fights. */
export const TICK = 1 / 20;
/** A snapshot every this many ticks (10 a second). */
export const SNAPSHOT_EVERY = 2;
/** How far behind the page draws the units (s): two snapshots. */
export const DELAY = 0.2;

export const TEAMS = ["kiln", "tide"] as const;
export type Team = (typeof TEAMS)[number];
export const TEAM_NAMES: Record<Team, string> = { kiln: "the Kiln", tide: "the Tide" };

export type UnitKind = "runner" | "warden";
export type BuildingKind = "hearth" | "lodge";

export interface UnitRule {
  hp: number;
  /** Cells a second, off roads. */
  speed: number;
  cost: number;
  /** Seconds to train. */
  time: number;
  /** Cells it sees. */
  sight: number;
  /** Damage a blow, blows a second apart (`cooldown`), within `range` cells (0: doesn't fight). */
  damage: number;
  cooldown: number;
  range: number;
}

export const UNITS: Record<UnitKind, UnitRule> = {
  runner: { hp: 40, speed: 2.2, cost: 50, time: 6, sight: 6, damage: 0, cooldown: 0, range: 0 },
  warden: { hp: 80, speed: 1.8, cost: 80, time: 9, sight: 7, damage: 9, cooldown: 1, range: 1.4 },
};

export interface BuildingRule {
  /** Cells a side (square). */
  size: number;
  hp: number;
  cost: number;
  /** Seconds to raise. */
  time: number;
  sight: number;
  trains: UnitKind;
}

export const BUILDINGS: Record<BuildingKind, BuildingRule> = {
  hearth: { size: 3, hp: 1000, cost: 0, time: 0, sight: 8, trains: "runner" },
  lodge: { size: 2, hp: 400, cost: 120, time: 15, sight: 6, trains: "warden" },
};

/** Each side starts with its hearth, this much glim and these runners. */
export const START = { glim: 150, runners: 3 };
/** A runner carries `carry` glim, mined in `seconds` within `reach` cells of a seep; it drops it within `reach` of its hearth. */
export const GATHER = { carry: 10, seconds: 2, reach: 1.3 };
/** Glim in a seep. */
export const SEEP_GLIM = 800;
/** Units go this much quicker on a road, and this much as quick in woods. */
export const ROAD_SPEED = 1.5;
export const WOODS_SPEED = 0.6;
/** Most a step to a neighbouring cell may climb (height steps): the bluffs and steep banks are walls. */
export const MAX_CLIMB = 1.5;
/** Most a building's footprint may rise across it (steps). */
export const MAX_RISE = 1;
/** A building goes up within this many cells of the middle of one of its side's own. */
export const BUILD_RANGE = 12;
/** Trainings a building holds at once. */
export const QUEUE = 5;
/** Units a page may order at once. */
export const MAX_ORDER = 200;
/** The match: waiting for a second side (a page alone gets the bot after `wait` s, or at once with `vs: "bot"`), play, `ended` s of the result, and the next. */
export const MATCH = { wait: 20, ended: 15, seconds: 1200 };
export type MatchPhase = "waiting" | "playing" | "ended";

/** Where each side starts (its hearth's top-left cell), and the seeps (cells): three by each hearth and two between. */
export const LAYOUT = {
  hearths: { kiln: [125, 236], tide: [200, 180] } as Record<Team, [number, number]>,
  seeps: [
    // the Kiln's, on Baker Beach
    [130, 233],
    [122, 241],
    [128, 242],
    // the Tide's, on Crissy Field
    [195, 177],
    [206, 178],
    [198, 185],
    // between, in clearings of the woods
    [160, 197],
    [187, 207],
  ] as [number, number][],
};

// ---------------------------------------------------------------- messages

/** Who a page is: its name, and whether it wants the bot now rather than wait for a second player. */
export interface RtsJoin {
  name: string;
  vs: "any" | "bot";
}

/** A page's orders (`TickClient.command`), checked on the server. Units are ids of the page's own. */
export type RtsCommand =
  | { t: "move"; u: number[]; x: number; y: number; attack?: boolean }
  | { t: "attack"; u: number[]; target: number }
  | { t: "gather"; u: number[]; seep: number }
  | { t: "stop"; u: number[] }
  | { t: "build"; kind: BuildingKind; x: number; y: number }
  | { t: "train"; b: number }
  /** Knock down one of the level's buildings (its object, `Structure.obj`). */
  | { t: "raze"; u: number[]; obj: number };

/** A unit as a page sees it: positions in cells to 0.01, its goal for its own side. */
export interface UnitNet {
  i: number;
  k: UnitKind;
  s: Team;
  x: number;
  y: number;
  /** Heading (rad, to 0.01). */
  d: number;
  hp: number;
  /** Carrying glim (runners). */
  c?: 1;
  /** Fighting now. */
  f?: 1;
  /** Where it is going (its own side's only). */
  g?: [number, number];
}

export interface BuildingNet {
  i: number;
  k: BuildingKind;
  s: Team;
  /** Top-left cell. */
  x: number;
  y: number;
  hp: number;
  /** Raised so far, 0–1 (1: standing). */
  b: number;
  /** Trainings waiting (its own side's only), and the first's progress 0–1. */
  q?: number;
  p?: number;
}

export interface SeepNet {
  i: number;
  x: number;
  y: number;
  left: number;
}

/** One player's own snapshot: what its side sees (the fog of war), its glim. */
export interface RtsSnap {
  side: Team;
  glim: number;
  units: UnitNet[];
  buildings: BuildingNet[];
  seeps: SeepNet[];
  /** The level's buildings it sees knocked about, still standing: [object, hit points]. */
  hurt?: [number, number][];
}

export interface PlayerNet {
  id: string;
  name: string;
  side: Team;
  bot?: true;
}

/** What every page shares: the match and who plays. */
export interface RtsWorldNet {
  match: { phase: MatchPhase; until: number | null; winner: Team | null };
  players: PlayerNet[];
  /** The level's buildings knocked down this match (objects, as they fell): every page takes them out of its world (D-124). */
  razed: number[];
}

/** Events, at server time; each to the pages whose side sees it. */
export type RtsEvent =
  /** A blow; `obj`: `to` is one of the level's buildings (its object). */
  | { kind: "hit"; by: number; to: number; obj?: 1; x: number; y: number }
  | { kind: "die"; id: number; x: number; y: number }
  | { kind: "refused"; why: string }
  | { kind: "phase"; phase: MatchPhase; winner: Team | null };

/** What the lobby lists. */
export interface RtsInfo {
  phase: MatchPhase;
  open: boolean;
}

// ---------------------------------------------------------------- the map's cells

export const WATER = 1;
/** One of the level's buildings: a wall. */
export const OBJECT = 2;
export const ROAD = 4;
/** Trees: slow going, and no building on them. */
export const WOODS = 8;

/** One of the level's buildings in the play area (D-124): wardens can knock it down. */
export interface Structure {
  /** The level's object (`ObjectHit.index`): the edit that takes it out of the world names it. */
  obj: number;
  /** The middle of the cells it walls, and its top (steps). */
  x: number;
  y: number;
  top: number;
  /** The grid cells it walls. */
  cells: number[];
  /** Hit points, from the cells it covers and its height (`structureHp`). */
  hp: number;
}

/** A level building's hit points: more for each cell it walls and each height step it rises. */
export const structureHp = (cells: number, height: number): number => Math.min(1000, Math.round((50 + 40 * cells + 60 * Math.max(0, height)) / 10) * 10);

/** The play area's cells, read once from the world: flags, heights, and the buildings standing on them. */
export interface MapGrid {
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** WATER | OBJECT | ROAD | WOODS per cell. */
  flags: Uint8Array;
  /** The ground at each cell's middle (steps). */
  height: Float32Array;
  /** The building on a cell (its id), 0 for none: changes as they go up and fall. */
  building: Int32Array;
  /** The level's buildings, by object (D-124). */
  structures?: Map<number, Structure>;
  /** Every placed object walling a cell (by cell): it opens once all of them have fallen. */
  walls?: Map<number, number[]>;
}

const isTree = (group: string) => group === "tree" || group.startsWith("tree.");
/** The level's objects wardens can knock down: buildings (not landmarks, walls or bridges). */
const isBuilding = (group: string) => group === "building" || group.startsWith("building.");
/** What walls a cell besides water: placed objects but trees (woods) and props (street lights, signals). */
const blocks = (group: string) => !isTree(group) && !group.startsWith("prop.");

/** Read the play area's cells from a world's queries (the terrain and objects there loaded: `query.ensure`). */
export function buildGrid(query: Pick<WorldQuery, "heightAt" | "surfaceAt" | "roadAt" | "objectsAt">, map = MAP): MapGrid {
  const n = map.w * map.h;
  const structures = new Map<number, Structure>();
  const walls = new Map<number, number[]>();
  const heights = new Map<number, number>();
  const g: MapGrid = { ...map, flags: new Uint8Array(n), height: new Float32Array(n), building: new Int32Array(n), structures, walls };
  for (let cy = 0; cy < map.h; cy++)
    for (let cx = 0; cx < map.w; cx++) {
      const x = map.x0 + cx + 0.5;
      const y = map.y0 + cy + 0.5;
      const i = cy * map.w + cx;
      g.height[i] = query.heightAt(x, y) ?? 0;
      let f = 0;
      if (query.surfaceAt(x, y)?.waterLevel != null) f |= WATER;
      const objects = query.objectsAt(x, y);
      const walling = objects.filter((o) => blocks(o.group));
      if (walling.length) {
        f |= OBJECT;
        walls.set(i, walling.map((o) => o.index));
        for (const o of walling) {
          if (!isBuilding(o.group)) continue;
          let s = structures.get(o.index);
          if (!s) {
            structures.set(o.index, (s = { obj: o.index, x: 0, y: 0, top: o.top ?? 0, cells: [], hp: 0 }));
            heights.set(o.index, o.top !== null && o.base !== null ? o.top - o.base : 0);
          }
          s.cells.push(i);
          s.x += x;
          s.y += y;
        }
      } else if (objects.some((o) => isTree(o.group))) f |= WOODS;
      if (query.roadAt(x, y)) f |= ROAD;
      g.flags[i] = f;
    }
  for (const s of structures.values()) {
    s.x /= s.cells.length;
    s.y /= s.cells.length;
    s.hp = structureHp(s.cells.length, heights.get(s.obj)!);
  }
  return g;
}

/**
 * One of the level's buildings has fallen (`razed` has it, D-124): the cells
 * it walled open, those nothing else standing walls.
 */
// ponytail: trees on a fallen building's cells stay out of the woods; read them in `walls` if that shows
export function razeCells(g: MapGrid, obj: number, razed: ReadonlySet<number>): void {
  for (const i of g.structures?.get(obj)?.cells ?? []) if (g.walls?.get(i)?.every((o) => razed.has(o)) ?? true) g.flags[i]! &= ~OBJECT;
}

/**
 * A page's side of the fallen buildings (D-124): the match's list
 * (`RtsWorldNet.razed`) put into the world's edits, so the view bakes them
 * away and the queries agree, and into the page's own cells. A list that
 * doesn't go on from the last (a new match) puts everything back first.
 */
export class Razed {
  private applied: number[] = [];
  private readonly pristine: Uint8Array;

  constructor(
    private readonly edits: Pick<WorldEdits, "remove" | "restore">,
    private readonly grid: MapGrid,
  ) {
    this.pristine = grid.flags.slice();
  }

  /** The match's list now: the buildings that fell since the last. */
  sync(razed: readonly number[]): number[] {
    if (this.applied.length > razed.length || this.applied.some((o, i) => razed[i] !== o)) {
      this.edits.restore();
      this.grid.flags.set(this.pristine);
      this.applied = [];
    }
    const fresh = razed.slice(this.applied.length);
    if (!fresh.length) return [];
    this.applied = [...razed];
    this.edits.remove(fresh);
    const all = new Set(razed);
    for (const o of fresh) razeCells(this.grid, o, all);
    return fresh;
  }
}

/** A cell's index in the grid, or -1 outside it. */
export function cellIndex(g: MapGrid, cx: number, cy: number): number {
  const x = cx - g.x0;
  const y = cy - g.y0;
  return x < 0 || y < 0 || x >= g.w || y >= g.h ? -1 : y * g.w + x;
}

/** Whether a unit may stand on a cell: in the area, not water, no object or building. */
export function passable(g: MapGrid, cx: number, cy: number): boolean {
  const i = cellIndex(g, cx, cy);
  return i >= 0 && (g.flags[i]! & (WATER | OBJECT)) === 0 && g.building[i] === 0;
}

/** Whether a unit may step from one cell to a neighbour: both passable, and not too steep. */
export function canStep(g: MapGrid, ax: number, ay: number, bx: number, by: number): boolean {
  if (!passable(g, bx, by)) return false;
  const a = cellIndex(g, ax, ay);
  return a < 0 || Math.abs(g.height[a]! - g.height[cellIndex(g, bx, by)]!) <= MAX_CLIMB;
}

/** How quick going is on a cell, over open ground's: roads quicker, woods slower. */
const paceOf = (g: MapGrid, i: number) => (i < 0 ? 1 : g.flags[i]! & ROAD ? ROAD_SPEED : g.flags[i]! & WOODS ? WOODS_SPEED : 1);

/** How quick going is at a point (`paceOf` its cell). */
export const paceAt = (g: MapGrid, x: number, y: number): number => paceOf(g, cellIndex(g, Math.floor(x), Math.floor(y)));

/** The ground under a point (steps): the cell's, between cells' middles. */
export function groundAt(g: MapGrid, x: number, y: number): number {
  const i = cellIndex(g, Math.floor(x), Math.floor(y));
  return i < 0 ? 0 : g.height[i]!;
}

// ---------------------------------------------------------------- paths

export interface Point {
  x: number;
  y: number;
}

const DIRS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** A cell's cost to cross a cell's length (s at speed 1). */
const costAt = (g: MapGrid, i: number) => 1 / paceOf(g, i);

/** A min-heap of grid indices by their f score. */
class Heap {
  private readonly items: number[] = [];
  constructor(private readonly f: Float64Array) {}
  get size(): number {
    return this.items.length;
  }
  push(i: number): void {
    const a = this.items;
    a.push(i);
    let k = a.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (this.f[a[p]!]! <= this.f[i]!) break;
      a[k] = a[p]!;
      k = p;
    }
    a[k] = i;
  }
  pop(): number {
    const a = this.items;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        if (l >= a.length) break;
        const r = l + 1;
        const c = r < a.length && this.f[a[r]!]! < this.f[a[l]!]! ? r : l;
        if (this.f[a[c]!]! >= this.f[last]!) break;
        a[k] = a[c]!;
        k = c;
      }
      a[k] = last;
    }
    return top;
  }
}

/**
 * A path from a point to a goal over the cells (A*, eight ways, no corner
 * cutting, roads quicker, woods slower), straightened where a straight line is clear and
 * no slower: the points to walk through, the last the goal itself. A goal
 * that can't be reached (water, a wall of woods, a building's middle) gives
 * the path to the reachable cell nearest it. Empty when already there, or
 * the start is shut in.
 */
export function findPath(g: MapGrid, from: Point, to: Point): Point[] {
  const sx = Math.floor(from.x);
  const sy = Math.floor(from.y);
  const gx = Math.floor(to.x);
  const gy = Math.floor(to.y);
  let start = cellIndex(g, sx, sy);
  if (start < 0) return [];
  // standing where it can't (pushed, or something went up there): from the nearest open cell
  if (!passable(g, sx, sy)) {
    const near = nearestOpen(g, sx, sy, 3);
    if (!near) return [];
    start = cellIndex(g, near.x, near.y);
  }
  const n = g.w * g.h;
  const cost = new Float64Array(n).fill(Infinity);
  const f = new Float64Array(n);
  const from_ = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const tx = Math.min(g.w - 1, Math.max(0, gx - g.x0));
  const ty = Math.min(g.h - 1, Math.max(0, gy - g.y0));
  const goal = ty * g.w + tx;
  const guess = (i: number) => {
    const dx = Math.abs((i % g.w) - tx);
    const dy = Math.abs(Math.floor(i / g.w) - ty);
    return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) / ROAD_SPEED;
  };
  cost[start] = 0;
  f[start] = guess(start);
  const open = new Heap(f);
  open.push(start);
  let best = start;
  let bestGuess = guess(start);
  while (open.size) {
    const i = open.pop();
    if (closed[i]) continue;
    closed[i] = 1;
    const h = guess(i);
    if (h < bestGuess || (h === bestGuess && cost[i]! < cost[best]!)) {
      best = i;
      bestGuess = h;
    }
    if (i === goal) break;
    const cx = (i % g.w) + g.x0;
    const cy = Math.floor(i / g.w) + g.y0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!canStep(g, cx, cy, nx, ny)) continue;
      if (dx && dy && !(passable(g, cx + dx, cy) && passable(g, cx, cy + dy))) continue; // no cutting a corner
      const j = cellIndex(g, nx, ny);
      if (closed[j]) continue;
      const c = cost[i]! + ((dx && dy ? Math.SQRT2 : 1) * (costAt(g, i) + costAt(g, j))) / 2;
      if (c >= cost[j]!) continue;
      cost[j] = c;
      from_[j] = i;
      f[j] = c + guess(j);
      open.push(j);
    }
  }
  const cells: number[] = [];
  for (let i = best; i !== -1; i = from_[i]!) cells.push(i);
  cells.reverse();
  const pts = cells.map((i) => ({ x: (i % g.w) + g.x0 + 0.5, y: Math.floor(i / g.w) + g.y0 + 0.5 }));
  const costs = cells.map((i) => cost[i]!);
  if (best === goal) pts[pts.length - 1] = { x: to.x, y: to.y }; // the goal itself, within its cell
  pts[0] = { x: from.x, y: from.y };
  // straighten: from each point, on to the furthest one a straight line reaches as quickly
  const out: Point[] = [];
  let a = 0;
  while (a < pts.length - 1) {
    let b = pts.length - 1;
    while (b > a + 1 && !(lineClear(g, pts[a]!, pts[b]!) && lineCost(g, pts[a]!, pts[b]!) <= costs[b]! - costs[a]! + 1e-6)) b--;
    out.push(pts[b]!);
    a = b;
  }
  return out;
}

/** Points along a line, a fifth of a cell apart. */
function* along(a: Point, b: Point): Generator<Point> {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(len * 5));
  for (let k = 0; k <= n; k++) yield { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
}

/** Whether a unit can walk a straight line: every cell on it open, and no step too steep. */
export function lineClear(g: MapGrid, a: Point, b: Point): boolean {
  let px = Math.floor(a.x);
  let py = Math.floor(a.y);
  for (const p of along(a, b)) {
    const cx = Math.floor(p.x);
    const cy = Math.floor(p.y);
    if (cx === px && cy === py) continue;
    // a diagonal step through a corner: both cells beside it open
    if (cx !== px && cy !== py && !(passable(g, cx, py) && passable(g, px, cy))) return false;
    if (!canStep(g, px, py, cx, cy)) return false;
    px = cx;
    py = cy;
  }
  return true;
}

/** A straight line's cost (as `findPath` counts it). */
function lineCost(g: MapGrid, a: Point, b: Point): number {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  let sum = 0;
  let n = 0;
  for (const p of along(a, b)) {
    const i = cellIndex(g, Math.floor(p.x), Math.floor(p.y));
    sum += costAt(g, i);
    n++;
  }
  return (len * sum) / n;
}

/** The open cell nearest a cell, within `radius` rings; null if none. */
export function nearestOpen(g: MapGrid, cx: number, cy: number, radius: number, ok: (x: number, y: number) => boolean = () => true): Point | null {
  for (let r = 0; r <= radius; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (passable(g, cx + dx, cy + dy) && ok(cx + dx, cy + dy)) return { x: cx + dx, y: cy + dy };
      }
  return null;
}

// ---------------------------------------------------------------- placing a building

/** What stands where a building would go: the side's buildings (to be near one), and units and seeps (to keep clear of). */
export interface Placing {
  own: { x: number; y: number; size: number }[];
  units: Point[];
  seeps: Point[];
}

/**
 * Why a building can't go up with its top-left at a cell, or null when it
 * can: the whole footprint in the area, on dry, level ground (`MAX_RISE`)
 * with nothing on it (no object, woods, building, unit or seep, and a cell
 * clear around seeps), within `BUILD_RANGE` of one of the side's buildings.
 */
export function placementError(g: MapGrid, kind: BuildingKind, x: number, y: number, at: Placing): string | null {
  const size = BUILDINGS[kind].size;
  let lo = Infinity;
  let hi = -Infinity;
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++) {
      const i = cellIndex(g, x + dx, y + dy);
      if (i < 0) return "outside the field";
      if (g.flags[i]! & WATER) return "water";
      if (g.flags[i]! & OBJECT) return "something stands there";
      if (g.flags[i]! & WOODS) return "woods";
      if (g.building[i]) return "a building stands there";
      lo = Math.min(lo, g.height[i]!);
      hi = Math.max(hi, g.height[i]!);
    }
  if (hi - lo > MAX_RISE) return "the ground isn't level";
  const inside = (p: Point, margin: number) => p.x >= x - margin && p.y >= y - margin && p.x < x + size + margin && p.y < y + size + margin;
  if (at.units.some((u) => inside(u, 0))) return "units stand there";
  if (at.seeps.some((s) => inside(s, 1))) return "too near a seep";
  const mid = { x: x + size / 2, y: y + size / 2 };
  if (!at.own.some((b) => Math.hypot(b.x + b.size / 2 - mid.x, b.y + b.size / 2 - mid.y) <= BUILD_RANGE)) return "too far from your buildings";
  return null;
}

/** How far a point is from a footprint (cells; 0 inside it): `size` cells a side from its top-left. */
export function distToBuilding(p: Point, b: { x: number; y: number; size: number }): number {
  const size = b.size;
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + size));
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + size));
  return Math.hypot(dx, dy);
}
