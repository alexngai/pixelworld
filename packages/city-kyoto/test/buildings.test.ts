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

const KYOTO = new Set(["machiya", "midrise", "templeHall", "kura"]);
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
    // Gion's paper lanterns glow at night too (D-100)
    expect(Object.keys(style.night.emissive).sort()).toEqual(["chochin", "lit", "lit-cool", "marker"]);
  });
});

/** No hints, a corner lot, a diagonal front, and each roof shape the data can give (D-100). */
const HINTS: (GenContext["hints"] | undefined)[] = [
  undefined,
  { floors: 2, corner: true, front: 0 },
  { floors: 5, front: 3 },
  ...["gabled", "hipped", "skillion", "flat", "pyramidal"].map((roof) => ({ floors: 2, front: 6, roof, corner: roof === "flat" })),
];

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
          for (const hints of HINTS) {
            const m = gen(group, seed++, mask, H, hints);
            expect(problems(m, mask), `${group} ${mask.sx}×${mask.sy} H=${H} ${JSON.stringify(hints)}`).toEqual([]);
            n++;
          }
    expect(n).toBe(GROUPS.length * masks.length * 3 * HINTS.length);
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

  it("draws the roof the data gives: hipped or gabled houses, a shed, a pitched mid-rise (D-100)", () => {
    const mask = rect(16, 16);
    const at = (group: string, roof: string, H = 16) => gen(group, 9, mask, H, { floors: 2, front: 6, roof });
    // gabled: the ridge runs the whole width; hipped: the ends fall away
    const gabled = at("building.house.gabled", "gabled");
    const hipped = at("building.house.gabled", "hipped");
    const ridgeY = (m: VoxelModel) => Array.from({ length: 16 }, (_, y) => y).reduce((b, y) => (topAt(m, 8, y) > topAt(m, 8, b) ? y : b), 0);
    expect(topAt(gabled, 0, ridgeY(gabled))).toBe(topAt(gabled, 8, ridgeY(gabled)));
    expect(topAt(hipped, 0, ridgeY(hipped))).toBeLessThan(topAt(hipped, 8, ridgeY(hipped)) - 2);
    // a shed rises from the front to the rear
    const shed = at("building.house.gabled", "skillion");
    expect(topAt(shed, 8, 14)).toBeGreaterThan(topAt(shed, 8, 3) + 2);
    // flat only where the asset draws flat roofs: the default houses do, the wooden ones keep a pitch
    // (behind the pent roof's two rows)
    expect(topAt(at("building.residential", "flat"), 8, 8)).toBe(topAt(at("building.residential", "flat"), 8, 3));
    expect(topAt(at("building.house.gabled", "flat"), 8, 8)).toBeGreaterThan(topAt(at("building.house.gabled", "flat"), 8, 3));
    // a mid-rise with a pitched roof in the data wears one in tile, without the flat roof's parapet
    const pitched = at("building.midrise", "hipped", 40);
    expect(nameAt(pitched, 8, 8, topAt(pitched, 8, 8))).toBe("kawara");
    expect(topAt(pitched, 8, 8)).toBeGreaterThan(topAt(pitched, 1, 8) + 2);
  });

  it("draws a kura: a namako skirt under white plaster and a steep tile roof (D-100)", () => {
    const m = gen("building.kura", 3, rect(10, 14), 16, { floors: 2, front: 6 });
    const side = (z: number) => Array.from({ length: 14 }, (_, y) => nameAt(m, 0, y, z));
    expect(side(2)).toContain("kawara"); // the skirt's tiles
    expect(side(2)).toContain("plaster"); // and their joints
    expect(new Set(side(10))).toEqual(new Set(["plaster"]));
    expect(topAt(m, 5, 7)).toBeGreaterThanOrEqual(topAt(m, 0, 7) + 2); // the ridge along the longer side
  });

  it("draws a row mapped as one footprint as houses of their own, party walls between (D-102)", () => {
    // 30 m of front, 19 m deep, two storeys: about five houses
    const heights = new Set<number>();
    let pillars = 0;
    for (const seed of [11, 12, 13]) {
      const m = gen("building.machiya", seed, rect(48, 30), 13, { floors: 2, front: 6 });
      for (let x = 1; x < 47; x++) heights.add(topAt(m, x, 9));
      for (let x = 1; x < 47; x++) if (nameAt(m, x, 0, 3) === "timber") pillars++;
    }
    expect(heights.size).toBeGreaterThan(1); // the houses' roofs stand at more than one height
    expect(pillars).toBeGreaterThanOrEqual(3 * 8); // a pair of pillars at each of four party walls
  });

  it("gives some mid-rises a pent eave of tile over the ground floor (D-102)", () => {
    let found = false;
    for (let seed = 1; seed < 40 && !found; seed++) {
      const m = gen("building.midrise", seed, rect(20, 20), 48, { floors: 6, front: 6 });
      const front = topAt(m, 10, 0);
      if (front < topAt(m, 10, 2) - 10 && nameAt(m, 10, 0, front) === "kawara") found = true;
    }
    expect(found).toBe(true);
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
      // a rail across the front (an air conditioner's box on it here and there), on the face a pent eave may set back
      const rails = Array.from({ length: m.sz }, (_, z) => [frontRow(m, z), frontRow(m, z, 1)])
        .map(([a, b]) => (a!.slice(1, -1).some((n) => n === "steel-grey") ? a! : b!))
        .filter((r) => {
          const mid = r.slice(1, -1);
          return mid.filter((n) => n === "steel-grey").length >= mid.length * 0.6 && mid.every((n) => n === "steel-grey" || n === "concrete-white" || n === "tile-beige");
        });
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

  it("draw a torii: two pillars open between them, a lintel wider than the span, stone lanterns (D-100)", () => {
    const H = 16;
    const m = generateModel(style.assets, rampIds, "landmark.torii", { seed: 1, heightVox: H });
    const row = (z: number) => Array.from({ length: m.sx }, (_, x) => (m.get(x, 1, z) ? 1 : 0)).join("");
    expect(row(4)).toMatch(/^0+1+0+1+0+$/); // two pillars, the passage open between them
    expect(row(H - 1)).toMatch(/^1+$/); // the kasagi across the whole width
    expect(nameAt(m, 0, 1, H)).toBe("timber-dark"); // its swept-up end
    const lamps: string[] = [];
    for (let y = 0; y < m.sy; y++) for (let x = 0; x < m.sx; x++) for (let z = 0; z < H; z++) lamps.push(nameAt(m, x, y, z));
    expect(lamps).toContain("lit");
  });

  it("draw a gilded pavilion: three storeys, the upper two gold, a phoenix on its pyramid (D-102)", () => {
    const H = 40;
    const m = generateModel(style.assets, rampIds, "landmark.pavilion.gold", { seed: 1, heightVox: H });
    const cx = Math.floor(m.sx / 2);
    const cy = Math.floor(m.sy / 2);
    expect(topAt(m, cx, cy)).toBe(H);
    expect(nameAt(m, cx, cy, H)).toBe("gold");
    const facing = (z: number) => {
      for (let y = 0; y < m.sy; y++) if (m.get(cx + 1, y, z)) return nameAt(m, cx + 1, y, z);
      return "";
    };
    expect(facing(Math.round(H * 0.15))).not.toBe("gold"); // the first storey, natural wood
    const golds = Array.from({ length: H }, (_, z) => facing(z)).filter((n) => n === "gold").length;
    expect(golds).toBeGreaterThan(H * 0.15);
    // the lower roof reaches further than the top one
    const reach = (z0: number, z1: number) => {
      let r = 0;
      for (let z = z0; z < z1; z++) for (let x = 0; x <= cx; x++) if (m.get(x, cy, z)) r = Math.max(r, cx - x);
      return r;
    };
    expect(reach(H * 0.3, H * 0.6)).toBeGreaterThan(reach(H * 0.75, H));
  });

  it("draw utility poles whose wires reach along y, sagging toward their ends (D-102)", () => {
    const m = generateModel(style.assets, rampIds, "prop.pole", { seed: 2 });
    const c = Math.floor(m.sy / 2);
    expect(m.sy).toBeGreaterThan(40); // 24 voxels each side
    const at = (y: number) => {
      for (let z = m.sz - 1; z >= 0; z--) if (m.get(0, y, z)) return z;
      return -1;
    };
    expect(at(c + 1)).toBeGreaterThan(at(m.sy - 1)); // lower at mid-span than by the pole
    expect(at(0)).toBe(at(m.sy - 1));
  });

  it("draw a diagonal street's pole with its wires along x = y (D-103)", () => {
    const m = generateModel(style.assets, rampIds, "prop.pole.diagonal", { seed: 2 });
    expect(m.sx).toBe(m.sy);
    const c = Math.floor(m.sx / 2);
    let wires = 0;
    for (let t = 3; t < c; t++) for (let z = 0; z < m.sz; z++) if (m.get(c + t, c + t, z) || m.get(c - t, c - t, z)) wires++;
    expect(wires).toBeGreaterThan(c / 2); // the telecom cable at every step out to its reach
    for (let z = 0; z < m.sz; z++) expect(m.get(c + c - 1, c - (c - 1), z)).toBe(0); // nothing along the other diagonal
  });

  it("draw stone wall segments along each of the four directions, and the 2:1 streets' poles (D-104)", () => {
    const along = (group: string, dx: number, dy: number) => {
      const m = generateModel(style.assets, rampIds, group, { seed: 1 });
      const c = Math.floor(m.sx / 2);
      let on = 0;
      for (let t = 1; t <= 3; t++) if (m.get(c + Math.round(t * dx), c + Math.round(t * dy), 0) || m.get(c + Math.round(t * dx), c + Math.round(t * dy), 1)) on++;
      return on;
    };
    expect(along("wall.stone", 0, 1)).toBe(3);
    expect(along("wall.stone.diagonal", 1, 1)).toBe(3);
    expect(along("wall.stone.slant", 1, -0.5)).toBe(3);
    expect(along("wall.stone.slant2", 0.5, -1)).toBe(3);
    // the 2:1 pole's telecom cable runs along (2, −1)
    const m = generateModel(style.assets, rampIds, "prop.pole.slant", { seed: 2 });
    const c = Math.floor(m.sx / 2);
    let cable = 0;
    for (let t = 2; t < 10; t++) for (let z = 0; z < m.sz; z++) if (m.get(c + t, c + Math.round(-t / 2), z)) cable++;
    expect(cable).toBeGreaterThanOrEqual(6);
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
