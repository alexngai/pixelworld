import { listenTo, type Controller, type ControllerView, type Entity, type KeyInput } from "@pixelworld/engine";
import { Follow } from "./follow";
import { FlyWorld } from "./ground";
import { geoToPose, type GeoPose } from "./levels";
import { FlightPilot, type Waypoint } from "./pilot";
import { LEVEL_FLIGHT, flyPlane, throttleFor, type PlaneInput, type PlaneParams, type PlaneState, type PlaneStep } from "./plane";
import { roadUnder } from "./roads";
import { FLY_PACE, PLANE, pace } from "./tuning";
import type { Place } from "./carController";

/**
 * The player's plane (M4) on a flying level: the style's `vehicle.plane`
 * entity with a silhouette where the world hides it, and its drop shadow (the
 * plane's dithered outline, `part` 1) on the ground straight below, so its
 * height reads as the gap between them. Steps the flight model (plane.ts);
 * a crash puts it back where it was a few seconds earlier, higher up.
 *
 * Keys: W/↑ climb, S/↓ descend, A/D or ←/→ bank, Shift or + throttle up,
 * Z or − throttle down. Low and slow over a road, it lands (`onLand`).
 */

export interface PlaneControllerOptions {
  start?: Place;
  /** A place and heading from another level (a take-off), through the geo grids; wins over `start`. */
  pose?: GeoPose;
  heading?: number;
  /** Height over the ground at the start (steps; default PLANE.startAgl). */
  agl?: number;
  /** Starting speed (cells/s; default cruise at the level's pace). */
  speed?: number;
  /** The camera follows the plane (default true). */
  follow?: boolean;
  listen?: { keys?: EventTarget | null };
}

export class PlaneController implements Controller {
  readonly id = "plane";
  readonly state: PlaneState = { x: 0, y: 0, h: 0, heading: 0, speed: 0, climb: 0, bank: 0, throttle: 0.5 };
  params: PlaneParams = { pace: 1, ceiling: 30, length: 1.25 };
  paused = false;
  frozen = false;
  follow: boolean;
  last: PlaneStep = { crashed: null, agl: null };
  /** Crashes so far, and the last one's time. */
  crashes = 0;
  crashedAt: number | null = null;
  /** Where and why the last crash happened. */
  lastCrash: { reason: string; x: number; y: number; h: number; agl: number | null } | null = null;
  /** Seconds flown (physics time). */
  time = 0;
  distance = 0;
  /** Called once low and slow over a road for `PLANE.landDwell` seconds (the game switches level). */
  onLand: (() => void) | null = null;
  /** Land by itself when it can (else only on request). */
  autoLand = true;
  private landing = 0;
  private view: ControllerView | null = null;
  private world: FlyWorld | null = null;
  private plane: Entity | null = null;
  private shadowEntity: Entity | null = null;
  private pilot: FlightPilot | null = null;
  private readonly keys = new Set<string>();
  private readonly cam = new Follow();
  private readonly history: { t: number; s: PlaneState }[] = [];
  private unlisten: (() => void) | null = null;
  private ensured = { x: NaN, y: NaN };

  constructor(private readonly opts: PlaneControllerOptions = {}) {
    this.follow = opts.follow ?? true;
  }

  get entity(): Entity {
    if (!this.plane) throw new Error("the plane controller isn't attached to a view");
    return this.plane;
  }

  get shadow(): Entity {
    if (!this.shadowEntity) throw new Error("the plane controller isn't attached to a view");
    return this.shadowEntity;
  }

  /** Where the shadow lies, or null when the controller isn't attached (a level change took it away). */
  get shadowPose(): { x: number; y: number; h: number } | null {
    const s = this.shadowEntity;
    return s ? { x: s.x, y: s.y, h: s.h } : null;
  }

  get fly(): FlyWorld {
    if (!this.world) throw new Error("the plane controller isn't attached to a view");
    return this.world;
  }

  async attach(view: ControllerView): Promise<void> {
    this.view = view;
    const w = view.world;
    const m = w.manifest;
    const k = pace(m.scale.metersPerCell, FLY_PACE.ref, FLY_PACE.floor) / w.renderScale;
    const vox = PLANE.voxels;
    const size = { length: vox.length * w.renderScale, width: vox.width * w.renderScale, height: vox.height * w.renderScale };
    this.params = { pace: k, ceiling: w.heightRange[1] + PLANE.ceiling, length: vox.length / 16 };
    this.world = new FlyWorld(view.query, w.cellsX, w.cellsY);
    let start = { x: (m.start?.x ?? w.cellsX / 2) + 0.5, y: (m.start?.y ?? w.cellsY / 2) + 0.5 };
    let heading = this.opts.heading ?? 0;
    const s = this.opts.start;
    const posed = this.opts.pose ? geoToPose(view.query, this.opts.pose) : null;
    if (posed) {
      start = posed;
      heading = this.opts.heading ?? posed.heading;
    } else if (s && "lon" in s) {
      const c = view.query.lonLatToCell(s.lon, s.lat);
      if (c) start = { x: c[0], y: c[1] };
    } else if (s) start = { x: s.x, y: s.y };
    await view.query.ensure(start.x - 10, start.y - 10, start.x + 10, start.y + 10);
    const ground = this.world.groundAt(start.x, start.y) ?? 0;
    const speed = this.opts.speed ?? PLANE.cruiseSpeed * k;
    Object.assign(this.state, {
      x: start.x,
      y: start.y,
      h: ground + (this.opts.agl ?? PLANE.startAgl),
      heading,
      speed,
      climb: PLANE.startClimb,
      bank: 0,
      throttle: throttleFor(Math.max(speed, PLANE.cruiseSpeed * k), k),
    });
    const model = { group: PLANE.group, seed: PLANE.seed, size };
    this.shadowEntity = view.entities.add({ model: { ...model, part: 1 }, x: start.x, y: start.y, h: ground + PLANE.shadowLift, heading: this.state.heading });
    this.plane = view.entities.add({ model, x: start.x, y: start.y, h: this.state.h, heading: this.state.heading, silhouette: true });
    this.cam.snap(start.x, start.y, (this.state.h + ground) / 2);
    if (this.follow) view.camera.setFocus(this.cam.x, this.cam.y, this.cam.h);
    this.remember();
    if (this.opts.listen) this.unlisten = listenTo(this, this.opts.listen);
  }

  detach(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.plane?.remove();
    this.shadowEntity?.remove();
    this.plane = null;
    this.shadowEntity = null;
    this.view = null;
    this.keys.clear();
  }

  /** Put the plane at a place (cells) facing `heading`, at height `h` (default 2 steps over the ground), level, at cruise. */
  place(x: number, y: number, heading = this.state.heading, h?: number): void {
    const ground = this.world?.groundAt(x, y) ?? this.state.h - 2;
    const cruise = PLANE.cruiseSpeed * this.params.pace;
    Object.assign(this.state, { x, y, heading, h: h ?? ground + 2, speed: cruise, climb: 0, bank: 0, throttle: throttleFor(cruise, this.params.pace) });
    this.pilot = null;
    this.history.length = 0;
    this.remember();
    this.draw(0);
  }

  /** Fly through waypoints (cells, heights over the ground), as the scripted run does; null stops. */
  flyRoute(waypoints: readonly Waypoint[] | null): FlightPilot | null {
    this.pilot = waypoints?.length ? new FlightPilot(waypoints) : null;
    return this.pilot;
  }

  get following(): FlightPilot | null {
    return this.pilot;
  }

  /** Height over the ground (steps), or null where it isn't loaded. */
  get agl(): number | null {
    const g = this.world?.groundAt(this.state.x, this.state.y);
    return g === null || g === undefined ? null : this.state.h - g;
  }

  /** Low and slow over a road: it may land. */
  get canLand(): boolean {
    const view = this.view;
    const s = this.state;
    const agl = this.agl;
    if (!view || this.frozen || agl === null) return false;
    if (agl > PLANE.landAgl || s.speed > PLANE.landSpeed * this.params.pace) return false;
    return roadUnder(view.query, s.x, s.y, PLANE.roadReach) !== null;
  }

  input(): PlaneInput {
    // past its last waypoint the pilot circles it
    if (this.pilot && this.world) return this.pilot.input(this.state, this.world, this.params.pace);
    const k = this.keys;
    return {
      pitch: (k.has("arrowup") || k.has("w") ? 1 : 0) - (k.has("arrowdown") || k.has("s") ? 1 : 0),
      roll: (k.has("arrowright") || k.has("d") ? 1 : 0) - (k.has("arrowleft") || k.has("a") ? 1 : 0),
      throttle: (k.has("shift") || k.has("+") || k.has("=") ? 1 : 0) - (k.has("z") || k.has("-") ? 1 : 0),
    };
  }

  private remember(): void {
    const last = this.history[this.history.length - 1];
    if (last && this.time - last.t < 0.25) return;
    this.history.push({ t: this.time, s: { ...this.state } });
    while (this.history.length > 0 && this.time - this.history[0]!.t > PLANE.resetBack + 1) this.history.shift();
  }

  /** After a crash (or on R): back where it was `resetBack` seconds ago, at least `resetAgl` up, level, at cruise. */
  reset(): void {
    const back = this.history.find((h) => this.time - h.t <= PLANE.resetBack) ?? this.history[0];
    const s = back ? { ...back.s } : { ...this.state };
    const ground = this.world?.groundAt(s.x, s.y) ?? s.h;
    Object.assign(this.state, s, {
      h: Math.min(this.params.ceiling, Math.max(s.h, ground + PLANE.resetAgl)),
      climb: 0,
      bank: 0,
      speed: Math.max(s.speed, PLANE.cruiseSpeed * this.params.pace),
      throttle: throttleFor(PLANE.cruiseSpeed * this.params.pace, this.params.pace),
    });
    this.history.length = 0;
    this.remember();
  }

  /** Step the flight by dt seconds with an input (default the keys' or the pilot's), and draw. */
  step(dt: number, input: PlaneInput = this.input()): PlaneStep {
    if (!this.world || this.frozen) return this.last;
    const x0 = this.state.x;
    const y0 = this.state.y;
    this.last = flyPlane(this.state, this.frozen ? LEVEL_FLIGHT : input, this.world, this.params, dt);
    this.time += dt;
    this.distance += Math.hypot(this.state.x - x0, this.state.y - y0);
    if (this.last.crashed) {
      this.crashes++;
      this.crashedAt = this.time;
      this.lastCrash = { reason: this.last.crashed, x: this.state.x, y: this.state.y, h: this.state.h, agl: this.last.agl };
      this.reset();
    } else this.remember();
    // landing: low and slow over a road for a moment
    if (this.canLand) {
      this.landing += dt;
      if (this.autoLand && this.landing >= PLANE.landDwell && this.onLand) {
        this.landing = 0;
        this.onLand();
      }
    } else this.landing = 0;
    this.draw(dt);
    return this.last;
  }

  /**
   * Where the shadow lies: the highest ground under the plane's outline (its
   * middle, nose, tail and wing tips), so a flat shadow over rough ground
   * isn't buried in it.
   */
  shadowGround(): number | null {
    const w = this.world;
    if (!w) return null;
    const s = this.state;
    const c = Math.cos(s.heading);
    const n = Math.sin(s.heading);
    const half = this.params.length / 2;
    const span = PLANE.voxels.width / 32;
    let top: number | null = null;
    for (const [u, v] of [[0, 0], [half, 0], [-half, 0], [0, span], [0, -span]] as const) {
      const g = w.groundAt(s.x + c * u - n * v, s.y + n * u + c * v);
      if (g !== null) top = Math.max(top ?? -Infinity, g);
    }
    return top;
  }

  private ensureAhead(): void {
    const view = this.view;
    const s = this.state;
    if (!view) return;
    const ahead = 8 + s.speed * 1.5;
    const cx = s.x + Math.cos(s.heading) * ahead * 0.5;
    const cy = s.y + Math.sin(s.heading) * ahead * 0.5;
    if (Math.hypot(cx - this.ensured.x, cy - this.ensured.y) < 4) return;
    this.ensured = { x: cx, y: cy };
    void view.query.ensure(cx - ahead, cy - ahead, cx + ahead, cy + ahead);
  }

  private draw(dt: number): void {
    const view = this.view;
    const plane = this.plane;
    const shadow = this.shadowEntity;
    if (!view || !plane || !shadow || !this.world) return;
    const s = this.state;
    plane.moveTo(s.x, s.y, s.h);
    plane.heading = s.heading;
    const ground = this.world.groundAt(s.x, s.y);
    shadow.moveTo(s.x, s.y, (this.shadowGround() ?? shadow.h - PLANE.shadowLift) + PLANE.shadowLift);
    shadow.heading = s.heading;
    if (this.follow) {
      // between the plane and its shadow, so both stay in view
      const f = this.cam.update(s.x, s.y, ((ground ?? s.h) + s.h) / 2, s.heading, s.speed, dt);
      view.camera.setFocus(f.x, f.y, f.h);
    }
  }

  update(dt: number): void {
    if (!this.view) return;
    this.ensureAhead();
    if (!this.paused && !this.frozen) this.step(dt);
    else this.draw(dt);
  }

  keyDown(e: KeyInput): boolean {
    const k = e.key.toLowerCase();
    if (!["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d", "shift", "+", "=", "-", "z"].includes(k)) return false;
    this.keys.add(k);
    if (k.startsWith("arrow")) e.preventDefault?.();
    this.pilot = null;
    return true;
  }

  keyUp(e: KeyInput): void {
    this.keys.delete(e.key.toLowerCase());
  }

  blur(): void {
    this.keys.clear();
  }
}

export function planeController(opts: PlaneControllerOptions = {}): PlaneController {
  return new PlaneController(opts);
}
