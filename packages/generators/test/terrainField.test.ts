import { LANE_DIVIDED, LANE_ONEWAY, TerrainGrid, emptyMicro } from "@pixelworlds/grid";
import { describe, expect, it } from "vitest";
import { NEAR_MEDIAN, buildTerrainField, forEachFieldPoint } from "../src/index";

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
  it("bounds a water plane's level only where the package shapes its shores (D-094)", () => {
    const g = stepGrid();
    g.water.set([9, -32768]); // west cell under water at 9 steps, above all its ground
    const tops = (shores: boolean) => {
      let top = -Infinity;
      forEachFieldPoint(buildTerrainField(g, { world: { width: 2, height: 1 }, shores }), (_x, _y, h) => (top = Math.max(top, h)));
      return top;
    };
    expect(tops(true)).toBe(9);
    expect(tops(false)).toBe(3); // the highest ground: 6 micro-steps at k=2
  });

  it("derives micro-cell corners and packs cell attributes", () => {
    const f = buildTerrainField(stepGrid(), { offset: [10, 20], world: { width: 100, height: 100 }, floor: -2 });
    expect([f.k, f.width, f.height, f.origin]).toEqual([2, 2, 1, [10, 20]]);
    // micro-cell (2, 0) spans corners x 2..3: 0 → 6 is steeper than 3, so it's flat at the mean 3
    expect(Array.from(f.corners.subarray(2 * 4, 3 * 4))).toEqual([3, 3, 3, 3]);
    expect(Array.from(f.corners.subarray(3 * 4, 4 * 4))).toEqual([6, 6, 6, 6]);
    expect(Array.from(f.cells.subarray(0, 4))).toEqual([3, 4, 2 | (1 << 8), -32768]);
  });

  it("packs real widths and paths, and how far they reach (D-050)", () => {
    const plain = buildTerrainField(stepGrid(), { offset: [0, 0], world: { width: 2, height: 1 } });
    expect(plain.wayReach).toBe(0); // style widths: roads stay inside their cells
    const g = stepGrid();
    g.roadWidth.set([40, 0]); // 1.25 cells half-width
    g.path.set([0, 0x0040]);
    g.pathClass.set([0, 2]);
    g.pathWidth.set([0, 5]);
    const f = buildTerrainField(g, { offset: [0, 0], world: { width: 2, height: 1 } });
    // road mask, class | width << 8, path mask, class | width << 8
    expect(Array.from(f.ways)).toEqual([0x0004, 2 | (40 << 8), 0, 0, 0, 0, 0x0040, 2 | (5 << 8)]);
    expect(f.wayReach).toBe(2);
  });

  it("packs lanes over the road's connections (M3.5)", () => {
    const g = stepGrid();
    g.road.set([0x0044 | (1 << 9), 0]); // east and west, and a crossing flag the decal doesn't use
    g.roadWidth.set([16, 0]); // half a cell
    g.lane.set([4 | LANE_ONEWAY, 3]); // no width in the second cell: nothing to draw there
    const f = buildTerrainField(g, { offset: [0, 0], world: { width: 2, height: 1 } });
    expect(f.ways[0]).toBe(0x0044 | ((4 | LANE_ONEWAY) << 8));
    expect(f.ways[4]).toBe(0);
    expect([f.ways[2], f.ways[6]]).toEqual([0, 0]);
    expect(f.wayReach).toBe(1);
  });

  it("flags the cells between a divided road's carriageways, and only those (M3.5)", () => {
    // two east-west carriageways of a divided road, in rows 1 and 4 of a 9×7 grid
    const k = 2;
    const g = new TerrainGrid(9, 7, { micro: emptyMicro(k, 9, 7) });
    for (const row of [1, 4])
      for (let x = 0; x < 9; x++) {
        const i = row * 9 + x;
        g.road[i] = 0x44;
        g.roadWidth[i] = 8;
        g.lane[i] = 2 | LANE_ONEWAY | LANE_DIVIDED;
      }
    const f = buildTerrainField(g, { offset: [0, 0], world: { width: 9, height: 7 } });
    const near = (x: number, y: number) => (f.ways[(y * 9 + x) * 4 + 2]! & NEAR_MEDIAN) !== 0;
    // rows 0 to 5: the two carriageways, the median between them and a cell's margin;
    // three cells apart, they look three cells out
    for (let y = 0; y < 7; y++) expect(near(4, y)).toBe(y <= 5);
    expect((f.ways[(2 * 9 + 4) * 4 + 2]! & NEAR_MEDIAN) >> 12).toBe(3);
    // a carriageway whose partner is out of reach flags nothing
    const lone = new TerrainGrid(9, 7, { micro: emptyMicro(k, 9, 7) });
    for (let x = 0; x < 9; x++) {
      lone.road[9 + x] = 0x44;
      lone.roadWidth[9 + x] = 8;
      lone.lane[9 + x] = 2 | LANE_ONEWAY | LANE_DIVIDED;
    }
    const l = buildTerrainField(lone, { offset: [0, 0], world: { width: 9, height: 7 } });
    expect(Array.from({ length: 63 }, (_, i) => l.ways[i * 4 + 2]! & NEAR_MEDIAN).every((v) => v === 0)).toBe(true);
  });

  it("packs rails drawn in the street (M3.5): connections and what is drawn", () => {
    const g = stepGrid();
    g.rail.set([0x0004 | (1 << 12), 0x0040 | (3 << 12)]);
    const f = buildTerrainField(g, { offset: [0, 0], world: { width: 2, height: 1 } });
    expect(Array.from(f.rails)).toEqual([0x0004 | (1 << 12), 0x0040 | (3 << 12)]);
    expect(Array.from(buildTerrainField(stepGrid(), { offset: [0, 0], world: { width: 2, height: 1 } }).rails)).toEqual([0, 0]);
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
