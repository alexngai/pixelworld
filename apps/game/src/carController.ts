import { listenTo, type Controller, type ControllerView, type Entity, type KeyInput } from "@pixelworld/engine";
import { levelScale, vehicleVoxels, type RouteNetwork } from "@pixelworld/sim";
import { NO_INPUT, driveCar, type CarInput, type CarParams, type CarState, type CarStep } from "./car";
import { Bob, Follow } from "./follow";
import { Decks, DriveWorld, type TrafficSource } from "./ground";
import { geoToPose, type GeoPose } from "./levels";
import { CarPilot, steerToward } from "./pilot";
import { angleBetween, nearestRoad, roadDirection, straightAhead, traceRoad } from "./roads";
import { CAR, DRIVE_PACE, TAKEOFF, pace } from "./tuning";

/**
 * The player's car (M4): a controller on the engine's public API. It owns
 * the car entity (the style's `vehicle.car.player`, with a silhouette where
 * the world hides it), steps the physics (car.ts) against the world as the
 * queries read it (ground.ts), and drives the camera with a look-ahead.
 *
 * Keys: W/↑ throttle, S/↓ brake then reverse, A/D or ←/→ steer. With the
 * road assist on (G), a car on a road with the wheel straight keeps to it.
 * A script drives it through `step(dt, input)` with `paused` set, or hands
 * it a path to follow (`drivePath`).
 */

export type Place = { x: number; y: number } | { lon: number; lat: number };

export interface CarControllerOptions {
  /** Where the car starts: a cell or a lon/lat; it is put on the nearest road within `snap` cells. */
  start?: Place;
  /** Facing (radians); else toward `toward` along the road; else along the road. */
  heading?: number;
  toward?: Place;
  /** Starting speed (cells/s). */
  speed?: number;
  /** A place and heading from another level (a landing), through the geo grids; wins over `start`. */
  pose?: GeoPose;
  /** Cells to look for a road around the start (default 6; 0 keeps the place as given). */
  snap?: number;
  /** The world's routes (bridge decks). */
  routes?: RouteNetwork | null;
  /** Traffic to collide with. */
  traffic?: () => TrafficSource | null;
  /** The camera follows the car (default true). */
  follow?: boolean;
  /** Listen for keys here; without, the app forwards them. */
  listen?: { keys?: EventTarget | null };
}

export class CarController implements Controller {
  readonly id = "car";
  /** The car's physical state (cells, steps, radians, cells/s). */
  readonly state: CarState = { x: 0, y: 0, h: 0, heading: 0, speed: 0, steer: 0 };
  params: CarParams = { pace: 1, length: 0.7, width: 0.3 };
  /** The real-time loop doesn't step the physics (a script does, with `step`). */
  paused = false;
  /** Held still, input ignored: during a level change. */
  frozen = false;
  /** Keep to the road while the wheel is straight. */
  assist = true;
  /** The camera follows the car. */
  follow: boolean;
  /** Raise the drawn car (steps): it lifts off at a take-off. */
  lift = 0;
  /** The last step's report. */
  last: CarStep = { blocked: null, topSpeed: 0, grade: 0 };
  /** The last thing the car bumped into (a reason and what it was), for the HUD. */
  bump: { reason: string; what: string | null; t: number } | null = null;
  /** Seconds driven (physics time). */
  time = 0;
  /** Cells driven, and of them off the roads' asphalt. */
  distance = 0;
  offRoad = 0;
  /** The start asked for was outside this world: the car started at the world's start. */
  outside = false;
  private view: ControllerView | null = null;
  private entity: Entity | null = null;
  private world: DriveWorld | null = null;
  private pilot: CarPilot | null = null;
  private readonly keys = new Set<string>();
  private readonly cam = new Follow();
  private readonly bob = new Bob();
  private unlisten: (() => void) | null = null;
  private ensured = { x: NaN, y: NaN };

  constructor(private readonly opts: CarControllerOptions = {}) {
    this.follow = opts.follow ?? true;
  }

  /** The car entity (once attached). */
  get car(): Entity {
    if (!this.entity) throw new Error("the car controller isn't attached to a view");
    return this.entity;
  }

  /** The world the physics reads (once attached). */
  get drive(): DriveWorld {
    if (!this.world) throw new Error("the car controller isn't attached to a view");
    return this.world;
  }

  async attach(view: ControllerView): Promise<void> {
    this.view = view;
    const m = view.world.manifest;
    const k = pace(m.scale.metersPerCell, DRIVE_PACE.ref, DRIVE_PACE.floor) / view.world.renderScale;
    // the drawn car: a little larger than a traffic car at this level
    const scale = levelScale(m.scale.metersPerCell, m.level, {
      heightStretch: m.depiction?.heightStretch,
      maxScale: m.depiction?.vehicleScale,
    });
    const vox = vehicleVoxels("car", scale, view.world.renderScale);
    const size = {
      length: vox.length + CAR.extraVoxels.length,
      width: vox.width + CAR.extraVoxels.width,
      height: vox.height + CAR.extraVoxels.height,
    };
    const perCell = 16 * view.world.renderScale;
    this.params = { pace: k, length: size.length / perCell, width: size.width / perCell };
    this.world = new DriveWorld(view.query, view.world.cellsX, view.world.cellsY, new Decks(this.opts.routes ?? null), this.opts.traffic ?? (() => null));

    // from another level (a landing): the place and heading through this level's geo grid
    const posed = this.opts.pose ? geoToPose(view.query, this.opts.pose) : null;
    const start = posed ?? this.resolve(this.opts.start) ?? this.home();
    this.outside = !!(this.opts.pose || this.opts.start) && !posed && !this.resolve(this.opts.start);
    await view.query.ensure(start.x - 8, start.y - 8, start.x + 8, start.y + 8);
    const placed = this.placeOnRoad(start.x, start.y, this.opts.snap ?? 6, this.opts.heading ?? posed?.heading);
    this.entity = view.entities.add({
      model: { group: CAR.group, seed: CAR.seed, size },
      x: placed.x,
      y: placed.y,
      h: this.state.h,
      heading: this.state.heading,
      silhouette: true,
    });
    this.state.speed = this.opts.speed ?? 0;
    this.cam.snap(this.state.x, this.state.y, this.state.h);
    if (this.follow) view.camera.setFocus(this.state.x, this.state.y, this.state.h);
    if (this.opts.listen) this.unlisten = listenTo(this, this.opts.listen);
  }

  detach(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.entity?.remove();
    this.entity = null;
    this.view = null;
    this.keys.clear();
  }

  private home(): { x: number; y: number } {
    const m = this.view!.world.manifest;
    const s = m.start ?? { x: Math.floor(m.cellsX / 2), y: Math.floor(m.cellsY / 2) };
    return { x: s.x + 0.5, y: s.y + 0.5 };
  }

  private resolve(p: Place | undefined): { x: number; y: number } | null {
    if (!p || !this.view) return null;
    if ("lon" in p) {
      const c = this.view.query.lonLatToCell(p.lon, p.lat);
      return c ? { x: c[0], y: c[1] } : null;
    }
    return { x: p.x, y: p.y };
  }

  /** Put the car on the nearest road to a place (within `snap` cells), facing along it; returns where. */
  private placeOnRoad(x: number, y: number, snap: number, heading?: number): { x: number; y: number } {
    const view = this.view!;
    const q = view.query;
    const road = snap > 0 ? nearestRoad(q, x, y, snap) : null;
    const px = road ? road.x : x;
    const py = road ? road.y : y;
    if (heading === undefined) {
      const toward = this.resolve(this.opts.toward);
      const want = toward ? Math.atan2(toward.y - py, toward.x - px) : 0;
      heading = road ? roadDirection(road.road, want) : want;
    } else if (road) heading = angleBetween(roadDirection(road.road, heading), heading) < Math.PI / 4 ? roadDirection(road.road, heading) : heading;
    this.state.x = px;
    this.state.y = py;
    this.state.heading = heading;
    this.state.h = this.world!.groundAt(px, py, q.heightAt(px, py) ?? 0) ?? 0;
    this.state.steer = 0;
    this.bob.reset();
    return { x: px, y: py };
  }

  /** Put the car at a place (cells), on the ground, facing `heading` (default: as it was), stopped. */
  place(x: number, y: number, heading = this.state.heading): void {
    const q = this.view?.query;
    this.state.x = x;
    this.state.y = y;
    this.state.heading = heading;
    this.state.speed = 0;
    this.state.steer = 0;
    this.state.h = this.world?.groundAt(x, y, q?.heightAt(x, y) ?? this.state.h) ?? this.state.h;
    this.bob.reset();
    this.pilot = null;
    this.draw(0);
  }

  /** Back onto the nearest road (within 12 cells), stopped, facing along it (R). */
  toRoad(): boolean {
    const view = this.view;
    if (!view) return false;
    const road = nearestRoad(view.query, this.state.x, this.state.y, 12);
    if (!road) return false;
    this.place(road.x, road.y, roadDirection(road.road, this.state.heading));
    return true;
  }

  /** The take-off roll, drawn only: on along the heading at its speed, rising `climb` steps a second. */
  coast(dt: number, climb: number): void {
    const s = this.state;
    const view = this.view;
    if (!view) return;
    s.x = Math.max(0.5, Math.min(view.world.cellsX - 0.5, s.x + Math.cos(s.heading) * s.speed * dt));
    s.y = Math.max(0.5, Math.min(view.world.cellsY - 0.5, s.y + Math.sin(s.heading) * s.speed * dt));
    s.h = Math.max(s.h, view.query.heightAt(s.x, s.y) ?? s.h);
    this.lift += climb * dt;
    this.draw(dt);
  }

  /** Drive along a path (cell points), as the scripted run does; null stops following. */
  drivePath(points: readonly { x: number; y: number }[] | null, opts: ConstructorParameters<typeof CarPilot>[1] = {}): CarPilot | null {
    this.pilot = points && points.length > 1 ? new CarPilot(points, opts) : null;
    return this.pilot;
  }

  get following(): CarPilot | null {
    return this.pilot;
  }

  /** Fast enough on a road running straight ahead to take off (TAKEOFF). */
  get canTakeOff(): boolean {
    const view = this.view;
    const s = this.state;
    if (!view || !this.world || this.frozen) return false;
    if (s.speed < TAKEOFF.speed * this.params.pace) return false;
    if (!this.world.roadClassAt(s.x, s.y, s.h)) return false;
    return straightAhead(view.query, s.x, s.y, s.heading, Math.ceil(TAKEOFF.straight * this.params.pace) + 2) >= TAKEOFF.straight * this.params.pace;
  }

  /** The input the keys give (with the road assist), or the path's. */
  input(): CarInput {
    const s = this.state;
    if (this.pilot && !this.pilot.done) return this.pilot.input(s, this.params.pace, this.last.topSpeed || this.world!.topSpeedAt(s.x, s.y, s.h) * this.params.pace);
    const k = this.keys;
    return this.inputFrom({
      throttle: k.has("arrowup") || k.has("w") ? 1 : 0,
      brake: k.has("arrowdown") || k.has("s") ? 1 : 0,
      steer: (k.has("arrowright") || k.has("d") ? 1 : 0) - (k.has("arrowleft") || k.has("a") ? 1 : 0),
    });
  }

  /** The input for pedals and a wheel held as keys would hold them, with the road assist while the wheel is straight. */
  inputFrom(held: Partial<CarInput>): CarInput {
    const input: CarInput = { throttle: 0, brake: 0, steer: 0, ...held };
    if (this.assist && !input.steer && this.state.speed > 1) input.steer = this.assistSteer();
    return input;
  }

  /** The road assist: steer along the road ahead when the car runs along it (within 35°). */
  assistSteer(): number {
    const view = this.view;
    const s = this.state;
    if (!view || !this.world?.roadClassAt(s.x, s.y, s.h)) return 0;
    const pts = traceRoad(view.query, s.x, s.y, s.heading, 8, Math.PI / 3);
    if (pts.length < 2) return 0;
    const look = Math.max(1.5, Math.min(5, s.speed * 0.4));
    // the traced centre line, from the car's cell on
    let target = pts[pts.length - 1]!;
    for (const p of pts) {
      const ahead = (p.x - s.x) * Math.cos(s.heading) + (p.y - s.y) * Math.sin(s.heading);
      if (ahead >= look) {
        target = p;
        break;
      }
    }
    const err = angleBetween(Math.atan2(target.y - s.y, target.x - s.x), s.heading);
    return err < (35 * Math.PI) / 180 ? steerToward(s, target, 1.8) : 0;
  }

  /** Step the physics by dt seconds with an input (default the keys'), and draw. */
  step(dt: number, input: CarInput = this.input()): CarStep {
    if (!this.world || this.frozen) return this.last;
    const x0 = this.state.x;
    const y0 = this.state.y;
    this.last = driveCar(this.state, this.frozen ? NO_INPUT : input, this.world, this.params, dt);
    this.time += dt;
    const moved = Math.hypot(this.state.x - x0, this.state.y - y0);
    this.distance += moved;
    if (moved > 0 && !this.world.onRoad(this.state.x, this.state.y, this.state.h)) this.offRoad += moved;
    if (this.last.blocked && this.last.blocked !== "loading")
      this.bump = { reason: this.last.blocked, what: this.last.blocked === "building" || this.last.blocked === "vehicle" ? this.world.lastHit : null, t: this.time };
    this.draw(dt);
    return this.last;
  }

  /** Load the terrain around and ahead of the car, so its queries answer. */
  private ensureAhead(): void {
    const view = this.view;
    const s = this.state;
    if (!view) return;
    const ahead = 6 + Math.abs(s.speed) * 1.5;
    const cx = s.x + Math.cos(s.heading) * ahead * 0.5;
    const cy = s.y + Math.sin(s.heading) * ahead * 0.5;
    if (Math.hypot(cx - this.ensured.x, cy - this.ensured.y) < 4) return;
    this.ensured = { x: cx, y: cy };
    void view.query.ensure(cx - ahead, cy - ahead, cx + ahead, cy + ahead);
  }

  /** Move the entity and the camera to the car. */
  private draw(dt: number): void {
    const view = this.view;
    const e = this.entity;
    if (!view || !e) return;
    const s = this.state;
    const bob = this.bob.update(s.h, dt);
    e.moveTo(s.x, s.y, s.h + bob + this.lift);
    e.heading = s.heading;
    if (this.follow) {
      const f = this.cam.update(s.x, s.y, s.h, s.heading, s.speed, dt);
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
    if (k === "g") {
      this.assist = !this.assist;
      return true;
    }
    if (!["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d"].includes(k)) return false;
    this.keys.add(k);
    if (k.startsWith("arrow")) e.preventDefault?.();
    this.pilot = null; // the player takes the wheel
    return true;
  }

  keyUp(e: KeyInput): void {
    this.keys.delete(e.key.toLowerCase());
  }

  blur(): void {
    this.keys.clear();
  }
}

/** The player's car controller. */
export function carController(opts: CarControllerOptions = {}): CarController {
  return new CarController(opts);
}
