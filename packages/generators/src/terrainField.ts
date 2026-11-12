import { LANE_DIVIDED, NO_WATER, PIECES, TerrainGrid } from "@pixelworlds/grid";

/** Texels per cell in TerrainField.segs: road, path and rail pieces (D-082, D-097). */
export const SEG_SLOTS = 3 * PIECES;

/** The most cells the decal looks out for a median's two carriageways (M3.5). */
export const MEDIAN_REACH = 3;
/**
 * ways[i * 4 + 2] (the path mask) bits 12-13: how far a cell between a
 * divided road's two carriageways looks out for them (2 or 3 cells; 0 for
 * other cells; flagMedians). NEAR_MEDIAN masks it.
 */
export const NEAR_MEDIAN = 0x3000;
const MEDIAN_SHIFT = 12;

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
  /**
   * Per cell (D-050), everything the road and path decal needs in one texel:
   * road connections | lanes << 8 (the LANE byte, M3.5), road class |
   * half-width << 8, path mask | NEAR_MEDIAN, path class | half-width << 8
   * (half-widths in 1/32 cell, at most 127; 0 = style width).
   */
  ways: Int16Array;
  /**
   * How many cells a road or path can reach beyond its own (the widest
   * half-width, rounded up), so the shader knows how far to look; cells
   * flagged NEAR_MEDIAN look MEDIAN_REACH out. 0 when the world has no real
   * widths: roads keep the style's fixed in-cell decal.
   */
  wayReach: number;
  /**
   * Per cell (M3.5): rails drawn in the street, connections in bits 0-7 and
   * what is drawn in bits 12-15 (RAIL_STREET, RAIL_CABLE, RAIL_TRAIN); a rail
   * corridor's track count less one in bits 8-10 and RAIL_NEAR (D-097).
   */
  rails: Int16Array;
  /**
   * Centre lines (D-082): per cell SEG_SLOTS RGBA8 texels, its road pieces,
   * then its path pieces, then its rail corridors' (D-097) (x0, y0, x1, y1 in
   * 1/255 cell; empty slots last and zero), as a (SEG_SLOTS·width) × height
   * texture; null when the grid has none.
   */
  segs: Uint8Array | null;
  /** Height (steps) that world-edge skirts reach down to. */
  floor: number;
  /** World size in cells: skirts are drawn only at real world edges. */
  world: { width: number; height: number };
  /**
   * Water is drawn as planes at its levels over shaped shores (D-094):
   * packages whose manifest says micro.shores. Without it, water cells are
   * flat at their level and drawn as their tops.
   */
  shores: boolean;
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
  /** TerrainField.shores (default false). */
  shores?: boolean;
}

const DIRS8 = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
] as const;

/**
 * Flag the cells between a divided road's two carriageways (NEAR_MEDIAN in
 * the path mask), with a cell's margin, so only they pay for the decal's
 * longer look for a median (M3.5): from each carriageway cell, across its
 * road, up to twice MEDIAN_REACH cells to the next carriageway cell.
 */
function flagMedians(grid: TerrainGrid, ways: Int16Array, divided: number[]): void {
  const w = grid.width;
  const h = grid.height;
  const isDivided = new Uint8Array(w * h);
  for (const i of divided) isDivided[i] = 1;
  const flag = (x: number, y: number, reach: number) => {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = (ny * w + nx) * 4 + 2;
        const had = (ways[j]! & NEAR_MEDIAN) >> MEDIAN_SHIFT;
        if (reach > had) ways[j] = (ways[j]! & ~NEAR_MEDIAN) | (reach << MEDIAN_SHIFT);
      }
  };
  for (const i of divided) {
    const x = i % w;
    const y = (i - x) / w;
    const m = grid.road[i]! & 0xff;
    const along = DIRS8.findIndex((_, d) => ((m >> d) & 1) === 1);
    if (along < 0) continue;
    // across the road: the directions a quarter turn either side of it
    for (const turn of [2, 6]) {
      const [dx, dy] = DIRS8[(along + turn) % 8]!;
      for (let s = 1; s <= 2 * MEDIAN_REACH; s++) {
        const nx = x + dx * s;
        const ny = y + dy * s;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) break;
        if (!isDivided[ny * w + nx]) continue;
        // neighbouring carriageways are found from anywhere between them two cells out
        for (let t = 0; t <= s; t++) flag(x + dx * t, y + dy * t, Math.min(s + 1, MEDIAN_REACH));
        break;
      }
    }
  }
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
  const ways = new Int16Array(n * 4);
  let widest = 0;
  const divided: number[] = [];
  for (let i = 0; i < n; i++) {
    const rw = Math.min(127, grid.roadWidth[i]!);
    const pw = Math.min(127, grid.pathWidth[i]!);
    // the decal needs a road's connections only, so its lanes take the high byte
    const lane = rw > 0 ? grid.lane[i]! : 0;
    ways[i * 4] = (grid.road[i]! & 0xff) | (lane << 8);
    ways[i * 4 + 1] = grid.roadClass[i]! | (rw << 8);
    ways[i * 4 + 2] = grid.path[i]! & 0x0fff;
    ways[i * 4 + 3] = grid.pathClass[i]! | (pw << 8);
    widest = Math.max(widest, rw, pw);
    if (lane & LANE_DIVIDED) divided.push(i);
  }
  flagMedians(grid, ways, divided);
  for (let i = 0; i < n; i++) {
    vmap[i * 2] = grid.vref[i]!;
    vmap[i * 2 + 1] = grid.vfac[i]!;
  }
  const rails = new Int16Array(n);
  for (let i = 0; i < n; i++) rails[i] = grid.rail[i]! & 0x7fff;
  let segs: Uint8Array | null = null;
  if (grid.roadSeg.some((v) => v !== 0) || grid.pathSeg.some((v) => v !== 0) || grid.railSeg.some((v) => v !== 0)) {
    const words = new Uint32Array(n * SEG_SLOTS); // little-endian: the bytes are x0, y0, x1, y1
    for (let i = 0; i < n; i++)
      for (let k = 0; k < PIECES; k++) {
        words[i * SEG_SLOTS + k] = grid.roadSeg[i * PIECES + k]!;
        words[i * SEG_SLOTS + PIECES + k] = grid.pathSeg[i * PIECES + k]!;
        words[i * SEG_SLOTS + 2 * PIECES + k] = grid.railSeg[i * PIECES + k]!;
      }
    segs = new Uint8Array(words.buffer);
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
    ways,
    wayReach: widest > 0 ? Math.ceil(widest / 32) : 0,
    rails,
    segs,
    floor: options.floor ?? grid.heightRange()[0] - 2,
    world,
    shores: options.shores ?? false,
    walls: lists.map((l) => Int32Array.from(l)) as TerrainField["walls"],
  };
}

/**
 * Visit the points that bound a field: every micro-cell's four drawn corners,
 * skirt bottoms at world edges, and the corners of water cells at their level
 * (the water plane, D-094). fn receives (x, y, h steps, cellX, cellY).
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
  // the planes over a water cell's neighbours stand at a water cell's level too
  if (!f.shores) return;
  for (let y = 0; y < f.height; y++)
    for (let x = 0; x < f.width; x++) {
      const level = f.cells[(y * f.width + x) * 4 + 3]!;
      if (level === NO_WATER) continue;
      for (let c = 0; c < 4; c++) fn(ox + x + OFF[c * 2]!, oy + y + OFF[c * 2 + 1]!, level, ox + x, oy + y);
    }
}
