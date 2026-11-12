import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateModel, type AssetCatalog, type GenContext, type VoxelModel } from "pixelworld/generators";
import { BUILDING_GENERATORS } from "../src/buildings";
import { register } from "../src/index";

await register(); // the city pack's generators, on this thread

/**
 * New York's fabric (buildings.ts) under the style guide's building rules
 * (§13): inside the footprint, no overhangs, glass only on the skin, style
 * ramps only; and the parts that make each read: a stoop, fire escapes, a
 * column grid, water tanks.
 */
const style = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../worlds/_styles/new-york/style.json", import.meta.url)), "utf8"),
) as { assets: AssetCatalog; ramps: Record<string, string[]> };
const rampIds = new Map(Object.keys(style.ramps).map((name, i) => [name, i + 1]));
const rampName = new Map([...rampIds].map(([n, i]) => [i, n]));
const glassRamps = new Set(["glass", "lit", "lit-cool"]);
type Mask = { sx: number; sy: number; on: Uint8Array };

const NYC = new Set(Object.keys(BUILDING_GENERATORS));
const GROUPS = Object.keys(style.assets).filter((g) => g.startsWith("building.") && NYC.has(style.assets[g]!.generator));

function rect(sx: number, sy: number, cut = 0): Mask {
  const on = new Uint8Array(sx * sy);
  for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) on[y * sx + x] = x < cut && y < cut ? 0 : 1;
  return { sx, sy, on };
}

/** A footprint on a diagonal (a lot on Broadway's angle). */
function diamond(r: number): Mask {
  const s = 2 * r + 1;
  const on = new Uint8Array(s * s);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) on[y * s + x] = Math.abs(x - r) + Math.abs(y - r) <= r ? 1 : 0;
  return { sx: s, sy: s, on };
}

function problems(m: VoxelModel, mask: Mask): string[] {
  const out: string[] = [];
  const onFp = (x: number, y: number) => x >= 0 && y >= 0 && x < mask.sx && y < mask.sy && mask.on[y * mask.sx + x] === 1;
  for (let z = 0; z < m.sz; z++)
    for (let y = 0; y < m.sy; y++)
      for (let x = 0; x < m.sx; x++) {
        const v = m.get(x, y, z);
        if (!v) continue;
        if (!onFp(x, y)) out.push(`outside ${x},${y},${z}`);
        if (z > 0 && !m.get(x, y, z - 1)) out.push(`overhang ${x},${y},${z}`);
        const name = rampName.get(m.materials[v]!);
        if (!name) out.push(`unknown ramp ${x},${y},${z}`);
        if (name && glassRamps.has(name) && m.get(x - 1, y, z) && m.get(x + 1, y, z) && m.get(x, y - 1, z) && m.get(x, y + 1, z) && m.get(x, y, z + 1))
          out.push(`hidden glass ${x},${y},${z}`);
      }
  return out;
}

const gen = (group: string, seed: number, mask: Mask, heightVox: number, hints?: GenContext["hints"]) =>
  generateModel(style.assets, rampIds, group, { seed, mask, heightVox, hints });

/** How many voxels of a model are of a ramp. */
const count = (m: VoxelModel, ramp: string) => {
  const ids = new Set(m.materials.flatMap((r, i) => (i > 0 && rampName.get(r) === ramp ? [i] : [])));
  let n = 0;
  for (const v of m.data) if (ids.has(v)) n++;
  return n;
};
const topAt = (m: VoxelModel, x: number, y: number) => {
  for (let z = m.sz - 1; z >= 0; z--) if (m.get(x, y, z)) return z;
  return -1;
};

describe("New York's buildings", () => {
  it("are drawn by groups of the new-york pack", () =>
    expect(new Set(GROUPS.map((g) => style.assets[g]!.generator))).toEqual(NYC));

  it("stay on their footprint, never overhang and show glass only on their skin", () => {
    let n = 0;
    let seed = 1;
    // a 25-foot lot at the walking and driving scales, a deep lot, a corner notch, a wide block, a diagonal
    const masks = [rect(1, 4), rect(3, 3), rect(5, 12), rect(12, 24), rect(16, 30, 5), rect(40, 32), diamond(9)];
    for (const group of GROUPS)
      for (const mask of masks)
        for (const H of [10, 36, 140])
          for (const hints of [undefined, { floors: 6, corner: true, front: 0 }, { front: 3 }]) {
            const m = gen(group, seed++, mask, H, hints);
            expect(problems(m, mask), `${group} ${mask.sx}×${mask.sy} H=${H} ${JSON.stringify(hints)}`).toEqual([]);
            n++;
          }
    expect(n).toBe(GROUPS.length * masks.length * 3 * 3);
  }, 30_000);

  it("takes trim, base and stoop from the body's scheme when they name the same variants", () => {
    const variants = (ramps: Record<string, string>, role: string) =>
      Object.keys(ramps)
        .filter((k) => k === role || k.startsWith(role + "."))
        .map((k) => k.slice(role.length + 1))
        .sort();
    for (const group of GROUPS) {
      const r = style.assets[group]!.ramps;
      const walls = variants(r, "wall");
      for (const role of ["trim", "base", "stoop", "cornice", "iron", "accent"]) {
        const vs = variants(r, role);
        if (vs.length === walls.length) expect(vs, `${group} ${role}`).toEqual(walls);
      }
    }
  });

  it("raises a brownstone's parlour floor on a stoop in front of a facade set back for it", () => {
    let stoops = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const m = gen("building.brownstone", seed, rect(11, 24), 36, { front: 2, floors: 4 });
      // front 2 faces +y: the street is at y = 23; the stoop climbs toward the facade
      const front = [...Array(11).keys()].map((x) => topAt(m, x, 23));
      const climbs = [...Array(11).keys()].some((x) => topAt(m, x, 23) >= 0 && topAt(m, x, 19) > topAt(m, x, 23) && topAt(m, x, 19) < 20);
      if (climbs && Math.min(...front) < 3) stoops++;
      expect(count(m, "iron"), `seed ${seed}`).toBeGreaterThan(0); // the fence and the stoop's rails
    }
    expect(stoops).toBe(20);
  });

  it("puts fire escapes on most tenements and shopfronts under them", () => {
    let escapes = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const m = gen("building.tenement", seed, rect(12, 30), 48, { front: 2 });
      if (count(m, "iron") > 40) escapes++;
      const signs = ["sign-red", "sign-green", "paint-navy", "gold", "paint-white"].reduce((s, r) => s + count(m, r), 0);
      expect(signs, `seed ${seed}`).toBeGreaterThan(0);
    }
    expect(escapes).toBeGreaterThan(18);
  });

  it("puts water tanks on prewar blocks of any height, with no storey cap", () => {
    let tanks = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const tall = gen("building.apartment.prewar", seed, rect(30, 30), 400, { floors: 48 });
      expect(tall.sz).toBeGreaterThan(400); // SF's block stops at 120 voxels
      if (count(tall, "cedar") > 0) tanks++;
    }
    expect(tanks).toBeGreaterThan(9);
  });

  it("gives a cast-iron loft a painted front over brick party walls", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const m = gen("building.loft.castiron", seed, rect(16, 30), 50, { front: 2 });
      expect(count(m, "brick") + count(m, "brick-buff"), `seed ${seed}`).toBeGreaterThan(0);
      expect(count(m, "castiron-cream") + count(m, "castiron-grey") + count(m, "paint-white"), `seed ${seed}`).toBeGreaterThan(0);
    }
  });

  it("is deterministic", () => {
    for (const group of GROUPS) {
      const a = gen(group, 7, rect(12, 24), 40, { front: 2 });
      const b = gen(group, 7, rect(12, 24), 40, { front: 2 });
      expect(Buffer.from(a.data).equals(Buffer.from(b.data)), group).toBe(true);
    }
  });
});
