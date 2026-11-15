import { describe, expect, it } from "vitest";
import { steamPlumes } from "../src/steam";

// D-138: a plume over every placed object of a steam source's group
const sources = {
  "landmark.pool": { heightMeters: 12, radiusMeters: 3, density: 0.8, minAreaMeters: 20 },
  "landmark.geyser": { heightMeters: 20, radiusMeters: 1.5, density: 1 },
};
const square = (x: number, y: number, side: number): [number, number][] => [
  [x, y],
  [x + side, y],
  [x + side, y + side],
  [x, y + side],
];

describe("steam plumes", () => {
  it("rise over the source groups' objects, the longest prefix's, and nothing else", () => {
    const plumes = steamPlumes(
      [
        { g: "landmark.geyser.castle", x: 10, y: 20, s: 7 },
        { g: "landmark.pool", x: 30, y: 40, s: 8, z0: 5, fp: square(28, 38, 4) },
        { g: "tree.lodgepole", x: 1, y: 1, s: 9 },
      ],
      { sources },
      6,
    );
    expect(plumes).toHaveLength(2);
    const [geyser, pool] = plumes;
    // a geyser without a footprint: the source's radius (cells); its height in steps, a third of a step a metre at 6 m cells
    expect(geyser).toMatchObject({ x: 10, y: 20, radius: 0.25, density: 1 });
    expect(geyser!.height).toBeCloseTo(20 / 3);
    expect("z0" in geyser!).toBe(false);
    // a pool 4 cells square (24 m): two-thirds of its outline's radius, rising higher for its size, on its water
    const r = Math.sqrt(16 / Math.PI);
    expect(pool).toMatchObject({ x: 30, y: 40, z0: 5, density: 0.8 });
    expect(pool!.radius).toBeCloseTo((2 / 3) * r);
    expect(pool!.height).toBeCloseTo((12 + 1.5 * r * 6) / 3);
  });

  it("leaves out footprints under the source's least area, and scales with the height stretch", () => {
    const small = { g: "landmark.pool", x: 0, y: 0, s: 1, fp: square(0, 0, 0.5) }; // 3 m square: 9 m²
    expect(steamPlumes([small], { sources }, 6)).toEqual([]);
    const [tall] = steamPlumes([{ g: "landmark.geyser", x: 0, y: 0, s: 1 }], { sources }, 6, 2);
    expect(tall!.height).toBeCloseTo(40 / 3);
  });
});
