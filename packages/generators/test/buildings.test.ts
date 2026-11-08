import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateModel, type AssetCatalog, type VoxelModel } from "../src/index";

/**
 * The building rules of the style guide (§13), checked on generated models
 * over many footprints, heights, seeds and roof shapes.
 */
const style = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../worlds/_styles/desert-southwest/style.json", import.meta.url)), "utf8"),
) as { assets: AssetCatalog; ramps: Record<string, string[]> };
const rampIds = new Map(Object.keys(style.ramps).map((name, i) => [name, i + 1]));
const rampName = new Map([...rampIds].map(([n, i]) => [i, n]));

function rectMask(sx: number, sy: number, cut = 0) {
  const on = new Uint8Array(sx * sy);
  // a rectangle, optionally with a notch cut out of one corner (L-shaped)
  for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) on[y * sx + x] = x < cut && y < cut ? 0 : 1;
  return { sx, sy, on };
}

function* cases() {
  const groups = ["building.residential", "building.commercial", "building.tower", "building.tower.hotel"];
  const roofs = [undefined, "flat", "pyramidal", "dome", "hipped", "gabled"];
  let seed = 1;
  for (const group of groups)
    for (const [sx, sy, cut] of [[3, 3, 0], [8, 5, 0], [12, 12, 4], [20, 14, 0]] as const)
      for (const H of group.startsWith("building.tower") ? [24, 60] : [3, 9])
        for (const roof of roofs) yield { group, mask: rectMask(sx, sy, cut), H, roof, seed: seed++ };
}

const glassRamps = new Set(["glass", "lit", "lit-cool"]);

function check(m: VoxelModel, mask: { sx: number; sy: number; on: Uint8Array }) {
  const problems: string[] = [];
  const onFp = (x: number, y: number) => x >= 0 && y >= 0 && x < mask.sx && y < mask.sy && mask.on[y * mask.sx + x] === 1;
  for (let z = 0; z < m.sz; z++)
    for (let y = 0; y < m.sy; y++)
      for (let x = 0; x < m.sx; x++) {
        const v = m.get(x, y, z);
        if (!v) continue;
        if (!onFp(x, y)) problems.push(`voxel outside the footprint at ${x},${y},${z}`);
        if (z > 0 && !m.get(x, y, z - 1)) problems.push(`overhang at ${x},${y},${z}`);
        const name = rampName.get(m.materials[v]!);
        if (!name) problems.push(`unknown ramp at ${x},${y},${z}`);
        // glass only on outer walls: a glass voxel has an empty neighbour (or is roof glass)
        if (name && glassRamps.has(name) && m.get(x - 1, y, z) && m.get(x + 1, y, z) && m.get(x, y - 1, z) && m.get(x, y + 1, z) && m.get(x, y, z + 1))
          problems.push(`hidden glass at ${x},${y},${z}`);
      }
  return problems;
}

describe("building generator v2 follows the style guide", () => {
  it("stays on its footprint, has no overhangs and shows glass only on its skin", () => {
    let n = 0;
    for (const c of cases()) {
      const m = generateModel(style.assets, rampIds, c.group, {
        seed: c.seed,
        mask: c.mask,
        heightVox: c.H,
        hints: c.roof ? { roof: c.roof } : undefined,
      });
      const problems = check(m, c.mask);
      expect(problems, `${c.group} ${c.mask.sx}×${c.mask.sy} H=${c.H} roof=${c.roof} seed=${c.seed}`).toEqual([]);
      n++;
    }
    expect(n).toBe(4 * 4 * 2 * 6);
  });

  it("makes a broad, low building with a pyramidal roof a pyramid of glass", () => {
    const mask = rectMask(20, 20);
    const m = generateModel(style.assets, rampIds, "building.tower", { seed: 3, mask, heightVox: 30, hints: { roof: "pyramidal" } });
    const top = (x: number, y: number) => {
      let z = m.sz - 1;
      while (z >= 0 && !m.get(x, y, z)) z--;
      return z;
    };
    expect(top(0, 0)).toBeLessThan(4); // corners stay low
    expect(top(9, 9)).toBeGreaterThan(24); // the apex is near the full height
    expect(rampName.get(m.materials[m.get(5, 5, top(5, 5))]!)).toBe("glass"); // its skin is glass
  });

  it("steps tall towers back without ever leaving their footprint", () => {
    let stepped = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const mask = rectMask(14, 12);
      const m = generateModel(style.assets, rampIds, "building.tower", { seed, mask, heightVox: 60, hints: { roof: "flat" } });
      const width = (z: number) => {
        let n = 0;
        for (let x = 0; x < m.sx; x++) if (m.get(x, 6, z)) n++;
        return n;
      };
      if (width(55) < width(10)) stepped++;
      expect(check(m, mask)).toEqual([]);
    }
    expect(stepped).toBeGreaterThan(5); // about 60% of towers get setbacks
  });
});
