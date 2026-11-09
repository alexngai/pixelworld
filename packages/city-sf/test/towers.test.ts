import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateModel, type AssetCatalog, type VoxelModel } from "@pixelworld/generators";
import { register } from "../src/index";
import { footprintDepth } from "../src/towers";

await register(); // the city pack's generators, on this thread

/**
 * San Francisco's towers (towers.ts) under the style guide's building rules
 * (§13): inside the footprint, no overhangs, glass only on the skin, style
 * ramps only; and the shapes that make them read: piers, setbacks, crowns.
 */
const style = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../worlds/_styles/bay-area/style.json", import.meta.url)), "utf8"),
) as { assets: AssetCatalog; ramps: Record<string, string[]> };
const rampIds = new Map(Object.keys(style.ramps).map((name, i) => [name, i + 1]));
const rampName = new Map([...rampIds].map(([n, i]) => [i, n]));
const glassRamps = new Set(["glass", "lit", "lit-cool"]);

const GROUPS = ["building.tower", "building.tower.hotel", "building.tower.deco", "building.tower.slab", "building.tower.postmodern", "building.tower.glass"];

function rectMask(sx: number, sy: number, cut = 0) {
  const on = new Uint8Array(sx * sy);
  for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) on[y * sx + x] = x < cut && y < cut ? 0 : 1;
  return { sx, sy, on };
}

/** A diamond (a footprint on the diagonal grid south of Market). */
function diamondMask(r: number) {
  const s = 2 * r + 1;
  const on = new Uint8Array(s * s);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) on[y * s + x] = Math.abs(x - r) + Math.abs(y - r) <= r ? 1 : 0;
  return { sx: s, sy: s, on };
}

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
        if (name && glassRamps.has(name) && m.get(x - 1, y, z) && m.get(x + 1, y, z) && m.get(x, y - 1, z) && m.get(x, y + 1, z) && m.get(x, y, z + 1))
          problems.push(`hidden glass at ${x},${y},${z}`);
      }
  return problems;
}

const topOf = (m: VoxelModel, x: number, y: number) => {
  for (let z = m.sz - 1; z >= 0; z--) if (m.get(x, y, z)) return z;
  return -1;
};
const widthAt = (m: VoxelModel, y: number, z: number) => [...Array(m.sx).keys()].filter((x) => m.get(x, y, z)).length;

describe("San Francisco towers", () => {
  it("stay on their footprint, never overhang and show glass only on their skin", () => {
    let n = 0;
    let seed = 1;
    const masks = [rectMask(3, 3), rectMask(8, 5), rectMask(14, 12, 4), rectMask(26, 18), rectMask(40, 30, 9), diamondMask(11)];
    for (const group of GROUPS)
      for (const mask of masks)
        for (const H of [12, 45, 120])
          for (const floors of [undefined, 30])
            for (const roof of [undefined, "pyramidal"]) {
              const m = generateModel(style.assets, rampIds, group, { seed: seed++, mask, heightVox: H, hints: { floors, roof } });
              expect(check(m, mask), `${group} ${mask.sx}×${mask.sy} H=${H} floors=${floors} roof=${roof}`).toEqual([]);
              n++;
            }
    expect(n).toBe(GROUPS.length * masks.length * 3 * 2 * 2);
  }, 30_000); // several hundred towers: about 3 s alone, longer on a loaded runner

  it("measures a footprint's depth from its edge", () => {
    const { depth, maxDepth } = footprintDepth(rectMask(9, 7));
    expect(depth[0]).toBe(1);
    expect(depth[3 * 9 + 4]).toBe(4);
    expect(maxDepth).toBe(4);
    const notched = footprintDepth(rectMask(10, 10, 3));
    expect(notched.depth[0]).toBe(0);
    expect(notched.depth[3 * 10 + 3]).toBe(1); // the notch's inner corner is on the edge
  });

  it("draws a 1920s tower with recessed bays between piers, setbacks and a crown", () => {
    let stepped = 0;
    let recessed = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const mask = rectMask(24, 20);
      const m = generateModel(style.assets, rampIds, "building.tower.deco", { seed, mask, heightVox: 110, hints: { floors: 28 } });
      expect(check(m, mask)).toEqual([]);
      if (widthAt(m, 10, 100) < widthAt(m, 10, 20)) stepped++;
      // a face at mid-height alternates piers and open bays
      const row = [...Array(24).keys()].map((x) => m.get(x, 0, 40) > 0);
      if (row.includes(true) && row.includes(false)) recessed++;
      // something stands above the roof line (a crown, pinnacles, a finial)
      let top = 0;
      for (let y = 0; y < m.sy; y++) for (let x = 0; x < m.sx; x++) top = Math.max(top, topOf(m, x, y));
      expect(top).toBeGreaterThanOrEqual(110);
    }
    expect(stepped).toBeGreaterThanOrEqual(9);
    expect(recessed).toBe(12);
  });

  it("stands a deco tower on a rectangle when it has no footprint (a point landmark)", () => {
    const m = generateModel(style.assets, rampIds, "building.tower.deco", { seed: 4, heightVox: 100 });
    expect(m.sx).toBeGreaterThan(20);
    let top = 0;
    for (let y = 0; y < m.sy; y++) for (let x = 0; x < m.sx; x++) top = Math.max(top, topOf(m, x, y));
    expect(top).toBeGreaterThanOrEqual(99);
  });

  it("draws glass towers in pale panels, and lighter overall than dark glass", () => {
    const mask = rectMask(20, 16);
    for (let seed = 1; seed <= 6; seed++) {
      const m = generateModel(style.assets, rampIds, "building.tower.glass", { seed, mask, heightVox: 150 });
      const counts = new Map<string, number>();
      for (let z = 10; z < 120; z++)
        for (let x = 0; x < 20; x++) {
          const v = m.get(x, 0, z);
          if (v) counts.set(rampName.get(m.materials[v]!)!, (counts.get(rampName.get(m.materials[v]!)!) ?? 0) + 1);
        }
      const dark = (counts.get("glass") ?? 0) + (counts.get("lit") ?? 0) + (counts.get("lit-cool") ?? 0);
      const light = (counts.get("paint-sky") ?? 0) + (counts.get("bridge-grey") ?? 0) + (counts.get("tower-white") ?? 0) + (counts.get("concrete") ?? 0);
      expect(light, `seed ${seed}: ${JSON.stringify([...counts])}`).toBeGreaterThan(dark);
    }
  });

  it("picks every kind for towers with no year, and glass where the data says glass", () => {
    const mask = rectMask(22, 18);
    const fingerprints = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const m = generateModel(style.assets, rampIds, "building.tower", { seed, mask, heightVox: 90 });
      expect(check(m, mask)).toEqual([]);
      const used = new Set<string>();
      for (let i = 1; i < m.materials.length; i++) used.add(rampName.get(m.materials[i]!)!);
      fingerprints.add([...used].sort().join(","));
    }
    expect(fingerprints.size).toBeGreaterThan(8);
    const g = generateModel(style.assets, rampIds, "building.tower", { seed: 5, mask, heightVox: 90, hints: { facade: "glass" } });
    const names = new Set(g.materials.slice(1).map((r) => rampName.get(r)));
    expect(names.has("paint-sky") || names.has("bridge-grey")).toBe(true);
  });

  it("puts windows on faces turned 45° (the grid south of Market), and never steps a round tower back", () => {
    const diamond = diamondMask(14);
    for (const group of GROUPS)
      for (let seed = 1; seed <= 6; seed++) {
        const m = generateModel(style.assets, rampIds, group, { seed, mask: diamond, heightVox: 80 });
        let glass = 0;
        for (let z = 12; z < 60; z++)
          for (let k = 0; k <= 14; k++) {
            const v = m.get(14 + k, 28 - k, z); // the southeast face
            if (v && glassRamps.has(rampName.get(m.materials[v]!)!)) glass++;
          }
        expect(glass, `${group} seed ${seed}`).toBeGreaterThan(30);
      }
    // a round footprint keeps its width to the top of its body
    const r = 12;
    const on = new Uint8Array((2 * r + 1) ** 2);
    for (let y = 0; y <= 2 * r; y++) for (let x = 0; x <= 2 * r; x++) on[y * (2 * r + 1) + x] = Math.hypot(x - r, y - r) <= r + 0.3 ? 1 : 0;
    const round = { sx: 2 * r + 1, sy: 2 * r + 1, on };
    for (const group of ["building.tower.deco", "building.tower.postmodern"])
      for (let seed = 1; seed <= 8; seed++) {
        const m = generateModel(style.assets, rampIds, group, { seed, mask: round, heightVox: 120 });
        expect(widthAt(m, r, 100), `${group} seed ${seed}`).toBeGreaterThanOrEqual(widthAt(m, r, 20) - 2);
      }
  });

  it("keeps the desert's generic towers on the building generator", () => {
    const desert = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../worlds/_styles/desert-southwest/style.json", import.meta.url)), "utf8"),
    ) as { assets: AssetCatalog };
    for (const [group, a] of Object.entries(desert.assets)) if (group.startsWith("building.")) expect(a.generator, group).toBe("building");
  });
});
