import { wrapAngle } from "./car";
import type { PlaneWorld } from "./ground";
import { MAX_STEP, PLANE } from "./tuning";

/**
 * The flight model, as pure functions over `PlaneWorld`: a point mass with a
 * full 3D attitude, tuned to play rather than to certify. Nothing limits the
 * attitude: hold the stick and the plane loops or rolls all the way round.
 *
 * - **Stick:** back and forth sets the angle of attack (the nose over the
 *   path), so the pull, up to `maxLoad` g, curves the path: held back, the
 *   plane loops. Side to side rolls it about its path at `rollRate`. The
 *   rudder slips the nose off the path and turns the path flat. Each follows
 *   with a little lag, so the plane has weight.
 * - **Hands off** (stick centred): it rolls the short way to wings level and
 *   flies the angle of attack that holds its height, easing its path level.
 * - **Lift** grows with the angle of attack and the square of the speed, up
 *   to the stall: past it the lift goes, the nose drops and a banked wing
 *   drops further, until the plane flies again. Slow down and the nose must
 *   ride higher to hold the height; too slow and it sinks.
 * - **Turns:** banked lift turns the path; pulling turns it tighter.
 * - **Speed:** toward the throttle's; climbing costs speed, diving adds it,
 *   and pulling g's or slipping bleeds it. A loop wants speed going in.
 * - **Collisions:** the ground (or water) under the plane or under its nose,
 *   or a tower's top, within `crashClearance`: a crash. The ceiling is a
 *   little above the world's highest ground.
 *
 * Axes: x east, y south, z up, a cell across as tall as `stepsPerCell` steps
 * (the path's own space). The path is a heading, a climb and a bank about
 * it; the nose is the path pitched up by the angle of attack and yawed by the
 * slip, and its yaw, pitch and roll (Rz·Ry·Rx, as objects.ts tilts a sprite's
 * boxes) are worked out each step for drawing.
 */

export interface PlaneState {
  x: number;
  y: number;
  /** Height (steps). */
  h: number;
  /** The flight path's direction (radians; x east, y south). */
  heading: number;
  /** Air speed (cells/s). */
  speed: number;
  /** Flight path angle (rad, positive climbing; ±π/2 straight up or down). */
  climb: number;
  /** Bank about the path (rad, positive right wing down; ±π inverted). */
  bank: number;
  /** Roll rate about the path (rad/s). */
  rollRate: number;
  /** Angle of attack: the nose over the path (rad). */
  alpha: number;
  /** The nose off the path to the right (rad): the rudder's slip. */
  slip: number;
  /** Stalled: past the stalling angle, and not yet back under `stallExit` of it. */
  stalled?: boolean;
  /** 0–1. */
  throttle: number;
  /** The nose's yaw, pitch and roll (rad; pitch −π/2 to π/2): worked out each step, for drawing. */
  yaw: number;
  pitch: number;
  roll: number;
}

export interface PlaneInput {
  /** −1 (push) to 1 (pull): the angle of attack between pushing `maxPush` g and pulling `maxLoad` g; 0 holds the height. */
  pitch: number;
  /** −1 (left) to 1 (right): a roll rate; 0 (with no pitch either) levels the wings. */
  roll: number;
  /** −1 to 1: the throttle moves at `throttleRate` per second while held. */
  throttle: number;
  /** −1 (left) to 1 (right): the rudder (default 0). */
  yaw?: number;
}

export const LEVEL_FLIGHT: Readonly<PlaneInput> = { pitch: 0, roll: 0, throttle: 0, yaw: 0 };

export interface PlaneParams {
  /** The level's pace (tuning.ts). */
  pace: number;
  /** Highest the plane may fly (steps). */
  ceiling: number;
  /** The plane's length (cells): its nose is tested too. */
  length: number;
  /** The stall speed (cells/s at pace 1; default PLANE.stallSpeed): the throttle's slowest. */
  stall?: number;
}

export interface PlaneStep {
  /** "ground", "water"… what the plane hit, or null. */
  crashed: string | null;
  /** Height over the ground (steps), or null where nothing is loaded. */
  agl: number | null;
  /** The wing is past its stalling angle. */
  stalled?: boolean;
}

type V3 = [number, number, number];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Ease v toward a target with time constant tau (exact for any dt). */
const ease = (v: number, target: number, tau: number, dt: number) => target + (v - target) * Math.exp(-dt / tau);
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: V3, b: V3, k: number): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const mix = (a: V3, ka: number, b: V3, kb: number): V3 => [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb];
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** The part of a across u (u a unit vector). */
const across = (a: V3, u: V3): V3 => add(a, u, -dot(a, u));

/** The axes of a frame at a yaw, pitch and roll: forward, right, up (Rz·Ry·Rx). */
export function axes(yaw: number, pitch: number, roll: number): { f: V3; r: V3; n: V3 } {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  return {
    f: [cy * cp, sy * cp, sp],
    r: [cy * sr * sp - sy * cr, sy * sr * sp + cy * cr, -sr * cp],
    n: [-cy * cr * sp - sy * sr, -sy * cr * sp + cy * sr, cr * cp],
  };
}

/** Yaw, pitch and roll of a frame with these axes (straight up or down: no roll). */
export function angles(f: V3, r: V3, n: V3): { yaw: number; pitch: number; roll: number } {
  const pitch = Math.asin(clamp(f[2], -1, 1));
  if (Math.abs(f[2]) > 1 - 1e-9) return { yaw: Math.atan2(-r[0], r[1]), pitch, roll: 0 };
  return { yaw: Math.atan2(f[1], f[0]), pitch, roll: Math.atan2(-r[2], n[2]) };
}

/** The speed the throttle asks for (cells/s, paced). */
export function throttleSpeed(throttle: number, pace: number, stall = PLANE.stallSpeed): number {
  return (stall + (PLANE.maxSpeed - stall) * clamp(throttle, 0, 1)) * pace;
}

/** The throttle that holds a speed (inverse of throttleSpeed). */
export function throttleFor(speed: number, pace: number, stall = PLANE.stallSpeed): number {
  return clamp((speed / pace - stall) / (PLANE.maxSpeed - stall), 0, 1);
}

/** The wing: the most lift it gives (as a share of cruise's), and the angle of attack (rad) for cruise's. */
function wing(stall: number): { clMax: number; a1: number } {
  const clMax = (PLANE.cruiseSpeed / (stall * PLANE.stallMargin)) ** 2;
  return { clMax, a1: PLANE.stallAoa / clMax };
}

/** The lift (a share of cruise's) at an angle of attack: linear up to the stall, falling off past it. */
function liftAt(alpha: number, a1: number, clMax: number): number {
  const a = Math.abs(alpha);
  const cl = a <= PLANE.stallAoa ? a / a1 : clMax * (1 - 0.5 * Math.min(1, (a - PLANE.stallAoa) / PLANE.stallAoa));
  return Math.sign(alpha) * cl;
}

/**
 * The load (g) that holds the height at a bank: 1/cos in a turn, up to 2 g at
 * 60°; fading to none at knife edge (a roll goes on straight rather than
 * turning hard); pushing 1 g at most inverted.
 */
function bankLoad(bank: number): number {
  const c = Math.cos(bank);
  return c >= 0.5 ? 1 / c : c >= 0 ? 4 * c : c;
}

/** The angle of attack (rad) that holds the height on a path at a speed (paced) and bank: negative inverted. */
export function aoaFor(speed: number, climb: number, bank: number, p: PlaneParams): number {
  const { a1 } = wing(p.stall ?? PLANE.stallSpeed);
  const q = (speed / p.pace / PLANE.cruiseSpeed) ** 2;
  return (a1 * Math.cos(climb) * bankLoad(bank)) / Math.max(1e-3, q);
}

/** Work out the nose's yaw, pitch and roll from the path and the angle of attack and slip. */
export function settleNose(s: PlaneState): void {
  const { f: u, r: rho, n: nu } = axes(s.heading, s.climb, s.bank);
  const ca = Math.cos(s.alpha);
  const sa = Math.sin(s.alpha);
  const f1 = mix(u, ca, nu, sa);
  const n1 = mix(nu, ca, u, -sa);
  const cs = Math.cos(s.slip);
  const ss = Math.sin(s.slip);
  const f2 = mix(f1, cs, rho, ss);
  const r2 = mix(rho, cs, f1, -ss);
  Object.assign(s, angles(f2, r2, n1));
}

export function stepPlane(s: PlaneState, input: PlaneInput, world: PlaneWorld, p: PlaneParams, dt: number): PlaneStep {
  const k = p.pace;
  const stall = p.stall ?? PLANE.stallSpeed;
  const { clMax, a1 } = wing(stall);
  const G = PLANE.gravity;
  s.throttle = clamp(s.throttle + clamp(input.throttle, -1, 1) * PLANE.throttleRate * dt, 0, 1);
  const v = Math.max(0.3, s.speed / k); // pace-1 units below
  const q = (v / PLANE.cruiseSpeed) ** 2;
  const pIn = clamp(input.pitch, -1, 1);
  const rIn = clamp(input.roll, -1, 1);
  const yIn = clamp(input.yaw ?? 0, -1, 1);
  const cosB = Math.cos(s.bank);
  // the angle of attack that holds the height, and the pull and push the stick reaches (no further than the stall)
  const hold = clamp(aoaFor(s.speed, s.climb, s.bank, p), -PLANE.stallAoa, PLANE.stallAoa);
  const pull = Math.max(hold, Math.min(PLANE.stallAoa * 1.05, (a1 * PLANE.maxLoad) / q));
  const push = Math.min(hold, Math.max(-PLANE.stallAoa, (-a1 * PLANE.maxPush) / q));
  // a stall breaks past the stalling angle and lasts until the wing is well clear of it
  const stalled = (s.stalled = Math.abs(s.alpha) > PLANE.stallAoa || (!!s.stalled && Math.abs(s.alpha) > PLANE.stallAoa * PLANE.stallExit));

  // the stick: an angle of attack; hands off, the height-holding one, eased toward a level path
  let alphaCmd: number;
  if (pIn > 0) alphaCmd = hold + pIn * (pull - hold);
  else if (pIn < 0) alphaCmd = hold - pIn * (push - hold);
  else {
    const K = (G * q * Math.max(0.3, Math.abs(cosB))) / (a1 * v); // the path's response (1/s per rad)
    alphaCmd = clamp(hold - (Math.sign(cosB || 1) * PLANE.levelClimb * s.climb) / K, push, pull);
  }
  if (stalled) alphaCmd = Math.sign(s.alpha) * PLANE.stallAoa * 0.5; // the nose drops, whatever the stick says
  s.alpha = ease(s.alpha, alphaCmd, PLANE.pitchLag, dt);
  // the rudder: a slip
  s.slip = ease(s.slip, yIn * PLANE.maxSlip, PLANE.yawLag, dt);
  // roll: the stick's rate, or hands off, the short way back to wings level; a stalled wing drops; a slip rolls it
  let rollCmd = rIn !== 0 ? rIn * PLANE.rollRate : pIn === 0 ? -wrapAngle(s.bank) * PLANE.levelRoll : 0;
  if (stalled) rollCmd += Math.sign(s.bank) * PLANE.stallRoll;
  s.rollRate = ease(s.rollRate, rollCmd, PLANE.rollLag, dt);
  s.bank = wrapAngle(s.bank + (s.rollRate + s.slip * PLANE.slipRoll) * dt);

  // the path: the lift and gravity curve it toward its up (the wings' way), gravity and the slip across
  let { f: u, r: rho, n: nu } = axes(s.heading, s.climb, s.bank);
  const lift = G * liftAt(s.alpha, a1, clMax) * q;
  const up = ((lift + dot([0, 0, -G], nu)) / v) * dt;
  const side = ((dot([0, 0, -G], rho) + v * PLANE.slipTurn * Math.sqrt(q) * s.slip) / v) * dt;
  [u, nu] = [mix(u, Math.cos(up), nu, Math.sin(up)), mix(nu, Math.cos(up), u, -Math.sin(up))];
  [u, rho] = [mix(u, Math.cos(side), rho, Math.sin(side)), mix(rho, Math.cos(side), u, -Math.sin(side))];
  u = unit(u);
  rho = unit(across(rho, u));
  nu = unit(across(across(nu, u), rho));
  const path = angles(u, rho, nu);
  s.heading = path.yaw;
  s.climb = path.pitch;
  s.bank = path.roll;
  settleNose(s);
  // the load on the wing (1 in level flight), for the drag it costs
  const load = Math.abs(lift) / G;

  // speed (pace 1): toward the throttle's; less on a climb, more on a dive; g's and slip cost speed
  const target = throttleSpeed(s.throttle, 1, stall);
  let v1 = v + (Math.min(PLANE.maxAccel, PLANE.thrust * (target - v)) - PLANE.climbCost * u[2]) * dt;
  v1 -= (PLANE.loadDrag * Math.max(0, load - 1) + PLANE.slipDrag * Math.abs(s.slip) * v) * dt;
  s.speed = Math.max(0.3 * stall, v1) * k;

  // move
  const run = s.speed * dt;
  s.x = clamp(s.x + u[0] * run, 0.5, world.cellsX - 0.5);
  s.y = clamp(s.y + u[1] * run, 0.5, world.cellsY - 0.5);
  s.h = Math.min(p.ceiling, s.h + u[2] * run * PLANE.stepsPerCell);
  if (s.h >= p.ceiling && s.climb > 0) s.climb = 0; // at the top of the sky: along it
  // what is under the plane and its nose
  const ground = world.groundAt(s.x, s.y);
  const nx = s.x + (Math.cos(s.yaw) * p.length) / 2;
  const ny = s.y + (Math.sin(s.yaw) * p.length) / 2;
  const nose = world.groundAt(nx, ny);
  const agl = ground === null ? null : s.h - ground;
  if (ground !== null && s.h - ground < PLANE.crashClearance) return { crashed: "ground", agl, stalled };
  if (nose !== null && s.h - nose < PLANE.crashClearance) return { crashed: "ground", agl, stalled };
  const tower = world.objectTopAt(s.x, s.y);
  if (tower !== null && s.h < tower) return { crashed: "tower", agl, stalled };
  return { crashed: null, agl, stalled };
}

/** Advance the plane by dt in steps of at most MAX_STEP; stops at a crash. */
export function flyPlane(s: PlaneState, input: PlaneInput, world: PlaneWorld, p: PlaneParams, dt: number): PlaneStep {
  const n = Math.max(1, Math.ceil(dt / MAX_STEP - 1e-9));
  let last: PlaneStep = { crashed: null, agl: null };
  for (let i = 0; i < n; i++) {
    last = stepPlane(s, input, world, p, dt / n);
    if (last.crashed) break;
  }
  return last;
}
