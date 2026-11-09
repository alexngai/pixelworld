import { project, unprojectAtHeight } from "@pixelworlds/grid";
import { describe, expect, it } from "vitest";
import { Camera, cellsScreenRect, worldDepthRange } from "../src/camera";

describe("Camera", () => {
  it("centres the focus point and snaps to integer pixels", () => {
    const cam = new Camera(640, 360);
    cam.zoom = 2;
    cam.fx = 10.3;
    cam.fy = 7.1;
    cam.fh = 4;
    const s = cam.snapped();
    expect(Number.isInteger(s.left)).toBe(true);
    expect(s.fracX).toBeGreaterThanOrEqual(0);
    expect(s.fracX).toBeLessThan(1);
    const c = project(10.3, 7.1, 4, 0);
    expect(s.left + s.fracX + cam.internalWidth / 2).toBeCloseTo(c.sx, 9);
    expect(s.top + s.fracY + cam.internalHeight / 2).toBeCloseTo(c.sy, 9);
  });

  it("pans in screen space and keeps the focus through rotations", () => {
    const cam = new Camera(640, 360);
    cam.fx = 5;
    cam.fy = 5;
    cam.panPixels(32, 0);
    expect(project(cam.fx, cam.fy, 0, 0).sx).toBeCloseTo(project(5, 5, 0, 0).sx + 32, 9);
    cam.rotate(1);
    cam.rotate(1);
    cam.rotate(-1);
    expect(cam.rotation).toBe(1);
    const [x, y] = unprojectAtHeight(...([project(cam.fx, cam.fy, 0, 1).sx, project(cam.fx, cam.fy, 0, 1).sy] as const), 0, 1);
    expect(x).toBeCloseTo(cam.fx, 9);
    expect(y).toBeCloseTo(cam.fy, 9);
  });

  it("maps screen directions to unit grid directions", () => {
    const cam = new Camera(640, 360);
    const [gx, gy] = cam.screenDirToGrid(0, -1); // up the screen at rotation 0 → north-west
    expect(gx).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(gy).toBeCloseTo(-Math.SQRT1_2, 9);
    cam.rotation = 2;
    const [hx, hy] = cam.screenDirToGrid(0, -1);
    expect(hx).toBeCloseTo(Math.SQRT1_2, 9);
    expect(hy).toBeCloseTo(Math.SQRT1_2, 9);
  });
});

describe("screen rect estimates", () => {
  it("contains the projections of all cell corners at both height extremes", () => {
    for (const r of [0, 1, 2, 3] as const) {
      const rect = cellsScreenRect(4, 8, 12, 20, -3, 9, r);
      for (const [x, y] of [[4, 8], [12, 8], [4, 20], [12, 20]] as const)
        for (const h of [-3, 9]) {
          const p = project(x, y, h, r);
          expect(p.sx).toBeGreaterThanOrEqual(rect.left);
          expect(p.sx).toBeLessThanOrEqual(rect.right);
          expect(p.sy).toBeGreaterThanOrEqual(rect.top);
          expect(p.sy).toBeLessThanOrEqual(rect.bottom);
        }
    }
  });

  it("depth range covers the world in every rotation", () => {
    const [lo, hi] = worldDepthRange(10, 6, 0, 12);
    for (const r of [0, 1, 2, 3] as const)
      for (const [x, y] of [[0, 0], [10, 0], [0, 6], [10, 6]] as const)
        for (const h of [0, 12]) {
          const d = project(x, y, h, r).depth;
          expect(d).toBeGreaterThan(lo);
          expect(d).toBeLessThan(hi);
        }
  });
});
