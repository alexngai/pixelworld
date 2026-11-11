import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateModel, type AssetCatalog, type GenContext, type VoxelModel } from "pixelworld/generators";
import { BUILDING_GENERATORS } from "../src/buildings";
import { facadeOf } from "../src/facade";
import { register } from "../src/index";

await register(); // the city pack's generators, on this thread

/**
 * Paris's fabric (buildings.ts) and landmarks (landmarks.ts) under the style
 * guide's building rules (§13): inside the footprint, no overhangs, glass
 * only on the skin, style ramps only; and the parts that make each read: the
 * balconies on storeys 2 and 5, the mansard stepping in, the pitched roof,
 * the brick and its bands, the arch's openings.
 */
const style = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../worlds/_styles/paris/style.json", import.meta.url)), "utf8"),
) as { assets: AssetCatalog; ramps: Record<string, string[]> };
const rampIds = new Map(Object.keys(style.ramps).map((name, i) => [name, i + 1]));
const rampName = new Map([...rampIds].map(([n, i]) => [i, n]));
const glassRamps = new Set(["glass", "lit", "lit-cool"]);
type Mask = { sx: number; sy: number; on: Uint8Array };

const PARIS = new Set(Object.keys(BUILDING_GENERATORS));
const GROUPS = Object.keys(style.assets).filter((g) => g.startsWith("building.") && PARIS.has(style.assets[g]!.generator));

function rect(sx: number, sy: number, cut = 0): Mask {
  const on = new Uint8Array(sx * sy);
  for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) on[y * sx + x] = x < cut && y < cut ? 0 : 1;
  return { sx, sy, on };
}

/** A footprint on a diagonal (a lot on a radial avenue). */
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

/** The ramp names of a model's voxels in one row of its front (y = 0 faces −y: front 6). */
const frontRow = (m: VoxelModel, z: number) => {
  const out: string[] = [];
  for (let x = 0; x < m.sx; x++) {
    const v = m.get(x, 0, z);
    out.push(v ? rampName.get(m.materials[v]!)! : "");
  }
  return out;
};
const topAt = (m: VoxelModel, x: number, y: number) => {
  for (let z = m.sz - 1; z >= 0; z--) if (m.get(x, y, z)) return z;
  return -1;
};

describe("Paris's buildings", () => {
  it("are drawn by groups of the paris pack", () => expect(new Set(GROUPS.map((g) => style.assets[g]!.generator))).toEqual(PARIS));

  it("stay on their footprint, never overhang and show glass only on their skin", () => {
    let n = 0;
    let seed = 1;
    // a sliver, a narrow faubourg lot, a deep lot, a corner notch, a wide block, a diagonal
    const masks = [rect(1, 4), rect(3, 3), rect(5, 12), rect(12, 24), rect(16, 30, 5), rect(40, 32), diamond(9)];
    for (const group of GROUPS)
      for (const mask of masks)
        for (const H of [10, 50, 140])
          for (const hints of [undefined, { floors: 7, corner: true, front: 0 }, { floors: 4, front: 3 }]) {
            const m = gen(group, seed++, mask, H, hints);
            expect(problems(m, mask), `${group} ${mask.sx}×${mask.sy} H=${H} ${JSON.stringify(hints)}`).toEqual([]);
            n++;
          }
    expect(n).toBe(GROUPS.length * masks.length * 3 * 3);
  }, 60_000);

  it("takes trim, shop and door from the body's scheme when they name the same variants", () => {
    const variants = (ramps: Record<string, string>, role: string) =>
      Object.keys(ramps)
        .filter((k) => k === role || k.startsWith(role + "."))
        .map((k) => k.slice(role.length + 1))
        .sort();
    for (const group of GROUPS) {
      const r = style.assets[group]!.ramps;
      const walls = variants(r, "wall");
      for (const role of ["trim", "door", "shutter", "shop"]) {
        const vs = variants(r, role);
        if (vs.length === walls.length) expect(vs, `${group} ${role}`).toEqual(walls);
      }
    }
  });

  it("puts a Haussmann block's continuous balconies on storeys 2 and 5, under a mansard that steps in", () => {
    // seven storeys on a 20 m front, facing −y (front 6)
    const m = gen("building.haussmann", 7, rect(24, 30), 60, { floors: 7, front: 6 });
    // rows of iron running the whole front: the balconies' handrails
    const railRows: number[] = [];
    for (let z = 0; z < m.sz; z++) {
      const row = frontRow(m, z);
      if (row.length && row.every((r) => r === "iron")) railRows.push(z);
    }
    expect(railRows.length).toBe(2);
    const [r2, r5] = railRows as [number, number];
    // three storeys apart (2 → 5), and the lower one above the shops
    expect(r5 - r2).toBeGreaterThanOrEqual(3 * 3);
    expect(r2).toBeGreaterThan(m.sz * 0.2);
    // the mansard: the front wall's top is below the roof's, which stands back from it
    const front = topAt(m, 12, 0);
    const behind = Math.max(...Array.from({ length: 10 }, (_, d) => topAt(m, 12, d)));
    expect(behind).toBeGreaterThan(front + 3);
    // zinc or slate on the roof
    const roofTop = topAt(m, 12, 15);
    expect(rampName.get(m.materials[m.get(12, 15, roofTop)]!)).toMatch(/zinc|slate/);
  });

  it("gives a faubourg house a pitched roof whose ridge runs along the street", () => {
    const m = gen("building.faubourg", 3, rect(10, 16), 40, { floors: 4, front: 6 });
    expect(facadeOf(rect(10, 16), 6).width).toBe(10);
    // highest in the middle of its depth, lower at the front and the rear; level along the street
    const mid = topAt(m, 5, 8);
    expect(mid).toBeGreaterThan(topAt(m, 5, 0) + 3);
    expect(mid).toBeGreaterThan(topAt(m, 5, 15) + 3);
    expect(topAt(m, 2, 8)).toBe(mid);
  });

  it("builds an HBM block of brick with pale bands at its floor lines", () => {
    const m = gen("building.hbm", 5, rect(30, 14), 56, { floors: 7, front: 6 });
    const rows = Array.from({ length: m.sz }, (_, z) => frontRow(m, z));
    const brick = rows.flat().filter((r) => r === "brick" || r === "brick-pale").length;
    expect(brick).toBeGreaterThan(100);
    const bands = rows.filter((row) => row.length && row.every((r) => r === "concrete-white" || r === "brick-pale")).length;
    expect(bands).toBeGreaterThanOrEqual(5);
  });

  it("is the same model for the same seed", () => {
    for (const group of GROUPS) {
      const a = gen(group, 42, rect(14, 20), 48, { floors: 6 });
      const b = gen(group, 42, rect(14, 20), 48, { floors: 6 });
      expect(Buffer.from(a.data).equals(Buffer.from(b.data)), group).toBe(true);
    }
  });
});

describe("Paris's landmarks", () => {
  it("draw a cathedral with two west towers and a spire over the crossing", () => {
    const m = generateModel(style.assets, rampIds, "landmark.cathedral.gothic", { seed: 1, heightVox: 160 });
    expect(m.sx).toBeGreaterThan(m.sy * 2);
    const c = Math.floor(m.sy / 2);
    // the towers at the west front's sides stand above its middle
    const tower = topAt(m, 2, Math.round(m.sy / 2 - 160 * 0.17));
    expect(tower).toBeGreaterThan(topAt(m, 2, c) + 20);
    // the spire is the highest point, east of the towers
    let best = [-1, 0];
    for (let x = 0; x < m.sx; x++) {
      const t = topAt(m, x, c);
      if (t > best[0]!) best = [t, x];
    }
    expect(best[0]).toBeGreaterThan(tower);
    expect(best[1]).toBeGreaterThan(m.sx * 0.4);
  });

  it("draw a triumphal arch open through both pairs of faces", () => {
    const m = generateModel(style.assets, rampIds, "landmark.arch.triumphal", { seed: 1, heightVox: 100 });
    const cx = Math.floor(m.sx / 2);
    const cy = Math.floor(m.sy / 2);
    expect(m.get(cx, 0, 5)).toBe(0); // the great arch
    expect(m.get(0, cy, 5)).toBe(0); // a side arch
    expect(m.get(3, 0, 5)).not.toBe(0); // a pier
    expect(topAt(m, cx, 0)).toBe(99); // closed over the top
  });
});
