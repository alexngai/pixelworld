import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FACADE_GENERATORS as FACADES, facadeOf } from "../src/facades";
import { generateModel, type AssetCatalog, type VoxelModel } from "../src/index";

/**
 * Street-facing typologies (D-055) under the style guide's building rules:
 * inside the footprint, no overhangs, glass only on the skin, style ramps only.
 */
const style = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../worlds/_styles/bay-area/style.json", import.meta.url)), "utf8"),
) as { assets: AssetCatalog; ramps: Record<string, string[]> };
const rampIds = new Map(Object.keys(style.ramps).map((name, i) => [name, i + 1]));
const rampName = new Map([...rampIds].map(([n, i]) => [i, n]));
const glassRamps = new Set(["glass", "lit", "lit-cool"]);
const FACADE_GENERATORS = new Set(Object.keys(FACADES));

function rect(sx: number, sy: number) {
  return { sx, sy, on: new Uint8Array(sx * sy).fill(1) };
}

function problems(m: VoxelModel, mask: { sx: number; sy: number; on: Uint8Array }): string[] {
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

const GROUPS = [
  "building.rowhouse.victorian",
  "building.rowhouse.edwardian",
  "building.rowhouse.stucco",
  "building.house",
  "building.apartment.bay",
  "building.apartment.modern",
  "building.chinatown",
  "building.commercial.historic",
  "building.industrial",
  "building.pier",
];

// every era a row house can take its form from, and no record at all
const YEARS = [1885, 1898, 1912, 1938, 1956, 1972, undefined];

/** The variant names of a role: wall, wall.blue → ["", "blue"]. */
const variants = (ramps: Record<string, string>, role: string) =>
  Object.keys(ramps)
    .filter((k) => k === role || k.startsWith(role + "."))
    .map((k) => k.slice(role.length + 1))
    .sort();

describe("facade paint and roofs", () => {
  const buildings = Object.entries(style.assets).filter(([g, a]) => g.startsWith("building.") && FACADE_GENERATORS.has(a.generator));

  it("takes trim and accent from the body's scheme when they name the same variants", () => {
    for (const [group, asset] of buildings) {
      const walls = variants(asset.ramps, "wall");
      for (const role of ["trim", "accent"]) {
        const vs = variants(asset.ramps, role);
        // lists of the same length line up by position, so they must name the same schemes
        if (vs.length === walls.length) expect(vs, `${group} ${role}`).toEqual(walls);
      }
    }
  });

  it("keeps flat roofs light: dark slate only on gables", () => {
    for (const [group, asset] of buildings)
      for (const [role, ramp] of Object.entries(asset.ramps))
        if (role === "roof" || role.startsWith("roof.")) expect(ramp, `${group} ${role}`).not.toBe("roof-slate");
    // across many Victorians (some with Queen Anne gables), few roof tops are slate
    const slate = rampIds.get("roof-slate")!;
    let tops = 0;
    let dark = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const mask = rect(5, 19);
      const m = generateModel(style.assets, rampIds, "building.rowhouse.victorian", { seed, mask, heightVox: 9, hints: { front: 6, year: 1895, floors: 2 } });
      for (let y = 0; y < m.sy; y++)
        for (let x = 0; x < m.sx; x++)
          for (let z = m.sz - 1; z >= 0; z--) {
            const v = m.get(x, y, z);
            if (!v) continue;
            tops++;
            if (m.materials[v] === slate) dark++;
            break;
          }
    }
    expect(dark / tops).toBeLessThan(0.1);
  });

  it("sets each house in a row off with a parapet on one lot line", () => {
    // a lot facing -y: seen from the street, along runs toward -x, so along 0 is x = 4
    expect(facadeOf(rect(5, 19), 6).along[4]).toBe(0);
    const m = generateModel(style.assets, rampIds, "building.rowhouse.stucco", { seed: 3, mask: rect(5, 19), heightVox: 7, hints: { front: 6, year: 1938, floors: 1 } });
    const top = (x: number, y: number) => {
      for (let z = m.sz - 1; z >= 0; z--) if (m.get(x, y, z)) return z;
      return -1;
    };
    for (const y of [6, 10, 14]) expect(top(4, y)).toBe(top(2, y) + 1);
  });
});

describe("stucco rows (the Sunset and the Richmond)", () => {
  // driving-scale lots: 5 voxels wide, 14 deep, the front facing +y (the y = 13 row)
  const houses = Array.from({ length: 240 }, (_, i) => {
    const year = [1925, 1940, 1948][i % 3]!;
    const m = generateModel(style.assets, rampIds, "building.rowhouse.stucco", {
      seed: 1000 + i,
      mask: rect(5, 14),
      heightVox: 5.8,
      hints: { front: 2, year, floors: 1 },
    });
    const ramp = (x: number, y: number, z: number) => rampName.get(m.materials[m.get(x, y, z)]!) ?? "";
    let top = 0;
    while (m.get(0, 5, top + 1)) top++;
    // the body's paint low on the side wall (the lot-line parapet runs back in the roof's)
    return { m, year, ramp, H: top, body: ramp(0, 5, 1) };
  });

  it("puts tile on a minority, mostly the 1920s", () => {
    const tiled = houses.map(({ m, ramp }) => {
      for (let z = 0; z < m.sz; z++) for (let y = 0; y < m.sy; y++) for (let x = 0; x < m.sx; x++) if (ramp(x, y, z) === "roof-tile") return true;
      return false;
    });
    const share = (ys: number[]) => {
      const sel = houses.map((h, i) => (ys.includes(h.year) ? tiled[i] : null)).filter((t) => t !== null);
      return sel.filter(Boolean).length / sel.length;
    };
    expect(share([1925, 1940, 1948])).toBeGreaterThan(0.08);
    expect(share([1925, 1940, 1948])).toBeLessThan(0.25);
    expect(share([1925])).toBeGreaterThan(share([1948]));
  });

  it("draws a white garage door at the street and a bay over it on most", () => {
    let garages = 0;
    let painted = 0;
    let bays = 0;
    for (const { m, ramp, H, body } of houses) {
      // the bay keeps the street line while the front beside it (not the entry) steps back
      let bay = false;
      let pier = false;
      for (let x = 0; x < 5; x++) {
        if (m.get(x, 13, H - 2)) bay = true;
        else if (m.get(x, 13, 1)) pier = true;
      }
      if (bay && pier) bays++;
      if (body === "paint-white") continue;
      painted++;
      let white = 0;
      for (let x = 0; x < 5; x++) if (ramp(x, 13, 0) === "paint-white") white++;
      if (white >= 2) garages++;
    }
    expect(garages / painted).toBeGreaterThan(0.9);
    expect(bays / houses.length).toBeGreaterThan(0.7);
  });

  it("varies the parapet's profile from house to house", () => {
    const profiles = new Set(
      houses.map(({ m }) => {
        const tops: number[] = [];
        for (let x = 0; x < 5; x++) {
          let z = m.sz - 1;
          while (z > 0 && !m.get(x, 13, z) && !m.get(x, 12, z)) z--;
          tops.push(z);
        }
        const lo = Math.min(...tops);
        return tops.map((t) => t - lo).join("");
      }),
    );
    expect(profiles.size).toBeGreaterThanOrEqual(5);
  });

  it("paints most of them white, cream, beige, grey or sand, with a pastel here and there", () => {
    const share = (set: Set<string>) => houses.filter((h) => set.has(h.body)).length / houses.length;
    expect(share(NEUTRAL)).toBeGreaterThan(0.65);
    expect(share(PASTEL)).toBeGreaterThan(0.08);
    expect(share(PASTEL)).toBeLessThan(0.33);
  });

  it("caps the bay at the roof line with the parapet set back behind it", () => {
    let capped = 0;
    for (const { m, ramp } of houses) {
      for (let x = 0; x < 5; x++) {
        let z = m.sz - 1;
        while (z > 0 && !m.get(x, 13, z)) z--;
        // the bay's top at the street line: a cap over its glass, the parapet a voxel behind it and higher
        if (!glassRamps.has(ramp(x, 13, z)) && glassRamps.has(ramp(x, 13, z - 1)) && m.get(x, 12, z + 1)) {
          capped++;
          break;
        }
      }
    }
    expect(capped / houses.length).toBeGreaterThan(0.5);
  });
});

/** Body paints: neutral (the avenues), pastel, and the saturated paints of painted ladies. */
const NEUTRAL = new Set(["paint-white", "paint-cream", "stucco", "sand", "tower-white", "terracotta", "concrete"]);
const PASTEL = new Set(["paint-butter", "paint-mint", "paint-sky", "paint-rose", "paint-salmon"]);

describe("paint and height by typology, era and neighbourhood", () => {
  /** The body paint and wall height of n houses of a group on 5 × 12 lots facing +y. */
  const row = (group: string, heightVox: number, floors: number, year: number, n = 160) =>
    Array.from({ length: n }, (_, i) => {
      const m = generateModel(style.assets, rampIds, group, { seed: 7000 + i, mask: rect(5, 12), heightVox, hints: { front: 2, year, floors } });
      // the body low on a side wall; the wall's height at the back of the lot, under any parapet
      let H = 0;
      while (m.get(2, 1, H + 1)) H++;
      return { body: rampName.get(m.materials[m.get(0, 6, 1)]!)!, H };
    });
  const neutral = (xs: { body: string }[]) => xs.filter((h) => NEUTRAL.has(h.body)).length / xs.length;

  it("paints the painted ladies saturated, and the northern hills' Victorians pale", () => {
    expect(neutral(row("building.rowhouse.victorian", 9, 2, 1895))).toBeLessThan(0.25);
    expect(neutral(row("building.rowhouse.victorian.pale", 9, 2, 1895))).toBeGreaterThan(0.55);
    expect(neutral(row("building.rowhouse.edwardian", 9, 2, 1912))).toBeGreaterThan(0.6);
    expect(neutral(row("building.rowhouse.edwardian.painted", 9, 2, 1912))).toBeLessThan(0.5);
  });

  it("steps the roof line house by house where the footprints share one height", () => {
    for (const [group, h, floors, year] of [
      ["building.rowhouse.stucco", 5.76, 1, 1941],
      ["building.rowhouse.edwardian", 8.64, 2, 1912],
      ["building.rowhouse.victorian", 8.64, 2, 1895],
    ] as const) {
      const hs = row(group, h, floors, year).map((x) => x.H);
      let steps = 0;
      for (let i = 1; i < hs.length; i++) if (hs[i] !== hs[i - 1]) steps++;
      expect(steps / (hs.length - 1), group).toBeGreaterThan(0.4);
      expect(Math.max(...hs) - Math.min(...hs), group).toBeLessThanOrEqual(4);
    }
    // three storeys on the roll stand taller than two at the same footprint height
    const mean = (xs: { H: number }[]) => xs.reduce((s, x) => s + x.H, 0) / xs.length;
    expect(mean(row("building.rowhouse.edwardian", 8.64, 3, 1912))).toBeGreaterThan(mean(row("building.rowhouse.edwardian", 8.64, 2, 1912)) + 0.8);
  });
});

describe("Chinatown", () => {
  // walking-scale lots: 18 voxels wide, 30 deep, four storeys, the front facing +y (the y = 29 row)
  const fronts = Array.from({ length: 60 }, (_, i) => {
    const m = generateModel(style.assets, rampIds, "building.chinatown", {
      seed: 300 + i,
      mask: rect(18, 30),
      heightVox: 28,
      hints: { front: 2, year: 1910, floors: 4, corner: i % 2 === 0 },
    });
    const ramps = new Set<string>();
    let glass = "";
    let jadeTop = false;
    let top = 0;
    for (let z = 0; z < m.sz; z++)
      for (let x = 0; x < 18; x++) {
        const v = m.get(x, 29, z);
        const r = v ? rampName.get(m.materials[v]!)! : "";
        if (r) ramps.add(r);
        if (z < 28) glass += glassRamps.has(r) ? "#" : ".";
        if (r === "jade" && z >= 25) jadeTop = true;
      }
    for (let y = 0; y < 30; y++) for (let x = 0; x < 18; x++) for (let z = m.sz - 1; z > top; z--) if (m.get(x, y, z)) top = z;
    return { ramps, glass, jadeTop, top, corner: i % 2 === 0 };
  });

  it("hangs red and gold on every front: rails, signs, a sign band", () => {
    for (const f of fronts) {
      expect(f.ramps.has("chinatown-red")).toBe(true);
      expect(f.ramps.has("tower-gold") || f.ramps.has("jade")).toBe(true);
    }
    expect(fronts.filter((f) => f.ramps.has("tower-gold")).length / fronts.length).toBeGreaterThan(0.8);
  });

  it("tops most fronts with a jade eave, and raises pagodas on some corners", () => {
    expect(fronts.filter((f) => f.jadeTop).length / fronts.length).toBeGreaterThan(0.6);
    const pagodas = (corner: boolean) => fronts.filter((f) => f.corner === corner && f.top >= 28 + 6).length / 30;
    expect(pagodas(true)).toBeGreaterThan(0.2);
    expect(pagodas(true)).toBeGreaterThan(pagodas(false));
  });

  it("varies its window layout from building to building", () => {
    expect(new Set(fronts.map((f) => f.glass)).size).toBeGreaterThanOrEqual(12);
  });

  it("wraps the eave round its sides, and gives a corner lot's side street a front", () => {
    const side = (corner: boolean, seed = 11) => {
      const m = generateModel(style.assets, rampIds, "building.chinatown", {
        seed,
        mask: rect(18, 30),
        heightVox: 28,
        hints: { front: 2, year: 1910, floors: 4, corner },
      });
      // the x = 0 side wall, behind the front
      const count = (want: Set<string>) => {
        let n = 0;
        for (let y = 2; y < 28; y++) for (let z = 0; z < 26; z++) if (want.has(rampName.get(m.materials[m.get(0, y, z)]!) ?? "")) n++;
        return n;
      };
      let jade = 0;
      for (let y = 0; y < 30; y++) if (rampName.get(m.materials[m.get(0, y, 27)]!) === "jade") jade++;
      return { red: count(new Set(["chinatown-red"])), glass: count(glassRamps), jade };
    };
    const plain = side(false);
    const corner = side(true);
    expect(corner.red).toBeGreaterThan(plain.red + 20);
    expect(corner.glass).toBeGreaterThan(plain.glass);
    // most carry the jade eave round the whole roof's edge
    const jade = Array.from({ length: 10 }, (_, i) => side(false, 20 + i).jade > 20);
    expect(jade.filter(Boolean).length).toBeGreaterThanOrEqual(6);
  });
});

describe("facade typologies follow the style guide", () => {
  it("every group, front, size, height and year", () => {
    let seed = 1;
    let models = 0;
    const all: string[] = [];
    for (const group of GROUPS)
      for (const [sx, sy] of [[3, 8], [5, 13], [12, 32], [20, 20], [32, 12]] as const)
        for (const front of [0, 2, 4, 6, 1, undefined])
          for (const H of [4, 11, 18]) {
            const mask = rect(sx, sy);
            const m = generateModel(style.assets, rampIds, group, {
              seed: seed++,
              mask,
              heightVox: H,
              hints: { front, year: YEARS[seed % YEARS.length], floors: Math.max(1, Math.round(H / 4)), corner: seed % 3 === 0 },
            });
            models++;
            expect(m.count()).toBeGreaterThan(0);
            for (const p of problems(m, mask)) all.push(`${group} ${sx}x${sy} front ${front} H ${H}: ${p}`);
          }
    expect(all.slice(0, 10)).toEqual([]);
    expect(models).toBe(GROUPS.length * 5 * 6 * 3);
  });

  it("puts windows and the bay on the street front", () => {
    // a 12×32 lot whose front faces -y (north): the y = 0 wall carries most of the glass
    const mask = rect(12, 32);
    const m = generateModel(style.assets, rampIds, "building.rowhouse.victorian", {
      seed: 7,
      mask,
      heightVox: 18,
      hints: { front: 6, floors: 3, year: 1895 },
    });
    const glassAt = (y: number) => {
      let n = 0;
      for (let z = 0; z < m.sz; z++)
        for (let x = 0; x < m.sx; x++)
          for (const yy of [y, y + (y === 0 ? 1 : -1)]) {
            const v = m.get(x, yy, z);
            if (v && glassRamps.has(rampName.get(m.materials[v]!)!)) n++;
          }
      return n;
    };
    expect(glassAt(0)).toBeGreaterThan(2 * glassAt(31));
  });

  it("measures depth from the front and position along it", () => {
    const f = facadeOf(rect(4, 6), 2); // facing +y
    expect(f.width).toBe(4);
    expect(f.maxDepth).toBe(5);
    expect(f.depth[5 * 4 + 0]).toBe(0); // the y = 5 row is the front
    expect(f.depth[0]).toBe(5);
    const d = facadeOf(rect(4, 6), 4); // facing -x
    expect(d.width).toBe(6);
    expect(d.depth[0]).toBe(0);
  });
});
