import { describe, expect, it } from "vitest";
import { generateModel, type AssetCatalog, type VoxelModel } from "../src/index";

// D-138: a hot pool's rings of colour, from its edge in
const ROLES = { edge: "mat", rim: "yellow", shallow: "green", pool: "turquoise", deep: "blue" };
const rampIds = new Map(Object.values(ROLES).map((name, i) => [name, i + 1]));
const catalog: AssetCatalog = {
  "landmark.pool": { generator: "hotPool", ramps: ROLES, params: { greenOdds: 0 } },
  "landmark.pool.thick": { generator: "hotPool", ramps: { edge: "mat", deep: "blue" }, params: { thick: 2 } },
};
const rampAt = (m: VoxelModel, x: number, y: number, z = 0) => [...rampIds].find(([, i]) => i === m.materials[m.get(x, y, z)])?.[0];

function disc(r: number) {
  const n = 2 * r + 1;
  const on = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) on[y * n + x] = (x - r) ** 2 + (y - r) ** 2 <= r * r ? 1 : 0;
  return { sx: n, sy: n, on };
}

describe("hot pools", () => {
  it("rings run from the edge's mats through the rim, the shallows and the pool to a deep centre", () => {
    const mask = disc(30);
    for (let seed = 1; seed <= 6; seed++) {
      const m = generateModel(catalog, rampIds, "landmark.pool", { seed, mask });
      expect(m.sz).toBe(1);
      // along a radius from the edge to the centre, each ring comes after the one outside it
      const order = Object.values(ROLES);
      let last = 0;
      const seen = new Set<string>();
      for (let x = 0; x <= 30; x++) {
        const ramp = rampAt(m, x, 30)!;
        seen.add(ramp);
        const k = order.indexOf(ramp);
        // ragged by a voxel, so a ring may reach one step back; never further
        expect(k).toBeGreaterThanOrEqual(last - 1);
        last = Math.max(last, k);
      }
      expect(rampAt(m, 0, 30)).toBe("mat");
      expect(rampAt(m, 30, 30)).toBe("blue");
      expect([...seen].sort()).toEqual([...order].sort());
      // only the outline is drawn
      for (let y = 0; y < m.sy; y++) for (let x = 0; x < m.sx; x++) expect(m.get(x, y, 0) !== 0).toBe(mask.on[y * m.sx + x] === 1);
    }
  });

  it("a small pool keeps its edge and its centre; a missing role's ring goes inward; thick stacks it", () => {
    const m = generateModel(catalog, rampIds, "landmark.pool.thick", { seed: 3, mask: disc(4) });
    expect(m.sz).toBe(2);
    expect(rampAt(m, 0, 4)).toBe("mat");
    expect(rampAt(m, 4, 4)).toBe("blue");
    expect(rampAt(m, 4, 4, 1)).toBe("blue");
  });

  it("needs a footprint", () => {
    expect(() => generateModel(catalog, rampIds, "landmark.pool", { seed: 1 })).toThrow(/footprint/);
  });
});
