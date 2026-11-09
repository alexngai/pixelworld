import { NO_WATER, type TerrainGrid } from "@pixelworlds/grid";
import type { ObjectInstance } from "./assets";

/**
 * Decorative scatter (M3): vegetation and rocks the client adds by surface, so
 * every level gets them without storing an instance per tree. Everything is a
 * function of the world cell (hashed), so overlapping tiles agree.
 */
export interface ScatterRule {
  group: string;
  /** Expected objects per cell (objects keep a fixed pixel size, so this reads the same on every level). */
  perCell: number;
}

export interface ScatterRules {
  /** Surface id → rules. */
  bySurface: Record<number, ScatterRule[]>;
  /** Multiplies every rule's density (a level's `depiction.scatter`). */
  density: number;
}

function hash(x: number, y: number, k: number): number {
  let h = Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(k + 1, 0xcb1ab31f);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}
const unit = (h: number) => (h & 0xffffff) / 0x1000000;

/**
 * Scatter instances for cells [x0, x1) × [y0, y1) of `grid` (slice-local
 * cells; `origin` is the slice's world cell). Skips water, roads and paths
 * (and wide paved bands next to them), steep cells, and cells marked in
 * `occupied` (slice-local, row-major), e.g. under buildings.
 */
export function scatterInstances(
  grid: TerrainGrid,
  origin: [number, number],
  rect: { x0: number; y0: number; x1: number; y1: number },
  rules: ScatterRules,
  occupied?: Uint8Array,
): ObjectInstance[] {
  const out: ObjectInstance[] = [];
  const paved = (x: number, y: number) => {
    if (!grid.inBounds(x, y)) return false;
    const i = grid.index(x, y);
    return grid.road[i]! !== 0 || grid.path[i]! !== 0;
  };
  const wideRoadNear = (x: number, y: number) => {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (grid.inBounds(nx, ny) && grid.road[grid.index(nx, ny)]! !== 0 && grid.roadWidth[grid.index(nx, ny)]! > 16) return true;
    }
    return false;
  };
  for (let y = Math.max(0, rect.y0); y < Math.min(grid.height, rect.y1); y++)
    for (let x = Math.max(0, rect.x0); x < Math.min(grid.width, rect.x1); x++) {
      const i = grid.index(x, y);
      const list = rules.bySurface[grid.surface[i]!];
      if (!list || !list.length) continue;
      if (grid.water[i] !== NO_WATER || paved(x, y) || wideRoadNear(x, y)) continue;
      if (occupied?.[i]) continue;
      // no trees on cliffs: a cell whose corners rise more than one step
      const shape = grid.shape[i]!;
      if (((shape | (shape >> 2) | (shape >> 4) | (shape >> 6)) & 2) !== 0) continue;
      const wx = origin[0] + x;
      const wy = origin[1] + y;
      list.forEach((rule, r) => {
        const want = rule.perCell * rules.density;
        let n = Math.floor(want);
        if (unit(hash(wx, wy, 97 + r)) < want - n) n++;
        for (let k = 0; k < n; k++) {
          const h = hash(wx, wy, r * 31 + k);
          out.push({
            g: rule.group,
            x: wx + 0.12 + 0.76 * unit(h),
            y: wy + 0.12 + 0.76 * unit(hash(h, wy, k)),
            s: h & 0x7fffffff,
            r: (h >>> 24) & 3,
          });
        }
      });
    }
  return out;
}

/**
 * Cells (slice-local, row-major) covered by objects the pipeline placed, so
 * scatter leaves them alone: footprints by their bounding box, others by the
 * cell they stand in.
 */
export function occupiedCells(
  instances: ObjectInstance[],
  origin: [number, number],
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  const mark = (x: number, y: number) => {
    const lx = Math.floor(x) - origin[0];
    const ly = Math.floor(y) - origin[1];
    if (lx >= 0 && ly >= 0 && lx < width && ly < height) out[ly * width + lx] = 1;
  };
  for (const o of instances) {
    if (o.fp) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const [x, y] of o.fp) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      for (let y = Math.floor(y0); y <= Math.floor(y1); y++) for (let x = Math.floor(x0); x <= Math.floor(x1); x++) mark(x, y);
    } else mark(o.x, o.y);
  }
  return out;
}
