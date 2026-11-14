import type { ObjectHit, WorldEdits, WorldQuery } from "./types";

/**
 * A rectangle of a world's cells read once from its queries, for games
 * (D-125): the ground's height on each, the water, what stands there (the
 * level's buildings and walls, trees) and how high, the surface and the road
 * class; and walking and seeing over them: A* paths (`findPath`), straight
 * lines walked (`lineClear`), lines of sight over the ground, buildings and
 * canopies (`lineOfSight`), and what an eye sees around it (`viewshed`).
 * Plain data, so a server keeps one per room and applies its own match's
 * edits to it (`setRemoved`) without touching the world they share. Read
 * by Fogfront (D-121) on a server through `openWorld` and in its pages.
 */

/** A cell's flags. */
export const CELL_WATER = 1;
/** A placed object walls it: a building, a wall, a landmark's part. */
export const CELL_WALL = 2;
export const CELL_ROAD = 4;
/** Trees stand there. */
export const CELL_TREES = 8;

export interface CellRect {
  /** The top-left cell (the world's), and the size in cells. */
  x0: number;
  y0: number;
  w: number;
  h: number;
}

export interface CellPoint {
  x: number;
  y: number;
}

/** A point and a height (steps): an eye, or what it looks at. */
export interface CellEye extends CellPoint {
  h: number;
}

/** A placed object on a cell, as the cells keep it. */
export interface CellObject {
  /** `ObjectHit.index`: what `WorldEdits` and `setRemoved` name. */
  index: number;
  wall: boolean;
  trees: boolean;
  /** Where its top stands (steps): its own, or its base and a default height where the world doesn't say. */
  top: number;
}

export interface Cells extends CellRect {
  /** `CELL_*` per cell (index `(cy − y0) · w + cx − x0`). */
  flags: Uint8Array;
  /** The ground at each cell's middle (steps). */
  height: Float32Array;
  /** The highest thing on each cell (steps): an object's top, a canopy, or the ground. Lines of sight pass over it. */
  top: Float32Array;
  /** The surface id (the world's `manifest.surfaces`), and the road class id (0: none). */
  surface: Uint8Array;
  roadClass: Uint8Array;
  /** The placed objects standing on each cell that wall it or are trees, by cell index. */
  objects: Map<number, CellObject[]>;
}

export interface ReadCellsOptions {
  /** Whether an object walls the cells it stands on (default: everything but trees and props). */
  wall?: (o: ObjectHit) => boolean;
  /** Whether an object is trees (default: groups `tree` and `tree.*`). */
  trees?: (o: ObjectHit) => boolean;
  /** How high an object stands over its base where the world doesn't say (steps; default 3, as `pickObject` takes it). */
  defaultHeight?: number;
  /** Each object read, on each cell it stands on: for a game's own lists (its buildings with hit points, say). */
  onObject?: (o: ObjectHit, cell: number) => void;
}

const isTree = (o: ObjectHit) => o.group === "tree" || o.group.startsWith("tree.");
const isWall = (o: ObjectHit) => !isTree(o) && !o.group.startsWith("prop.");

/**
 * Read a rectangle's cells from a world's queries, at each cell's middle
 * (the terrain and objects there loaded: `query.ensure`). Objects already
 * removed by edits aren't there; read before edits for `setRemoved` and
 * `followEdits` to know every object.
 */
export function readCells(query: Pick<WorldQuery, "heightAt" | "surfaceAt" | "roadAt" | "objectsAt">, rect: CellRect, opts: ReadCellsOptions = {}): Cells {
  const n = rect.w * rect.h;
  const c: Cells = {
    x0: rect.x0,
    y0: rect.y0,
    w: rect.w,
    h: rect.h,
    flags: new Uint8Array(n),
    height: new Float32Array(n),
    top: new Float32Array(n),
    surface: new Uint8Array(n),
    roadClass: new Uint8Array(n),
    objects: new Map(),
  };
  const wall = opts.wall ?? isWall;
  const trees = opts.trees ?? isTree;
  const tall = opts.defaultHeight ?? 3;
  for (let cy = 0; cy < rect.h; cy++)
    for (let cx = 0; cx < rect.w; cx++) {
      const x = rect.x0 + cx + 0.5;
      const y = rect.y0 + cy + 0.5;
      const i = cy * rect.w + cx;
      const ground = query.heightAt(x, y) ?? 0;
      c.height[i] = ground;
      const s = query.surfaceAt(x, y);
      let f = s?.waterLevel != null ? CELL_WATER : 0;
      c.surface[i] = s?.id ?? 0;
      const road = query.roadAt(x, y);
      if (road) {
        f |= CELL_ROAD;
        c.roadClass[i] = road.classId;
      }
      c.flags[i] = f;
      const on: CellObject[] = [];
      for (const o of query.objectsAt(x, y)) {
        opts.onObject?.(o, i);
        const w = wall(o);
        const t = !w && trees(o);
        if (w || t) on.push({ index: o.index, wall: w, trees: t, top: o.top ?? (o.base ?? ground) + tall });
      }
      if (on.length) c.objects.set(i, on);
      settle(c, i, () => false);
    }
  return c;
}

/** A cell's walls, trees and top from the objects standing on it (and its ground). */
function settle(c: Cells, i: number, removed: (index: number) => boolean): void {
  let f = c.flags[i]! & ~(CELL_WALL | CELL_TREES);
  let top = c.height[i]!;
  for (const o of c.objects.get(i) ?? []) {
    if (removed(o.index)) continue;
    if (o.wall) f |= CELL_WALL;
    if (o.trees) f |= CELL_TREES;
    top = Math.max(top, o.top);
  }
  c.flags[i] = f;
  c.top[i] = top;
}

/** The cells the given objects stand on. */
export function cellsOf(c: Cells, objects: Iterable<number>): number[] {
  const want = new Set(objects);
  const out: number[] = [];
  for (const [i, on] of c.objects) if (on.some((o) => want.has(o.index))) out.push(i);
  return out;
}

/**
 * The cells under objects taken out or put back read again from what stands
 * there: a cell opens once nothing walling it stands, and its top drops.
 * Only `objects`' cells change (every cell without them).
 */
export function setRemoved(c: Cells, removed: (index: number) => boolean, objects?: Iterable<number>): void {
  const cells = objects ? cellsOf(c, objects) : [...c.objects.keys()];
  for (const i of cells) settle(c, i, removed);
}

/** Keep the cells to a world's edits (a page's view, or a world a server keeps for one match): returns a function that stops. */
export function followEdits(c: Cells, edits: Pick<WorldEdits, "isRemoved" | "onChange">): () => void {
  setRemoved(c, (o) => edits.isRemoved(o));
  return edits.onChange((e) => setRemoved(c, (o) => edits.isRemoved(o), e.objects));
}

/** A cell's index, or −1 outside the rectangle. */
export function cellIndex(c: CellRect, cx: number, cy: number): number {
  const x = cx - c.x0;
  const y = cy - c.y0;
  return x < 0 || y < 0 || x >= c.w || y >= c.h ? -1 : y * c.w + x;
}

/** The index of the cell a point is on, or −1. */
export const cellAt = (c: CellRect, x: number, y: number): number => cellIndex(c, Math.floor(x), Math.floor(y));

// ---------------------------------------------------------------- walking

export interface PathOptions {
  /**
   * How long crossing a cell's length takes on cell `i` (at speed 1), or
   * Infinity where nothing may stand: a game's terrain, roads, woods and its
   * own buildings. Default 1 on dry cells nothing walls, else Infinity.
   */
  cost?: (i: number) => number;
  /** The least `cost` gives anywhere (default 1): A*'s guess may never be more than the way is. */
  minCost?: number;
  /** Most a step to a neighbour may climb (steps; default no limit). */
  maxClimb?: number;
}

const openCost = (c: Cells) => (i: number) => (c.flags[i]! & (CELL_WATER | CELL_WALL) ? Infinity : 1);

/** Whether a unit may stand on a cell (`cost` finite). */
export function walkable(c: Cells, cx: number, cy: number, opts: PathOptions = {}): boolean {
  const i = cellIndex(c, cx, cy);
  return i >= 0 && Number.isFinite((opts.cost ?? openCost(c))(i));
}

/** Whether a unit may step from a cell to a neighbour: it may stand there, and the climb is within `maxClimb`. */
export function canStep(c: Cells, ax: number, ay: number, bx: number, by: number, opts: PathOptions = {}): boolean {
  if (!walkable(c, bx, by, opts)) return false;
  const a = cellIndex(c, ax, ay);
  return a < 0 || opts.maxClimb === undefined || Math.abs(c.height[a]! - c.height[cellIndex(c, bx, by)]!) <= opts.maxClimb;
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

/** A min-heap of cell indices by their f score. */
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
        const m = r < a.length && this.f[a[r]!]! < this.f[a[l]!]! ? r : l;
        if (this.f[a[m]!]! >= this.f[last]!) break;
        a[k] = a[m]!;
        k = m;
      }
      a[k] = last;
    }
    return top;
  }
}

/** The open cell nearest a cell, within `radius` rings (and `ok`), or null. */
export function nearestWalkable(c: Cells, cx: number, cy: number, radius: number, opts: PathOptions = {}, ok: (x: number, y: number) => boolean = () => true): CellPoint | null {
  for (let r = 0; r <= radius; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (walkable(c, cx + dx, cy + dy, opts) && ok(cx + dx, cy + dy)) return { x: cx + dx, y: cy + dy };
      }
  return null;
}

/**
 * A path from a point to a goal over the cells: A*, eight ways, no corner
 * cut, each cell at its `cost`, no step over `maxClimb`; then straightened
 * where a straight line is clear and no slower. The points to walk through,
 * the last the goal itself. A goal that can't be reached (water, a wall, the
 * middle of a building) gives the way to the reachable cell nearest it. Empty
 * when already there, or shut in.
 */
export function findPath(c: Cells, from: CellPoint, to: CellPoint, opts: PathOptions = {}): CellPoint[] {
  const cost = opts.cost ?? openCost(c);
  const o = { ...opts, cost };
  const sx = Math.floor(from.x);
  const sy = Math.floor(from.y);
  let start = cellIndex(c, sx, sy);
  if (start < 0) return [];
  // standing where it can't (pushed, or something went up there): from the nearest open cell
  if (!walkable(c, sx, sy, o)) {
    const near = nearestWalkable(c, sx, sy, 3, o);
    if (!near) return [];
    start = cellIndex(c, near.x, near.y);
  }
  const n = c.w * c.h;
  const g = new Float64Array(n).fill(Infinity);
  const f = new Float64Array(n);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const tx = Math.min(c.w - 1, Math.max(0, Math.floor(to.x) - c.x0));
  const ty = Math.min(c.h - 1, Math.max(0, Math.floor(to.y) - c.y0));
  const goal = ty * c.w + tx;
  const least = opts.minCost ?? 1;
  const guess = (i: number) => {
    const dx = Math.abs((i % c.w) - tx);
    const dy = Math.abs(Math.floor(i / c.w) - ty);
    return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * least;
  };
  g[start] = 0;
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
    if (h < bestGuess || (h === bestGuess && g[i]! < g[best]!)) {
      best = i;
      bestGuess = h;
    }
    if (i === goal) break;
    const cx = (i % c.w) + c.x0;
    const cy = Math.floor(i / c.w) + c.y0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!canStep(c, cx, cy, nx, ny, o)) continue;
      if (dx && dy && !(walkable(c, cx + dx, cy, o) && walkable(c, cx, cy + dy, o))) continue; // no cutting a corner
      const j = cellIndex(c, nx, ny);
      if (closed[j]) continue;
      const step = g[i]! + ((dx && dy ? Math.SQRT2 : 1) * (cost(i) + cost(j))) / 2;
      if (step >= g[j]!) continue;
      g[j] = step;
      came[j] = i;
      f[j] = step + guess(j);
      open.push(j);
    }
  }
  const cells: number[] = [];
  for (let i = best; i !== -1; i = came[i]!) cells.push(i);
  cells.reverse();
  const pts = cells.map((i) => ({ x: (i % c.w) + c.x0 + 0.5, y: Math.floor(i / c.w) + c.y0 + 0.5 }));
  const costs = cells.map((i) => g[i]!);
  // the goal itself, within its cell (not a goal off the rectangle, clamped to its edge)
  if (best === goal && cellAt(c, to.x, to.y) === goal) pts[pts.length - 1] = { x: to.x, y: to.y };
  pts[0] = { x: from.x, y: from.y };
  // straighten: from each point, on to the furthest one a straight line reaches as quickly
  const out: CellPoint[] = [];
  let a = 0;
  while (a < pts.length - 1) {
    let b = pts.length - 1;
    while (b > a + 1 && !(lineClear(c, pts[a]!, pts[b]!, o) && lineCost(c, pts[a]!, pts[b]!, cost) <= costs[b]! - costs[a]! + 1e-6)) b--;
    out.push(pts[b]!);
    a = b;
  }
  return out;
}

/** Points along a line, a fifth of a cell apart. */
function* along(a: CellPoint, b: CellPoint, per = 5): Generator<CellPoint & { t: number }> {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(len * per));
  for (let k = 0; k <= n; k++) yield { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n, t: k / n };
}

/** Whether a unit can walk a straight line: every cell on it one it may stand on, no corner cut, no step too steep. */
export function lineClear(c: Cells, a: CellPoint, b: CellPoint, opts: PathOptions = {}): boolean {
  let px = Math.floor(a.x);
  let py = Math.floor(a.y);
  for (const p of along(a, b)) {
    const cx = Math.floor(p.x);
    const cy = Math.floor(p.y);
    if (cx === px && cy === py) continue;
    if (cx !== px && cy !== py && !(walkable(c, cx, py, opts) && walkable(c, px, cy, opts))) return false;
    if (!canStep(c, px, py, cx, cy, opts)) return false;
    px = cx;
    py = cy;
  }
  return true;
}

/** A straight line's cost (as `findPath` counts it). */
function lineCost(c: Cells, a: CellPoint, b: CellPoint, cost: (i: number) => number): number {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  let sum = 0;
  let n = 0;
  for (const p of along(a, b)) {
    const i = cellAt(c, p.x, p.y);
    sum += i < 0 ? 1 : cost(i);
    n++;
  }
  return (len * sum) / n;
}

// ---------------------------------------------------------------- seeing

/**
 * Whether an eye sees a point: nothing between them (the ground, a
 * building's top, a canopy: `top`) rises above the straight line from one to
 * the other. The cells the eye and the point are on don't hide (one sees out
 * of woods and into them, and a roof's edge is seen), nor those `ignore`
 * names (the rest of the roof an eye stands on). Heights are absolute
 * (steps), sampled a quarter of a cell apart.
 */
export function lineOfSight(c: Cells, from: CellEye, to: CellEye, ignore?: (i: number) => boolean): boolean {
  const a = cellAt(c, from.x, from.y);
  const b = cellAt(c, to.x, to.y);
  for (const p of along(from, to, 4)) {
    const i = cellAt(c, p.x, p.y);
    if (i < 0 || i === a || i === b || ignore?.(i)) continue;
    if (c.top[i]! > from.h + (to.h - from.h) * p.t) return false;
  }
  return true;
}

export interface ViewshedOptions {
  /** How high over its ground a cell's middle is looked at (steps; default 1: a person's height, about). */
  targetHeight?: number;
  /** Whether the eye can see as far as `dist` cells to cell `i` at all (fog, dark): checked before the line of sight. */
  reach?: (i: number, dist: number) => boolean;
  /** Cells that don't hide what is beyond them from this eye: the roof it stands on, say (every cell of a building it looks out of). */
  ignore?: (i: number) => boolean;
}

/**
 * What an eye sees within `radius` cells: each cell whose middle, at
 * `targetHeight` over its ground, it has a line of sight to. `out` (a value a
 * cell, Infinity where none is seen yet) takes each seen cell's distance
 * from the eye where it is less, so a side's eyes fill one field together
 * and a game can ask how near the nearest eye is (to see into woods, say).
 */
// ponytail: a ray per cell, O(r³) an eye; shadow casting by octants if sides field hundreds of eyes
export function viewshed(c: Cells, eye: CellEye, radius: number, out: Float32Array, opts: ViewshedOptions = {}): void {
  const lift = opts.targetHeight ?? 1;
  const r = Math.ceil(radius);
  const ex = Math.floor(eye.x);
  const ey = Math.floor(eye.y);
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const i = cellIndex(c, ex + dx, ey + dy);
      if (i < 0) continue;
      const x = ex + dx + 0.5;
      const y = ey + dy + 0.5;
      const d = Math.hypot(x - eye.x, y - eye.y);
      if (d > radius || d >= out[i]!) continue;
      if (opts.reach && !opts.reach(i, d)) continue;
      if (lineOfSight(c, eye, { x, y, h: c.height[i]! + lift }, opts.ignore)) out[i] = d;
    }
}
