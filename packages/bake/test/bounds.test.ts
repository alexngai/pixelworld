import { SUN_DIR, TerrainGrid } from "@pixelworld/grid";
import { buildTerrainMesh } from "@pixelworld/generators";
import { describe, expect, it } from "vitest";
import { lightBasis, lightBounds, pixelRect, screenBounds } from "../src/bounds";

function flatGrid(w: number, h: number, height: number) {
  const g = new TerrainGrid(w, h);
  g.base.fill(height);
  return g;
}

describe("screen bounds", () => {
  it("covers exactly the owned cells' diamond", () => {
    const g = flatGrid(8, 8, 0);
    const mesh = buildTerrainMesh(g, { x0: 0, y0: 0, x1: 8, y1: 8 }, { floor: 0 });
    const b = screenBounds(mesh, 0, { x0: 2, y0: 2, x1: 4, y1: 4 })!;
    // cells 2..4 × 2..4: corners (2,2) (4,2) (2,4) (4,4) → sx ∈ [-32, 32], sy ∈ [32, 64]
    expect(pixelRect(b)).toEqual({ left: -32, top: 32, width: 64, height: 32 });
    expect(b.minDepth).toBe(4);
    expect(b.maxDepth).toBe(8);
  });

  it("returns null when nothing is owned", () => {
    const g = flatGrid(2, 2, 0);
    const mesh = buildTerrainMesh(g, { x0: 0, y0: 0, x1: 2, y1: 2 });
    expect(screenBounds(mesh, 0, { x0: 5, y0: 5, x1: 6, y1: 6 })).toBeNull();
  });

  it("rotates consistently", () => {
    const g = flatGrid(4, 4, 3);
    const mesh = buildTerrainMesh(g, { x0: 0, y0: 0, x1: 4, y1: 4 }, { floor: 3 });
    for (const r of [0, 1, 2, 3] as const) {
      const rect = pixelRect(screenBounds(mesh, r, "all")!);
      expect(rect.width).toBe(128); // a 4×4 diamond is 4·32 px wide in every rotation
      expect(rect.height).toBe(64);
    }
  });
});

describe("light bounds", () => {
  it("builds an orthonormal basis around the sun", () => {
    const b = lightBasis(SUN_DIR);
    const dot = (a: number[], c: number[]) => a[0]! * c[0]! + a[1]! * c[1]! + a[2]! * c[2]!;
    expect(dot(b.right, b.sun)).toBeCloseTo(0, 12);
    expect(dot(b.up, b.sun)).toBeCloseTo(0, 12);
    expect(dot(b.up, b.right)).toBeCloseTo(0, 12);
    expect(dot(b.up, b.up)).toBeCloseTo(1, 12);
  });

  it("limits XY to receivers but depth to all casters", () => {
    const g = flatGrid(16, 16, 0);
    g.base[g.index(15, 15)] = 40; // a tall caster far from the receivers
    const mesh = buildTerrainMesh(g, { x0: 0, y0: 0, x1: 16, y1: 16 }, { floor: 0 });
    const basis = lightBasis(SUN_DIR);
    const small = lightBounds(mesh, 0, { x0: 0, y0: 0, x1: 2, y1: 2 }, basis);
    const all = lightBounds(mesh, 0, "all", basis);
    expect(small.rect[2] - small.rect[0]).toBeLessThan(all.rect[2] - all.rect[0]);
    expect(small.depth).toEqual(all.depth);
  });
});
