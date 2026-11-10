import { describe, expect, it } from "vitest";
import {
  CORNER_OFFSETS,
  EDGE_CORNERS,
  EDGE_NEIGHBOR,
  EDGE_NEIGHBOR_CORNERS,
  TerrainGrid,
  copyCells,
  cornerHeights,
  emptyMicro,
  microCellCorners,
  isValidShape,
  packShape,
  shapeFromCorners,
  shapeFromV0Mask,
  shapeRise,
  splitDiagonal,
} from "../src/index";

describe("corner shapes", () => {
  it("round-trips every representable corner configuration", () => {
    for (let o0 = 0; o0 <= 3; o0++)
      for (let o1 = 0; o1 <= 3; o1++)
        for (let o2 = 0; o2 <= 3; o2++)
          for (let o3 = 0; o3 <= 3; o3++) {
            if (Math.min(o0, o1, o2, o3) !== 0) continue;
            const shape = packShape(o0, o1, o2, o3);
            expect(isValidShape(shape)).toBe(true);
            const corners = cornerHeights(10, shape);
            expect(corners).toEqual([10 + o0, 10 + o1, 10 + o2, 10 + o3]);
            expect(shapeFromCorners(corners)).toEqual({ base: 10, shape });
          }
  });

  it("normalizes uniformly raised corners to a flat cell", () => {
    expect(shapeFromCorners([4, 4, 4, 4])).toEqual({ base: 4, shape: 0 });
    expect(isValidShape(packShape(1, 1, 1, 1))).toBe(false);
  });

  it("rejects corners spanning more than the allowed rise", () => {
    expect(shapeFromCorners([0, 2, 1, 1], 1)).toBeNull();
    expect(shapeFromCorners([0, 2, 1, 1], 2)).toEqual({ base: 0, shape: packShape(0, 2, 1, 1) });
    expect(shapeFromCorners([0, 4, 1, 1])).toBeNull();
  });

  it("converts v0 slope masks", () => {
    expect(shapeFromV0Mask(0b0101)).toBe(packShape(1, 0, 1, 0));
    expect(shapeRise(shapeFromV0Mask(0b1110))).toBe(1);
  });

  it("splits one-step slopes like the RCT model", () => {
    expect(splitDiagonal([1, 0, 0, 0])).toBe(1); // c0 raised → split c1–c3
    expect(splitDiagonal([0, 1, 0, 0])).toBe(0); // c1 raised → split c0–c2
    expect(splitDiagonal([0, 1, 1, 1])).toBe(1); // c0 lowered → split c1–c3
    expect(splitDiagonal([1, 0, 1, 0])).toBe(0); // ridge c0–c2
    expect(splitDiagonal([0, 1, 0, 1])).toBe(1); // ridge c1–c3
  });

  it("splits multi-step cells along the diagonal with the smaller difference", () => {
    expect(splitDiagonal([0, 1, 3, 2])).toBe(1); // |c0−c2| = 3 > |c1−c3| = 1
    expect(splitDiagonal([2, 0, 2, 3])).toBe(0);
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
    g.shape[0] = packShape(1, 0, 0, 0); // c0 raised, split c1–c3
    expect(g.surfaceHeightAt(0, 0)).toBe(3);
    expect(g.surfaceHeightAt(1, 1)).toBe(2);
    expect(g.surfaceHeightAt(0.75, 0.75)).toBe(2); // flat triangle
    expect(g.surfaceHeightAt(0.25, 0.25)).toBeCloseTo(2.5, 9);
  });

  it("reports the height range", () => {
    const g = new TerrainGrid(2, 1);
    g.base.set([3, 7]);
    g.shape.set([0, packShape(0, 3, 1, 0)]);
    expect(g.heightRange()).toEqual([3, 10]);
    expect(g.steepness(1, 0)).toBe(3);
  });

  it("validates layer sizes", () => {
    expect(() => new TerrainGrid(2, 2, { base: new Int16Array(3) })).toThrow();
  });
});

describe("micro-terrain", () => {
  it("derives micro-cells: slope tiles up to 3 micro-steps, flat terraces when steeper", () => {
    expect(microCellCorners(0, 1, 3, 1)).toEqual([0, 1, 3, 1]);
    expect(microCellCorners(1, 9, 9, 1)).toEqual([5, 5, 5, 5]); // mean 5
    expect(microCellCorners(0, 1, 9, 12)).toEqual([6, 6, 6, 6]); // mean 5.5 rounds half up
  });

  it("samples heights from micro-terrain when present, in steps", () => {
    const k = 4;
    const g = new TerrainGrid(1, 1, { micro: emptyMicro(k, 1, 1) });
    // a ramp rising 1 micro-step per micro-corner eastward
    for (let y = 0; y <= k; y++) for (let x = 0; x <= k; x++) g.micro!.corners[y * (k + 1) + x] = 40 + x;
    expect(g.surfaceHeightAt(0, 0.5)).toBe(10);
    expect(g.surfaceHeightAt(0.5, 0.5)).toBe(10.5);
    expect(g.surfaceHeightAt(1, 0.5)).toBe(11);
    expect(g.heightRange()).toEqual([0, 11]); // cell layer at 0, micro up to 44/4
  });

  it("copies micro-corners with their cells", () => {
    const k = 2;
    const src = new TerrainGrid(2, 1, { micro: emptyMicro(k, 2, 1) });
    src.micro!.corners.forEach((_, i, a) => (a[i] = i));
    const dst = src.slice(1, 0, 1, 1);
    // cell (1, 0) covers micro-corners x 2..4 of rows 0..2 in a 5-wide source
    expect(Array.from(dst.micro!.corners)).toEqual([2, 3, 4, 7, 8, 9, 12, 13, 14]);
    const plain = new TerrainGrid(1, 1);
    copyCells(src, 0, 0, plain, 0, 0, 1, 1); // a grid without micro-terrain just skips it
    expect(plain.micro).toBeNull();
  });
});
