import { listenTo } from "./controller";
import type { Controller, ControllerView, KeyInput, PointerInput } from "./types";

/**
 * Free-camera controller: WASD and pointer drag pan, Q/E rotate 90°, and 1–6
 * set integer zoom. Spawns no entities and does not intercept Arrow/F/N keys.
 */

const DEFAULT_PAN_SPEED = 220; // internal px / s

export interface CameraControllerOptions {
  /** Pan speed in internal pixels per second (default 220). */
  panSpeed?: number;
  /** Listen for keys and drags here; without, the app forwards input (`keyDown`, `pointerMove`, …). */
  listen?: { keys?: EventTarget | null; pointer?: EventTarget | null };
  /** Called whenever user pan/drag moves the camera. */
  onPan?: () => void;
}

export class CameraController implements Controller {
  readonly id: string = "camera";
  protected view: ControllerView | null = null;
  protected readonly keys = new Set<string>();
  protected drag: { x: number; y: number } | null = null;
  protected unlisten: (() => void) | null = null;
  protected readonly panSpeed: number;
  protected readonly onPan?: () => void;
  private readonly listenTargets?: CameraControllerOptions["listen"];

  constructor(opts: CameraControllerOptions = {}) {
    this.panSpeed = opts.panSpeed ?? DEFAULT_PAN_SPEED;
    this.listenTargets = opts.listen;
    this.onPan = opts.onPan;
  }

  attach(view: ControllerView): void | Promise<void> {
    this.view = view;
    if (this.listenTargets) this.unlisten = listenTo(this, this.listenTargets);
  }

  detach(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.view = null;
    this.keys.clear();
    this.drag = null;
  }

  update(dt: number): void {
    const view = this.view;
    if (!view) return;
    let px = 0;
    let py = 0;
    if (this.keys.has("a")) px -= 1;
    if (this.keys.has("d")) px += 1;
    if (this.keys.has("w")) py -= 1;
    if (this.keys.has("s")) py += 1;
    if (px || py) {
      const len = Math.hypot(px, py);
      view.camera.pan((px / len) * this.panSpeed * dt, (py / len) * this.panSpeed * dt);
      this.onPan?.();
    }
  }

  keyDown(e: KeyInput): boolean {
    const view = this.view;
    if (!view) return false;
    const k = e.key.toLowerCase();
    this.keys.add(k);
    if (k === "q") {
      view.camera.rotate(-1);
      return true;
    }
    if (k === "e") {
      view.camera.rotate(1);
      return true;
    }
    if (k >= "1" && k <= "6" && k.length === 1) {
      view.camera.zoom = Number(k);
      return true;
    }
    return "wasd".includes(k) && k.length === 1;
  }

  keyUp(e: KeyInput): void {
    this.keys.delete(e.key.toLowerCase());
  }

  blur(): void {
    this.keys.clear();
  }

  pointerDown(e: PointerInput): void {
    this.drag = { x: e.clientX, y: e.clientY };
    if (e.pointerId !== undefined) this.view?.canvas.setPointerCapture?.(e.pointerId);
  }

  pointerMove(e: PointerInput): void {
    const view = this.view;
    if (!this.drag || !view) return;
    const scale = view.pixelRatio / view.camera.zoom;
    view.camera.pan(-(e.clientX - this.drag.x) * scale, -(e.clientY - this.drag.y) * scale);
    this.drag = { x: e.clientX, y: e.clientY };
    this.onPan?.();
  }

  pointerUp(): void {
    this.drag = null;
  }
}

/** Free-camera controller: WASD/drag pan, Q/E rotate, 1–6 zoom (no rover entity). */
export function cameraController(opts: CameraControllerOptions = {}): CameraController {
  return new CameraController(opts);
}
