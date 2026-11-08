/**
 * Cell terrain model (RCT-style). See docs/architecture.md §3.3.
 *
 * Each cell has a base height (steps) and a shape: the height of each of its
 * four corners above the base, 0..MAX_CORNER_OFFSET steps, packed two bits per
 * corner (corner i in bits 2i..2i+1). The base is the lowest corner, so at
 * least one offset is 0. Corners, in grid space:
 *
 *   c0 = (x,   y)    north-west
 *   c1 = (x+1, y)    north-east
 *   c2 = (x+1, y+1)  south-east
 *   c3 = (x,   y+1)  south-west
 *
 * Neighbouring cells normally share corner heights, giving continuous slopes.
 * Where they disagree along a shared edge, the edge renders as a vertical
 * cliff face owned by the higher side.
 *
 * Offsets up to 3 keep edges on clean pixel angles: a cell edge rising 1, 2 or
 * 3 steps projects to a horizontal, 2:1 or 1:1 screen line.
 */

export const CORNER_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/** Edges: 0 north (c0→c1), 1 east (c1→c2), 2 south (c2→c3), 3 west (c3→c0). */
export const EDGE_CORNERS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
];

/** Neighbour offset across each edge. */
export const EDGE_NEIGHBOR: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** For corner k of edge e, the matching corner index in the neighbour cell. */
export const EDGE_NEIGHBOR_CORNERS: readonly (readonly [number, number])[] = [
  [3, 2], // north edge c0,c1 ↔ neighbour's c3,c2
  [0, 3], // east  edge c1,c2 ↔ neighbour's c0,c3
  [1, 0], // south edge c2,c3 ↔ neighbour's c1,c0
  [2, 1], // west  edge c3,c0 ↔ neighbour's c2,c1
];

/** Outward horizontal normal of each edge in grid space. */
export const EDGE_NORMAL: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/**
 * Road network layer (u16 per cell). Bits 0–7: the cell's road connects to the
 * neighbour in direction ROAD_DIRS[i]. Bits 8–11: a diagonal road between two
 * other cells passes through corner i of this cell (so the road strip can be
 * drawn across the corner without gaps).
 */
export const ROAD_DIRS: readonly (readonly [number, number])[] = [
  [0, -1], // 0 N
  [1, -1], // 1 NE
  [1, 0], // 2 E
  [1, 1], // 3 SE
  [0, 1], // 4 S
  [-1, 1], // 5 SW
  [-1, 0], // 6 W
  [-1, -1], // 7 NW
];
export const ROAD_CROSSING_SHIFT = 8;

export function roadConnects(mask: number, dir: number): boolean {
  return ((mask >> dir) & 1) === 1;
}

export function roadCrossesCorner(mask: number, corner: number): boolean {
  return ((mask >> (ROAD_CROSSING_SHIFT + corner)) & 1) === 1;
}

/** Direction index from (dx, dy) in −1..1, or −1 for (0, 0). */
export function roadDirIndex(dx: number, dy: number): number {
  return ROAD_DIRS.findIndex(([x, y]) => x === dx && y === dy);
}

/** Largest corner offset a shape can encode (2 bits per corner). */
export const MAX_CORNER_OFFSET = 3;
/** Sentinel for "no water" in the water layer. */
export const NO_WATER = -32768;

export type Corners = [number, number, number, number];

export function cornerOffset(shape: number, corner: number): number {
  return (shape >> (2 * corner)) & 3;
}

export function packShape(o0: number, o1: number, o2: number, o3: number): number {
  return (o0 & 3) | ((o1 & 3) << 2) | ((o2 & 3) << 4) | ((o3 & 3) << 6);
}

/** A shape is valid when it is a byte and its lowest corner offset is 0. */
export function isValidShape(shape: number): boolean {
  if (!Number.isInteger(shape) || shape < 0 || shape > 255) return false;
  return Math.min(
    cornerOffset(shape, 0),
    cornerOffset(shape, 1),
    cornerOffset(shape, 2),
    cornerOffset(shape, 3),
  ) === 0;
}

/** Largest corner offset of a shape (0 = flat). */
export function shapeRise(shape: number): number {
  return Math.max(
    cornerOffset(shape, 0),
    cornerOffset(shape, 1),
    cornerOffset(shape, 2),
    cornerOffset(shape, 3),
  );
}

export function cornerHeights(base: number, shape: number): Corners {
  return [
    base + cornerOffset(shape, 0),
    base + cornerOffset(shape, 1),
    base + cornerOffset(shape, 2),
    base + cornerOffset(shape, 3),
  ];
}

/**
 * Encode four integer corner heights as base + shape, or null when they span
 * more than `maxOffset` steps (not representable as one sloped cell).
 */
export function shapeFromCorners(
  corners: readonly [number, number, number, number],
  maxOffset = MAX_CORNER_OFFSET,
): { base: number; shape: number } | null {
  const lo = Math.min(...corners);
  const hi = Math.max(...corners);
  if (hi - lo > Math.min(maxOffset, MAX_CORNER_OFFSET)) return null;
  return {
    base: lo,
    shape: packShape(corners[0] - lo, corners[1] - lo, corners[2] - lo, corners[3] - lo),
  };
}

/** Convert a v0 slope mask (bit i = corner i raised one step) to a shape. */
export function shapeFromV0Mask(mask: number): number {
  return packShape(mask & 1, (mask >> 1) & 1, (mask >> 2) & 1, (mask >> 3) & 1);
}

/**
 * Which diagonal splits the cell's top into two triangles: 0 = c0–c2, 1 = c1–c3.
 * Split along the diagonal whose ends differ least, so the fold follows the
 * terrain (with one odd corner this keeps the other triangle flat, the RCT
 * look). On a tie, split through the higher pair (a ridge), else c0–c2.
 */
export function splitDiagonal(h: readonly [number, number, number, number]): 0 | 1 {
  const d02 = Math.abs(h[0] - h[2]);
  const d13 = Math.abs(h[1] - h[3]);
  if (d02 !== d13) return d02 < d13 ? 0 : 1;
  return h[1] + h[3] > h[0] + h[2] ? 1 : 0;
}

/**
 * Height on a cell's top at fractional position (fx, fy) in [0, 1]², following
 * the same triangle split as the rendered mesh.
 */
export function triangleHeight(h: Corners, fx: number, fy: number): number {
  const [h0, h1, h2, h3] = h;
  if (splitDiagonal(h) === 0) {
    // diagonal c0–c2: triangles (c0,c1,c2) where fx >= fy, else (c0,c2,c3)
    return fx >= fy ? h0 + (h1 - h0) * fx + (h2 - h1) * fy : h0 + (h3 - h0) * fy + (h2 - h3) * fx;
  }
  // diagonal c1–c3: triangles (c0,c1,c3) where fx + fy <= 1, else (c1,c2,c3)
  return fx + fy <= 1
    ? h0 + (h1 - h0) * fx + (h3 - h0) * fy
    : h2 + (h3 - h2) * (1 - fx) + (h1 - h2) * (1 - fy);
}

export interface TerrainLayers {
  base: Int16Array;
  shape: Uint8Array;
  surface: Uint8Array;
  water: Int16Array;
  road: Uint16Array;
  roadClass: Uint8Array;
  geology: Uint8Array;
}

/**
 * Micro-terrain (M1.6, D-037): k×k micro-cells per cell. `corners` holds the
 * height of every micro-corner in micro-steps (1/k step), row-major over
 * (k·width + 1) × (k·height + 1). Micro-cells follow from their four corners
 * by `microCellCorners`.
 */
export interface MicroLayers {
  k: number;
  corners: Int16Array;
}

/** Steepest micro-cell that stays a slope tile; steeper ones become flat terraces. */
export const MICRO_MAX_OFFSET = 3;

export function emptyMicro(k: number, width: number, height: number): MicroLayers {
  return { k, corners: new Int16Array((k * width + 1) * (k * height + 1)) };
}

/**
 * A micro-cell's drawn corner heights from its micro-corner heights (c0..c3):
 * the corners themselves when they span at most MICRO_MAX_OFFSET, otherwise
 * flat at their rounded-half-up mean. Mirrors world_format.micro_cells.
 */
export function microCellCorners(c0: number, c1: number, c2: number, c3: number): Corners {
  const lo = Math.min(c0, c1, c2, c3);
  const hi = Math.max(c0, c1, c2, c3);
  if (hi - lo <= MICRO_MAX_OFFSET) return [c0, c1, c2, c3];
  const flat = Math.floor((c0 + c1 + c2 + c3) / 4 + 0.5);
  return [flat, flat, flat, flat];
}

/**
 * Copy a w×h block of cells from src (at sx, sy) to dst (at dx, dy), skipping
 * cells outside either grid.
 */
export function copyCells(
  src: TerrainGrid,
  sx: number,
  sy: number,
  dst: TerrainGrid,
  dx: number,
  dy: number,
  w: number,
  h: number,
): void {
  const a = src.layers();
  const b = dst.layers();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!src.inBounds(sx + x, sy + y) || !dst.inBounds(dx + x, dy + y)) continue;
      const si = src.index(sx + x, sy + y);
      const di = dst.index(dx + x, dy + y);
      b.base[di] = a.base[si]!;
      b.shape[di] = a.shape[si]!;
      b.surface[di] = a.surface[si]!;
      b.water[di] = a.water[si]!;
      b.road[di] = a.road[si]!;
      b.roadClass[di] = a.roadClass[si]!;
      b.geology[di] = a.geology[si]!;
    }
  }
  const ma = src.micro;
  const mb = dst.micro;
  if (!ma || !mb) return;
  if (ma.k !== mb.k) throw new Error(`micro k mismatch (${ma.k} vs ${mb.k})`);
  // every copied cell brings its (k+1)² micro-corners (shared ones agree)
  const k = ma.k;
  const sw = src.width * k + 1;
  const dw = dst.width * k + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!src.inBounds(sx + x, sy + y) || !dst.inBounds(dx + x, dy + y)) continue;
      for (let j = 0; j <= k; j++) {
        const si = ((sy + y) * k + j) * sw + (sx + x) * k;
        const di = ((dy + y) * k + j) * dw + (dx + x) * k;
        mb.corners.set(ma.corners.subarray(si, si + k + 1), di);
      }
    }
  }
}

/** Dense terrain layers for a rectangular block of cells (row-major, y then x). */
export class TerrainGrid {
  readonly base: Int16Array;
  readonly shape: Uint8Array;
  readonly surface: Uint8Array;
  readonly water: Int16Array;
  /** Road connectivity + corner crossings (see ROAD_DIRS). */
  readonly road: Uint16Array;
  /** Road class id (manifest roadClasses), 0 = none. */
  readonly roadClass: Uint8Array;
  /** Geology province id (manifest geology), selects the cliff strata set. */
  readonly geology: Uint8Array;
  /** Micro-terrain, or null for cell-only terrain. */
  readonly micro: MicroLayers | null;

  constructor(
    readonly width: number,
    readonly height: number,
    layers?: Partial<TerrainLayers> & { micro?: MicroLayers | null },
  ) {
    const n = width * height;
    this.base = layers?.base ?? new Int16Array(n);
    this.shape = layers?.shape ?? new Uint8Array(n);
    this.surface = layers?.surface ?? new Uint8Array(n);
    this.water = layers?.water ?? new Int16Array(n).fill(NO_WATER);
    this.road = layers?.road ?? new Uint16Array(n);
    this.roadClass = layers?.roadClass ?? new Uint8Array(n);
    this.geology = layers?.geology ?? new Uint8Array(n);
    for (const [name, arr] of Object.entries(this.layers())) {
      if (arr.length !== n) throw new Error(`layer ${name} has ${arr.length} cells, expected ${n}`);
    }
    this.micro = layers?.micro ?? null;
    if (this.micro) {
      const k = this.micro.k;
      const m = (k * width + 1) * (k * height + 1);
      if (this.micro.corners.length !== m) throw new Error(`micro layers need ${m} micro-corners for k=${k}`);
    }
  }

  /** Drawn corner heights of micro-cell (mx, my), in micro-steps. */
  microCorners(mx: number, my: number): Corners {
    const m = this.micro!;
    const w = this.width * m.k + 1;
    const i = my * w + mx;
    const c = m.corners;
    return microCellCorners(c[i]!, c[i + 1]!, c[i + w + 1]!, c[i + w]!);
  }

  layers(): TerrainLayers {
    return {
      base: this.base,
      shape: this.shape,
      surface: this.surface,
      water: this.water,
      road: this.road,
      roadClass: this.roadClass,
      geology: this.geology,
    };
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  cornerHeight(x: number, y: number, corner: number): number {
    const i = this.index(x, y);
    return this.base[i]! + cornerOffset(this.shape[i]!, corner);
  }

  corners(x: number, y: number): Corners {
    const i = this.index(x, y);
    return cornerHeights(this.base[i]!, this.shape[i]!);
  }

  /** Lowest and highest corner height of one cell. */
  cellRange(i: number): [number, number] {
    const b = this.base[i]!;
    return [b, b + shapeRise(this.shape[i]!)];
  }

  /** Minimum and maximum corner height over the whole grid. */
  heightRange(): [number, number] {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < this.base.length; i++) {
      const [a, b] = this.cellRange(i);
      if (a < lo) lo = a;
      if (b > hi) hi = b;
    }
    const m = this.micro;
    if (m) {
      // derived micro-cells never leave the range of their corners
      for (const c of m.corners) {
        if (Math.floor(c / m.k) < lo) lo = Math.floor(c / m.k);
        if (Math.ceil(c / m.k) > hi) hi = Math.ceil(c / m.k);
      }
    }
    return [lo, hi];
  }

  /**
   * Surface height at a continuous grid position (x, y), following the same
   * triangle split as the rendered mesh.
   */
  surfaceHeightAt(x: number, y: number): number {
    const m = this.micro;
    if (m) {
      // micro-terrain is what's drawn: sample it, in steps
      const mw = this.width * m.k;
      const mh = this.height * m.k;
      const px = x * m.k;
      const py = y * m.k;
      const mx = Math.min(mw - 1, Math.max(0, Math.floor(px)));
      const my = Math.min(mh - 1, Math.max(0, Math.floor(py)));
      const h = this.microCorners(mx, my);
      return triangleHeight(h, Math.min(1, Math.max(0, px - mx)), Math.min(1, Math.max(0, py - my))) / m.k;
    }
    const cx = Math.min(this.width - 1, Math.max(0, Math.floor(x)));
    const cy = Math.min(this.height - 1, Math.max(0, Math.floor(y)));
    const fx = Math.min(1, Math.max(0, x - cx));
    const fy = Math.min(1, Math.max(0, y - cy));
    return triangleHeight(this.corners(cx, cy), fx, fy);
  }

  /**
   * Steepest rise across the cell's top in steps per cell (0 = flat), the
   * largest height change along any cell edge or diagonal triangle edge.
   */
  steepness(x: number, y: number): number {
    const [h0, h1, h2, h3] = this.corners(x, y);
    return Math.max(
      Math.abs(h1 - h0),
      Math.abs(h2 - h1),
      Math.abs(h3 - h2),
      Math.abs(h0 - h3),
    );
  }

  /** Copy a sub-rectangle (clipped to bounds) into a new grid. */
  slice(x0: number, y0: number, w: number, h: number): TerrainGrid {
    const out = new TerrainGrid(w, h, this.micro ? { micro: emptyMicro(this.micro.k, w, h) } : undefined);
    copyCells(this, x0, y0, out, 0, 0, w, h);
    return out;
  }
}
