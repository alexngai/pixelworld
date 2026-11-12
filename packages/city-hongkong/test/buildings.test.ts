import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateModel, type AssetCatalog, type GenContext, type VoxelModel } from "pixelworld/generators";
import { register as registerSf } from "@pixelworlds/city-sf";
import { BUILDING_GENERATORS } from "../src/buildings";
import { register } from "../src/index";

await register(); // the city pack's generators, on this thread
await registerSf(); // San Francisco's block and towers, which the hongkong pack names too

/**
 * Kowloon's fabric (buildings.ts) under the style guide's building rules
 * (§13): inside the footprint, no overhangs, glass only on the skin, style
 * ramps only; the parts that make each read (a tong lau's row of houses and
 * balconies, a composite's grid of windows and air conditioners, a pencil
 * tower's bay windows and crown); the landmark shapes; and the neon signs.
 */
const style = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../worlds/_styles/hongkong/style.json", import.meta.url)), "utf8"),
) as { assets: AssetCatalog; ramps: Record<string, string[]> };
const rampIds = new Map(Object.keys(style.ramps).map((name, i) => [name, i + 1]));
const rampName = new Map([...rampIds].map(([n, i]) => [i, n]));
const glassRamps = new Set(["glass", "lit", "lit-cool", "curtain-glass"]);
type Mask = { sx: number; sy: number; on: Uint8Array };

const HK = new Set(Object.keys(BUILDING_GENERATORS));
const GROUPS = Object.keys(style.assets).filter((g) => g.startsWith("building.") && HK.has(style.assets[g]!.generator));

function rect(sx: number, sy: number, cut = 0): Mask {
  const on = new Uint8Array(sx * sy);
  for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) on[y * sx + x] = x < cut && y < cut ? 0 : 1;
  return { sx, sy, on };
}

/** A footprint on a diagonal. */
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
  for (const l of m.lines) if (!rampName.has(m.materials[l.m]!)) out.push("a line of an unknown ramp");
  return out;
}

const gen = (group: string, seed: number, mask?: Mask, heightVox?: number, hints?: GenContext["hints"]) =>
  generateModel(style.assets, rampIds, group, { seed, mask, heightVox, hints });

/** How many voxels of a model are of the given ramps. */
const count = (m: VoxelModel, ...ramps: string[]) => {
  const ids = new Set(m.materials.flatMap((r, i) => (i > 0 && ramps.includes(rampName.get(r) ?? "") ? [i] : [])));
  let n = 0;
  for (const v of m.data) if (ids.has(v)) n++;
  return n;
};
const at = (m: VoxelModel, x: number, y: number, z: number) => rampName.get(m.materials[m.get(x, y, z)]!) ?? "";
const topAt = (m: VoxelModel, x: number, y: number) => {
  for (let z = m.sz - 1; z >= 0; z--) if (m.get(x, y, z)) return z;
  return -1;
};
const SIGNS = ["neon-red", "neon-pink", "neon-cyan", "neon-yellow", "neon-green", "sign-white"];
const PASTELS = ["paint-cream", "paint-mint", "mosaic-white", "paint-salmon", "paint-sky", "paint-yellow"];

describe("Hong Kong's buildings", () => {
  it("are drawn by groups of the hongkong pack", () => expect(new Set(GROUPS.map((g) => style.assets[g]!.generator))).toEqual(HK));

  it("stay on their footprint, never overhang and show glass only on their skin", () => {
    let n = 0;
    let seed = 1;
    // a pencil lot, a narrow deep lot, a corner notch, a row, a wide block, a diagonal
    const masks = [rect(1, 4), rect(3, 3), rect(7, 24), rect(12, 30, 4), rect(40, 20), rect(24, 24), diamond(9)];
    for (const group of GROUPS)
      for (const mask of masks)
        for (const H of [10, 40, 160])
          for (const hints of [undefined, { floors: 6, corner: true, front: 0 }, { front: 3, floors: 30 }]) {
            const m = gen(group, seed++, mask, H, hints);
            expect(problems(m, mask), `${group} ${mask.sx}×${mask.sy} H=${H} ${JSON.stringify(hints)}`).toEqual([]);
            n++;
          }
    expect(n).toBe(GROUPS.length * masks.length * 3 * 3);
  }, 120_000);

  it("takes trim from the body's scheme when it names the same variants", () => {
    const variants = (ramps: Record<string, string>, role: string) =>
      Object.keys(ramps)
        .filter((k) => k === role || k.startsWith(role + "."))
        .map((k) => k.slice(role.length + 1))
        .sort();
    for (const group of GROUPS) {
      const r = style.assets[group]!.ramps;
      expect(variants(r, "trim"), group).toEqual(variants(r, "wall"));
    }
  });

  it("draws a wide tong lau footprint as a row of houses, each its own colour and height", () => {
    let colours = 0;
    let steps = 0;
    for (let seed = 1; seed <= 20; seed++) {
      // 35 voxels of front (about 22 m), 26 deep, seven storeys, facing +y: five lots
      const m = gen("building.tonglau", seed, rect(35, 26), 40, { front: 2, floors: 7 });
      const bodies = new Set([3, 10, 17, 24, 31].map((x) => at(m, x, 25, 17)).filter((r) => PASTELS.includes(r)));
      if (bodies.size >= 2) colours++;
      const tops = new Set([3, 10, 17, 24, 31].map((x) => topAt(m, x, 22)));
      if (tops.size >= 2) steps++;
    }
    expect(colours).toBeGreaterThan(15);
    expect(steps).toBeGreaterThan(5);
  });

  it("gives a tong lau a shop under its signboard and a balcony with a railing at every storey", () => {
    for (let seed = 1; seed <= 10; seed++) {
      // one lot: 7 wide, 24 deep, six storeys of 6 voxels over a shop of 8
      const m = gen("building.tonglau", seed, rect(7, 24), 38, { front: 2, floors: 6 });
      const y = 23;
      // the signboard over the shop: sign colours across the lot (not its piers)
      const board = [...Array(m.sz).keys()].filter((z) => SIGNS.includes(at(m, 3, y, z)));
      expect(board.length, `seed ${seed}`).toBeGreaterThanOrEqual(2);
      expect(Math.max(...board), `seed ${seed}`).toBeLessThan(8);
      // each storey above: a railing over the floor line with no glass in it, the balcony's shadow or windows over that
      for (let z0 = 8; z0 < 38; z0 += 6) {
        const row = (z: number) => [1, 2, 3, 4, 5].map((x) => at(m, x, y, z));
        expect(row(z0 + 1).some((r) => glassRamps.has(r)), `seed ${seed} z ${z0 + 1}`).toBe(false);
        const above = [2, 3, 4, 5].flatMap((d) => row(z0 + d));
        expect(above.some((r) => r === "grime" || glassRamps.has(r)), `seed ${seed} z ${z0}`).toBe(true);
      }
    }
  });

  it("hangs laundry poles out of some tong lau balconies, one-pixel lines out of the front", () => {
    let poles = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const m = gen("building.tonglau", seed, rect(14, 24), 40, { front: 2, floors: 7 });
      for (const l of m.lines) if (l.a[2] !== l.b[2] && Math.abs(l.b[1] - l.a[1]) >= 2 && l.b[1] > 24) poles++;
    }
    expect(poles).toBeGreaterThan(10);
  });

  it("puts huts, tanks and aerials on tong lau roofs", () => {
    let huts = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const m = gen("building.tonglau", seed, rect(7, 24), 38, { front: 2, floors: 6 });
      const roof = topAt(m, 3, 21);
      if ([...Array(24).keys()].some((y) => topAt(m, 3, y) > roof + 1)) huts++;
    }
    expect(huts).toBeGreaterThan(8);
  });

  it("covers a composite's front with small windows and air conditioners over its shops", () => {
    for (let seed = 1; seed <= 10; seed++) {
      // 12 wide, 20 deep, eighteen storeys of 5
      const m = gen("building.composite", seed, rect(12, 20), 91, { front: 2, floors: 18 });
      let glass = 0;
      let drips = 0; // under the air conditioners
      for (let z = 10; z < 90; z++)
        for (let x = 0; x < 12; x++) {
          const r = at(m, x, 19, z);
          if (glassRamps.has(r)) glass++;
          if (r === "grime") drips++;
        }
      expect(glass, `seed ${seed}`).toBeGreaterThan(150);
      expect(drips, `seed ${seed}`).toBeGreaterThan(2);
      expect([...Array(12).keys()].some((x) => SIGNS.includes(at(m, x, 19, 3))), `seed ${seed}`).toBe(true);
    }
  });

  it("draws a mall with its storeys under big sign bands", () => {
    let banded = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const m = gen("building.podium", seed, rect(60, 40), 30, { front: 2, floors: 4 });
      if (count(m, ...SIGNS) > 300) banded++;
    }
    expect(banded).toBeGreaterThan(6);
  });

  it("puts a pencil tower's bay windows on every face and a crown with the tanks' enclosure on top", () => {
    const m = gen("building.tower.residential", 4, rect(16, 16), 200, { front: 2, floors: 38 });
    for (const [x, y] of [
      [2, 0],
      [2, 15],
      [0, 2],
      [15, 2],
    ] as const)
      expect([...Array(180).keys()].filter((z) => glassRamps.has(at(m, x, y, z))).length, `${x},${y}`).toBeGreaterThan(80);
    const roof = 38 * 5 + 1; // 38 storeys of 5 under a crown of 8
    expect(topAt(m, 8, 8)).toBeGreaterThan(roof + 4); // the enclosure
    expect(topAt(m, 0, 0) === roof + 1 || topAt(m, 0, 0) > roof + 2).toBe(true); // parapet, or a fin
  });
});

describe("Hong Kong's landmark shapes", () => {
  it("sweeps the curved hall's roof up toward the back, with no windows", () => {
    const mask = rect(60, 50);
    const m = gen("landmark.hall.curved", 1, mask, 80);
    expect(problems(m, mask)).toEqual([]);
    // rises toward the north (y = 0): low at the front, steepening toward the top
    const tops = [49, 37, 25, 12, 0].map((y) => topAt(m, 30, y));
    for (let k = 1; k < tops.length; k++) expect(tops[k]!).toBeGreaterThan(tops[k - 1]!);
    expect(tops[1]! - tops[0]!).toBeLessThan(tops[4]! - tops[3]!);
    expect(count(m, ...glassRamps)).toBe(0);
  });

  it("raises the grand hotel's tower behind its wings, on its footprint", () => {
    // an H: two wings round a forecourt open to the south (+y)
    const mask = rect(40, 52);
    for (let y = 36; y < 52; y++) for (let x = 12; x < 28; x++) mask.on[y * 40 + x] = 0;
    const m = gen("landmark.hotel", 2, mask, 180);
    expect(problems(m, mask)).toEqual([]);
    const wing = topAt(m, 4, 48);
    expect(wing).toBeGreaterThan(50);
    expect(wing).toBeLessThan(70);
    expect(topAt(m, 20, 14)).toBeGreaterThan(170); // the tower over the main block's back
    expect(topAt(m, 20, 30)).toBeLessThan(70); // the main block before it
  });
});

describe("Hong Kong's neon signs", () => {
  const params = style.assets["prop.neon"]!.params as Record<string, number>;
  const S = params.span!;

  it("hang from both building lines over the street, staggered, the middle clear", () => {
    let both = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const m = gen("prop.neon", seed);
      expect(m.sx).toBe(S);
      const sides = [false, false];
      for (let z = 0; z < m.sz; z++)
        for (let y = 0; y < m.sy; y++)
          for (let x = 0; x < m.sx; x++) {
            if (!m.get(x, y, z)) continue;
            expect(SIGNS, `seed ${seed}`).toContain(at(m, x, y, z));
            expect(z, `seed ${seed}`).toBeGreaterThanOrEqual(params.low!);
            expect(z, `seed ${seed}`).toBeLessThan(params.high!);
            // within reach of its wall, a voxel off it
            if (x <= params.reach!) sides[0] = true;
            else if (x >= S - 1 - params.reach!) sides[1] = true;
            else throw new Error(`seed ${seed}: a board in the street's middle at x ${x}`);
            expect(x === 0 || x === S - 1, `seed ${seed}: a board against the wall`).toBe(false);
          }
      if (sides[0] && sides[1]) both++;
      // each board on its frame: lines from a wall (x = 0 or span) out over the street
      expect(m.lines.length, `seed ${seed}`).toBeGreaterThanOrEqual(6);
      for (const l of m.lines) expect([0, S], `seed ${seed}`).toContain(l.a[0]);
      expect(m.lines.every((l) => rampName.get(m.materials[l.m]!) === "steel")).toBe(true);
    }
    expect(both).toBe(30);
  });

  it("draws boards a voxel thick with a tube border and characters in it", () => {
    const m = gen("prop.neon.wide", 3);
    const colours = new Set<string>();
    for (let z = 0; z < m.sz; z++) for (let y = 0; y < m.sy; y++) for (let x = 0; x < m.sx; x++) if (m.get(x, y, z)) colours.add(at(m, x, y, z));
    expect(colours.size).toBeGreaterThanOrEqual(2);
    // a voxel thick: no board voxel has a board voxel beside it along the street
    for (let z = 0; z < m.sz; z++)
      for (let y = 1; y < m.sy; y++) for (let x = 0; x < m.sx; x++) if (m.get(x, y, z) && m.get(x, y - 1, z)) throw new Error(`two boards touching at ${x},${y},${z}`);
  });
});
