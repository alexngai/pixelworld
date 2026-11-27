import { ISO_PROJECTION, project, screenDirToGrid as gridScreenDir, unprojectAtHeight, type Projection, type Rotation } from "@pixelworlds/grid";

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
    /** How the view lays the world out (D-195). */
    readonly projection: Projection = ISO_PROJECTION,
  ) {}

  get internalWidth(): number {
    return Math.ceil(this.canvasWidth / this.zoom);
  }

  get internalHeight(): number {
    return Math.ceil(this.canvasHeight / this.zoom);
  }

  /** Top-left of the view in screen pixels (float). */
  origin(): [number, number] {
    const c = project(this.fx, this.fy, this.fh, this.rotation, this.projection);
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
    const c = project(this.fx, this.fy, this.fh, this.rotation, this.projection);
    const [x, y] = unprojectAtHeight(c.sx + dx, c.sy + dy, this.fh, this.rotation, this.projection);
    this.fx = x;
    this.fy = y;
  }

  /** Grid-space direction for a screen direction (unit length in cells), in `rotation` (default the camera's current). */
  screenDirToGrid(dx: number, dy: number, rotation: Rotation = this.rotation): [number, number] {
    return gridScreenDir(dx, dy, rotation, this.projection);
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
  p: Projection = ISO_PROJECTION,
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
      for (const h of [minH - 4, maxH + headroomSteps]) {
        const d = project(x, y, h, r, p).depth;
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
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
  p: Projection = ISO_PROJECTION,
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
    for (const h of [minH, maxH]) {
      const s = project(x, y, h, r, p);
      left = Math.min(left, s.sx);
      right = Math.max(right, s.sx);
      top = Math.min(top, s.sy);
      bottom = Math.max(bottom, s.sy);
    }
  }
  return { left, top, right, bottom };
}
