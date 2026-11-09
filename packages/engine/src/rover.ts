import { roverBoxes } from "@pixelworlds/generators";
import { listenTo } from "./controller";
import type { Controller, ControllerView, Entity, KeyInput, PointerInput } from "./types";

/**
 * The rover and the free camera, the viewer's interaction mode and the first
 * controller:
 *
 * - **Arrows** drive the rover across the ground: it stays on land, climbs
 *   gentle slopes and slides along what stops it.
 * - **WASD** and **dragging** pan the camera freely; driving again follows
 *   the rover. **F** toggles following, **N** no-clip (water and cliffs).
 * - **Q/E** rotate the view and **1–6** set the zoom.
 */

const PAN_SPEED = 220; // internal px / s
const DRIVE_SPEED = 3; // cells / s
// Steepest grade the rover can drive, in height steps per cell travelled. Gentle
// slopes (1 step per cell, up to 1.41 across a diagonal fold) are drivable;
// steep slope tiles and cliffs are not.
const MAX_GRADE = 2;

export interface RoverOptions {
  /** Where the rover starts: a cell, or a lon/lat (worlds with a geo grid). Default, or outside the world: the world's start. */
  start?: { x?: number; y?: number } | { lon: number; lat: number };
  /** The camera follows the rover (default true); without, it stays where the view put it. */
  follow?: boolean;
  /** Draw the rover (default true). */
  visible?: boolean;
  /** Listen for keys and drags here; without, the app forwards input (`keyDown`, `pointerMove`, …). */
  listen?: { keys?: EventTarget | null; pointer?: EventTarget | null };
}

export class RoverController implements Controller {
  readonly id = "rover";
  /** The camera follows the rover. */
  follow: boolean;
  /** Drive through water and up cliffs. */
  noclip = false;
  private view: ControllerView | null = null;
  private entity: Entity | null = null;
  private readonly keys = new Set<string>();
  private drag: { x: number; y: number } | null = null;
  private unlisten: (() => void) | null = null;

  constructor(private readonly opts: RoverOptions = {}) {
    this.follow = opts.follow ?? true;
  }

  /** The rover entity (once attached). */
  get rover(): Entity {
    if (!this.entity) throw new Error("the rover controller isn't attached to a view");
    return this.entity;
  }

  async attach(view: ControllerView): Promise<void> {
    const m = view.world.manifest;
    const home = m.start ?? { x: Math.floor(m.cellsX / 2), y: Math.floor(m.cellsY / 2) };
    let x = home.x + 0.5;
    let y = home.y + 0.5;
    const s = this.opts.start;
    if (s && "lon" in s) {
      const cell = view.query.lonLatToCell(s.lon, s.lat);
      if (cell) [x, y] = cell;
    } else if (s) {
      x = s.x ?? x;
      y = s.y ?? y;
    }
    await view.query.ensure(Math.floor(x), Math.floor(y), Math.floor(x) + 1, Math.floor(y) + 1);
    const h = view.query.heightAt(x, y) ?? 0;
    const pal = view.world.palette.rampIds;
    const body = pal.get("marker")!;
    // the cab: a pale ramp the style names "cab", else its first ramp after the marker
    const cab = pal.get("cab") ?? pal.get("coconino") ?? (body + 1) % pal.size;
    this.entity = view.entities.add({
      model: { boxes: roverBoxes(body, cab), key: "rover" },
      x,
      y,
      h,
      silhouette: true,
      visible: this.opts.visible ?? true,
    });
    // the camera starts on the rover; without following, the view may move it elsewhere
    view.camera.setFocus(x, y, h);
    this.view = view;
    if (this.opts.listen) this.unlisten = listenTo(this, this.opts.listen);
  }

  detach(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.entity?.remove();
    this.entity = null;
    this.view = null;
    this.keys.clear();
    this.drag = null;
  }

  /** Put the rover at a place (cells), on the ground there where it is loaded. */
  place(x: number, y: number): void {
    this.rover.moveTo(x, y);
  }

  update(dt: number): void {
    const view = this.view;
    const rover = this.entity;
    if (!view || !rover) return;
    const keys = this.keys;
    const camera = view.camera;
    let px = 0;
    let py = 0;
    if (keys.has("a")) px -= 1;
    if (keys.has("d")) px += 1;
    if (keys.has("w")) py -= 1;
    if (keys.has("s")) py += 1;
    if (px || py) {
      const len = Math.hypot(px, py);
      camera.pan((px / len) * PAN_SPEED * dt, (py / len) * PAN_SPEED * dt);
      this.follow = false;
    }
    let mx = 0;
    let my = 0;
    if (keys.has("arrowleft")) mx -= 2;
    if (keys.has("arrowright")) mx += 2;
    if (keys.has("arrowup")) my -= 1;
    if (keys.has("arrowdown")) my += 1;
    if (mx || my) {
      const { cellsX, cellsY, renderScale } = view.world;
      const [gx, gy] = camera.screenDirToGrid(mx, my);
      const step = (DRIVE_SPEED * dt) / renderScale; // same on-screen speed at any render scale
      const tryMove = (nx: number, ny: number) => {
        if (nx < 0.3 || ny < 0.3 || nx > cellsX - 0.3 || ny > cellsY - 0.3) return false;
        const nh = view.query.heightAt(nx, ny);
        if (nh === null) return false; // terrain not loaded yet
        const dist = Math.hypot(nx - rover.x, ny - rover.y);
        const tooSteep = Math.abs(nh - rover.h) > MAX_GRADE * dist + 0.01;
        const water = view.query.surfaceAt(nx, ny)?.waterLevel != null;
        if (!this.noclip && (water || tooSteep)) return false;
        rover.moveTo(nx, ny, nh);
        return true;
      };
      // slide along obstacles by trying each axis separately
      if (!tryMove(rover.x + gx * step, rover.y + gy * step)) {
        if (!tryMove(rover.x + gx * step, rover.y)) tryMove(rover.x, rover.y + gy * step);
      }
      if (!this.follow && !keys.has("w") && !keys.has("a") && !keys.has("s") && !keys.has("d")) this.follow = true;
    }
    if (this.follow) camera.setFocus(rover.x, rover.y, rover.h);
  }

  keyDown(e: KeyInput): boolean {
    const view = this.view;
    if (!view) return false;
    const k = e.key.toLowerCase();
    this.keys.add(k);
    let mine = true;
    if (k === "q") view.camera.rotate(-1);
    else if (k === "e") view.camera.rotate(1);
    else if (k === "f") this.follow = !this.follow;
    else if (k === "n") this.noclip = !this.noclip;
    else if (k >= "1" && k <= "6" && k.length === 1) view.camera.zoom = Number(k);
    else if (k.startsWith("arrow")) e.preventDefault?.();
    else mine = "wasd".includes(k) && k.length === 1;
    return mine;
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
    this.follow = false;
  }

  pointerUp(): void {
    this.drag = null;
  }
}

/** The rover and free camera controller. */
export function roverController(opts: RoverOptions = {}): RoverController {
  return new RoverController(opts);
}
