import {
  DEPTH_PER_STEP,
  HALF_H,
  HALF_W,
  STEP_PX,
  project,
  rotateXY,
  unprojectAtHeight,
  type Rotation,
} from "@pixelworld/grid";

/**
 * Pixel-snapped isometric camera. The view is drawn at integer internal
 * pixels; the fractional part of the camera position is applied when
 * upscaling, so scrolling is smooth without shimmer (architecture §8.2).
 */
export class Camera {
  rotation: Rotation = 0;
  zoom = 3;
  /** Focus point in grid space. */
  fx = 0;
  fy = 0;
  fh = 0;

  constructor(
    public canvasWidth: number,
    public canvasHeight: number,
  ) {}

  get internalWidth(): number {
    return Math.ceil(this.canvasWidth / this.zoom);
  }

  get internalHeight(): number {
    return Math.ceil(this.canvasHeight / this.zoom);
  }

  /** Top-left of the view in screen pixels (float). */
  origin(): [number, number] {
    const c = project(this.fx, this.fy, this.fh, this.rotation);
    return [c.sx - this.internalWidth / 2, c.sy - this.internalHeight / 2];
  }

  /** Integer top-left and the fractional remainder in [0, 1). */
  snapped(): { left: number; top: number; fracX: number; fracY: number } {
    const [x, y] = this.origin();
    const left = Math.floor(x);
    const top = Math.floor(y);
    return { left, top, fracX: x - left, fracY: y - top };
  }

  /** Pan by screen pixels (internal resolution), keeping the focus height. */
  panPixels(dx: number, dy: number): void {
    const c = project(this.fx, this.fy, this.fh, this.rotation);
    const [x, y] = unprojectAtHeight(c.sx + dx, c.sy + dy, this.fh, this.rotation);
    this.fx = x;
    this.fy = y;
  }

  /** Grid-space direction for a screen direction (unit length in cells). */
  screenDirToGrid(dx: number, dy: number): [number, number] {
    // screen (dx, dy) → view (du, dv): dx = 16(du − dv), dy = 8(du + dv)
    const a = dx / HALF_W;
    const b = dy / HALF_H;
    const du = (a + b) / 2;
    const dv = (b - a) / 2;
    // undo the view rotation (rotate by the inverse)
    const inv: Rotation = ((4 - this.rotation) % 4) as Rotation;
    const [gx, gy] = rotateXY(du, dv, inv);
    const len = Math.hypot(gx, gy) || 1;
    return [gx / len, gy / len];
  }

  rotate(delta: 1 | -1): void {
    this.rotation = ((this.rotation + delta + 4) % 4) as Rotation;
  }
}

/** Depth range of a world (all rotations), with room for objects above the terrain. */
export function worldDepthRange(
  cellsX: number,
  cellsY: number,
  minH: number,
  maxH: number,
  headroomSteps = 32,
): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of [0, 1, 2, 3] as Rotation[]) {
    for (const [x, y] of [
      [0, 0],
      [cellsX, 0],
      [0, cellsY],
      [cellsX, cellsY],
    ] as const) {
      const [u, v] = rotateXY(x, y, r);
      lo = Math.min(lo, u + v + (minH - 4) * DEPTH_PER_STEP);
      hi = Math.max(hi, u + v + (maxH + headroomSteps) * DEPTH_PER_STEP);
    }
  }
  return [lo - 1, hi + 1];
}

/** Conservative screen rectangle of a block of cells with a height range. */
export function cellsScreenRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  minH: number,
  maxH: number,
  r: Rotation,
): { left: number; top: number; right: number; bottom: number } {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ] as const) {
    const [u, v] = rotateXY(x, y, r);
    const sx = HALF_W * (u - v);
    const syBase = HALF_H * (u + v);
    left = Math.min(left, sx);
    right = Math.max(right, sx);
    top = Math.min(top, syBase - STEP_PX * maxH);
    bottom = Math.max(bottom, syBase - STEP_PX * minH);
  }
  return { left, top, right, bottom };
}
