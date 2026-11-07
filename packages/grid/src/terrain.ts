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

/** Dense terrain layers for a rectangular block of cells (row-major, y then x). */
export class TerrainGrid {
  readonly base: Int16Array;
  readonly shape: Uint8Array;
  readonly surface: Uint8Array;
  readonly water: Int16Array;

  constructor(
    readonly width: number,
    readonly height: number,
    layers?: {
      base?: Int16Array;
      shape?: Uint8Array;
      surface?: Uint8Array;
      water?: Int16Array;
    },
  ) {
    const n = width * height;
    this.base = layers?.base ?? new Int16Array(n);
    this.shape = layers?.shape ?? new Uint8Array(n);
    this.surface = layers?.surface ?? new Uint8Array(n);
    this.water = layers?.water ?? new Int16Array(n).fill(NO_WATER);
    for (const [name, arr] of Object.entries({
      base: this.base,
      shape: this.shape,
      surface: this.surface,
      water: this.water,
    })) {
      if (arr.length !== n) throw new Error(`layer ${name} has ${arr.length} cells, expected ${n}`);
    }
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
    return [lo, hi];
  }

  /**
   * Surface height at a continuous grid position (x, y), following the same
   * triangle split as the rendered mesh.
   */
  surfaceHeightAt(x: number, y: number): number {
    const cx = Math.min(this.width - 1, Math.max(0, Math.floor(x)));
    const cy = Math.min(this.height - 1, Math.max(0, Math.floor(y)));
    const fx = Math.min(1, Math.max(0, x - cx));
    const fy = Math.min(1, Math.max(0, y - cy));
    const h = this.corners(cx, cy);
    const [h0, h1, h2, h3] = h;
    if (splitDiagonal(h) === 0) {
      // diagonal c0–c2: triangles (c0,c1,c2) where fx >= fy, else (c0,c2,c3)
      return fx >= fy
        ? h0 + (h1 - h0) * fx + (h2 - h1) * fy
        : h0 + (h3 - h0) * fy + (h2 - h3) * fx;
    }
    // diagonal c1–c3: triangles (c0,c1,c3) where fx + fy <= 1, else (c1,c2,c3)
    return fx + fy <= 1
      ? h0 + (h1 - h0) * fx + (h3 - h0) * fy
      : h2 + (h3 - h2) * (1 - fx) + (h1 - h2) * (1 - fy);
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
    const out = new TerrainGrid(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = x0 + x;
        const sy = y0 + y;
        if (!this.inBounds(sx, sy)) continue;
        const si = this.index(sx, sy);
        const di = out.index(x, y);
        out.base[di] = this.base[si]!;
        out.shape[di] = this.shape[si]!;
        out.surface[di] = this.surface[si]!;
        out.water[di] = this.water[si]!;
      }
    }
    return out;
  }
}
