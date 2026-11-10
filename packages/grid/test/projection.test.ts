import { describe, expect, it } from "vitest";
import {
  ROTATIONS,
  STEP_WORLD,
  SUN_DIR,
  project,
  rotateXY,
  unprojectAtHeight,
  unrotateXY,
} from "../src/index";

describe("integer projection", () => {
  it("maps unit steps to exact pixel offsets", () => {
    expect(project(1, 0, 0, 0)).toMatchObject({ sx: 16, sy: 8 });
    expect(project(0, 1, 0, 0)).toMatchObject({ sx: -16, sy: 8 });
    expect(project(0, 0, 1, 0)).toMatchObject({ sx: 0, sy: -8 });
  });

  it("projects every integer grid point to integer pixels in all rotations", () => {
    for (const r of ROTATIONS) {
      for (let x = -3; x <= 3; x++)
        for (let y = -3; y <= 3; y++)
          for (let h = -2; h <= 2; h++) {
            const p = project(x, y, h, r);
            expect(Number.isInteger(p.sx)).toBe(true);
            expect(Number.isInteger(p.sy)).toBe(true);
          }
    }
  });

  it("matches an orthographic camera at 45° yaw / 30° pitch with step = 1/√6 cell", () => {
    const th = (30 * Math.PI) / 180;
    const s = 16 * Math.SQRT2; // pixels per world unit
    const right = [Math.SQRT1_2, -Math.SQRT1_2, 0];
    const up = [-Math.sin(th) / Math.SQRT2, -Math.sin(th) / Math.SQRT2, Math.cos(th)];
    const toCam = [Math.cos(th) / Math.SQRT2, Math.cos(th) / Math.SQRT2, Math.sin(th)];
    const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    for (const [x, y, h] of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [3, 5, 7],
      [-2, 4, -3],
    ] as const) {
      const p = [x, y, h * STEP_WORLD];
      const q = project(x, y, h, 0);
      expect(s * dot(p, right)).toBeCloseTo(q.sx, 9);
      expect(-s * dot(p, up)).toBeCloseTo(q.sy, 9);
      // camera depth is proportional to x + y + h/3
      expect(dot(p, toCam) / q.depth).toBeCloseTo(Math.sqrt(3) / (2 * Math.SQRT2), 9);
    }
  });

  it("depth increases toward the camera", () => {
    // moving toward the viewer (+x+y) or up increases depth
    expect(project(1, 1, 0, 0).depth).toBeGreaterThan(project(0, 0, 0, 0).depth);
    expect(project(0, 0, 1, 0).depth).toBeGreaterThan(project(0, 0, 0, 0).depth);
  });

  it("rotations are proper, invertible and cycle with period 4", () => {
    for (const r of ROTATIONS) {
      const [ax, ay] = rotateXY(1, 0, r);
      const [bx, by] = rotateXY(0, 1, r);
      expect(ax * by - ay * bx).toBe(1);
      const [u, v] = rotateXY(3, -7, r);
      expect(unrotateXY(u, v, r)).toEqual([3, -7]);
    }
    let p: [number, number] = [2, 5];
    for (let i = 0; i < 4; i++) p = rotateXY(p[0], p[1], 1);
    expect(p).toEqual([2, 5]);
  });

  it("unprojects onto a height plane", () => {
    for (const r of ROTATIONS) {
      const q = project(4.25, -1.5, 3, r);
      const [x, y] = unprojectAtHeight(q.sx, q.sy, 3, r);
      expect(x).toBeCloseTo(4.25, 9);
      expect(y).toBeCloseTo(-1.5, 9);
    }
  });

  it("lights the three canonical faces at evenly spaced levels", () => {
    const top = SUN_DIR[2];
    const left = SUN_DIR[1]; // +y face appears on the left
    const right = SUN_DIR[0]; // +x face appears on the right
    expect(top).toBeGreaterThan(left);
    expect(left).toBeGreaterThan(right);
    expect(right).toBeGreaterThan(0);
    expect(top - left).toBeCloseTo(left - right, 1);
  });
});
