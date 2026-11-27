import { roverBoxes } from "@pixelworlds/generators";
import { CameraController, type CameraControllerOptions } from "./cameraController";
import type { ControllerView, Entity, KeyInput } from "./types";

/**
 * The rover and the free camera, the viewer's interaction mode:
 *
 * - **Arrows** drive the rover across the ground: it stays on land, climbs
 *   gentle slopes and slides along what stops it.
 * - **WASD** and **dragging** pan the camera freely; driving again follows
 *   the rover. **F** toggles following, **N** no-clip (water and cliffs).
 * - **Q/E** rotate the view and **1–6** set the zoom.
 */

const DRIVE_SPEED = 3; // cells / s
// Steepest grade the rover can drive, in height steps per cell travelled. Gentle
// slopes (1 step per cell, up to 1.41 across a diagonal fold) are drivable;
// steep slope tiles and cliffs are not.
const MAX_GRADE = 2;

export interface RoverOptions extends Pick<CameraControllerOptions, "listen" | "panSpeed"> {
  /** Where the rover starts: a cell, or a lon/lat (worlds with a geo grid). Default, or outside the world: the world's start. */
  start?: { x?: number; y?: number } | { lon: number; lat: number };
  /** The camera follows the rover (default true); without, it stays where the view put it. */
  follow?: boolean;
  /** Draw the rover (default true). */
  visible?: boolean;
}

/** The rover controller's state (`serialize`): the rover's place and the switches. */
export interface RoverState {
  x: number;
  y: number;
  h: number;
  follow: boolean;
  noclip: boolean;
}

export class RoverController extends CameraController {
  override readonly id = "rover";
  /** The camera follows the rover. */
  follow: boolean;
  /** Drive through water and up cliffs. */
  noclip = false;
  private entity: Entity | null = null;
  private readonly roverOpts: RoverOptions;

  constructor(opts: RoverOptions = {}) {
    super({
      listen: opts.listen,
      panSpeed: opts.panSpeed,
      onPan: () => {
        this.follow = false;
      },
    });
    this.roverOpts = opts;
    this.follow = opts.follow ?? true;
  }

  /** The rover entity (once attached). */
  get rover(): Entity {
    if (!this.entity) throw new Error("the rover controller isn't attached to a view");
    return this.entity;
  }

  override async attach(view: ControllerView): Promise<void> {
    const m = view.world.manifest;
    const home = m.start ?? { x: Math.floor(m.cellsX / 2), y: Math.floor(m.cellsY / 2) };
    let x = home.x + 0.5;
    let y = home.y + 0.5;
    const s = this.roverOpts.start;
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
      visible: this.roverOpts.visible ?? true,
    });
    // the camera starts on the rover; without following, the view may move it elsewhere
    view.camera.setFocus(x, y, h);
    super.attach(view);
  }

  override detach(): void {
    this.entity?.remove();
    this.entity = null;
    super.detach();
  }

  /** Put the rover at a place (cells), on the ground there where it is loaded. */
  place(x: number, y: number): void {
    this.rover.moveTo(x, y);
  }

  /** Where the rover is and the switches (`view.serialize()` keeps it). */
  serialize(): RoverState {
    const r = this.rover;
    return { x: r.x, y: r.y, h: r.h, follow: this.follow, noclip: this.noclip };
  }

  restore(state: unknown): void {
    const s = state as RoverState;
    this.rover.moveTo(s.x, s.y, s.h);
    this.follow = s.follow;
    this.noclip = s.noclip;
    if (this.follow) this.view?.camera.setFocus(s.x, s.y, s.h);
  }

  override update(dt: number): void {
    const view = this.view;
    const rover = this.entity;
    if (!view || !rover) return;
    super.update(dt);
    const keys = this.keys;
    const camera = view.camera;
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

  override keyDown(e: KeyInput): boolean {
    const view = this.view;
    if (!view) return false;
    const k = e.key.toLowerCase();
    if (k === "f") {
      this.keys.add(k);
      this.follow = !this.follow;
      return true;
    }
    if (k === "n") {
      this.keys.add(k);
      this.noclip = !this.noclip;
      return true;
    }
    if (k.startsWith("arrow")) {
      this.keys.add(k);
      e.preventDefault?.();
      return true;
    }
    return super.keyDown(e);
  }
}

/** The rover and free camera controller. */
export function roverController(opts: RoverOptions = {}): RoverController {
  return new RoverController(opts);
}
