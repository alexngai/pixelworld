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
