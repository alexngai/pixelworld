/**
 * Integer isometric projection. See docs/architecture.md §3.4.
 *
 * Grid space: x grows east, y grows south (row order of north-up rasters),
 * h is height in steps. Screen space: pixels, y grows downward.
 *
 *   sx = 16 (x − y)
 *   sy =  8 (x + y) − 8 h
 *   depth = x + y + h / 3          (larger = closer to the camera)
 *
 * This equals an orthographic camera at 45° yaw / 30° pitch when one height
 * step measures STEP_WORLD = 1/√6 cell in true 3D, which is what lighting uses.
 * That is the default; a view may lay the world out with another
 * `Projection` (D-195), such as `STEEP_PROJECTION`'s higher camera.
 */

export const TILE_W = 32;
export const TILE_H = 16;
export const HALF_W = TILE_W / 2;
export const HALF_H = TILE_H / 2;
export const STEP_PX = 8;

/** Height of one step in cell units, in true 3D (used for normals/lighting). */
export const STEP_WORLD = 1 / Math.sqrt(6);

/** Depth contribution of one height step relative to one cell along x or y. */
export const DEPTH_PER_STEP = 1 / 3;

/** One of the 4 fixed view rotations (multiples of 90°). */
export type Rotation = 0 | 1 | 2 | 3;
export const ROTATIONS: readonly Rotation[] = [0, 1, 2, 3];

/**
 * Rotate grid (x, y) into view space for rotation r. Each step is a proper
 * 90° rotation (determinant +1), so handedness is preserved.
 */
export function rotateXY(x: number, y: number, r: Rotation): [number, number] {
  switch (r) {
    case 0:
      return [x, y];
    case 1:
      return [-y, x];
    case 2:
      return [-x, -y];
    case 3:
      return [y, -x];
  }
}

/** Inverse of rotateXY. */
export function unrotateXY(u: number, v: number, r: Rotation): [number, number] {
  switch (r) {
    case 0:
      return [u, v];
    case 1:
      return [v, -u];
    case 2:
      return [-u, -v];
    case 3:
      return [-v, u];
  }
}

/** 2×2 rotation matrix (column-major, for GLSL mat2) for rotation r. */
export function rotationMat2(r: Rotation): [number, number, number, number] {
  // columns: image of (1,0) and image of (0,1)
  const [ax, ay] = rotateXY(1, 0, r);
  const [bx, by] = rotateXY(0, 1, r);
  return [ax, ay, bx, by];
}

export interface ScreenPoint {
  sx: number;
  sy: number;
  depth: number;
}

/**
 * How a view lays the world out (D-155, D-195): screen x, screen y and depth
 * (larger nearer) as linear in a point's rotated (u, v) and height h (steps).
 * A view's tiles meet without seams when x and y are whole numbers, and draw
 * right when depth grows toward the camera along the view's rays.
 */
export interface Projection {
  x: readonly [number, number, number];
  y: readonly [number, number, number];
  d: readonly [number, number, number];
}

/** The world's 2:1 view: sx = 16(u − v), sy = 8(u + v) − 8h, depth = u + v + h/3. */
export const ISO_PROJECTION: Projection = {
  x: [HALF_W, -HALF_W, 0],
  y: [HALF_H, HALF_H, -STEP_PX],
  d: [1, 1, DEPTH_PER_STEP],
};

/**
 * A higher camera (D-195): 4:3 tiles, about 49° down rather than 30°, as
 * Into the Breach's boards are drawn. Heights stay 8 px a step, so a facade's
 * window rows stay whole; the ground shows more between buildings, and a
 * building stands two thirds as tall against its tile.
 */
export const STEEP_PROJECTION: Projection = {
  x: [HALF_W, -HALF_W, 0],
  y: [12, 12, -STEP_PX],
  d: [1, 1, DEPTH_PER_STEP],
};

/** Whether two projections lay the world out the same. */
export const sameProjection = (a: Projection, b: Projection): boolean =>
  [0, 1, 2].every((i) => a.x[i] === b.x[i] && a.y[i] === b.y[i] && a.d[i] === b.d[i]);

/** A short name for a projection, for cache keys: "" for the 2:1 view. */
export const projectionKey = (p: Projection): string =>
  sameProjection(p, ISO_PROJECTION) ? "" : `p${p.x.join(",")};${p.y.join(",")};${p.d.map((n) => +n.toFixed(4)).join(",")}`;

/** Project a view-space point (already rotated) to screen pixels and depth. */
export function projectView(u: number, v: number, h: number, p: Projection = ISO_PROJECTION): ScreenPoint {
  return {
    sx: p.x[0] * u + p.x[1] * v + p.x[2] * h,
    sy: p.y[0] * u + p.y[1] * v + p.y[2] * h,
    depth: p.d[0] * u + p.d[1] * v + p.d[2] * h,
  };
}

/** Project a grid-space point for rotation r. */
export function project(x: number, y: number, h: number, r: Rotation, p: Projection = ISO_PROJECTION): ScreenPoint {
  const [u, v] = rotateXY(x, y, r);
  return projectView(u, v, h, p);
}

/**
 * The view (u, v) that projects to screen (sx, sy) at height h: the screen
 * rows' (u, v) part inverted.
 */
export function unprojectView(sx: number, sy: number, h: number, p: Projection = ISO_PROJECTION): [number, number] {
  const [a, b, c, d] = groundInverse(p);
  const x = sx - p.x[2] * h;
  const y = sy - p.y[2] * h;
  return [a * x + c * y, b * x + d * y];
}

/**
 * Inverse projection onto the horizontal plane at height h: returns the grid
 * (x, y) that projects to screen (sx, sy) for rotation r.
 */
export function unprojectAtHeight(
  sx: number,
  sy: number,
  h: number,
  r: Rotation,
  p: Projection = ISO_PROJECTION,
): [number, number] {
  const [u, v] = unprojectView(sx, sy, h, p);
  return unrotateXY(u, v, r);
}

/** The inverse of the screen rows' (u, v) part, column-major (GLSL mat2): screen (sx, sy) at h = 0 → view (u, v). */
export function groundInverse(p: Projection): [number, number, number, number] {
  const det = p.x[0] * p.y[1] - p.x[1] * p.y[0];
  return [p.y[1] / det, -p.y[0] / det, -p.x[1] / det, p.x[0] / det];
}

/** The whole projection inverted, column-major (GLSL mat3): screen (sx, sy) and depth → view (u, v, h). */
export function projectionInverse(p: Projection): number[] {
  const m = [p.x, p.y, p.d];
  const c = (i: number, j: number) => {
    // the cofactor of row i, column j
    const r = [0, 1, 2].filter((k) => k !== i);
    const q = [0, 1, 2].filter((k) => k !== j);
    const minor = m[r[0]!]![q[0]!]! * m[r[1]!]![q[1]!]! - m[r[0]!]![q[1]!]! * m[r[1]!]![q[0]!]!;
    return (i + j) % 2 ? -minor : minor;
  };
  const det = m[0]![0]! * c(0, 0) + m[0]![1]! * c(0, 1) + m[0]![2]! * c(0, 2);
  // inverse[j][i] = cofactor(i, j) / det; column-major puts inverse[row][col] at col * 3 + row
  const out: number[] = new Array(9);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) out[col * 3 + row] = c(col, row) / det;
  return out;
}

/** A point's u + v from its screen position and depth: u + v = k · (sx, sy, depth), for the reveal (D-154). */
export function sumUV(p: Projection): [number, number, number] {
  const m = projectionInverse(p);
  // rows u and v of the inverse, summed: column-major, so row r is m[r], m[3 + r], m[6 + r]
  return [m[0]! + m[1]!, m[3]! + m[4]!, m[6]! + m[7]!];
}

/**
 * Sun direction in view space (true 3D: x, y, z-up), pointing toward the sun.
 * View-relative so every rotation is lit the same way: light comes from the
 * upper-left of the screen. Chosen so the three canonical face orientations
 * land on evenly spaced light levels: top 0.787, left (+y) 0.541, right (+x) 0.295.
 */
export const SUN_DIR: readonly [number, number, number] = normalize3([0.3, 0.55, 0.8]);

export function normalize3(v: readonly [number, number, number]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}
