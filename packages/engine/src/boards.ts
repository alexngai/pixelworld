import { CELL_ROAD, CELL_WATER, cellsOf, isTree, isWall, settleCell, type CellObject, type CellPoint, type Cells, type ReadCellsOptions } from "./cells";
import { cellsArea } from "./edits";
import type { ObjectHit, WorldEdits, WorldInfo, WorldQuery } from "./types";

/**
 * Game boards cut from a world at any resolution (D-148): a grid laid over a
 * rectangle of the map, each of its cells sampled from the world's queries
 * (`samples`² points: the mean ground, the most common surface and road,
 * water and walls where they cover most of it, trees where any stand, and the
 * object covering most of it). A board is `Cells` in its own coordinates
 * (board cell (i, j) is the point (i + ½, j + ½)), so `findPath`,
 * `lineOfSight`, `viewshed` and the rest work on it as they do on
 * `readCells`'s world cells. `Boards` keeps several on one map, overlapping
 * or apart, each sampled again where an edit changes the world under it.
 */

export interface BoardSpec {
  /** The board's corner (world cells). */
  x0: number;
  y0: number;
  /** Its size in board cells. */
  w: number;
  h: number;
  /** World cells across a board cell (default 1): 0.5 halves them, 3 makes a street a cell. */
  cell?: number;
  /** Points sampled along each edge of a board cell (default two a world cell, 1–8). */
  samples?: number;
}

/** A board: `Cells` in board coordinates (`x0`, `y0` 0), with where it lies in the world and more of what each cell holds. */
export interface Board extends Cells {
  /** Board cell (0, 0)'s corner in the world (cells). */
  readonly origin: [number, number];
  /** World cells across a board cell. */
  readonly cell: number;
  readonly samples: number;
  /** The water's level (steps) where it covers most of a cell, else NaN. */
  water: Float32Array;
  /** The placed object covering most of each cell (`ObjectHit.index`, what edits name), or −1; and the share of the cell it covers. */
  object: Int32Array;
  cover: Float32Array;
  /** Metres across a board cell and up a step. */
  readonly metersPerCell: number;
  readonly metersPerStep: number;
}

/** A board cell's world rectangle (cells, half-open). */
export function boardRect(b: Board, i: number): [number, number, number, number] {
  const x = b.origin[0] + (i % b.w) * b.cell;
  const y = b.origin[1] + Math.floor(i / b.w) * b.cell;
  return [x, y, x + b.cell, y + b.cell];
}

/** A world point (cells) in the board's coordinates (board cells), and back. */
export function toBoard(b: Board, x: number, y: number): CellPoint {
  return { x: (x - b.origin[0]) / b.cell, y: (y - b.origin[1]) / b.cell };
}

export function toWorld(b: Board, p: CellPoint): CellPoint {
  return { x: b.origin[0] + p.x * b.cell, y: b.origin[1] + p.y * b.cell };
}

/** The board cell over a world point (its index), or −1 off the board. */
export function boardCellAt(b: Board, x: number, y: number): number {
  const i = Math.floor((x - b.origin[0]) / b.cell);
  const j = Math.floor((y - b.origin[1]) / b.cell);
  return i < 0 || j < 0 || i >= b.w || j >= b.h ? -1 : j * b.w + i;
}

/** The board cells overlapping a world rectangle (cells, half-open). */
export function boardCellsUnder(b: Board, [x0, y0, x1, y1]: readonly [number, number, number, number]): number[] {
  const c = b.cell;
  const out: number[] = [];
  for (let j = Math.max(0, Math.floor((y0 - b.origin[1]) / c)); j < Math.min(b.h, Math.ceil((y1 - b.origin[1]) / c)); j++)
    for (let i = Math.max(0, Math.floor((x0 - b.origin[0]) / c)); i < Math.min(b.w, Math.ceil((x1 - b.origin[0]) / c)); i++) out.push(j * b.w + i);
  return out;
}

/** The board's world rectangle (cells, half-open). */
export function boardBounds(b: Board): [number, number, number, number] {
  return [b.origin[0], b.origin[1], b.origin[0] + b.w * b.cell, b.origin[1] + b.h * b.cell];
}

/** Cells round a board whose ground `Boards.add` loads too: as far as the object index files a landmark from its anchor. */
const REACH = 16;

/**
 * Cut a board from a world's queries (the terrain and objects under it
 * loaded: `query.ensure`, or `Boards.add`). Objects already taken out by
 * edits aren't on it.
 */
export function cutBoard(
  query: Pick<WorldQuery, "heightAt" | "surfaceAt" | "roadAt" | "objectsAt" | "metersPerCellAt">,
  world: Pick<WorldInfo, "manifest">,
  spec: BoardSpec,
  opts: ReadCellsOptions = {},
): Board {
  const cell = spec.cell ?? 1;
  if (!(cell > 0) || !Number.isInteger(spec.w) || !Number.isInteger(spec.h) || spec.w < 1 || spec.h < 1)
    throw new Error(`a board needs a positive cell size and a whole size in cells (got ${spec.w} × ${spec.h} of ${cell})`);
  const n = spec.w * spec.h;
  const b: Board = {
    x0: 0,
    y0: 0,
    w: spec.w,
    h: spec.h,
    origin: [spec.x0, spec.y0],
    cell,
    samples: Math.max(1, Math.min(8, Math.round(spec.samples ?? Math.ceil(cell * 2)))),
    flags: new Uint8Array(n),
    height: new Float32Array(n),
    top: new Float32Array(n),
    surface: new Uint8Array(n),
    roadClass: new Uint8Array(n),
    objects: new Map(),
    water: new Float32Array(n).fill(NaN),
    object: new Int32Array(n).fill(-1),
    cover: new Float32Array(n),
    metersPerCell: query.metersPerCellAt(spec.x0 + (spec.w * cell) / 2, spec.y0 + (spec.h * cell) / 2) * cell,
    metersPerStep: world.manifest.scale.metersPerStep,
  };
  for (let i = 0; i < n; i++) sampleCell(b, query, i, opts);
  return b;
}

/** The most common key of a tally (the lowest on a tie). */
function mode(tally: Map<number, number>): number {
  let best = 0;
  let count = 0;
  for (const [k, c] of tally) if (c > count || (c === count && k < best)) [best, count] = [k, c];
  return best;
}

/**
 * Sample one board cell from the queries. What edits took out stays on its
 * object list (the queries no longer answer for it), so putting it back finds it.
 */
export function sampleCell(
  b: Board,
  query: Pick<WorldQuery, "heightAt" | "surfaceAt" | "roadAt" | "objectsAt">,
  i: number,
  opts: ReadCellsOptions = {},
  removed: (index: number) => boolean = () => false,
): void {
  const wall = opts.wall ?? isWall;
  const trees = opts.trees ?? isTree;
  const tall = opts.defaultHeight ?? 3;
  const n = b.samples;
  const all = n * n;
  const [x0, y0] = boardRect(b, i);
  const surfaces = new Map<number, number>();
  const roads = new Map<number, number>();
  /** Every object on a sample: how many, and the hit. */
  const seen = new Map<number, { count: number; hit: ObjectHit }>();
  /** The tallest on each sample: how many it is tallest on. */
  const tallest = new Map<number, number>();
  let ground = 0;
  let grounds = 0;
  let wet = 0;
  let level = -Infinity;
  for (let v = 0; v < n; v++)
    for (let u = 0; u < n; u++) {
      const x = x0 + ((u + 0.5) / n) * b.cell;
      const y = y0 + ((v + 0.5) / n) * b.cell;
      const g = query.heightAt(x, y);
      if (g !== null) {
        ground += g;
        grounds++;
      }
      const s = query.surfaceAt(x, y);
      if (s) {
        surfaces.set(s.id, (surfaces.get(s.id) ?? 0) + 1);
        if (s.waterLevel !== null) {
          wet++;
          level = Math.max(level, s.waterLevel);
        }
      }
      const road = query.roadAt(x, y);
      if (road) roads.set(road.classId, (roads.get(road.classId) ?? 0) + 1);
      let top: ObjectHit | null = null;
      for (const o of query.objectsAt(x, y)) {
        const e = seen.get(o.index);
        if (e) e.count++;
        else seen.set(o.index, { count: 1, hit: o });
        if (!top || (o.top ?? -Infinity) > (top.top ?? -Infinity)) top = o;
      }
      if (top) tallest.set(top.index, (tallest.get(top.index) ?? 0) + 1);
    }
  const height = grounds ? ground / grounds : 0;
  b.height[i] = height;
  b.surface[i] = mode(surfaces);
  b.water[i] = wet * 2 > all ? level : NaN;
  let roadCount = 0;
  for (const c of roads.values()) roadCount += c;
  const road = roadCount * 2 > all;
  b.roadClass[i] = road ? mode(roads) : 0;
  b.flags[i] = (Number.isNaN(b.water[i]) ? 0 : CELL_WATER) | (road ? CELL_ROAD : 0);
  // walls where they cover most of the cell; trees where any stand
  const on: CellObject[] = (b.objects.get(i) ?? []).filter((o) => removed(o.index));
  for (const { count, hit } of seen.values()) {
    opts.onObject?.(hit, i);
    const w = wall(hit) && count * 2 >= all;
    const t = !wall(hit) && trees(hit);
    if (w || t) on.push({ index: hit.index, wall: w, trees: t, top: hit.top ?? (hit.base ?? height) + tall });
  }
  if (on.length) b.objects.set(i, on);
  else b.objects.delete(i);
  let main = -1;
  let most = 0;
  for (const [index, count] of tallest) if (count > most || (count === most && index < main)) [main, most] = [index, count];
  b.object[i] = main;
  b.cover[i] = most / all;
  settleCell(b, i, removed);
}

/** A world boards are cut from and kept to: a view, or an opened world. */
export interface BoardSource {
  readonly query: WorldQuery;
  readonly edits: Pick<WorldEdits, "isRemoved" | "onChange">;
  readonly world: Pick<WorldInfo, "manifest">;
}

/**
 * The boards on one map (D-148): each cut from the world, and sampled again
 * where an edit changes the world under it (objects taken out or put back,
 * terrain edited), whichever board's game made it. So a fire one board's
 * game spreads, or a tower it fells, shows on every board over that ground.
 */
export class Boards {
  private readonly list: Board[] = [];
  /** Each board's cells by the objects ever sampled on them: where an object taken out or put back is. */
  private readonly where = new Map<Board, Map<number, Set<number>>>();
  private readonly listeners = new Set<(board: Board, cells: number[]) => void>();
  private readonly off: () => void;

  constructor(
    private readonly source: BoardSource,
    private readonly opts: ReadCellsOptions = {},
  ) {
    const removed = (o: number) => source.edits.isRemoved(o);
    this.off = source.edits.onChange((e) => {
      const area = e.op === "cells" ? cellsArea(e.cells) : null;
      for (const b of this.list) {
        const at = new Set(area ? boardCellsUnder(b, area) : []);
        if (e.op !== "cells") {
          const where = this.where.get(b)!;
          for (const o of e.objects) for (const i of where.get(o) ?? []) at.add(i);
          for (const i of cellsOf(b, e.objects)) at.add(i);
        }
        if (!at.size) continue;
        const cells = [...at].sort((p, q) => p - q);
        const read = this.read(this.where.get(b)!);
        for (const i of cells) sampleCell(b, source.query, i, read, removed); // the ground under a board stays loaded
        for (const f of this.listeners) f(b, cells);
      }
    });
  }

  /** The options a board's cells are read with, noting in `where` the cells each object is on. */
  private read(where: Map<number, Set<number>>): ReadCellsOptions {
    return {
      ...this.opts,
      onObject: (o, i) => {
        let set = where.get(o.index);
        if (!set) where.set(o.index, (set = new Set()));
        set.add(i);
        this.opts.onObject?.(o, i);
      },
    };
  }

  /**
   * Cut a board and keep it to the edits. The ground under it is loaded, and
   * round it as far as a building standing on it may reach: an object's top
   * is known once the ground under all its footprint is.
   */
  async add(spec: BoardSpec): Promise<Board> {
    const cell = spec.cell ?? 1;
    const r = REACH;
    await this.source.query.ensure(spec.x0 - r, spec.y0 - r, spec.x0 + spec.w * cell + r, spec.y0 + spec.h * cell + r);
    const where = new Map<number, Set<number>>();
    const b = cutBoard(this.source.query, this.source.world, spec, this.read(where));
    this.where.set(b, where);
    this.list.push(b);
    return b;
  }

  remove(board: Board): void {
    const i = this.list.indexOf(board);
    if (i >= 0) this.list.splice(i, 1);
    this.where.delete(board);
  }

  get boards(): readonly Board[] {
    return this.list;
  }

  /** The boards over a world point (cells): where a unit stepping off one board lands on another. */
  at(x: number, y: number): Board[] {
    return this.list.filter((b) => boardCellAt(b, x, y) >= 0);
  }

  /** Called with a board and the cells (indices) an edit made it sample again. */
  onChange(listener: (board: Board, cells: number[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stop following the world's edits. */
  dispose(): void {
    this.off();
    this.list.length = 0;
    this.where.clear();
    this.listeners.clear();
  }
}
