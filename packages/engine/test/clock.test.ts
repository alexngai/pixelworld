import { describe, expect, it } from "vitest";
import { GameClock, MAX_FRAME_DT } from "../src/clock";

/** The view's game clock (D-073): what controllers, layers and `onFrame` get as `dt`. */
describe("the game clock", () => {
  it("holds game time at 0 until the first complete frame, the wall clock running", () => {
    const c = new GameClock();
    const before = c.tick(16);
    expect(before).toEqual({ dt: 0, realDt: 0.016, time: 0, started: false, paused: false });
    c.start();
    const after = c.tick(16);
    expect(after).toMatchObject({ dt: 0.016, realDt: 0.016, started: true });
    expect(c.time).toBeCloseTo(0.016, 9);
  });

  it("stops while paused and runs at its time scale", () => {
    const c = new GameClock();
    c.start();
    c.paused = true;
    expect(c.tick(20)).toMatchObject({ dt: 0, realDt: 0.02, paused: true });
    c.paused = false;
    c.timeScale = 0.5;
    expect(c.tick(20).dt).toBeCloseTo(0.01, 9);
    c.timeScale = 3;
    expect(c.tick(20).dt).toBeCloseTo(0.06, 9);
    c.timeScale = 0;
    expect(c.tick(20).dt).toBe(0);
    expect(c.time).toBeCloseTo(0.07, 9);
  });

  it("caps a long frame before scaling, so a stall doesn't jump the game", () => {
    const c = new GameClock();
    c.start();
    expect(c.tick(5000)).toMatchObject({ dt: MAX_FRAME_DT, realDt: MAX_FRAME_DT });
    c.timeScale = 2;
    expect(c.tick(5000).dt).toBeCloseTo(2 * MAX_FRAME_DT, 9);
    expect(c.tick(-5).dt).toBe(0); // a clock that went backwards
  });

  it("refuses a time scale that isn't a finite number ≥ 0", () => {
    const c = new GameClock();
    expect(() => (c.timeScale = -1)).toThrow(RangeError);
    expect(() => (c.timeScale = Number.NaN)).toThrow(RangeError);
    expect(() => (c.timeScale = Infinity)).toThrow(RangeError);
    expect(c.timeScale).toBe(1);
  });
});
