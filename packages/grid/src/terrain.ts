/**
 * Cell terrain model (RCT-style). See docs/architecture.md §3.3.
 *
 * Each cell has a base height (steps) and a slope mask: bit i set means
 * corner i is raised one step above the base. Corners, in grid space:
 *
 *   c0 = (x,   y)    north-west
 *   c1 = (x+1, y)    north-east
 *   c2 = (x+1, y+1)  south-east
 *   c3 = (x,   y+1)  south-west
 *
 * Mask 15 (all raised) is never stored; it normalizes to base+1, mask 0.
 * Where neighbouring cells disagree along a shared edge, the edge renders as
 * a vertical cliff face owned by the higher side.
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

export const MAX_SLOPE = 14;
/** Sentinel for "no water" in the water layer. */
export const NO_WATER = -32768;

export function isValidSlope(slope: number): boolean {
  return Number.isInteger(slope) && slope >= 0 && slope <= MAX_SLOPE;
}

export function cornerRaise(slope: number, corner: number): number {
  return (slope >> corner) & 1;
}

export function cornerHeights(base: number, slope: number): [number, number, number, number] {
  return [
    base + cornerRaise(slope, 0),
    base + cornerRaise(slope, 1),
    base + cornerRaise(slope, 2),
    base + cornerRaise(slope, 3),
  ];
}

/**
 * Encode four integer corner heights as base + slope mask, or null when they
 * span more than one step (not representable as a single sloped cell).
 */
export function slopeFromCorners(
  corners: readonly [number, number, number, number],
): { base: number; slope: number } | null {
  const lo = Math.min(...corners);
  const hi = Math.max(...corners);
  if (hi - lo > 1) return null;
  let slope = 0;
  for (let i = 0; i < 4; i++) if (corners[i]! > lo) slope |= 1 << i;
  if (slope === 15) return { base: lo + 1, slope: 0 };
  return { base: lo, slope };
}

/**
 * Which diagonal splits the cell's top into two triangles: 0 = c0–c2, 1 = c1–c3.
 * With one raised (or one lowered) corner, split along the diagonal that
 * excludes the odd corner, so one triangle stays flat (RCT look). With two
 * opposite corners raised, split through them (a ridge).
 */
export function splitDiagonal(slope: number): 0 | 1 {
  const bits = popcount4(slope);
  if (bits === 1 || bits === 3) {
    const odd = bits === 1 ? slope : ~slope & 15;
    // odd corner is c0 or c2 → exclude it → split along c1–c3
    return odd === 1 || odd === 4 ? 1 : 0;
  }
  if (slope === 5) return 0; // c0 and c2 raised: ridge along c0–c2
  if (slope === 10) return 1; // c1 and c3 raised: ridge along c1–c3
  return 0;
}

function popcount4(v: number): number {
  return (v & 1) + ((v >> 1) & 1) + ((v >> 2) & 1) + ((v >> 3) & 1);
}

/** Dense terrain layers for a rectangular block of cells (row-major, y then x). */
export class TerrainGrid {
  readonly base: Int16Array;
  readonly slope: Uint8Array;
  readonly surface: Uint8Array;
  readonly water: Int16Array;

  constructor(
    readonly width: number,
    readonly height: number,
    layers?: {
      base?: Int16Array;
      slope?: Uint8Array;
      surface?: Uint8Array;
      water?: Int16Array;
    },
  ) {
    const n = width * height;
    this.base = layers?.base ?? new Int16Array(n);
    this.slope = layers?.slope ?? new Uint8Array(n);
    this.surface = layers?.surface ?? new Uint8Array(n);
    this.water = layers?.water ?? new Int16Array(n).fill(NO_WATER);
    for (const [name, arr] of Object.entries({
      base: this.base,
      slope: this.slope,
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
    return this.base[i]! + cornerRaise(this.slope[i]!, corner);
  }

  corners(x: number, y: number): [number, number, number, number] {
    const i = this.index(x, y);
    return cornerHeights(this.base[i]!, this.slope[i]!);
  }

  /** Minimum and maximum corner height over the whole grid. */
  heightRange(): [number, number] {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < this.base.length; i++) {
      const b = this.base[i]!;
      const s = this.slope[i]!;
      if (b < lo) lo = b;
      const top = b + (s ? 1 : 0);
      if (top > hi) hi = top;
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
    const [h0, h1, h2, h3] = this.corners(cx, cy);
    const i = this.index(cx, cy);
    if (splitDiagonal(this.slope[i]!) === 0) {
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
        out.slope[di] = this.slope[si]!;
        out.surface[di] = this.surface[si]!;
        out.water[di] = this.water[si]!;
      }
    }
    return out;
  }
}
