import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateModel, registerGenerators, type AssetCatalog, type GenContext, type VoxelModel } from "pixelworld/generators";
import { TEMPLE_GENERATORS } from "../src/temple";

registerGenerators(TEMPLE_GENERATORS);

/**
 * The Chinese temple (temple.ts) under the building rules (§13): inside the
 * footprint, no overhangs, style ramps only; and what makes it read: a roof
 * ridge to each hall (three on Man Mo's footprint, the middle tallest), roofs
 * of glazed tile, the ridge's figures, a red door on the front.
 */
const style = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../worlds/_styles/hongkong/style.json", import.meta.url)), "utf8"),
) as { ramps: Record<string, string[]> };
const rampIds = new Map(Object.keys(style.ramps).map((name, i) => [name, i + 1]));
const rampName = new Map([...rampIds].map(([n, i]) => [i, n]));
const RIDGE = ["paint-yellow", "paint-sky", "paint-mint", "mosaic-white"];
const catalog: AssetCatalog = {
  "landmark.temple.chinese": {
    generator: "chineseTemple",
    ramps: { wall: "tile-grey", base: "granite", roof: "jade", ridge: RIDGE[0]!, "ridge.a": RIDGE[1]!, "ridge.b": RIDGE[2]!, "ridge.c": RIDGE[3]!, door: "taxi", trim: "bark" },
  },
};
type Mask = { sx: number; sy: number; on: Uint8Array };

/** A rectangle, less a w × d corner: the rear left (y < d) or the front left. */
function rect(sx: number, sy: number, w = 0, d = 0, frontCut = false): Mask {
  const on = new Uint8Array(sx * sy);
  for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) on[y * sx + x] = x < w && (frontCut ? y >= sy - d : y < d) ? 0 : 1;
  return { sx, sy, on };
}

const gen = (seed: number, mask?: Mask, heightVox = 14, hints?: GenContext["hints"]) =>
  generateModel(catalog, rampIds, "landmark.temple.chinese", { seed, mask, heightVox, hints });
const at = (m: VoxelModel, x: number, y: number, z: number) => rampName.get(m.materials[m.get(x, y, z)]!) ?? "";
const topAt = (m: VoxelModel, x: number, y: number) => {
  for (let z = m.sz - 1; z >= 0; z--) if (m.get(x, y, z)) return z;
  return -1;
};

function problems(m: VoxelModel, mask: Mask): string[] {
  const out: string[] = [];
  const onFp = (x: number, y: number) => x >= 0 && y >= 0 && x < mask.sx && y < mask.sy && mask.on[y * mask.sx + x] === 1;
  for (let z = 0; z < m.sz; z++)
    for (let y = 0; y < m.sy; y++)
      for (let x = 0; x < m.sx; x++) {
        if (!m.get(x, y, z)) continue;
        if (!onFp(x, y)) out.push(`outside ${x},${y},${z}`);
        if (z > 0 && !m.get(x, y, z - 1)) out.push(`overhang ${x},${y},${z}`);
        if (!at(m, x, y, z)) out.push(`unknown ramp ${x},${y},${z}`);
      }
  return out;
}

/** The ridges along the front (x when alongX): runs of positions whose columns are topped by a ridge colour, and each run's top. */
function ridges(m: VoxelModel, alongX = true): number[] {
  const tops: number[] = [];
  let run = -1;
  for (let u = 0; u < (alongX ? m.sx : m.sy); u++) {
    let top = -1;
    for (let v = 0; v < (alongX ? m.sy : m.sx); v++) {
      const [x, y] = alongX ? [u, v] : [v, u];
      const z = topAt(m, x, y);
      if (z >= 0 && RIDGE.includes(at(m, x, y, z))) top = Math.max(top, z);
    }
    if (top < 0) run = -1;
    else if (run < 0) run = tops.push(top) - 1;
    else tops[run] = Math.max(tops[run]!, top);
  }
  return tops;
}

describe("the Chinese temple", () => {
  const masks: [string, Mask][] = [
    ["10×8", rect(10, 8)],
    ["24×12", rect(24, 12)],
    ["72×32", rect(72, 32)],
    ["L", rect(48, 24, 16, 10)],
    ["front notch", rect(40, 20, 8, 6, true)],
    ["deep 12×30", rect(12, 30)],
  ];

  it("stays inside its footprint, overhangs nothing and draws in the style's ramps", () => {
    for (const [name, mask] of masks)
      for (const h of [12, 14, 16])
        for (let seed = 1; seed <= 4; seed++) expect(problems(gen(seed, mask, h), mask), `${name} h${h} seed ${seed}`).toEqual([]);
    const m = gen(1);
    expect([m.sx, m.sy]).toEqual([24, 12]); // no footprint: a default one
    expect(problems(m, rect(24, 12))).toEqual([]);
  });

  it("raises a ridge to each hall: one on a small temple, two or three side by side on a wide one, the middle tallest", () => {
    expect(ridges(gen(1, rect(10, 8), 12))).toHaveLength(1);
    expect(ridges(gen(1, rect(24, 12), 12))).toHaveLength(1);
    expect(ridges(gen(1, rect(44, 16)))).toHaveLength(2);
    for (let seed = 1; seed <= 4; seed++) {
      const r = ridges(gen(seed, rect(72, 32), 16));
      expect(r, `seed ${seed}`).toHaveLength(3);
      expect(r[1]).toBeGreaterThan(r[0]!);
      expect(r[1]).toBeGreaterThan(r[2]!);
    }
    expect(ridges(gen(1, rect(32, 72), 16), false)).toHaveLength(3); // deeper than wide: the front faces +x
  });

  it("roofs it mostly in glazed tile, with figures of several colours on the ridges", () => {
    for (const [name, mask] of masks) {
      const m = gen(2, mask);
      let tops = 0;
      let tile = 0;
      for (let y = 0; y < m.sy; y++)
        for (let x = 0; x < m.sx; x++) {
          const z = topAt(m, x, y);
          if (z < 0) continue;
          tops++;
          if (at(m, x, y, z) === "jade") tile++;
        }
      expect(tile / tops, name).toBeGreaterThan(0.5);
    }
    const m = gen(3, rect(72, 32), 16);
    const accents = new Set<string>();
    for (let i = 0; i < m.data.length; i++) {
      const r = rampName.get(m.materials[m.data[i]!]!) ?? "";
      if (RIDGE.slice(1).includes(r)) accents.add(r);
    }
    expect(accents.size).toBeGreaterThanOrEqual(2);
  });

  it("opens a red door on its front: the long side, or the side the data gives", () => {
    const doorFacing = (m: VoxelModel, dx: number, dy: number) => {
      for (let z = 1; z < m.sz; z++)
        for (let y = 0; y < m.sy; y++)
          for (let x = 0; x < m.sx; x++) if (at(m, x, y, z) === "taxi" && !m.get(x + dx, y + dy, z)) return true;
      return false;
    };
    expect(doorFacing(gen(1, rect(24, 12)), 0, 1)).toBe(true); // +y
    expect(doorFacing(gen(1, rect(12, 24)), 1, 0)).toBe(true); // +x
    const north = gen(1, rect(24, 12), 14, { front: 6 });
    expect(doorFacing(north, 0, -1)).toBe(true);
    expect(doorFacing(north, 0, 1)).toBe(false);
  });
});
