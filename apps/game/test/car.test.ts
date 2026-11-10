import { describe, expect, it } from "vitest";
import {
  NO_INPUT,
  boxesOverlap,
  climbLimit,
  driveCar,
  turnRate,
  wrapAngle,
  type CarBody,
  type CarInput,
  type CarParams,
  type CarState,
  type CarWorld,
} from "../src/car";
import { CAR } from "../src/tuning";

/**
 * The car's physics against a made-up world: flat desert at height 0, a road
 * along 4 ≤ y < 6 (top speed 11), water east of x = 60 off it, a cliff (8 steps up)
 * north of y = 1, a gentle ramp (1 step per cell) for 20 ≤ x < 30 south of
 * y = 10, and a wall reported as a building for x ≥ 90 on the road.
 */
function world(): CarWorld {
  const ground = (x: number, y: number) => (y < 1 ? 8 : y >= 10 && x >= 20 ? Math.min(10, x - 20) : 0);
  return {
    cellsX: 100,
    cellsY: 40,
    groundAt: (x, y) => ground(x, y),
    topSpeedAt: (x, y) => (y >= 4 && y < 6 ? 11 : x > 60 ? 0 : 2.8),
    onRoad: (_x, y) => y >= 4 && y < 6,
    obstacle: (b: CarBody) => (b.y >= 4 && b.y < 6 && b.x + (b.length / 2) * b.dir >= 90 ? "building" : null),
  };
}

const PARAMS: CarParams = { pace: 1, length: 0.7, width: 0.3 };
const car = (x: number, y: number, heading = 0, speed = 0): CarState => ({ x, y, h: 0, heading, speed, steer: 0 });
const go = (s: CarState, input: Partial<CarInput>, seconds: number, w = world(), p = PARAMS) => {
  let blocked: string | null = null;
  for (let t = 0; t < seconds - 1e-9; t += 1 / 30) blocked = driveCar(s, { ...NO_INPUT, ...input }, w, p, 1 / 30).blocked ?? blocked;
  return blocked;
};

describe("car physics", () => {
  it("accelerates toward the road's top speed, faster at full throttle, and scales with the pace", () => {
    const a = car(2, 5);
    go(a, { throttle: 1 }, 1);
    expect(a.speed).toBeGreaterThan(3);
    expect(a.speed).toBeLessThan(5);
    go(a, { throttle: 1 }, 6);
    expect(a.speed).toBeGreaterThan(10.5);
    expect(a.speed).toBeLessThanOrEqual(11 + 1e-9);
    expect(a.y).toBeCloseTo(5, 9); // straight along the road
    const slow = car(2, 5);
    go(slow, { throttle: 1 }, 8, world(), { ...PARAMS, pace: 0.5 });
    expect(slow.speed).toBeCloseTo(5.5, 0);
  });

  it("slows to the surface's speed off the road, and stops when coasting", () => {
    const s = car(2, 5, 0, 10);
    s.heading = Math.PI / 2; // south, off the road
    go(s, { throttle: 1 }, 3);
    expect(s.y).toBeGreaterThan(6);
    expect(s.speed).toBeCloseTo(2.8, 1);
    const c = car(2, 5, 0, 6);
    go(c, {}, 20);
    expect(c.speed).toBe(0);
    expect(c.x).toBeGreaterThan(2 + 6); // it rolled a fair way first
  });

  it("brakes to a stop, then reverses slowly", () => {
    const s = car(30, 5, 0, 10);
    go(s, { brake: 1 }, 0.5);
    expect(s.speed).toBeLessThan(5);
    go(s, { brake: 1 }, 1);
    expect(s.speed).toBeLessThan(0);
    go(s, { brake: 1 }, 6);
    expect(s.speed).toBeCloseTo(-CAR.reverseSpeed, 1);
    const x = s.x;
    go(s, { throttle: 1 }, 0.1); // throttle while reversing brakes first
    expect(s.speed).toBeGreaterThan(-1.5);
    expect(s.speed).toBeLessThan(0);
    expect(s.x).toBeLessThan(x);
  });

  it("can't drive into water or up a cliff, and bumps back from them", () => {
    const s = car(57, 8, 0, 3);
    const blocked = go(s, { throttle: 1 }, 2);
    expect(blocked).toBe("water");
    expect(s.x + PARAMS.length / 2).toBeLessThanOrEqual(60 + 0.01);
    const c = car(5, 2, -Math.PI / 2, 4);
    expect(go(c, { throttle: 1 }, 2)).toBe("cliff");
    expect(c.y).toBeGreaterThan(1);
    expect(c.h).toBe(0);
    // the bump sends it back a little
    const b = car(5, 2.5, -Math.PI / 2, 4);
    let speed = 0;
    for (let i = 0; i < 30 && speed >= 0; i++) {
      driveCar(b, NO_INPUT, world(), PARAMS, 1 / 30);
      speed = b.speed;
    }
    expect(speed).toBeLessThan(0);
  });

  it("stops at what the world reports (a building), and pulls away from it in reverse", () => {
    const s = car(80, 5, 0, 0);
    expect(go(s, { throttle: 1 }, 4)).toBe("building");
    expect(s.x + PARAMS.length / 2).toBeLessThan(90);
    go(s, { throttle: 0, brake: 1 }, 1);
    expect(s.x).toBeLessThan(89);
  });

  it("climbs a ramp slower than it drives on the flat, at the ground's height", () => {
    const flat = car(10, 15, 0, 0);
    const ramp = car(19, 15, 0, 0);
    go(flat, { throttle: 1 }, 2);
    go(ramp, { throttle: 1 }, 2);
    expect(ramp.h).toBeCloseTo(ramp.x - 20, 6);
    expect(ramp.x - 19).toBeLessThan(flat.x - 10);
    expect(climbLimit(10, 0)).toBe(10);
    expect(climbLimit(10, CAR.maxGrade)).toBeCloseTo(10 * CAR.climbKeep, 9);
    expect(climbLimit(10, -1)).toBe(10);
  });

  it("turns less at speed, not at all standing still, and the other way in reverse", () => {
    expect(turnRate(0, 1)).toBe(0);
    expect(turnRate(3, 1)).toBeGreaterThan(turnRate(11, 1));
    expect(turnRate(11, 1)).toBeCloseTo(CAR.turnRateFast, 9);
    const fwd = car(10, 20, 0, 5);
    go(fwd, { steer: 1, throttle: 0.3 }, 0.5);
    expect(fwd.heading).toBeGreaterThan(0.3); // right is clockwise: toward +y
    const rev = car(10, 20, 0, -2);
    go(rev, { steer: 1, brake: 1 }, 0.5);
    expect(rev.heading).toBeLessThan(0);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(wrapAngle(-Math.PI / 2 - 2 * Math.PI)).toBeCloseTo(-Math.PI / 2, 9);
  });

  it("is deterministic and independent of how a second is cut into steps", () => {
    const a = car(2, 5);
    const b = car(2, 5);
    for (let i = 0; i < 60; i++) driveCar(a, { throttle: 1, brake: 0, steer: 0.2 }, world(), PARAMS, 1 / 60);
    for (let i = 0; i < 6; i++) driveCar(b, { throttle: 1, brake: 0, steer: 0.2 }, world(), PARAMS, 1 / 6);
    expect(b).toEqual(a);
  });

  it("finds overlapping vehicles in plan, turned or not", () => {
    const a = { x: 0, y: 0, heading: 0, length: 1, width: 0.4 };
    expect(boxesOverlap(a, { x: 0.9, y: 0, heading: 0, length: 1, width: 0.4 })).toBe(true);
    expect(boxesOverlap(a, { x: 1.1, y: 0, heading: 0, length: 1, width: 0.4 })).toBe(false);
    expect(boxesOverlap(a, { x: 0, y: 0.45, heading: 0, length: 1, width: 0.4 })).toBe(false);
    // a car across our nose
    expect(boxesOverlap(a, { x: 0.65, y: 0, heading: Math.PI / 2, length: 1, width: 0.4 })).toBe(true);
    expect(boxesOverlap(a, { x: 0.75, y: 0.75, heading: Math.PI / 4, length: 0.8, width: 0.3 })).toBe(false);
  });
});
