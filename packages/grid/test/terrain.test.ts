import { describe, expect, it } from "vitest";
import {
  CORNER_OFFSETS,
  EDGE_CORNERS,
  EDGE_NEIGHBOR,
  EDGE_NEIGHBOR_CORNERS,
  TerrainGrid,
  cornerHeights,
  slopeFromCorners,
  splitDiagonal,
} from "../src/index";

describe("slope encoding", () => {
  it("round-trips every representable corner configuration", () => {
    for (let slope = 0; slope <= 14; slope++) {
      const corners = cornerHeights(10, slope);
      expect(slopeFromCorners(corners)).toEqual({ base: 10, slope });
    }
  });

  it("normalizes all-raised to a flat cell one step up", () => {
    expect(slopeFromCorners([4, 4, 4, 4])).toEqual({ base: 4, slope: 0 });
    expect(slopeFromCorners([5, 5, 5, 5])).toEqual({ base: 5, slope: 0 });
  });

  it("rejects corners spanning more than one step", () => {
    expect(slopeFromCorners([0, 2, 1, 1])).toBeNull();
  });

  it("splits single-corner slopes away from the odd corner", () => {
    expect(splitDiagonal(0b0001)).toBe(1); // c0 raised → split c1–c3
    expect(splitDiagonal(0b0010)).toBe(0); // c1 raised → split c0–c2
    expect(splitDiagonal(0b1110)).toBe(1); // c0 lowered → split c1–c3
    expect(splitDiagonal(0b0101)).toBe(0); // ridge c0–c2
    expect(splitDiagonal(0b1010)).toBe(1); // ridge c1–c3
  });
});

describe("edge tables", () => {
  it("pair each edge's corners with the neighbour's coincident corners", () => {
    for (let e = 0; e < 4; e++) {
      const [nx, ny] = EDGE_NEIGHBOR[e]!;
      for (let k = 0; k < 2; k++) {
        const c = EDGE_CORNERS[e]![k]!;
        const nc = EDGE_NEIGHBOR_CORNERS[e]![k]!;
        const [cx, cy] = CORNER_OFFSETS[c]!;
        const [ncx, ncy] = CORNER_OFFSETS[nc]!;
        expect([cx, cy]).toEqual([nx + ncx, ny + ncy]);
      }
    }
  });
});

describe("TerrainGrid", () => {
  it("interpolates the surface consistently with the triangle split", () => {
    const g = new TerrainGrid(1, 1);
    g.base[0] = 2;
    g.slope[0] = 0b0001; // c0 raised, split c1–c3
    expect(g.surfaceHeightAt(0, 0)).toBe(3);
    expect(g.surfaceHeightAt(1, 1)).toBe(2);
    expect(g.surfaceHeightAt(0.75, 0.75)).toBe(2); // flat triangle
    expect(g.surfaceHeightAt(0.25, 0.25)).toBeCloseTo(2.5, 9);
  });

  it("reports the height range", () => {
    const g = new TerrainGrid(2, 1);
    g.base.set([3, 7]);
    g.slope.set([0, 2]);
    expect(g.heightRange()).toEqual([3, 8]);
  });

  it("validates layer sizes", () => {
    expect(() => new TerrainGrid(2, 2, { base: new Int16Array(3) })).toThrow();
  });
});
