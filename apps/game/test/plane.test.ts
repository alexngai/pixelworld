import { describe, expect, it } from "vitest";
import type { PlaneWorld } from "../src/ground";
import { FlightPilot } from "../src/pilot";
import { LEVEL_FLIGHT, flyPlane, throttleFor, throttleSpeed, type PlaneInput, type PlaneParams, type PlaneState } from "../src/plane";
import { PLANE } from "../src/tuning";

/**
 * The flight model over a made-up world: flat ground at 2 steps, a ridge
 * 12 steps high for 40 ≤ x < 44, and a tower 9 steps tall in cell (20, 20).
 */
const WORLD: PlaneWorld = {
  cellsX: 200,
  cellsY: 200,
  groundAt: (x) => (x >= 40 && x < 44 ? 12 : 2),
  objectTopAt: (x, y) => (Math.floor(x) === 20 && Math.floor(y) === 20 ? 9 : null),
};
const PARAMS: PlaneParams = { pace: 1, ceiling: 30, length: 1.25 };
const plane = (x: number, y: number, h: number, heading = 0): PlaneState => ({
  x,
  y,
  h,
  heading,
  speed: PLANE.cruiseSpeed,
  climb: 0,
  bank: 0,
  throttle: throttleFor(PLANE.cruiseSpeed, 1),
});
const fly = (s: PlaneState, input: Partial<PlaneInput>, seconds: number, world = WORLD) => {
  let crashed: string | null = null;
  for (let t = 0; t < seconds - 1e-9 && !crashed; t += 1 / 30) crashed = flyPlane(s, { ...LEVEL_FLIGHT, ...input }, world, PARAMS, 1 / 30).crashed;
  return crashed;
};

describe("the flight model", () => {
  it("holds its height and speed in level flight", () => {
    const s = plane(5, 100, 6);
    expect(fly(s, {}, 3)).toBeNull();
    expect(s.h).toBeCloseTo(6, 6);
    expect(s.speed).toBeCloseTo(PLANE.cruiseSpeed, 3);
    expect(s.x).toBeCloseTo(5 + 3 * PLANE.cruiseSpeed, 1);
  });

  it("climbs, and levels out without input; dives and gains speed", () => {
    const s = plane(5, 100, 6);
    fly(s, { pitch: 1 }, 2);
    expect(s.h).toBeGreaterThan(9);
    expect(s.climb).toBeCloseTo(PLANE.maxClimb, 2);
    expect(s.speed).toBeLessThan(PLANE.cruiseSpeed);
    fly(s, {}, 2);
    expect(s.climb).toBeCloseTo(0, 6);
    const d = plane(5, 100, 25);
    fly(d, { pitch: -1 }, 1.5);
    expect(d.h).toBeLessThan(21);
    expect(d.speed).toBeGreaterThan(PLANE.cruiseSpeed);
  });

  it("goes as fast as the throttle says, between the stall and the top speed", () => {
    expect(throttleSpeed(0, 1)).toBe(PLANE.stallSpeed);
    expect(throttleSpeed(1, 1)).toBe(PLANE.maxSpeed);
    expect(throttleSpeed(1, 0.5)).toBe(PLANE.maxSpeed / 2);
    expect(throttleSpeed(throttleFor(5, 1), 1)).toBeCloseTo(5, 9);
    const s = plane(5, 100, 10);
    fly(s, { throttle: 1 }, 5);
    expect(s.throttle).toBe(1);
    fly(s, {}, 5);
    expect(s.speed).toBeCloseTo(PLANE.maxSpeed, 1);
  });

  it("banks into a turn and levels its wings without input", () => {
    const s = plane(100, 100, 10);
    fly(s, { roll: 1 }, 1);
    expect(s.bank).toBeCloseTo(PLANE.maxBank, 3);
    expect(s.heading).toBeGreaterThan(0.4); // right: toward +y
    fly(s, {}, 1);
    expect(s.bank).toBeCloseTo(0, 6);
    const full = plane(100, 100, 10);
    fly(full, { roll: -1 }, (2 * Math.PI) / PLANE.turnRate + 0.6);
    expect(Math.abs(full.heading)).toBeLessThan(0.5); // a whole circle, near where it began
    expect(Math.hypot(full.x - 100, full.y - 100)).toBeLessThan(4);
  });

  it("crashes into the ground, a ridge ahead or a tower, and not under the ceiling", () => {
    expect(fly(plane(5, 100, 4), { pitch: -1 }, 3)).toBe("ground");
    expect(fly(plane(30, 100, 8), {}, 4)).toBe("ground"); // the ridge
    expect(fly(plane(15, 20.5, 8), {}, 2)).toBe("tower");
    expect(fly(plane(15, 22.5, 8), {}, 2)).toBeNull(); // beside it
    const high = plane(5, 100, 28);
    fly(high, { pitch: 1 }, 3);
    expect(high.h).toBeLessThanOrEqual(30);
  });

  it("drops its nose when it stalls, and recovers", () => {
    const s = plane(5, 100, 20);
    s.speed = PLANE.stallSpeed * 0.8;
    s.throttle = 0;
    fly(s, { pitch: 1 }, 0.2);
    expect(s.climb).toBeLessThan(0);
    fly(s, { pitch: 1, throttle: 1 }, 3);
    expect(s.speed).toBeGreaterThan(PLANE.stallSpeed);
  });

  it("flies a pilot through waypoints over a ridge without hitting it", () => {
    const s = plane(5, 100, 4);
    const pilot = new FlightPilot([
      { x: 60, y: 100, agl: 2 },
      { x: 60, y: 140, agl: 2 },
    ]);
    let crashed: string | null = null;
    for (let t = 0; t < 30 && !pilot.done && !crashed; t += 1 / 30)
      crashed = flyPlane(s, pilot.input(s, WORLD, 1), WORLD, PARAMS, 1 / 30).crashed;
    expect(crashed).toBeNull();
    expect(pilot.done).toBe(true);
    // past its last waypoint it circles it
    for (let t = 0; t < 20; t += 1 / 30) flyPlane(s, pilot.input(s, WORLD, 1), WORLD, PARAMS, 1 / 30);
    expect(Math.hypot(s.x - 60, s.y - 140)).toBeLessThan(10);
  });
});
