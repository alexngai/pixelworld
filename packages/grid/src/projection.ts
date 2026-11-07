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

/** Project a view-space point (already rotated) to screen pixels and depth. */
export function projectView(u: number, v: number, h: number): ScreenPoint {
  return {
    sx: HALF_W * (u - v),
    sy: HALF_H * (u + v) - STEP_PX * h,
    depth: u + v + h * DEPTH_PER_STEP,
  };
}

/** Project a grid-space point for rotation r. */
export function project(x: number, y: number, h: number, r: Rotation): ScreenPoint {
  const [u, v] = rotateXY(x, y, r);
  return projectView(u, v, h);
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
): [number, number] {
  const a = sx / HALF_W; // u − v
  const b = (sy + STEP_PX * h) / HALF_H; // u + v
  const u = (a + b) / 2;
  const v = (b - a) / 2;
  return unrotateXY(u, v, r);
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
