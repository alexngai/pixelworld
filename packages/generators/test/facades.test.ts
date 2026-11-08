import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { facadeOf } from "../src/facades";
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
  "building.apartment.bay",
  "building.apartment.modern",
  "building.chinatown",
  "building.commercial.historic",
  "building.industrial",
  "building.pier",
];

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
              hints: { front, year: seed % 2 ? 1885 : 1898, floors: Math.max(1, Math.round(H / 4)), corner: seed % 3 === 0 },
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
