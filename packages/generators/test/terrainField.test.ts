import { TerrainGrid, emptyMicro } from "@pixelworld/grid";
import { describe, expect, it } from "vitest";
import { buildTerrainField, forEachFieldPoint } from "../src/index";

/** A 2×1-cell grid at k=2 (4×2 micro-cells) whose east half stands 6 micro-steps higher. */
function stepGrid(): TerrainGrid {
  const k = 2;
  const g = new TerrainGrid(2, 1, { micro: emptyMicro(k, 2, 1) });
  const w = 2 * k + 1;
  for (let y = 0; y <= k; y++) for (let x = 0; x < w; x++) g.micro!.corners[y * w + x] = x >= 3 ? 6 : 0;
  g.surface.set([3, 4]);
  g.road.set([0x0004, 0]);
  g.roadClass.set([2, 0]);
  g.geology.set([1, 0]);
  return g;
}

describe("terrain fields", () => {
  it("derives micro-cell corners and packs cell attributes", () => {
    const f = buildTerrainField(stepGrid(), { offset: [10, 20], world: { width: 100, height: 100 }, floor: -2 });
    expect([f.k, f.width, f.height, f.origin]).toEqual([2, 2, 1, [10, 20]]);
    // micro-cell (2, 0) spans corners x 2..3: 0 → 6 is steeper than 3, so it's flat at the mean 3
    expect(Array.from(f.corners.subarray(2 * 4, 3 * 4))).toEqual([3, 3, 3, 3]);
    expect(Array.from(f.corners.subarray(3 * 4, 4 * 4))).toEqual([6, 6, 6, 6]);
    expect(Array.from(f.cells.subarray(0, 4))).toEqual([3, 4, 2 | (1 << 8), -32768]);
  });

  it("lists walls only where a micro-cell stands above its neighbour or at the world edge", () => {
    const f = buildTerrainField(stepGrid(), { offset: [0, 0], world: { width: 2, height: 1 }, floor: -2 });
    // west edges (3): micro-cells 2 and 3 (and 6, 7 in the second row) rise above their west neighbours,
    // and column 0 sits on the world's west edge
    expect(Array.from(f.walls[3])).toEqual([0, 2, 3, 4, 6, 7]);
    // east edges (1): only the world edge (column 3), nothing in between faces down eastward
    expect(Array.from(f.walls[1])).toEqual([3, 7]);
    // inside a larger world the slice edge gets no skirt
    const inner = buildTerrainField(stepGrid(), { offset: [5, 5], world: { width: 20, height: 20 } });
    expect(Array.from(inner.walls[1])).toEqual([]);
    expect(Array.from(inner.walls[0])).toEqual([]);
  });

  it("bounds include every drawn corner and the skirt floor at world edges", () => {
    const f = buildTerrainField(stepGrid(), { offset: [0, 0], world: { width: 2, height: 1 }, floor: -2 });
    let lo = Infinity;
    let hi = -Infinity;
    let n = 0;
    forEachFieldPoint(f, (_x, _y, h) => {
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
      n++;
    });
    expect([lo, hi]).toEqual([-2, 3]); // 6 micro-steps = 3 steps; skirts down to the floor
    expect(n).toBe(8 * 4 * 2); // every micro-cell touches a world edge here
  });
});
