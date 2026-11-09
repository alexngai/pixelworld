import { CAR, MAX_STEP } from "./tuning";

/**
 * Arcade car physics, as pure functions over a small view of the world
 * (`CarWorld`), so they run the same in the game, in tests and in a script.
 *
 * - **Longitudinal:** throttle accelerates toward the surface's top speed
 *   (roads by class, slower off-road, nothing on water); the brake stops the
 *   car and then reverses it; coasting rolls to a stop. Over a surface's top
 *   speed (leaving the road) the car slows hard to it.
 * - **Slopes:** the grade over the car's length lowers the top speed when
 *   climbing and pulls the car down a slope while it rolls; steeper than
 *   `CAR.maxGrade` off-road (`CAR.roadMaxGrade` on a road) is a cliff,
 *   which stops it.
 * - **Steering:** the wheel eases toward the keys; the turn rate falls with
 *   speed and fades in as the car starts to roll; reversing turns the other
 *   way, as a car does.
 * - **Collisions:** the car's leading end is tested at the new place: the
 *   world's edge, water, a cliff, or what the world reports (buildings,
 *   vehicles). A bump stops the car and sends it back a little.
 */

export interface CarState {
  x: number;
  y: number;
  /** Height (steps): the ground it stands on. */
  h: number;
  /** Facing (radians; x east, y south). */
  heading: number;
  /** Along the heading (cells/s); negative in reverse. */
  speed: number;
  /** The wheel, −1 (left) to 1 (right). */
  steer: number;
}

export interface CarInput {
  /** 0–1 each. */
  throttle: number;
  brake: number;
  /** −1 (left) to 1 (right). */
  steer: number;
}

export const NO_INPUT: Readonly<CarInput> = { throttle: 0, brake: 0, steer: 0 };

/** The car in plan, for collision tests: its middle, heading, size (cells) and direction of motion. */
export interface CarBody {
  x: number;
  y: number;
  heading: number;
  length: number;
  width: number;
  /** 1 moving forward, −1 in reverse. */
  dir: 1 | -1;
}

/** What the car drives on. */
export interface CarWorld {
  readonly cellsX: number;
  readonly cellsY: number;
  /** The height to drive on (steps): the ground, or a bridge deck near the car's height `h`; null where nothing is loaded. */
  groundAt(x: number, y: number, h: number): number | null;
  /** The top speed there (cells/s at pace 1): by road class, or the surface off-road; 0 where the car can't go (water). */
  topSpeedAt(x: number, y: number, h: number): number;
  /** Whether a point is on a road's asphalt or a deck (where the car climbs whatever the road does). */
  onRoad(x: number, y: number, h: number): boolean;
  /** What stops a car body there (a building, a vehicle), or null. */
  obstacle(body: CarBody): string | null;
}

export interface CarParams {
  /** The level's pace (tuning.ts): every speed and acceleration scales by it. */
  pace: number;
  /** The car's size in plan (cells). */
  length: number;
  width: number;
}

/** What one step did. */
export interface CarStep {
  /** What stopped the car ("edge", "loading", "water", "cliff", or the world's obstacle), or null. */
  blocked: string | null;
  /** The surface's top speed under the car (cells/s, paced). */
  topSpeed: number;
  /** Grade along the car's heading (steps per cell; positive uphill ahead). */
  grade: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** An angle in (−π, π]. */
export function wrapAngle(a: number): number {
  a = a % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  else if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Full-lock turn rate (rad/s) at a speed: falls with speed, and fades in as the car starts to roll. */
export function turnRate(speed: number, pace: number): number {
  const v = Math.abs(speed);
  const fast = clamp(v / (CAR.turnFadeSpeed * pace), 0, 1);
  const grip = clamp(v / (CAR.turnGripSpeed * pace), 0, 1);
  return (CAR.turnRate + (CAR.turnRateFast - CAR.turnRate) * fast) * grip;
}

/** The top speed in a direction of motion on a grade (steps/cell, positive uphill ahead). */
export function climbLimit(top: number, grade: number): number {
  return top * (1 - (1 - CAR.climbKeep) * clamp(grade / CAR.maxGrade, 0, 1));
}

/** Advance the car by one step of at most MAX_STEP seconds. */
export function stepCar(s: CarState, input: CarInput, world: CarWorld, p: CarParams, dt: number): CarStep {
  const k = p.pace;
  s.steer += clamp(input.steer - s.steer, -CAR.steerRate * dt, CAR.steerRate * dt);
  const top = world.topSpeedAt(s.x, s.y, s.h) * k;
  const half = p.length / 2;
  const c = Math.cos(s.heading);
  const sn = Math.sin(s.heading);
  const front = world.groundAt(s.x + c * half, s.y + sn * half, s.h);
  const back = world.groundAt(s.x - c * half, s.y - sn * half, s.h);
  const grade = front !== null && back !== null ? (front - back) / p.length : 0;
  const forwardTop = climbLimit(top, grade);
  const reverseTop = climbLimit(Math.min(CAR.reverseSpeed * k, top), -grade);

  let v = s.speed;
  const throttle = clamp(input.throttle, 0, 1);
  const brake = clamp(input.brake, 0, 1);
  if (throttle > 0) {
    if (v < -0.05) v = Math.min(0, v + CAR.brake * k * throttle * dt); // throttle while reversing: brake first
    else if (forwardTop > 0) v += CAR.accel * k * throttle * Math.max(0, 1 - (v / forwardTop) ** 2) * dt;
  }
  if (brake > 0) {
    if (v > 0.05) v = Math.max(0, v - CAR.brake * k * brake * dt);
    else if (throttle === 0 && reverseTop > 0) v -= CAR.reverseAccel * k * brake * Math.max(0, 1 - (v / reverseTop) ** 2) * dt;
  }
  if (throttle === 0 && brake === 0) {
    const r = (CAR.roll * k + CAR.drag * Math.abs(v)) * dt;
    v = Math.abs(v) <= r ? 0 : v - Math.sign(v) * r;
  }
  // over the surface's top speed (off the road): slow down hard
  if (v > forwardTop) v = Math.max(forwardTop, v - CAR.overSpeedDecel * k * dt);
  if (v < -reverseTop) v = Math.min(-reverseTop, v + CAR.overSpeedDecel * k * dt);
  // a rolling car is pulled down the slope; a stopped one holds
  if (Math.abs(v) > 0.05) v -= CAR.gravity * k * grade * dt;

  s.heading = wrapAngle(s.heading + s.steer * turnRate(v, k) * Math.sign(v) * dt);
  const dist = v * dt;
  if (dist === 0) {
    s.speed = 0;
    return { blocked: null, topSpeed: top, grade };
  }
  const hc = Math.cos(s.heading);
  const hs = Math.sin(s.heading);
  const nx = s.x + hc * dist;
  const ny = s.y + hs * dist;
  const dir: 1 | -1 = v >= 0 ? 1 : -1;
  // the leading end at the new place
  const lx = nx + hc * half * dir;
  const ly = ny + hs * half * dir;
  let blocked: string | null = null;
  if (lx < 0.1 || ly < 0.1 || lx > world.cellsX - 0.1 || ly > world.cellsY - 0.1) blocked = "edge";
  const ground = blocked ? null : world.groundAt(nx, ny, s.h);
  const lead = blocked ? null : world.groundAt(lx, ly, s.h);
  // the trailing end, where the car stands now: the grade is measured over the car's whole length
  const trail = blocked ? null : world.groundAt(s.x - hc * half * dir, s.y - hs * half * dir, s.h);
  if (!blocked && (ground === null || lead === null)) blocked = "loading";
  else if (!blocked && world.topSpeedAt(lx, ly, s.h) <= 0) blocked = "water";
  else if (!blocked) {
    // roads are cut into the terrain: what they climb, the car climbs
    const grade = world.onRoad(lx, ly, s.h) ? CAR.roadMaxGrade : CAR.maxGrade;
    if (Math.abs(lead! - (trail ?? s.h)) > grade * (p.length + Math.abs(dist)) + 0.05) blocked = "cliff";
    // and the middle doesn't drop or jump (a deck's edge under the car)
    else if (Math.abs(ground! - s.h) > grade * Math.abs(dist) + 0.35) blocked = "cliff";
  }
  if (!blocked) blocked = world.obstacle({ x: nx, y: ny, heading: s.heading, length: p.length, width: p.width, dir });
  if (blocked) {
    s.speed = blocked !== "loading" && Math.abs(v) > 1 * k ? -v * CAR.bounce : 0;
    return { blocked, topSpeed: top, grade };
  }
  s.x = nx;
  s.y = ny;
  s.h = ground!;
  s.speed = v;
  return { blocked: null, topSpeed: top, grade };
}

/** Advance the car by dt seconds in steps of at most MAX_STEP; reports the last blocked reason in the time. */
export function driveCar(s: CarState, input: CarInput, world: CarWorld, p: CarParams, dt: number): CarStep {
  const n = Math.max(1, Math.ceil(dt / MAX_STEP - 1e-9));
  let last: CarStep = { blocked: null, topSpeed: 0, grade: 0 };
  let blocked: string | null = null;
  for (let i = 0; i < n; i++) {
    last = stepCar(s, input, world, p, dt / n);
    blocked ??= last.blocked;
  }
  return { ...last, blocked };
}

/** Oriented rectangles in plan overlap (separating axes). */
export function boxesOverlap(
  a: { x: number; y: number; heading: number; length: number; width: number },
  b: { x: number; y: number; heading: number; length: number; width: number },
): boolean {
  const axes = [a.heading, a.heading + Math.PI / 2, b.heading, b.heading + Math.PI / 2];
  const corners = (r: typeof a) => {
    const c = Math.cos(r.heading);
    const s = Math.sin(r.heading);
    const out: [number, number][] = [];
    for (const [u, w] of [[1, 1], [1, -1], [-1, -1], [-1, 1]] as const) {
      const du = (u * r.length) / 2;
      const dw = (w * r.width) / 2;
      out.push([r.x + c * du - s * dw, r.y + s * du + c * dw]);
    }
    return out;
  };
  const ca = corners(a);
  const cb = corners(b);
  for (const t of axes) {
    const ax = Math.cos(t);
    const ay = Math.sin(t);
    let a0 = Infinity;
    let a1 = -Infinity;
    let b0 = Infinity;
    let b1 = -Infinity;
    for (const [x, y] of ca) {
      const d = x * ax + y * ay;
      a0 = Math.min(a0, d);
      a1 = Math.max(a1, d);
    }
    for (const [x, y] of cb) {
      const d = x * ax + y * ay;
      b0 = Math.min(b0, d);
      b1 = Math.max(b1, d);
    }
    if (a1 < b0 || b1 < a0) return false;
  }
  return true;
}
