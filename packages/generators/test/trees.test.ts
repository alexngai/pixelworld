import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateModel, type AssetCatalog, type VoxelModel } from "../src/index";

const style = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../worlds/_styles/bay-area/style.json", import.meta.url)), "utf8"),
) as { assets: AssetCatalog; ramps: Record<string, string[]> };
const rampIds = new Map(Object.keys(style.ramps).map((name, i) => [name, i + 1]));
const rampOf = (m: VoxelModel, v: number) => [...rampIds].find(([, i]) => i === m.materials[v])![0];

/** Per z: the crown's width (voxels across, in x) and whether the trunk shows there. */
function profile(m: VoxelModel) {
  const rows: { width: number; voxels: number; ramps: Set<string> }[] = [];
  for (let z = 0; z < m.sz; z++) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let voxels = 0;
    const ramps = new Set<string>();
    for (let y = 0; y < m.sy; y++)
      for (let x = 0; x < m.sx; x++) {
        const v = m.get(x, y, z);
        if (!v) continue;
        voxels++;
        ramps.add(rampOf(m, v));
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
      }
    rows.push({ width: voxels ? x1 - x0 + 1 : 0, voxels, ramps });
  }
  return rows;
}

describe("round trees", () => {
  for (const group of ["tree.street", "tree"])
    it(`${group}: a full, round crown wider than tall on a short trunk, not a palm`, () => {
      expect(style.assets[group]!.generator).toBe("roundTree");
      for (let seed = 1; seed <= 12; seed++) {
        const m = generateModel(style.assets, rampIds, group, { seed });
        const rows = profile(m);
        const crown = rows.filter((r) => r.ramps.has("leaf"));
        const trunk = rows.filter((r) => r.voxels && !r.ramps.has("leaf"));
        // the bare trunk: one voxel column, at most two voxels tall
        expect(trunk.length).toBeLessThanOrEqual(2);
        for (const r of trunk) expect([...r.ramps]).toEqual(["bark"]);
        for (const r of trunk) expect(r.voxels).toBe(1);
        // the crown: at least five voxels across, wider than it is tall, and full
        const width = Math.max(...crown.map((r) => r.width));
        expect(width).toBeGreaterThanOrEqual(5);
        expect(crown.length).toBeLessThan(width);
        const widest = crown.find((r) => r.width === width)!;
        expect(widest.voxels).toBeGreaterThanOrEqual(width * width * 0.5);
      }
    });

  it("is the same tree for the same seed, and varies between seeds", () => {
    const a = generateModel(style.assets, rampIds, "tree.street", { seed: 5 });
    const b = generateModel(style.assets, rampIds, "tree.street", { seed: 5 });
    expect([...a.data]).toEqual([...b.data]);
    const shapes = new Set<string>();
    for (let seed = 1; seed <= 8; seed++)
      shapes.add([...generateModel(style.assets, rampIds, "tree.street", { seed }).data].join(""));
    expect(shapes.size).toBeGreaterThan(3);
  });

  it("keeps the leaf ramp apart from the lawn it stands on", () => {
    expect(style.ramps["leaf"]).not.toEqual(style.ramps["lawn"]);
    // a lit canopy top (shade 4) is darker than a lit lawn
    const lum = (hex: string) => {
      const v = parseInt(hex.slice(1), 16);
      return 0.3 * (v >> 16) + 0.59 * ((v >> 8) & 255) + 0.11 * (v & 255);
    };
    expect(lum(style.ramps["leaf"]![4]!)).toBeLessThan(lum(style.ramps["lawn"]![4]!));
  });
});
