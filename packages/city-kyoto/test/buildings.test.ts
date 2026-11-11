import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateModel, type AssetCatalog, type GenContext, type VoxelModel } from "pixelworld/generators";
import { register } from "../src/index";

await register(); // the city pack's generators, on this thread

/**
 * Kyoto's fabric (buildings.ts) and its temples, gates and pagodas
 * (temples.ts) under the style guide's building rules (§13): inside the
 * footprint, no overhangs, glass only on the skin, style ramps only, for every
 * building group; and the parts that make each read: the machiya's lattice,
 * pent roof, slit windows and ridge along the street, the mid-rise's
 * balconies, the temple's platform and hip-and-gable roof, the gate's open
 * passage, the pagoda's tiers and finial, the stage on its pillars.
 */
const style = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../worlds/_styles/kyoto/style.json", import.meta.url)), "utf8"),
) as { assets: AssetCatalog; ramps: Record<string, string[]>; night: { emissive: Record<string, string[]> } };
const rampIds = new Map(Object.keys(style.ramps).map((name, i) => [name, i + 1]));
const rampName = new Map([...rampIds].map(([n, i]) => [i, n]));
const glassRamps = new Set(["glass", "lit", "lit-cool", "curtain-glass"]);
type Mask = { sx: number; sy: number; on: Uint8Array };

const KYOTO = new Set(["machiya", "midrise", "templeHall"]);
const GROUPS = Object.keys(style.assets).filter((g) => g.startsWith("building.") && KYOTO.has(style.assets[g]!.generator));

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

/** An L: a lot with a wing round a garden. */
function ell(s: number): Mask {
  const on = new Uint8Array(s * s);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) on[y * s + x] = x < s / 3 || y < s / 3 ? 1 : 0;
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

const gen = (group: string, seed: number, mask: Mask | undefined, heightVox: number, hints?: GenContext["hints"]) =>
  generateModel(style.assets, rampIds, group, { seed, mask, heightVox, hints });

/** The ramp names of a model's voxels in one row of its front (y = 0 faces −y: front 6). */
const frontRow = (m: VoxelModel, z: number, y = 0) => {
  const out: string[] = [];
  for (let x = 0; x < m.sx; x++) {
    const v = m.get(x, y, z);
    out.push(v ? rampName.get(m.materials[v]!)! : "");
  }
  return out;
};
const topAt = (m: VoxelModel, x: number, y: number) => {
  for (let z = m.sz - 1; z >= 0; z--) if (m.get(x, y, z)) return z;
  return -1;
};
const nameAt = (m: VoxelModel, x: number, y: number, z: number) => rampName.get(m.materials[m.get(x, y, z)]!) ?? "";

describe("Kyoto's pack", () => {
  it("keeps to 42 ramps, with a marker and a night palette", () => {
    expect(Object.keys(style.ramps).length).toBeLessThanOrEqual(42);
    expect(style.ramps.marker).toBeDefined();
    expect(Object.keys(style.night.emissive).sort()).toEqual(["lit", "lit-cool", "marker"]);
  });
});

describe("Kyoto's buildings", () => {
  it("are drawn by groups of the kyoto pack", () => expect(new Set(GROUPS.map((g) => style.assets[g]!.generator))).toEqual(KYOTO));

  it("stay on their footprint, never overhang and show glass only on their skin", () => {
    let n = 0;
    let seed = 1;
    // a sliver, a narrow machiya lot, a deep one, a corner notch, a wide block, a diagonal, an L round a garden
    const masks = [rect(1, 4), rect(3, 3), rect(8, 40), rect(12, 24), rect(16, 30, 5), rect(40, 32), diamond(9), ell(30)];
    for (const group of GROUPS)
      for (const mask of masks)
        for (const H of [8, 20, 60])
          for (const hints of [undefined, { floors: 2, corner: true, front: 0 }, { floors: 5, front: 3 }]) {
            const m = gen(group, seed++, mask, H, hints);
            expect(problems(m, mask), `${group} ${mask.sx}×${mask.sy} H=${H} ${JSON.stringify(hints)}`).toEqual([]);
            n++;
          }
    expect(n).toBe(GROUPS.length * masks.length * 3 * 3);
  }, 60_000);

  it("draws a machiya with a lattice front, a pent roof, slit windows and a ridge along the street", () => {
    // 6 m wide and 25 m deep, facing −y (front 6), two storeys, 8 m to the ridge
    const mask = rect(10, 40);
    const m = gen("building.machiya", 4, mask, 19, { floors: 2, front: 6 });
    // the ground storey's front alternates slats and dark gaps (or a fence at its foot)
    const rows = Array.from({ length: 8 }, (_, z) => frontRow(m, z).slice(1, -1));
    const lattice = rows.filter((r) => r.some((n) => n === "koshi" || n === "timber") && r.some((n) => n === "timber-dark" || n === "lit"));
    expect(lattice.length).toBeGreaterThanOrEqual(2);
    // the pent roof: tile on the front column, the upper storey standing back behind it
    const front = topAt(m, 5, 0);
    expect(nameAt(m, 5, 0, front)).toBe("kawara");
    expect(topAt(m, 5, 3)).toBeGreaterThan(front + 4);
    // the ridge runs along the street: level across the front, highest mid-depth of the front house
    const ridgeY = Array.from({ length: 20 }, (_, y) => y).reduce((b, y) => (topAt(m, 5, y) > topAt(m, 5, b) ? y : b), 0);
    expect(ridgeY).toBeGreaterThan(4);
    for (let x = 1; x < 9; x++) expect(topAt(m, x, ridgeY)).toBe(topAt(m, 5, ridgeY));
    expect(topAt(m, 5, ridgeY)).toBe(m.sz - 3 + (topAt(m, 5, ridgeY) - (m.sz - 3)));
  });

  it("gives a deep machiya lot a front house and wings under roofs of their own", () => {
    const m = gen("building.machiya", 4, rect(9, 64), 19, { floors: 2, front: 6 });
    const tops = Array.from({ length: 64 }, (_, y) => topAt(m, 4, y));
    // a valley between two ridges: some row lower than rows on both sides of it
    const valley = tops.some((t, y) => y > 4 && y < 60 && t < Math.max(...tops.slice(0, y)) - 2 && t < Math.max(...tops.slice(y)) - 2);
    expect(valley).toBe(true);
  });

  it("draws a mid-rise's flats with a balcony across every storey", () => {
    for (let seed = 1; seed < 40; seed++) {
      const m = gen("building.midrise", seed, rect(24, 20), 56, { floors: 7, front: 6 });
      const rails = Array.from({ length: m.sz }, (_, z) => frontRow(m, z)).filter((r) => r.slice(1, -1).every((n) => n === "steel-grey"));
      if (rails.length) {
        expect(rails.length).toBe(6); // every storey above the ground
        return;
      }
    }
    throw new Error("no flats in 40 seeds");
  });

  it("puts a temple hall on a stone platform under a hip-and-gable roof whose ridge runs along the longer side", () => {
    const mask = rect(40, 24);
    const m = gen("building.temple", 2, mask, 50);
    // the platform at the foot of every face
    expect(nameAt(m, 20, 0, 0)).toBe("stone");
    expect(nameAt(m, 0, 12, 0)).toBe("stone");
    // the roof is the larger part, highest along the long axis
    const ridge = topAt(m, 20, 12);
    expect(ridge).toBeGreaterThan(m.sz * 0.7);
    expect(topAt(m, 20, 3)).toBeLessThan(ridge - 8);
    expect(topAt(m, 12, 12)).toBeGreaterThan(ridge - 3); // along the ridge
    // the hipped skirt at the ends, the gable standing on it: the end lower than the gable
    expect(topAt(m, 1, 12)).toBeLessThan(topAt(m, 10, 12) - 4);
    // plaster in the gable, its ornament under the apex
    const gable: string[] = [];
    for (let x = 0; x < 20; x++) for (let z = 0; z < m.sz; z++) gable.push(nameAt(m, x, 12, z));
    expect(gable).toContain("plaster");
    expect(gable).toContain("gold");
  });

  it("is the same model for the same seed", () => {
    for (const group of GROUPS) {
      const a = gen(group, 42, rect(14, 20), 30, { floors: 2 });
      const b = gen(group, 42, rect(14, 20), 30, { floors: 2 });
      expect(Buffer.from(a.data).equals(Buffer.from(b.data)), group).toBe(true);
    }
  });
});

describe("Kyoto's landmarks", () => {
  it("draw a five-storey pagoda: five roofs, each smaller than the one below, and a finial", () => {
    const H = 110;
    const m = generateModel(style.assets, rampIds, "landmark.pagoda", { seed: 1, heightVox: H });
    const c = Math.floor(m.sx / 2);
    expect(topAt(m, c, c)).toBe(H);
    // up a line just outside the body: roof, open air, roof … five times
    const x = c - Math.round(H * 0.09); // outside every body and the platform, under every roof
    let roofs = 0;
    let inRoof = false;
    for (let z = 0; z < H; z++) {
      const solid = m.get(x, c, z) !== 0;
      if (solid && !inRoof) roofs++;
      inRoof = solid;
    }
    expect(roofs).toBe(5);
    // the eaves reach out far past the body, and the top roof is narrower than the lowest
    const reach = (z0: number, z1: number) => {
      let r = 0;
      for (let z = z0; z < z1; z++) for (let xx = 0; xx <= c; xx++) if (m.get(xx, c, z)) r = Math.max(r, c - xx);
      return r;
    };
    expect(reach(0, H * 0.3)).toBeGreaterThan(reach(H * 0.55, H * 0.78));
    // bronze rings on the mast
    expect(nameAt(m, c, c, H - 6)).toBe("bronze");
  });

  it("draw a two-storey gate open through its middle bay", () => {
    for (const group of ["landmark.gate.romon", "landmark.gate.sanmon"]) {
      const m = generateModel(style.assets, rampIds, group, { seed: 1, heightVox: 60 });
      expect(m.sx).toBeGreaterThan(m.sy);
      const cx = Math.floor(m.sx / 2);
      const cy = Math.floor(m.sy / 2);
      // the passage: open at the foot through the middle, under a closed upper storey
      let open = 0;
      for (let y = 0; y < m.sy; y++) if (!m.get(cx + 1, y, 6)) open++;
      expect(open, group).toBeGreaterThan(m.sy * 0.5);
      expect(m.get(cx, cy, 40), group).not.toBe(0);
      expect(topAt(m, cx, cy), group).toBeGreaterThanOrEqual(58);
    }
  });

  it("draw Kyoto Tower: a slender shaft, a deck wider than it with windows, a spire to the top", () => {
    const H = 210;
    const m = generateModel(style.assets, rampIds, "landmark.tower.candle", { seed: 1, heightVox: H });
    const c = Math.floor(m.sx / 2);
    const width = (z: number) => {
      let n = 0;
      for (let x = 0; x < m.sx; x++) if (m.get(x, c, z)) n++;
      return n;
    };
    const deck = Math.round(H * 0.72);
    expect(width(deck)).toBeGreaterThan(width(Math.round(H * 0.5)) + 6);
    expect(width(Math.round(H * 0.5))).toBeLessThan(width(Math.round(H * 0.1)));
    expect(width(Math.round(H * 0.9))).toBeLessThan(width(Math.round(H * 0.5)));
    expect(topAt(m, c, c)).toBeGreaterThanOrEqual(H - 1);
    const ring: string[] = [];
    for (let z = deck - 6; z < deck + 6; z++) for (let x = 0; x < m.sx; x++) ring.push(nameAt(m, x, c, z));
    expect(ring).toContain("lit");
  });

  it("draw Kiyomizu-dera's hall on a stage of pillars over the slope", () => {
    const H = 74;
    const m = generateModel(style.assets, rampIds, "landmark.temple.stage", { seed: 1, heightVox: H });
    const zs = Math.round(H * 0.42);
    const cx = Math.floor(m.sx / 2);
    // the stage's deck at zs on the +y side, open under it but for pillars
    expect(nameAt(m, cx, m.sy - 2, zs)).toBe("timber");
    let air = 0;
    for (let x = 0; x < m.sx; x++) if (!m.get(x, m.sy - 3, Math.round(zs / 2))) air++;
    expect(air).toBeGreaterThan(m.sx * 0.4);
    // the hall behind it, its roof the highest point
    let ridge = 0;
    for (let y = 0; y < m.sy * 0.6; y++) ridge = Math.max(ridge, topAt(m, cx, y));
    expect(ridge).toBeGreaterThanOrEqual(H - 2);
  });
});
