import { NO_WATER, TerrainGrid } from "@pixelworld/grid";

/**
 * Micro-terrain prepared for the GPU (M1.6): the baker builds the geometry in
 * its vertex shader, one instance per micro-cell, so nothing here grows with
 * the vertex count. Coordinates: micro-cell (mx, my) of the slice covers world
 * cells x ∈ [ox + mx/k, ox + (mx+1)/k).
 */
export interface TerrainField {
  k: number;
  /** World cell of the slice's cell (0, 0). */
  origin: [number, number];
  /** Slice size in cells. */
  width: number;
  height: number;
  /** Drawn corner heights c0..c3 of every micro-cell, in micro-steps (4 per micro-cell, row-major). */
  corners: Int16Array;
  /** Per cell: surface id, road mask, road class | geology << 8, water level (4 per cell). */
  cells: Int16Array;
  /** Per cell: relief reference (1/16 steps) and inverse factor (1/4096), 2 per cell. */
  vmap: Int16Array;
  /** Height (steps) that world-edge skirts reach down to. */
  floor: number;
  /** World size in cells: skirts are drawn only at real world edges. */
  world: { width: number; height: number };
  /**
   * Per edge (0 N, 1 E, 2 S, 3 W): the micro-cells (row-major index) that
   * have a wall on that edge, i.e. stand above their neighbour there or sit at
   * the world edge. The baker draws walls only for these.
   */
  walls: [Int32Array, Int32Array, Int32Array, Int32Array];
}

const EDGE_CORNERS = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
] as const;
const EDGE_NEIGHBOR = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;
const EDGE_NB_CORNERS = [
  [3, 2],
  [0, 3],
  [1, 0],
  [2, 1],
] as const;

export interface TerrainFieldOptions {
  offset?: [number, number];
  world?: { width: number; height: number };
  floor?: number;
}

/** Prepare a grid that has micro-terrain for GPU drawing. */
export function buildTerrainField(grid: TerrainGrid, options: TerrainFieldOptions = {}): TerrainField {
  const m = grid.micro;
  if (!m) throw new Error("buildTerrainField needs a grid with micro-terrain");
  const k = m.k;
  const mw = grid.width * k;
  const mh = grid.height * k;
  const corners = new Int16Array(mw * mh * 4);
  for (let my = 0; my < mh; my++)
    for (let mx = 0; mx < mw; mx++) corners.set(grid.microCorners(mx, my), (my * mw + mx) * 4);
  const [ox, oy] = options.offset ?? [0, 0];
  const world = options.world ?? { width: grid.width, height: grid.height };
  const lists: number[][] = [[], [], [], []];
  for (let my = 0; my < mh; my++)
    for (let mx = 0; mx < mw; mx++) {
      const i = my * mw + mx;
      for (let e = 0; e < 4; e++) {
        const nx = mx + EDGE_NEIGHBOR[e]![0];
        const ny = my + EDGE_NEIGHBOR[e]![1];
        const [ca, cb] = EDGE_CORNERS[e]!;
        if (nx >= 0 && ny >= 0 && nx < mw && ny < mh) {
          const [na, nb] = EDGE_NB_CORNERS[e]!;
          const j = (ny * mw + nx) * 4;
          if (corners[i * 4 + ca]! > corners[j + na]! || corners[i * 4 + cb]! > corners[j + nb]!) lists[e]!.push(i);
        } else {
          const wx = ox * k + nx;
          const wy = oy * k + ny;
          const inWorld = wx >= 0 && wy >= 0 && wx < world.width * k && wy < world.height * k;
          if (!inWorld) lists[e]!.push(i); // world edge: skirt
        }
      }
    }
  const n = grid.width * grid.height;
  const cells = new Int16Array(n * 4);
  const vmap = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    vmap[i * 2] = grid.vref[i]!;
    vmap[i * 2 + 1] = grid.vfac[i]!;
  }
  for (let i = 0; i < n; i++) {
    cells[i * 4] = grid.surface[i]!;
    cells[i * 4 + 1] = grid.road[i]! & 0x0fff; // connections and corner crossings fit in 12 bits
    cells[i * 4 + 2] = grid.roadClass[i]! | (grid.geology[i]! << 8);
    cells[i * 4 + 3] = grid.water[i] ?? NO_WATER;
  }
  return {
    k,
    origin: [ox, oy],
    width: grid.width,
    height: grid.height,
    corners,
    cells,
    vmap,
    floor: options.floor ?? grid.heightRange()[0] - 2,
    world,
    walls: lists.map((l) => Int32Array.from(l)) as TerrainField["walls"],
  };
}

/**
 * Visit the points that bound a field: every micro-cell's four drawn corners,
 * plus skirt bottoms at world edges. fn receives (x, y, h steps, cellX, cellY).
 */
export function forEachFieldPoint(
  f: TerrainField,
  fn: (x: number, y: number, h: number, cx: number, cy: number) => void,
): void {
  const { k } = f;
  const mw = f.width * k;
  const mh = f.height * k;
  const [ox, oy] = f.origin;
  const OFF = [0, 0, 1, 0, 1, 1, 0, 1];
  for (let my = 0; my < mh; my++) {
    const cy = oy + Math.floor(my / k);
    const atEdgeY = (my === 0 && oy === 0) || (my === mh - 1 && oy + f.height === f.world.height);
    for (let mx = 0; mx < mw; mx++) {
      const cx = ox + Math.floor(mx / k);
      const base = (my * mw + mx) * 4;
      for (let c = 0; c < 4; c++)
        fn(ox + (mx + OFF[c * 2]!) / k, oy + (my + OFF[c * 2 + 1]!) / k, f.corners[base + c]! / k, cx, cy);
      const atEdgeX = (mx === 0 && ox === 0) || (mx === mw - 1 && ox + f.width === f.world.width);
      if (atEdgeX || atEdgeY)
        for (let c = 0; c < 4; c++) fn(ox + (mx + OFF[c * 2]!) / k, oy + (my + OFF[c * 2 + 1]!) / k, f.floor, cx, cy);
    }
  }
}
