import type { Rotation } from "@pixelworld/grid";
import type { Camera } from "@pixelworld/runtime";
import type { ViewCamera } from "./types";

/** About one internal pixel per this many canvas pixels, when the zoom is "auto". */
export const AUTO_ZOOM_PX = 640;

/**
 * The public camera: cells and steps outside, render units inside (the
 * runtime camera works in render units, cells × render scale). Changes
 * redraw; setting the focus to where it already is doesn't, so a controller
 * may set it every frame.
 */
export class ViewCameraImpl implements ViewCamera {
  autoZoom = true;

  constructor(
    private readonly cam: Camera,
    private readonly rs: number,
    private readonly changed: () => void,
    private readonly world: {
      ensure(x: number, y: number): Promise<void>;
      heightAt(x: number, y: number): number | null;
      lonLatToCell(lon: number, lat: number): [number, number] | null;
    },
  ) {}

  get x(): number {
    return this.cam.fx / this.rs;
  }

  get y(): number {
    return this.cam.fy / this.rs;
  }

  get h(): number {
    return this.cam.fh / this.rs;
  }

  get rotation(): Rotation {
    return this.cam.rotation;
  }

  set rotation(r: Rotation) {
    const q = (((Math.round(r) % 4) + 4) % 4) as Rotation;
    if (q === this.cam.rotation) return;
    this.cam.rotation = q;
    this.changed();
  }

  get zoom(): number {
    return this.cam.zoom;
  }

  set zoom(z: number) {
    this.autoZoom = false;
    this.setZoom(Math.max(1, Math.round(z)));
  }

  /** Set the zoom without fixing it (auto zoom on resize). */
  setZoom(z: number): void {
    if (z === this.cam.zoom) return;
    this.cam.zoom = z;
    this.changed();
  }

  /** Size the view (canvas pixels); an auto zoom follows the width. */
  setCanvasSize(width: number, height: number): void {
    this.cam.canvasWidth = width;
    this.cam.canvasHeight = height;
    if (this.autoZoom) this.cam.zoom = Math.max(1, Math.round(width / AUTO_ZOOM_PX));
    this.changed();
  }

  get internalWidth(): number {
    return this.cam.internalWidth;
  }

  get internalHeight(): number {
    return this.cam.internalHeight;
  }

  setFocus(x: number, y: number, h: number): void {
    const fx = x * this.rs;
    const fy = y * this.rs;
    const fh = h * this.rs;
    const c = this.cam;
    if (fx === c.fx && fy === c.fy && fh === c.fh) return;
    c.fx = fx;
    c.fy = fy;
    c.fh = fh;
    this.changed();
  }

  async lookAt(target: { x: number; y: number; h?: number } | { lon: number; lat: number; h?: number }): Promise<boolean> {
    let x: number;
    let y: number;
    if ("lon" in target) {
      const cell = this.world.lonLatToCell(target.lon, target.lat);
      if (!cell) return false;
      [x, y] = cell;
    } else {
      ({ x, y } = target);
    }
    await this.world.ensure(x, y);
    const c = this.cam;
    c.fx = x * this.rs;
    c.fy = y * this.rs;
    c.fh = (target.h ?? this.world.heightAt(x, y) ?? c.fh / this.rs) * this.rs;
    this.changed();
    return true;
  }

  pan(dx: number, dy: number): void {
    this.cam.panPixels(dx, dy);
    this.changed();
  }

  rotate(delta: 1 | -1): void {
    this.cam.rotate(delta);
    this.changed();
  }

  screenDirToGrid(dx: number, dy: number): [number, number] {
    return this.cam.screenDirToGrid(dx, dy);
  }
}
