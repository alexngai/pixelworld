import { CAR, PLANE } from "./tuning";
import { turnRate, wrapAngle, type CarInput, type CarState } from "./car";
import type { PlaneInput, PlaneParams, PlaneState } from "./plane";
import type { PlaneWorld } from "./ground";
import type { Point } from "./roads";

/**
 * Autopilots: the scripted run's drivers, and the road assist's steering.
 * They produce inputs (keys, in effect) for the same physics a player
 * drives: a car follows a path by pure pursuit, slowing for the bends ahead;
 * a plane flies to waypoints at a height over the terrain.
 */

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A polyline with distances along it. */
export class Path {
  readonly cum: Float64Array;
  readonly length: number;

  constructor(readonly points: readonly Point[]) {
    this.cum = new Float64Array(points.length);
    for (let i = 1; i < points.length; i++)
      this.cum[i] = this.cum[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    this.length = points.length ? this.cum[points.length - 1]! : 0;
  }

  /** The point at distance s along (clamped). */
  at(s: number): Point {
    const p = this.points;
    if (s <= 0 || p.length < 2) return p[0]!;
    if (s >= this.length) return p[p.length - 1]!;
    let lo = 0;
    let hi = p.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid]! <= s) lo = mid;
      else hi = mid;
    }
    const seg = this.cum[hi]! - this.cum[lo]!;
    const t = seg > 0 ? (s - this.cum[lo]!) / seg : 0;
    return { x: p[lo]!.x + (p[hi]!.x - p[lo]!.x) * t, y: p[lo]!.y + (p[hi]!.y - p[lo]!.y) * t };
  }

  /** The distance along of the point nearest (x, y), searching [s0, s1]. */
  project(x: number, y: number, s0 = 0, s1 = this.length): number {
    const p = this.points;
    let best = s0;
    let bestD = Infinity;
    for (let i = 0; i + 1 < p.length; i++) {
      if (this.cum[i + 1]! < s0 || this.cum[i]! > s1) continue;
      const a = p[i]!;
      const b = p[i + 1]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? clamp(((x - a.x) * dx + (y - a.y) * dy) / len2, 0, 1) : 0;
      const d = Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
      const s = this.cum[i]! + Math.sqrt(len2) * t;
      if (d < bestD && s >= s0 && s <= s1) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }
}

/** Steering toward a point: the wheel for the heading error (P control). */
export function steerToward(state: { x: number; y: number; heading: number; speed: number }, target: Point, gain = 2.2): number {
  const want = Math.atan2(target.y - state.y, target.x - state.x);
  const err = wrapAngle(want - state.heading);
  return clamp(err * gain * Math.sign(state.speed || 1), -1, 1);
}

/** The fastest a car can go into a bend that turns by `angle` over `dist` cells and still make it (cells/s). */
export function bendSpeed(angle: number, dist: number, pace: number, top: number): number {
  const kappa = (2 * Math.sin(Math.min(Math.PI / 2, Math.abs(angle)))) / Math.max(0.5, dist);
  if (kappa < 1e-6) return top;
  // v·κ ≤ 0.8·turnRate(v): the turn rate falls with speed, so settle it in a few rounds
  let v = top;
  for (let i = 0; i < 4; i++) v = Math.min(top, (0.8 * turnRate(Math.max(v, CAR.turnGripSpeed * pace), pace)) / kappa);
  return v;
}

/**
 * A road path for driving: resampled every `step` cells and averaged over
 * ±`window` cells, so the drawn roads' octilinear stairs (D-049) become the
 * lines and curves a driver takes, within a third of a cell of the cells'
 * centres.
 */
export function smoothPath(points: readonly Point[], step = 0.25, window = 1): Point[] {
  const raw = new Path(points);
  if (raw.length <= step) return [...points];
  const n = Math.max(2, Math.ceil(raw.length / step) + 1);
  const samples: Point[] = [];
  for (let i = 0; i < n; i++) samples.push(raw.at((raw.length * i) / (n - 1)));
  const k = Math.max(1, Math.round(window / (raw.length / (n - 1))));
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    // the ends keep their place; the window narrows toward them
    const w = Math.min(k, i, n - 1 - i);
    let sx = 0;
    let sy = 0;
    for (let j = i - w; j <= i + w; j++) {
      sx += samples[j]!.x;
      sy += samples[j]!.y;
    }
    out.push({ x: sx / (2 * w + 1), y: sy / (2 * w + 1) });
  }
  return out;
}

/** The fastest a car takes a curve of curvature κ (1/cells): v·κ ≤ `share` of the turn rate at v. */
export function curveSpeed(kappa: number, pace: number, top: number, share = 0.8): number {
  if (kappa < 1e-6) return top;
  let v = top;
  for (let i = 0; i < 5; i++) v = Math.min(top, (share * turnRate(Math.max(v, CAR.turnGripSpeed * pace), pace)) / kappa);
  return v;
}

export interface CarPilotOptions {
  /** Look-ahead for steering: seconds of travel, and its bounds (cells). */
  lookTime?: number;
  lookMin?: number;
  lookMax?: number;
  /** Speed limit (cells/s), on top of the physics' own (roads). */
  maxSpeed?: number;
  /** Stop at the path's end (else drive through it). */
  stop?: boolean;
}

/**
 * Drives a car along a path: pure pursuit with a pull back onto the line
 * for the wheel; for the pedals, the speed each stretch's curvature allows,
 * braked for in time.
 */
export class CarPilot {
  /** Distance along the path reached. */
  s = 0;
  readonly path: Path;
  /** Curvature (1/cells) at each of the path's points. */
  private readonly kappa: Float64Array;

  constructor(
    points: readonly Point[],
    private readonly opts: CarPilotOptions = {},
  ) {
    this.path = new Path(smoothPath(points));
    const p = this.path.points;
    this.kappa = new Float64Array(p.length);
    const span = 6; // points either side (1.5 cells): the bend a car takes, not the stairs' ripple
    for (let i = 0; i < p.length; i++) {
      const a = p[Math.max(0, i - span)]!;
      const m = p[i]!;
      const b = p[Math.min(p.length - 1, i + span)]!;
      const turn = Math.abs(wrapAngle(Math.atan2(b.y - m.y, b.x - m.x) - Math.atan2(m.y - a.y, m.x - a.x)));
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      this.kappa[i] = len > 1e-6 ? (2 * Math.sin(turn / 2)) / (len / 2) : 0;
    }
  }

  /** Within reach of the path's end. */
  get done(): boolean {
    return this.path.length - this.s < 1.2;
  }

  /** The speed the curves ahead allow now, braking for each in time (cells/s). */
  speedAhead(pace: number, cap: number, v: number): number {
    const path = this.path;
    const decel = CAR.brake * pace * 0.4;
    const reach = (v * v) / (2 * decel) + 2;
    let want = cap;
    const p = path.points;
    // the path's points from here to braking distance
    let i = 0;
    while (i < p.length - 1 && path.cum[i + 1]! < this.s) i++;
    for (; i < p.length && path.cum[i]! - this.s <= reach; i++) {
      const d = Math.max(0, path.cum[i]! - this.s);
      const vc = curveSpeed(this.kappa[i]!, pace, cap);
      want = Math.min(want, Math.sqrt(vc * vc + 2 * decel * d));
    }
    if (this.opts.stop !== false) want = Math.min(want, Math.sqrt(2 * decel * Math.max(0, path.length - this.s - 0.8)));
    return want;
  }

  input(car: CarState, pace: number, top: number): CarInput {
    const path = this.path;
    // keep the progress near the car: a little behind and ahead of where it was
    this.s = Math.max(this.s, path.project(car.x, car.y, this.s - 1, this.s + 8));
    const v = Math.max(0, car.speed);
    const look = clamp(v * (this.opts.lookTime ?? 0.3), this.opts.lookMin ?? 1, this.opts.lookMax ?? 4);
    const target = path.at(this.s + look);
    // pure pursuit, and a pull back onto the line against the corner-cutting it does
    const here = path.at(this.s);
    const a = path.at(this.s - 0.5);
    const b = path.at(this.s + 0.5);
    const tl = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const cross = ((b.x - a.x) * (car.y - here.y) - (b.y - a.y) * (car.x - here.x)) / tl; // > 0: right of the line
    const steer = clamp(steerToward(car, target) - (1.2 / (1 + v / 6)) * cross * Math.sign(car.speed || 1), -1, 1);
    const cap = Math.min(top, this.opts.maxSpeed ?? Infinity);
    let want = this.speedAhead(pace, cap, v);
    // and the heading error now: slow down to make a sharp turn back onto the line
    const err = Math.abs(wrapAngle(Math.atan2(target.y - car.y, target.x - car.x) - car.heading));
    want = Math.min(want, bendSpeed(err, look, pace, cap));
    if (v < want - 0.15) return { throttle: 1, brake: 0, steer };
    if (v > want + 0.4) return { throttle: 0, brake: clamp((v - want) / 3, 0.2, 1), steer };
    return { throttle: 0.35, brake: 0, steer };
  }
}

/** A waypoint for the plane: a place and a height over the ground there (steps), or a landing approach. */
export interface Waypoint {
  x: number;
  y: number;
  /** Height over the highest ground ahead (steps). */
  agl: number;
  /** Fly this slowly (cells/s, paced); default cruise. */
  speed?: number;
}

/** Flies a plane through waypoints, following the terrain ahead. */
export class FlightPilot {
  i = 0;

  constructor(readonly waypoints: readonly Waypoint[]) {}

  /** Every waypoint passed (it then circles the last). */
  get done(): boolean {
    return this.i >= this.waypoints.length;
  }

  /** The highest ground in a cone ahead (the way it may turn, too), `reach` cells out. */
  static groundAhead(plane: PlaneState, world: PlaneWorld, reach: number): number | null {
    let ground = -Infinity;
    for (const a of [-0.7, -0.35, 0, 0.35, 0.7]) {
      const c = Math.cos(plane.heading + a);
      const s = Math.sin(plane.heading + a);
      for (let d = 0; d <= reach; d += 0.5) ground = Math.max(ground, world.groundAt(plane.x + c * d, plane.y + s * d) ?? ground);
    }
    return Number.isFinite(ground) ? ground : null;
  }

  input(plane: PlaneState, world: PlaneWorld, params: PlaneParams): PlaneInput {
    let wp = this.waypoints[this.i];
    while (wp && Math.hypot(wp.x - plane.x, wp.y - plane.y) < 1.5) wp = this.waypoints[++this.i];
    // past the last: circle it, at its height and speed
    wp ??= this.waypoints[this.waypoints.length - 1];
    if (!wp) return { pitch: 0, roll: 0, throttle: 0 };
    // bank into the turn toward it, and roll to that bank
    const want = Math.atan2(wp.y - plane.y, wp.x - plane.x);
    const err = wrapAngle(want - plane.heading);
    const bank = clamp(err * 1.6, -PLANE.pilotBank, PLANE.pilotBank);
    const roll = clamp((bank - plane.bank) * 2.5 - plane.rollRate * 0.1, -1, 1);
    // height: over the highest ground on the way ahead (a slow approach looks only just ahead)
    const approach = wp.speed !== undefined;
    const reach = approach ? 1.5 : 2.5 * plane.speed + 2;
    const ground = FlightPilot.groundAhead(plane, world, reach);
    const targetH = (ground ?? plane.h) + wp.agl;
    let climb = clamp((targetH - plane.h) * 0.3, -PLANE.pilotDive, PLANE.pilotClimb);
    // about to meet the ground: climb
    const near = FlightPilot.groundAhead(plane, world, Math.max(2, plane.speed * 0.6));
    if (near !== null && near > plane.h - (approach ? 0.35 : 0.6)) climb = PLANE.pilotClimb;
    // the stick (an angle of attack) to bring the path there
    const pitch = clamp((climb - plane.climb) * 4, -1, 1);
    const speed = wp.speed ?? PLANE.cruiseSpeed * params.pace;
    const throttle = clamp((speed - plane.speed) * 2, -1, 1);
    return { pitch, roll, throttle };
  }
}
