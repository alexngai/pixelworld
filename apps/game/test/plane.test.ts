import { describe, expect, it } from "vitest";
import type { PlaneWorld } from "../src/ground";
import { wrapAngle } from "../src/car";
import { FlightPilot } from "../src/pilot";
import { LEVEL_FLIGHT, aoaFor, flyPlane, settleNose, throttleFor, throttleSpeed, type PlaneInput, type PlaneParams, type PlaneState } from "../src/plane";
import { FLY_PACE, PLANE, pace } from "../src/tuning";

/**
 * The flight model over a made-up world: flat ground at 2 steps, a ridge
 * 12 steps high for 40 ≤ x < 44, and a tower 9 steps tall in cell (20, 20).
 * Aerobatics fly over open ground with a high ceiling.
 */
const WORLD: PlaneWorld = {
  cellsX: 200,
  cellsY: 200,
  groundAt: (x) => (x >= 40 && x < 44 ? 12 : 2),
  objectTopAt: (x, y) => (Math.floor(x) === 20 && Math.floor(y) === 20 ? 9 : null),
};
const OPEN: PlaneWorld = { cellsX: 2000, cellsY: 2000, groundAt: () => 2, objectTopAt: () => null };
const PARAMS: PlaneParams = { pace: 1, ceiling: 30, length: 1.25 };
const HIGH: PlaneParams = { ...PARAMS, ceiling: 200 };
/** Level, wings level, at a speed (default cruise), with the angle of attack that holds the height. */
const plane = (x: number, y: number, h: number, heading = 0, speed = PLANE.cruiseSpeed): PlaneState => {
  const s: PlaneState = { x, y, h, heading, speed, climb: 0, bank: 0, rollRate: 0, alpha: aoaFor(speed, 0, 0, PARAMS), slip: 0, throttle: throttleFor(speed, 1), yaw: 0, pitch: 0, roll: 0 };
  settleNose(s);
  return s;
};
const fly = (s: PlaneState, input: Partial<PlaneInput>, seconds: number, world = WORLD, params = world === OPEN ? HIGH : PARAMS) => {
  let crashed: string | null = null;
  for (let t = 0; t < seconds - 1e-9 && !crashed; t += 1 / 30) crashed = flyPlane(s, { ...LEVEL_FLIGHT, ...input }, world, params, 1 / 30).crashed;
  return crashed;
};

describe("the flight model", () => {
  it("holds its height and speed in level flight", () => {
    const s = plane(5, 100, 6);
    expect(fly(s, {}, 3)).toBeNull();
    expect(s.h).toBeCloseTo(6, 6);
    expect(s.speed).toBeCloseTo(PLANE.cruiseSpeed, 3);
    expect(s.x).toBeCloseTo(5 + 3 * PLANE.cruiseSpeed, 1);
    expect(s.pitch).toBeGreaterThan(0); // the nose rides a little over the path
  });

  it("pulls up: the path follows the nose and climbs; let go, it levels out; pushed, it dives and gains speed", () => {
    const s = plane(50, 100, 6);
    fly(s, { pitch: 0.4 }, 1);
    expect(s.climb).toBeGreaterThan((10 * Math.PI) / 180);
    expect(s.pitch).toBeGreaterThan(s.climb); // the nose over the path
    expect(s.h).toBeGreaterThan(6.5);
    expect(s.speed).toBeLessThan(PLANE.cruiseSpeed);
    fly(s, {}, 3);
    expect(Math.abs(s.climb)).toBeLessThan(0.03);
    const d = plane(50, 100, 25);
    fly(d, { pitch: -0.6 }, 1);
    expect(d.h).toBeLessThan(24);
    expect(d.speed).toBeGreaterThan(PLANE.cruiseSpeed);
  });

  it("goes as fast as the throttle says, between its slowest and the top speed", () => {
    expect(throttleSpeed(0, 1)).toBe(PLANE.slowSpeed);
    expect(throttleSpeed(1, 1)).toBe(PLANE.maxSpeed);
    expect(throttleSpeed(1, 0.5)).toBe(PLANE.maxSpeed / 2);
    expect(throttleSpeed(throttleFor(5, 1), 1)).toBeCloseTo(5, 9);
    // a walking level's lower slowest: the plane flies it, holding its height
    expect(throttleSpeed(0, 1, PLANE.walkSlowSpeed)).toBe(PLANE.walkSlowSpeed);
    expect(throttleSpeed(throttleFor(5, 1, PLANE.walkSlowSpeed), 1, PLANE.walkSlowSpeed)).toBeCloseTo(5, 9);
    const slow = { ...plane(5, 100, 10), throttle: 0 };
    let crashed: string | null = null;
    for (let t = 0; t < 10 && !crashed; t += 1 / 30) crashed = flyPlane(slow, LEVEL_FLIGHT, WORLD, { ...PARAMS, slowest: PLANE.walkSlowSpeed }, 1 / 30).crashed;
    expect(crashed).toBeNull();
    expect(Math.abs(slow.speed - PLANE.walkSlowSpeed)).toBeLessThan(0.05);
    expect(Math.abs(slow.h - 10)).toBeLessThan(0.5); // it sinks a little while it slows, and levels out
    expect(Math.abs(slow.climb)).toBeLessThan(0.01);
    expect(slow.pitch).toBeGreaterThan(0.1); // slow: the nose rides high
    const s = plane(50, 100, 10); // past the ridge
    fly(s, { throttle: 1 }, 5);
    expect(s.throttle).toBe(1);
    fly(s, {}, 8);
    expect(s.speed).toBeCloseTo(PLANE.maxSpeed, 1);
  });

  it("banks into a turn holding its height hands off, tighter when slow, and levels its wings without input", () => {
    const turn = (v: number) => {
      const t = plane(1000, 1000, 20, 0, v);
      fly(t, { roll: 1 }, 0.3, OPEN);
      fly(t, { roll: 1e-9 }, 1.5, OPEN); // hold the bank (a tiny stick: no levelling), and settle
      const h0 = t.heading;
      fly(t, { roll: 1e-9 }, 0.4, OPEN);
      return { rate: wrapAngle(t.heading - h0) / 0.4, s: t };
    };
    const fast = turn(7);
    const slow = turn(3.5);
    expect(fast.rate).toBeGreaterThan(0.3); // right: toward +y
    expect(slow.rate).toBeGreaterThan(fast.rate); // tighter when slow
    expect(fast.rate).toBeCloseTo((PLANE.gravity * Math.tan(fast.s.bank)) / fast.s.speed, 1); // a level turn: g·tan(bank)/speed
    expect(Math.abs(fast.s.h - 20)).toBeLessThan(0.6);
    expect(fast.s.speed).toBeLessThan(7); // the turn's load bled some speed
    fly(fast.s, {}, 3, OPEN);
    expect(Math.abs(fast.s.bank)).toBeLessThan(0.02);
  });

  it("yaws with the rudder: the nose slips, the path follows, the wings roll after", () => {
    const s = plane(100, 100, 15);
    fly(s, { yaw: 1 }, 1);
    expect(s.slip).toBeGreaterThan(0.1);
    expect(s.yaw).toBeGreaterThan(s.heading); // the nose right of the path
    expect(s.heading).toBeGreaterThan(0.05);
    expect(s.bank).toBeGreaterThan(0);
    fly(s, {}, 3);
    expect(Math.abs(s.slip)).toBeLessThan(0.01);
  });

  it("loops with the stick held back: up, over the top upside down, down, and round to where it began", () => {
    const s = { ...plane(1000, 1000, 20, 0, PLANE.maxSpeed), throttle: 1 };
    let phase = 0; // 0 climbing, 1 over the top, 2 diving, 3 round again
    for (let t = 0; t < 8 && phase < 3; t += 1 / 30) {
      expect(flyPlane(s, { ...LEVEL_FLIGHT, pitch: 1 }, OPEN, HIGH, 1 / 30).crashed).toBeNull();
      if (phase === 0 && s.climb > 1.3) phase = 1;
      else if (phase === 1 && Math.abs(s.bank) > 2.5 && s.climb < 0.3) phase = 2; // upside down at the top
      else if (phase === 2 && s.climb < -1.3) phase = 2.5;
      else if (phase === 2.5 && s.climb > 0) phase = 3;
    }
    expect(phase).toBe(3);
    expect(Math.abs(wrapAngle(s.heading))).toBeLessThan(0.1); // the same way it went in
    expect(Math.abs(s.bank)).toBeLessThan(0.1); // upright
    expect(Math.abs(s.y - 1000)).toBeLessThan(0.5); // in its own plane
    expect(Math.abs(s.h - 20)).toBeLessThan(10);
  });

  it("rolls all the way round with the stick held to the side, its path near straight", () => {
    const s = plane(1000, 1000, 40);
    let inverted = false;
    for (let t = 0; t < (2 * Math.PI) / PLANE.rollRate + 0.15; t += 1 / 30) {
      flyPlane(s, { ...LEVEL_FLIGHT, roll: 1 }, OPEN, HIGH, 1 / 30);
      inverted ||= Math.abs(s.bank) > 3;
    }
    expect(inverted).toBe(true);
    expect(Math.abs(s.bank)).toBeLessThan(0.35); // round again
    expect(Math.abs(wrapAngle(s.heading))).toBeLessThan(0.6);
    expect(s.h).toBeGreaterThan(40 - 6);
  });

  it("hands off upside down, it rolls the short way upright and flies on", () => {
    const s = plane(1000, 1000, 40);
    // rolled right past upside down (the bank wraps to −π)
    for (let t = 0; t < 2 && !(s.bank < -2.9); t += 1 / 30) flyPlane(s, { ...LEVEL_FLIGHT, roll: 1 }, OPEN, HIGH, 1 / 30);
    expect(s.bank).toBeLessThan(-2.9);
    fly(s, {}, 0.3, OPEN);
    expect(s.rollRate).toBeGreaterThan(0); // on round to the right: the short way
    fly(s, {}, 3, OPEN);
    expect(Math.abs(s.bank)).toBeLessThan(0.05);
    expect(Math.abs(s.climb)).toBeLessThan(0.05);
    expect(s.h).toBeGreaterThan(40 - 10);
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

  // the plane's settings on each map: the flying map's pace, the driving map's (400 m cells), and the walking map's (its own slowest)
  const MAPS: [string, PlaneParams][] = [
    ["flying", { ...HIGH, pace: 1 }],
    ["driving", { ...HIGH, pace: pace(400, FLY_PACE.ref, FLY_PACE.floor) }],
    ["walking", { ...HIGH, pace: FLY_PACE.floor, slowest: PLANE.walkSlowSpeed }],
  ];
  it.each(MAPS)("never stalls on the %s map: slow with the stick held back it flies on, and hands off it levels out and holds its height", (_, p) => {
    const slowest = (p.slowest ?? PLANE.slowSpeed) * p.pace;
    const s: PlaneState = { x: 1000, y: 1000, h: 40, heading: 0, speed: slowest * 0.5, climb: 0, bank: 0, rollRate: 0, alpha: 0, slip: 0, throttle: 0, yaw: 0, pitch: 0, roll: 0 };
    let lowest = Infinity;
    for (let t = 0; t < 3; t += 1 / 30) {
      expect(flyPlane(s, { ...LEVEL_FLIGHT, pitch: 1 }, OPEN, p, 1 / 30).crashed).toBeNull();
      lowest = Math.min(lowest, s.speed);
      expect(s.alpha).toBeLessThanOrEqual(PLANE.maxAoa + 1e-9); // the wing's most, no further: the nose never drops on its own
    }
    expect(lowest).toBeGreaterThanOrEqual(slowest * PLANE.floorShare - 1e-9); // never slower than holds it up
    for (let t = 0; t < 5; t += 1 / 30) flyPlane(s, LEVEL_FLIGHT, OPEN, p, 1 / 30);
    expect(Math.abs(s.climb)).toBeLessThan(0.05);
    expect(Math.abs(s.bank)).toBeLessThan(0.05);
    // at its slowest, hands off, it holds its height
    const h = s.h;
    for (let t = 0; t < 5; t += 1 / 30) flyPlane(s, LEVEL_FLIGHT, OPEN, p, 1 / 30);
    expect(Math.abs(s.h - h)).toBeLessThan(0.5);
  });

  it("flies a pilot through waypoints over a ridge without hitting it", () => {
    const s = plane(5, 100, 4);
    const pilot = new FlightPilot([
      { x: 60, y: 100, agl: 2 },
      { x: 60, y: 140, agl: 2 },
    ]);
    let crashed: string | null = null;
    for (let t = 0; t < 30 && !pilot.done && !crashed; t += 1 / 30)
      crashed = flyPlane(s, pilot.input(s, WORLD, PARAMS), WORLD, PARAMS, 1 / 30).crashed;
    expect(crashed).toBeNull();
    expect(pilot.done).toBe(true);
    // past its last waypoint it circles it
    for (let t = 0; t < 20; t += 1 / 30) flyPlane(s, pilot.input(s, WORLD, PARAMS), WORLD, PARAMS, 1 / 30);
    expect(Math.hypot(s.x - 60, s.y - 140)).toBeLessThan(10);
  });
});
