import type { ObjectInstance } from "@pixelworld/generators";
import type { LandmarkInfo, ObjectHit } from "./types";

/**
 * The world's placed objects for gameplay queries (occupancy): which objects
 * stand at a point, and where the named landmarks are. Built on first use
 * from the objects file, in buckets of cells, so a query looks at a handful
 * of objects.
 *
 * - **Footprints:** a building or landmark with a footprint occupies the
 *   polygon (a point on its edge counts).
 * - **Points:** an object without one (a tree, a tower drawn from its
 *   anchor) occupies its anchor's cell.
 * - **Heights:** the base is where the object is built (its lowest
 *   footprint corner, or its own base); the top is estimated as the bake
 *   draws it: a crest height where the object has one, else its real height
 *   at the object voxel scale and the level's height stretch (D-010,
 *   D-047). Objects without a real height (trees, props, city blocks) have
 *   no top.
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

interface Entry {
  inst: ObjectInstance;
  bounds: [number, number, number, number];
  /** Cached base height (steps), once the terrain under it was loaded. */
  base: number | null;
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

  constructor(
    private readonly instances: readonly ObjectInstance[],
    private readonly world: ObjectIndexWorld,
    /** Whether the style draws a group (objects it doesn't draw aren't there). */
    private readonly drawn: (group: string) => boolean,
    private readonly heightAt: (x: number, y: number) => number | null,
  ) {
    this.cols = Math.ceil(world.cellsX / BUCKET) + 1;
  }

  private build(): Entry[] {
    if (this.entries) return this.entries;
    const entries: Entry[] = [];
    const known = new Map<string, boolean>();
    for (const inst of this.instances) {
      let ok = known.get(inst.g);
      if (ok === undefined) known.set(inst.g, (ok = this.drawn(inst.g)));
      if (!ok) continue;
      const bounds = boundsOf(inst);
      const i = entries.length;
      entries.push({ inst, bounds, base: inst.z0 ?? null });
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

  /** Objects standing at a point: footprints that contain it, footprint-less objects in its cell. */
  at(x: number, y: number): ObjectHit[] {
    const entries = this.build();
    if (x < 0 || y < 0 || x >= this.world.cellsX || y >= this.world.cellsY) return [];
    const list = this.buckets.get(Math.floor(y / BUCKET) * this.cols + Math.floor(x / BUCKET));
    if (!list) return [];
    const out: ObjectHit[] = [];
    for (const i of list) {
      const e = entries[i]!;
      const [x0, y0, x1, y1] = e.bounds;
      if (x < x0 || y < y0 || x > x1 || y > y1) continue;
      if (e.inst.fp?.length) {
        if (!inPolygon(x, y, e.inst.fp)) continue;
      } else if (x >= x1 || y >= y1) continue; // a point object's cell is half-open
      out.push(this.hit(e));
    }
    return out;
  }

  /** Landmarks from the registry (objects with an id), one per id at the middle of its parts' anchors. */
  landmarks(): LandmarkInfo[] {
    if (this.landmarkList) return this.landmarkList;
    // the group is the largest part's (a dam's, not one of its intake towers')
    const byId = new Map<string, { group: string; area: number; sx: number; sy: number; n: number }>();
    for (const e of this.build()) {
      const id = e.inst.id;
      if (!id) continue;
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
    return this.landmarkList;
  }
}
