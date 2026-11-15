import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateModel, registerGenerators, type AssetCatalog, type GenContext, type VoxelModel } from "pixelworld/generators";
import { ESTATE_GENERATORS } from "../src/estate";

registerGenerators(ESTATE_GENERATORS, { source: "estate.test" });

/**
 * The public estate's block (estate.ts) under the building rules (§13) on
 * the plans the data gives (a cross, a trident, a slab, a small square): its
 * grid of windows on every storey of every face, one estate colour a block,
 * and the roof's machine rooms and tanks. The asset is the test's own, on the
 * hongkong style's ramps.
 */
const style = JSON.parse(readFileSync(fileURLToPath(new URL("../../../worlds/_styles/hongkong/style.json", import.meta.url)), "utf8")) as {
  ramps: Record<string, string[]>;
};
const rampIds = new Map(Object.keys(style.ramps).map((name, i) => [name, i + 1]));
const rampName = new Map([...rampIds].map(([n, i]) => [i, n]));
const glassRamps = new Set(["glass", "lit", "lit-cool", "curtain-glass"]);
const ACCENTS = ["paint-mint", "paint-sky", "jade", "paint-salmon", "taxi", "paint-yellow"];
const TRIM = ["concrete", "tile-beige"];

const catalog: AssetCatalog = {
  "building.estate": {
    generator: "estateTower",
    ramps: {
      wall: "mosaic-white",
      "wall.cream": "paint-cream",
      trim: "concrete",
      "trim.cream": "tile-beige",
      accent: "paint-mint",
      "accent.blue": "paint-sky",
      "accent.green": "jade",
      "accent.pink": "paint-salmon",
      "accent.red": "taxi",
      "accent.yellow": "paint-yellow",
      window: "glass",
      lit: "lit",
      "lit.cool": "lit-cool",
      lobby: "glass",
      shade: "grime",
      ac: "tile-grey",
      roof: "roof-flat",
    },
    params: { litFraction: 0.4 },
  },
};

type Mask = { sx: number; sy: number; on: Uint8Array };
function mask(sx: number, sy: number, inside: (x: number, y: number) => boolean): Mask {
  const on = new Uint8Array(sx * sy);
  for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) on[y * sx + x] = inside(x, y) ? 1 : 0;
  return { sx, sy, on };
}

/** Three arms 12 voxels wide at 120° round a hub, one along +y. */
function trident(): Mask {
  const S = 44;
  const c = S / 2;
  return mask(S, S, (x, y) =>
    [90, 210, 330].some((deg) => {
      const a = (deg * Math.PI) / 180;
      const vx = x + 0.5 - c;
      const vy = y + 0.5 - c;
      const along = vx * Math.cos(a) + vy * Math.sin(a);
      return along >= -6 && along <= 21 && Math.abs(-vx * Math.sin(a) + vy * Math.cos(a)) <= 6;
    }),
  );
}

const MASKS: Record<string, Mask> = {
  cross: mask(40, 40, (x, y) => (x >= 14 && x < 26) || (y >= 14 && y < 26)),
  trident: trident(),
  slab: mask(60, 14, () => true),
  small: mask(10, 10, () => true),
};

function problems(m: VoxelModel, mk: Mask): string[] {
  const out: string[] = [];
  const onFp = (x: number, y: number) => x >= 0 && y >= 0 && x < mk.sx && y < mk.sy && mk.on[y * mk.sx + x] === 1;
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

const gen = (seed: number, mk?: Mask, heightVox?: number, hints?: GenContext["hints"]) => generateModel(catalog, rampIds, "building.estate", { seed, mask: mk, heightVox, hints });
const at = (m: VoxelModel, x: number, y: number, z: number) => rampName.get(m.materials[m.get(x, y, z)]!) ?? "";
const topAt = (m: VoxelModel, x: number, y: number) => {
  for (let z = m.sz - 1; z >= 0; z--) if (m.get(x, y, z)) return z;
  return -1;
};
const count = (m: VoxelModel, ramp: string) => {
  let n = 0;
  for (const v of m.data) if (v && rampName.get(m.materials[v]!) === ramp) n++;
  return n;
};

/** Each run of wall facing one way, at least `min` voxels long: its columns. */
function faces(mk: Mask, min: number): [number, number][][] {
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < mk.sx && y < mk.sy && mk.on[y * mk.sx + x] === 1;
  const out: [number, number][][] = [];
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const [tx, ty] = dx !== 0 ? [0, 1] : [1, 0];
    const exposed = (x: number, y: number) => on(x, y) && !on(x + dx, y + dy);
    for (let y = 0; y < mk.sy; y++)
      for (let x = 0; x < mk.sx; x++) {
        if (!exposed(x, y) || exposed(x - tx, y - ty)) continue;
        const run: [number, number][] = [];
        for (let k = 0; exposed(x + tx * k, y + ty * k); k++) run.push([x + tx * k, y + ty * k]);
        if (run.length >= min) out.push(run);
      }
  }
  return out;
}

describe("Hong Kong's public estate blocks", () => {
  it("stay on their footprint, never overhang, show glass only on their skin and stand as tall as the record", () => {
    for (const [name, mk] of Object.entries(MASKS))
      for (const H of [80, 140])
        for (let seed = 1; seed <= 6; seed++) {
          const m = gen(seed, mk, H);
          expect(problems(m, mk), `${name} H=${H} seed ${seed}`).toEqual([]);
          let top = 0;
          for (let y = 0; y < mk.sy; y++) for (let x = 0; x < mk.sx; x++) top = Math.max(top, topAt(m, x, y));
          expect(top + 1, `${name} H=${H} seed ${seed}`).toBe(H);
        }
    // a record's storeys; no footprint at all
    expect(problems(gen(1, MASKS.cross, 140, { floors: 30 }), MASKS.cross!)).toEqual([]);
    expect(problems(gen(2), mask(24, 24, () => true))).toEqual([]);
  }, 60_000);

  it("grids every face with windows on every storey", () => {
    for (const [name, mk] of Object.entries(MASKS))
      for (const H of [80, 140])
        for (let seed = 1; seed <= 4; seed++) {
          const m = gen(seed, mk, H);
          for (const run of faces(mk, 4)) {
            const [x0, y0] = run[0]!;
            const roof = topAt(m, x0, y0); // the parapet, at the face's end
            const rows = [...Array(roof).keys()].filter((z) => run.some(([x, y]) => glassRamps.has(at(m, x, y, z))));
            const where = `${name} H=${H} seed ${seed} face at ${x0},${y0} (${run.length})`;
            expect(rows[0], where).toBeLessThanOrEqual(1);
            expect(rows.at(-1), where).toBeGreaterThanOrEqual(roof - 6);
            // a storey of 4 or 5: never more than 3 rows without a window
            for (let k = 1; k < rows.length; k++) expect(rows[k]! - rows[k - 1]!, `${where} z ${rows[k - 1]}`).toBeLessThanOrEqual(4);
          }
        }
  });

  it("wears one estate colour a block, a different one across seeds", () => {
    const seen = new Set<string>();
    for (const mk of Object.values(MASKS))
      for (let seed = 1; seed <= 12; seed++) {
        const m = gen(seed, mk, 80);
        const used = ACCENTS.filter((r) => count(m, r) > 0);
        expect(used.length, `seed ${seed}`).toBe(1);
        expect(count(m, used[0]!), `seed ${seed}`).toBeGreaterThan(40);
        seen.add(used[0]!);
      }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it("puts the machine rooms and water tanks on the roof inside a parapet", () => {
    for (const [name, mk] of Object.entries(MASKS))
      for (const H of [80, 140]) {
        const m = gen(3, mk, H);
        const edge = faces(mk, 1)[0]![0]!;
        const parapet = topAt(m, ...edge);
        expect(TRIM, `${name} H=${H}`).toContain(at(m, ...edge, parapet));
        // the tank on top: trim, above the machine room's roof
        let tank = 0;
        for (let y = 0; y < mk.sy; y++) for (let x = 0; x < mk.sx; x++) if (topAt(m, x, y) === H - 1 && TRIM.includes(at(m, x, y, H - 1))) tank++;
        expect(tank, `${name} H=${H}`).toBeGreaterThan(0);
        expect(H - 1 - parapet, `${name} H=${H}`).toBeGreaterThan(4);
      }
  });
});
