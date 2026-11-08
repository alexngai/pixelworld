import { NO_WATER, TerrainGrid, packShape } from "@pixelworld/grid";
import { describe, expect, it } from "vitest";
import { occupiedCells, scatterInstances, type ScatterRules } from "../src/index";

const rules: ScatterRules = { bySurface: { 2: [{ group: "tree", perCell: 2 }], 4: [{ group: "shrub", perCell: 0.5 }] }, density: 1 };

function grid(): TerrainGrid {
  const g = new TerrainGrid(10, 10);
  g.surface.fill(2); // woodland everywhere
  g.water[0] = 0; // (0, 0) is water
  g.road[1] = 0x04; // (1, 0) is a road
  g.path[2] = 0x04; // (2, 0) is a path
  g.shape[3] = packShape(0, 2, 2, 0); // (3, 0) is steep
  return g;
}

describe("decorative scatter", () => {
  it("is a function of the world cell, so overlapping tiles agree", () => {
    const a = scatterInstances(grid(), [100, 200], { x0: 0, y0: 0, x1: 10, y1: 10 }, rules);
    const b = scatterInstances(grid(), [100, 200], { x0: 5, y0: 5, x1: 10, y1: 10 }, rules);
    const inB = a.filter((o) => o.x >= 105 && o.y >= 205);
    expect(b).toEqual(inB);
    expect(a.every((o) => o.g === "tree" && o.r! >= 0 && o.r! < 4)).toBe(true);
  });

  it("leaves water, roads, paths, steep cells and occupied cells alone", () => {
    const g = grid();
    const occupied = new Uint8Array(100);
    occupied[4] = 1; // (4, 0) is under a building
    const out = scatterInstances(g, [0, 0], { x0: 0, y0: 0, x1: 10, y1: 1 }, rules, occupied);
    const cells = new Set(out.map((o) => Math.floor(o.x)));
    for (const x of [0, 1, 2, 3, 4]) expect(cells.has(x)).toBe(false);
    for (const x of [5, 6, 7, 8, 9]) expect(cells.has(x)).toBe(true);
    expect(out.length).toBe(5 * 2);
  });

  it("follows the density, and fractional counts on average", () => {
    const g = new TerrainGrid(40, 40);
    g.surface.fill(4);
    const n = scatterInstances(g, [0, 0], { x0: 0, y0: 0, x1: 40, y1: 40 }, rules).length;
    expect(n).toBeGreaterThan(1600 * 0.5 * 0.85);
    expect(n).toBeLessThan(1600 * 0.5 * 1.15);
    const half = scatterInstances(g, [0, 0], { x0: 0, y0: 0, x1: 40, y1: 40 }, { ...rules, density: 0.5 }).length;
    expect(half).toBeLessThan(n * 0.65);
    expect(new TerrainGrid(1, 1).water[0]).toBe(NO_WATER);
  });

  it("marks footprints by their bounding box and others by their cell", () => {
    const occ = occupiedCells(
      [
        { g: "building", x: 3.5, y: 3.5, s: 1, fp: [[2.2, 2.1], [4.8, 2.1], [4.8, 3.9], [2.2, 3.9]] },
        { g: "tree", x: 7.2, y: 1.5, s: 2 },
      ],
      [0, 0],
      10,
      10,
    );
    expect(occ[2 * 10 + 2]).toBe(1);
    expect(occ[3 * 10 + 4]).toBe(1);
    expect(occ[1 * 10 + 7]).toBe(1);
    expect(occ.reduce((a, v) => a + v, 0)).toBe(6 + 1);
  });
});
