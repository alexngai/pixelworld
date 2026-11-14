import {
  generateModel,
  objectVoxelScale,
  rotateModel,
  type AssetCatalog,
  type ObjectInstance,
  type VoxelModel,
} from "@pixelworlds/generators";
import type { LandmarkInfo, ObjectHit, WorldEdits } from "./types";

/**
 * The world's placed objects for gameplay queries (occupancy): which objects
 * stand at a point, and where the named landmarks are. Built on first use
 * from the objects file, in buckets of cells, so a query looks at a handful
 * of objects.
 *
 * - **Footprints:** a building or landmark with a footprint occupies the
 *   polygon (a point on its edge counts).
 * - **Landmarks drawn from an anchor** (City Hall, a tower): where their
 *   model stands, in plan (the voxel columns it fills, D-073), when the
 *   index is given a `plan` for them; else their anchor's cell.
 * - **Points:** another object without a footprint (a tree, a prop)
 *   occupies its anchor's cell.
 * - **Heights:** the base is where the object is built (its lowest
 *   footprint corner, or its own base); the top is estimated as the bake
 *   draws it: a crest height where the object has one, else its real height
 *   at the object voxel scale and the level's height stretch (D-010,
 *   D-047). Objects without a real height (trees, props, city blocks) have
 *   no top.
 * - **Edits:** an object taken out of the world (`WorldEdits`, D-124) isn't
 *   there for any query until it is put back.
 */

const BUCKET = 8; // cells per bucket edge

export interface ObjectIndexWorld {
  cellsX: number;
  cellsY: number;
  /** Real metres per cell (objects on warped worlds carry their own). */
  metersPerCell: number;
  /** The level's object height stretch (D-047). */
  heightStretch: number;
}

/**
 * How far (cells) a landmark drawn from its anchor may reach: it is filed
 * this far around its anchor, and its model's plan is worked out when a
 * query first comes this close.
 */
const PLAN_REACH = 16;

interface Entry {
  /** Its place in the objects file. */
  index: number;
  inst: ObjectInstance;
  bounds: [number, number, number, number];
  /** Where its model stands, for a landmark drawn from its anchor; undefined until a query comes near. */
  plan: ModelPlan | null | undefined;
  /** Cached base height (steps), once the terrain under it was loaded. */
  base: number | null;
}

/** Where a model drawn from an anchor stands, in plan: the columns its voxels fill. */
export interface ModelPlan {
  /** Bounds of the filled columns (cells) [x0, y0, x1, y1]. */
  bounds: [number, number, number, number];
  /** The model's corner (cells), its columns along x and y and their size (cells). */
  x0: number;
  y0: number;
  sx: number;
  sy: number;
  cell: number;
  /** Whether each column (row-major from the corner) has a voxel. */
  filled: Uint8Array;
}

/** The plan of a voxel model drawn centred on an anchor (cells), its voxels `cell` cells across. */
export function modelPlan(model: VoxelModel, x: number, y: number, cell: number): ModelPlan {
  const { sx, sy, data } = model;
  const filled = new Uint8Array(sx * sy);
  for (let i = 0; i < data.length; i++) if (data[i]) filled[i % (sx * sy)] = 1;
  const x0 = x - (sx * cell) / 2;
  const y0 = y - (sy * cell) / 2;
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (let j = 0; j < sy; j++)
    for (let i = 0; i < sx; i++) {
      if (!filled[j * sx + i]) continue;
      bx0 = Math.min(bx0, i);
      by0 = Math.min(by0, j);
      bx1 = Math.max(bx1, i + 1);
      by1 = Math.max(by1, j + 1);
    }
  const bounds: [number, number, number, number] =
    bx0 === Infinity ? [x, y, x, y] : [x0 + bx0 * cell, y0 + by0 * cell, x0 + bx1 * cell, y0 + by1 * cell];
  return { bounds, x0, y0, sx, sy, cell, filled };
}

/** Whether a model's plan covers a point (cells). */
function inPlan(p: ModelPlan, x: number, y: number): boolean {
  const i = Math.floor((x - p.x0) / p.cell);
  const j = Math.floor((y - p.y0) / p.cell);
  return i >= 0 && j >= 0 && i < p.sx && j < p.sy && p.filled[j * p.sx + i] === 1;
}

/** What it takes to generate a landmark's model as the bake does (`landmarkPlan`). */
export interface PlanSource {
  catalog: AssetCatalog;
  rampIds: Map<string, number>;
  renderScale: number;
  /** Real metres per cell and the level's object height stretch (D-047). */
  metersPerCell: number;
  heightStretch: number;
}

/**
 * Where a registry landmark drawn from its anchor (no footprint) stands:
 * its model generated as the bake generates it (seed, height, quarter
 * turns), in plan. Null for other objects, or where the model can't be
 * generated here (a generator from a plugin the page didn't load).
 */
export function landmarkPlan(inst: ObjectInstance, src: PlanSource): ModelPlan | null {
  if (inst.fp?.length || !inst.id || (inst.hm === undefined && inst.top === undefined)) return null;
  const voxel = objectVoxelScale(src.renderScale);
  let heightVox: number | undefined;
  if (inst.hm !== undefined) heightVox = (inst.hm / (voxel.h * (inst.m ?? src.metersPerCell))) * src.heightStretch;
  else if (inst.top !== undefined && inst.z0 !== undefined) heightVox = Math.max(1, (inst.top - inst.z0) / voxel.v);
  const hints =
    inst.rs || inst.fm || inst.fr !== undefined || inst.fl !== undefined
      ? { roof: inst.rs, facade: inst.fm, front: inst.fr, corner: inst.cn === 1, year: inst.yr, floors: inst.fl }
      : undefined;
  try {
    const model = generateModel(src.catalog, src.rampIds, inst.g, { seed: inst.s, heightVox, hints });
    return modelPlan(inst.r ? rotateModel(model, inst.r) : model, inst.x, inst.y, voxel.h);
  } catch {
    return null;
  }
}

function boundsOf(inst: ObjectInstance): [number, number, number, number] {
  if (!inst.fp?.length) {
    const cx = Math.floor(inst.x);
    const cy = Math.floor(inst.y);
    return [cx, cy, cx + 1, cy + 1];
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of inst.fp) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

/** Whether a point is inside a polygon or on its edge (even-odd rule). */
export function inPolygon(px: number, py: number, fp: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let a = 0, b = fp.length - 1; a < fp.length; b = a++) {
    const [xa, ya] = fp[a]!;
    const [xb, yb] = fp[b]!;
    // on the edge
    const cross = (xb - xa) * (py - ya) - (yb - ya) * (px - xa);
    if (
      Math.abs(cross) < 1e-9 &&
      px >= Math.min(xa, xb) - 1e-9 &&
      px <= Math.max(xa, xb) + 1e-9 &&
      py >= Math.min(ya, yb) - 1e-9 &&
      py <= Math.max(ya, yb) + 1e-9
    )
      return true;
    if (ya > py !== yb > py && px < ((xb - xa) * (py - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}

export class ObjectIndex {
  private entries: Entry[] | null = null;
  private readonly buckets = new Map<number, number[]>();
  private readonly cols: number;
  private landmarkList: LandmarkInfo[] | null = null;
  /** The edits' version the landmarks were listed at. */
  private landmarkVersion = 0;
  private reach: { ground: number; top: number } | null = null;

  constructor(
    private readonly instances: readonly ObjectInstance[],
    private readonly world: ObjectIndexWorld,
    /** Whether the style draws a group (objects it doesn't draw aren't there). */
    private readonly drawn: (group: string) => boolean,
    private readonly heightAt: (x: number, y: number) => number | null,
    /** Where a landmark drawn from its anchor stands (`landmarkPlan`), or null for its anchor's cell. */
    private readonly plan: (inst: ObjectInstance) => ModelPlan | null = () => null,
    /** Objects taken out of the world (D-124). */
    private readonly edits: Pick<WorldEdits, "isRemoved" | "version"> | null = null,
    /** Whether `instances` is the whole objects file, so each one's place in it names it (`ObjectHit.index`); a chunk's file (D-123) isn't, and its hits say −1. */
    private readonly named = true,
  ) {
    this.cols = Math.ceil(world.cellsX / BUCKET) + 1;
  }

  private build(): Entry[] {
    if (this.entries) return this.entries;
    const entries: Entry[] = [];
    const known = new Map<string, boolean>();
    for (const [index, inst] of this.instances.entries()) {
      let ok = known.get(inst.g);
      if (ok === undefined) known.set(inst.g, (ok = this.drawn(inst.g)));
      if (!ok) continue;
      // a landmark drawn from its anchor: filed around it, its model generated when a query comes near
      const reaches = !inst.fp?.length && !!inst.id;
      const r = PLAN_REACH;
      const bounds: [number, number, number, number] = reaches ? [inst.x - r, inst.y - r, inst.x + r, inst.y + r] : boundsOf(inst);
      const i = entries.length;
      entries.push({ index: this.named ? index : -1, inst, bounds, plan: reaches ? undefined : null, base: inst.z0 ?? null });
      const bx0 = Math.max(0, Math.floor(bounds[0] / BUCKET));
      const by0 = Math.max(0, Math.floor(bounds[1] / BUCKET));
      const bx1 = Math.max(bx0, Math.floor(Math.min(bounds[2], this.world.cellsX) / BUCKET));
      const by1 = Math.max(by0, Math.floor(Math.min(bounds[3], this.world.cellsY) / BUCKET));
      for (let by = by0; by <= by1; by++)
        for (let bx = bx0; bx <= bx1; bx++) {
          const key = by * this.cols + bx;
          let list = this.buckets.get(key);
          if (!list) this.buckets.set(key, (list = []));
          list.push(i);
        }
    }
    this.entries = entries;
    return entries;
  }

  private base(e: Entry): number | null {
    if (e.base !== null) return e.base;
    const pts = e.inst.fp?.length ? e.inst.fp : [[e.inst.x, e.inst.y] as [number, number]];
    let lo = Infinity;
    for (const [x, y] of pts) {
      // a footprint corner on the world's far edge reads the last cell
      const h = this.heightAt(Math.min(x, this.world.cellsX - 1e-6), Math.min(y, this.world.cellsY - 1e-6));
      if (h === null) return null;
      lo = Math.min(lo, h);
    }
    e.base = lo;
    return lo;
  }

  private hit(e: Entry): ObjectHit {
    const inst = e.inst;
    const base = this.base(e);
    let top: number | null = null;
    if (inst.top !== undefined) top = inst.top;
    else if (inst.hm !== undefined && base !== null) {
      const m = inst.m ?? this.world.metersPerCell;
      // object voxels are 1/16 cell across and 1/8 step tall (D-010)
      top = base + (2 * inst.hm * this.world.heightStretch) / m;
    }
    return {
      index: e.index,
      group: inst.g,
      id: inst.id ?? null,
      x: inst.x,
      y: inst.y,
      bounds: [...e.bounds],
      footprint: !!inst.fp?.length,
      base,
      top,
    };
  }

  /** Objects standing at a point: footprints that contain it, landmarks' plans, other footprint-less objects in its cell. */
  at(x: number, y: number): ObjectHit[] {
    const entries = this.build();
    if (x < 0 || y < 0 || x >= this.world.cellsX || y >= this.world.cellsY) return [];
    const list = this.buckets.get(Math.floor(y / BUCKET) * this.cols + Math.floor(x / BUCKET));
    if (!list) return [];
    const out: ObjectHit[] = [];
    for (const i of list) {
      const e = entries[i]!;
      if (this.edits?.isRemoved(e.index)) continue;
      if (e.plan === undefined) {
        const [x0, y0, x1, y1] = e.bounds;
        if (x < x0 || y < y0 || x > x1 || y > y1) continue;
        e.plan = this.plan(e.inst);
        e.bounds = e.plan ? e.plan.bounds : boundsOf(e.inst);
      }
      const [x0, y0, x1, y1] = e.bounds;
      if (x < x0 || y < y0 || x > x1 || y > y1) continue;
      if (e.inst.fp?.length) {
        if (!inPolygon(x, y, e.inst.fp)) continue;
      } else if (e.plan) {
        if (!inPlan(e.plan, x, y)) continue;
      } else if (x >= x1 || y >= y1) continue; // a point object's cell is half-open
      out.push(this.hit(e));
    }
    return out;
  }

  /** Landmarks from the registry (objects with an id), one per id at the middle of its parts' anchors. */
  landmarks(): LandmarkInfo[] {
    const version = this.edits?.version ?? 0;
    if (this.landmarkList && this.landmarkVersion === version) return this.landmarkList;
    // the group is the largest part's (a dam's, not one of its intake towers')
    const byId = new Map<string, { group: string; area: number; sx: number; sy: number; n: number }>();
    for (const e of this.build()) {
      const id = e.inst.id;
      if (!id || this.edits?.isRemoved(e.index)) continue;
      const [x0, y0, x1, y1] = e.bounds;
      const area = e.inst.fp?.length ? (x1 - x0) * (y1 - y0) : 0;
      const l = byId.get(id);
      if (l) {
        l.sx += e.inst.x;
        l.sy += e.inst.y;
        l.n++;
        if (area > l.area) {
          l.area = area;
          l.group = e.inst.g;
        }
      } else byId.set(id, { group: e.inst.g, area, sx: e.inst.x, sy: e.inst.y, n: 1 });
    }
    this.landmarkList = [...byId].map(([id, l]) => ({ id, group: l.group, x: l.sx / l.n, y: l.sy / l.n, parts: l.n }));
    this.landmarkVersion = version;
    return this.landmarkList;
  }

  /**
   * The highest an object reaches (steps) where the ground is no higher than
   * `ground`: its crest, or its real height over that ground, as `hit`
   * estimates them. Where a march down a view ray may start.
   */
  highest(ground: number): number {
    if (this.reach?.ground === ground) return this.reach.top;
    let top = ground;
    for (const { inst } of this.build()) {
      if (inst.top !== undefined) top = Math.max(top, inst.top);
      else if (inst.hm !== undefined) top = Math.max(top, (inst.z0 ?? ground) + (2 * inst.hm * this.world.heightStretch) / (inst.m ?? this.world.metersPerCell));
    }
    this.reach = { ground, top };
    return top;
  }
}

/**
 * Placed objects by chunk (D-123), for a world that holds part of itself at a
 * time: each chunk's own index over its own file, made on its first query and
 * let go with its terrain, and the landmarks' kept whole. A chunk's file holds
 * everything without a landmark id that touches it, so a point's chunk alone
 * answers what stands there.
 */
export class ChunkedObjects {
  private readonly indexes = new WeakMap<object, ObjectIndex>();

  constructor(
    private readonly landmarkIndex: ObjectIndex,
    /** The instances of the chunk holding a cell: null where it has none, undefined where it isn't loaded. */
    private readonly ofChunk: (x: number, y: number) => { instances: ObjectInstance[] } | null | undefined,
    private readonly index: (instances: readonly ObjectInstance[]) => ObjectIndex,
  ) {}

  at(x: number, y: number): ObjectHit[] {
    const file = this.ofChunk(x, y);
    const marks = this.landmarkIndex.at(x, y);
    if (!file) return marks;
    let idx = this.indexes.get(file);
    if (!idx) this.indexes.set(file, (idx = this.index(file.instances)));
    return [...marks, ...idx.at(x, y)];
  }

  landmarks(): LandmarkInfo[] {
    return this.landmarkIndex.landmarks();
  }

  /** The landmarks' highest only: objects come by chunk only on a server (D-123), where nothing picks along a view ray (D-124). */
  highest(ground: number): number {
    return this.landmarkIndex.highest(ground);
  }
}
