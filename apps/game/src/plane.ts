import { wrapAngle } from "./car";
import type { PlaneWorld } from "./ground";
import { MAX_STEP, PLANE } from "./tuning";

/**
 * An arcade flight model, as pure functions over `PlaneWorld`.
 *
 * - **Throttle** sets a target speed between the stall speed and the top
 *   speed; the plane eases toward it. Climbing costs speed and diving adds it.
 * - **Pitch** sets the flight path angle (up to `maxClimb`, down to
 *   `maxDive`); with no input the nose levels out. Below the stall speed the
 *   nose drops.
 * - **Roll** banks the plane; the turn rate follows the bank, and with no
 *   input the wings level.
 * - **Collisions:** the ground (or water) under the plane or under its nose,
 *   or a tower's top, within `crashClearance`: a crash. The ceiling is a
 *   little above the world's highest ground.
 */

export interface PlaneState {
  x: number;
  y: number;
  /** Height (steps). */
  h: number;
  /** Facing (radians; x east, y south). */
  heading: number;
  /** Air speed (cells/s). */
  speed: number;
  /** Flight path angle (rad, positive climbing). */
  climb: number;
  /** Bank (rad, positive to the right). */
  bank: number;
  /** 0–1. */
  throttle: number;
}

export interface PlaneInput {
  /** −1 (dive) to 1 (climb). */
  pitch: number;
  /** −1 (left) to 1 (right). */
  roll: number;
  /** −1 to 1: the throttle moves at `throttleRate` per second while held. */
  throttle: number;
}

export const LEVEL_FLIGHT: Readonly<PlaneInput> = { pitch: 0, roll: 0, throttle: 0 };

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
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const toward = (v: number, target: number, rate: number) => v + clamp(target - v, -rate, rate);

/** The speed the throttle asks for (cells/s, paced). */
export function throttleSpeed(throttle: number, pace: number, stall = PLANE.stallSpeed): number {
  return (stall + (PLANE.maxSpeed - stall) * clamp(throttle, 0, 1)) * pace;
}

/** The throttle that holds a speed (inverse of throttleSpeed). */
export function throttleFor(speed: number, pace: number, stall = PLANE.stallSpeed): number {
  return clamp((speed / pace - stall) / (PLANE.maxSpeed - stall), 0, 1);
}

export function stepPlane(s: PlaneState, input: PlaneInput, world: PlaneWorld, p: PlaneParams, dt: number): PlaneStep {
  const k = p.pace;
  const stall = p.stall ?? PLANE.stallSpeed;
  s.throttle = clamp(s.throttle + clamp(input.throttle, -1, 1) * PLANE.throttleRate * dt, 0, 1);
  const stalled = s.speed < stall * k;
  // the nose: toward the stick, level without it, dropping in a stall
  const target = stalled
    ? -PLANE.maxDive
    : input.pitch >= 0
      ? clamp(input.pitch, 0, 1) * PLANE.maxClimb
      : clamp(input.pitch, -1, 0) * PLANE.maxDive;
  s.climb = toward(s.climb, target, (stalled ? PLANE.stallDrop : PLANE.pitchRate) * dt);
  // speed: toward the throttle's, less on a climb, more on a dive
  s.speed = toward(s.speed, throttleSpeed(s.throttle, k, stall), PLANE.accel * k * dt);
  s.speed = Math.max(0.5 * stall * k, s.speed - PLANE.climbCost * k * Math.sin(s.climb) * dt);
  // bank and turn
  s.bank = toward(s.bank, clamp(input.roll, -1, 1) * PLANE.maxBank, PLANE.rollRate * dt);
  s.heading = wrapAngle(s.heading + (s.bank / PLANE.maxBank) * PLANE.turnRate * dt);
  // move
  const run = s.speed * Math.cos(s.climb) * dt;
  s.x = clamp(s.x + Math.cos(s.heading) * run, 0.5, world.cellsX - 0.5);
  s.y = clamp(s.y + Math.sin(s.heading) * run, 0.5, world.cellsY - 0.5);
  s.h = Math.min(p.ceiling, s.h + Math.sin(s.climb) * s.speed * PLANE.stepsPerCell * dt);
  if (s.h >= p.ceiling && s.climb > 0) s.climb = toward(s.climb, 0, PLANE.pitchRate * dt);
  // what is under the plane and its nose
  const ground = world.groundAt(s.x, s.y);
  const nx = s.x + (Math.cos(s.heading) * p.length) / 2;
  const ny = s.y + (Math.sin(s.heading) * p.length) / 2;
  const nose = world.groundAt(nx, ny);
  const agl = ground === null ? null : s.h - ground;
  if (ground !== null && s.h - ground < PLANE.crashClearance) return { crashed: "ground", agl };
  if (nose !== null && s.h - nose < PLANE.crashClearance) return { crashed: "ground", agl };
  const tower = world.objectTopAt(s.x, s.y);
  if (tower !== null && s.h < tower) return { crashed: "tower", agl };
  return { crashed: null, agl };
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
