import {
  CORNER_OFFSETS,
  EDGE_CORNERS,
  EDGE_NEIGHBOR,
  EDGE_NEIGHBOR_CORNERS,
  EDGE_NORMAL,
  STEP_WORLD,
  TerrainGrid,
  splitDiagonal,
} from "@pixelworld/grid";
import { FACE_CLIFF, FACE_SKIRT, FACE_SLOPE, FACE_TOP, MeshBuilder, triangleNormal, type MeshData } from "./mesh";

export interface CellRect {
  x0: number;
  y0: number;
  x1: number; // exclusive
  y1: number; // exclusive
}

export interface TerrainMeshOptions {
  /** Height (steps) that world-edge skirts extend down to. Defaults to min height − 2. */
  floor?: number;
  /** Ambient-occlusion sample radius in cells. */
  aoRadius?: number;
}

type V3 = [number, number, number];

/**
 * Terrain mesh for the cells in `rect` (clipped to the grid): top triangles,
 * cliff faces owned by the higher side of each edge, and skirts down to a
 * floor at the world edge (diorama cross-section).
 */
export function buildTerrainMesh(
  grid: TerrainGrid,
  rect: CellRect,
  options: TerrainMeshOptions = {},
): MeshData {
  const floor = options.floor ?? grid.heightRange()[0] - 2;
  const ao = new AoSampler(grid, options.aoRadius ?? 3);
  const mb = new MeshBuilder();
  const x0 = Math.max(0, rect.x0);
  const y0 = Math.max(0, rect.y0);
  const x1 = Math.min(grid.width, rect.x1);
  const y1 = Math.min(grid.height, rect.y1);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = grid.index(x, y);
      const slope = grid.slope[i]!;
      const surface = grid.surface[i]!;
      const h = grid.corners(x, y);
      const p: V3[] = CORNER_OFFSETS.map(([dx, dy], k) => [x + dx, y + dy, h[k]!]);
      const kind = slope === 0 ? FACE_TOP : FACE_SLOPE;
      const tris: [number, number, number][] =
        splitDiagonal(slope) === 0
          ? [
              [0, 1, 2],
              [0, 2, 3],
            ]
          : [
              [0, 1, 3],
              [1, 2, 3],
            ];
      for (const [a, b, c] of tris) {
        const n = triangleNormal(p[a]!, p[b]!, p[c]!, STEP_WORLD, [0, 0, 1]);
        for (const k of [a, b, c]) mb.vertex(p[k]!, n, surface, kind, ao.at(p[k]!), x, y);
      }

      for (let e = 0; e < 4; e++) {
        const [ca, cb] = EDGE_CORNERS[e]!;
        const [nx, ny] = EDGE_NEIGHBOR[e]!;
        const hasNeighbor = grid.inBounds(x + nx, y + ny);
        let ba: number;
        let bb: number;
        if (hasNeighbor) {
          const [na, nb] = EDGE_NEIGHBOR_CORNERS[e]!;
          ba = grid.cornerHeight(x + nx, y + ny, na);
          bb = grid.cornerHeight(x + nx, y + ny, nb);
        } else {
          ba = floor;
          bb = floor;
        }
        const ta = h[ca]!;
        const tb = h[cb]!;
        const [ox, oy] = EDGE_NORMAL[e]!;
        const normal: V3 = [ox, oy, 0];
        const faceKind = hasNeighbor ? FACE_CLIFF : FACE_SKIRT;
        const pa = p[ca]!;
        const pb = p[cb]!;
        const emit = (tri: V3[]) => {
          for (const v of tri) mb.vertex(v, normal, surface, faceKind, ao.at(v), x, y);
        };
        const da = ta - ba;
        const db = tb - bb;
        if (da >= 0 && db >= 0) {
          if (da === 0 && db === 0) continue;
          const topA: V3 = [pa[0], pa[1], ta];
          const topB: V3 = [pb[0], pb[1], tb];
          const botA: V3 = [pa[0], pa[1], ba];
          const botB: V3 = [pb[0], pb[1], bb];
          if (da > 0) emit([topA, topB, botA]);
          if (db > 0) emit([topB, botB, botA]);
        } else if (da > 0 || db > 0) {
          // Edges cross: emit only the part where this side is higher.
          const f = da / (da - db); // where the height difference reaches 0
          const cx = pa[0] + (pb[0] - pa[0]) * f;
          const cy = pa[1] + (pb[1] - pa[1]) * f;
          const ch = ta + (tb - ta) * f;
          if (da > 0) emit([[pa[0], pa[1], ta], [cx, cy, ch], [pa[0], pa[1], ba]]);
          else emit([[pb[0], pb[1], tb], [pb[0], pb[1], bb], [cx, cy, ch]]);
        }
      }
    }
  }
  return mb.build();
}

/**
 * Per-vertex ambient occlusion from the terrain surface: average sine of the
 * horizon angle over 8 directions. 1 = open sky, lower = more occluded.
 */
export class AoSampler {
  private cache = new Map<number, number>();
  private static readonly DIRS: readonly [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [Math.SQRT1_2, Math.SQRT1_2],
    [-Math.SQRT1_2, Math.SQRT1_2],
    [Math.SQRT1_2, -Math.SQRT1_2],
    [-Math.SQRT1_2, -Math.SQRT1_2],
  ];

  constructor(
    private readonly grid: TerrainGrid,
    private readonly radius: number,
  ) {}

  at(p: readonly [number, number, number]): number {
    const key = (Math.round(p[1] * 4) * 4099 + Math.round(p[0] * 4)) * 2048 + Math.round(p[2] * 4);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const v = this.compute(p[0], p[1], p[2]);
    this.cache.set(key, v);
    return v;
  }

  private compute(x: number, y: number, h: number): number {
    const g = this.grid;
    let sum = 0;
    for (const [dx, dy] of AoSampler.DIRS) {
      let best = 0;
      for (const d of [0.5, 1, 2, this.radius]) {
        const qx = x + dx * d;
        const qy = y + dy * d;
        if (qx < 0 || qy < 0 || qx > g.width || qy > g.height) continue;
        const rise = (g.surfaceHeightAt(qx, qy) - h) * STEP_WORLD;
        if (rise > 0) best = Math.max(best, rise / d);
      }
      sum += best / Math.sqrt(1 + best * best);
    }
    return 1 - sum / AoSampler.DIRS.length;
  }
}
