import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { footprintMask, generateModel, type AssetCatalog, type GenContext, type VoxelModel } from "pixelworld/generators";
import { register as registerSf } from "@pixelworlds/city-sf";
import { BUILDING_GENERATORS, slabFront } from "../src/buildings";
import { register } from "../src/index";

await register(); // the city pack's generators, on this thread
await registerSf(); // San Francisco's block and towers, which the tokyo pack names too

/**
 * Tokyo's fabric (buildings.ts) under the style guide's building rules
 * (§13): inside the footprint, no overhangs, glass only on the skin, style
 * ramps only; and the parts that make each read: a zakkyo's signs, a
 * mansion's balconies, a kodate's roof and block wall.
 */
const style = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../worlds/_styles/tokyo/style.json", import.meta.url)), "utf8"),
) as { assets: AssetCatalog; ramps: Record<string, string[]> };
const rampIds = new Map(Object.keys(style.ramps).map((name, i) => [name, i + 1]));
const rampName = new Map([...rampIds].map(([n, i]) => [i, n]));
const glassRamps = new Set(["glass", "lit", "lit-cool", "curtain-glass"]);
type Mask = { sx: number; sy: number; on: Uint8Array };

const TOKYO = new Set(Object.keys(BUILDING_GENERATORS));
const GROUPS = Object.keys(style.assets).filter((g) => g.startsWith("building.") && TOKYO.has(style.assets[g]!.generator));

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
  return out;
}

const gen = (group: string, seed: number, mask: Mask, heightVox: number, hints?: GenContext["hints"]) =>
  generateModel(style.assets, rampIds, group, { seed, mask, heightVox, hints });

/** How many voxels of a model are of the given ramps. */
const count = (m: VoxelModel, ...ramps: string[]) => {
  const ids = new Set(m.materials.flatMap((r, i) => (i > 0 && ramps.includes(rampName.get(r) ?? "") ? [i] : [])));
  let n = 0;
  for (const v of m.data) if (ids.has(v)) n++;
  return n;
};
const topAt = (m: VoxelModel, x: number, y: number) => {
  for (let z = m.sz - 1; z >= 0; z--) if (m.get(x, y, z)) return z;
  return -1;
};
const SIGNS = ["neon-pink", "neon-cyan", "neon-yellow", "sign-white", "sign-red", "jr-green"];

describe("Tokyo's buildings", () => {
  it("are drawn by groups of the tokyo pack", () => expect(new Set(GROUPS.map((g) => style.assets[g]!.generator))).toEqual(TOKYO));

  it("stay on their footprint, never overhang and show glass only on their skin", () => {
    let n = 0;
    let seed = 1;
    // a pencil lot at the driving and walking scales, a deep lot, a corner notch, a wide block, a diagonal
    const masks = [rect(1, 4), rect(3, 3), rect(5, 12), rect(10, 24), rect(16, 30, 5), rect(40, 18), diamond(9)];
    for (const group of GROUPS)
      for (const mask of masks)
        for (const H of [10, 40, 140])
          for (const hints of [undefined, { floors: 6, corner: true, front: 0 }, { front: 3, floors: 2, roof: "hipped" }]) {
            const m = gen(group, seed++, mask, H, hints);
            expect(problems(m, mask), `${group} ${mask.sx}×${mask.sy} H=${H} ${JSON.stringify(hints)}`).toEqual([]);
            n++;
          }
    expect(n).toBe(GROUPS.length * masks.length * 3 * 3);
  }, 60_000);

  it("takes trim from the body's scheme when it names the same variants", () => {
    const variants = (ramps: Record<string, string>, role: string) =>
      Object.keys(ramps)
        .filter((k) => k === role || k.startsWith(role + "."))
        .map((k) => k.slice(role.length + 1))
        .sort();
    for (const group of GROUPS) {
      const r = style.assets[group]!.ramps;
      const walls = variants(r, "wall");
      for (const role of ["trim", "fence", "accent"]) {
        const vs = variants(r, role);
        if (vs.length === walls.length) expect(vs, `${group} ${role}`).toEqual(walls);
      }
    }
  });

  it("hangs signs on a zakkyo: a lit band at the street, panels up its front and on most a vertical board past the parapet", () => {
    let boards = 0;
    for (let seed = 1; seed <= 30; seed++) {
      // a 6 m by 16 m lot, eight storeys, facing +y
      const m = gen("building.zakkyo", seed, rect(10, 26), 64, { front: 2, floors: 8 });
      expect(count(m, ...SIGNS), `seed ${seed}`).toBeGreaterThan(20);
      // the board stands on the front row (y = 25) and rises past the roof (z = 63)
      if ([0, 9].some((x) => topAt(m, x, 25) >= 64)) boards++;
    }
    expect(boards).toBeGreaterThan(15);
  });

  it("keeps offices quieter: no vertical boards, few signs", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const m = gen("building.office", seed, rect(16, 24), 80, { front: 2, floors: 10 });
      expect(topAt(m, 0, 23), `seed ${seed}`).toBeLessThanOrEqual(80);
    }
  });

  it("faces a mansion's balconies to the south on its long side, a parapet band at every floor", () => {
    // long along x: its long sides face ±y; south is +y (front 2), whatever the street
    expect(slabFront(rect(40, 12), 6)).toBe(2);
    expect(slabFront(rect(40, 12), 0)).toBe(2);
    // long along y: the long sides face ±x, and the street's side is kept
    expect([0, 4]).toContain(slabFront(rect(12, 40), 4));
    const m = gen("building.mansion", 3, rect(40, 12), 80, { floors: 10, front: 6 });
    // the south face (y = 11): at each floor line, two rows of parapet in the trim's light ramps
    const light = new Set(["sign-white", "tile-white", "tile-beige", "tower-white"]);
    let bands = 0;
    for (let z = 8; z < 72; z += 8) if (light.has(rampName.get(m.materials[m.get(20, 11, z)]!)!) && light.has(rampName.get(m.materials[m.get(20, 11, z + 1)]!)!)) bands++;
    expect(bands).toBeGreaterThanOrEqual(7);
    // the glass behind the parapets
    expect(count(m, "glass", "lit")).toBeGreaterThan(200);
  });

  it("roofs a kodate inside its footprint: a ridge over the walls, gabled or hipped", () => {
    for (const roof of ["gabled", "hipped"]) {
      const m = gen("building.kodate", 5, rect(16, 14), 18, { front: 2, floors: 2, roof });
      // the yard is the front three rows (y 11–13); the house is y 0–10, wider than deep, its ridge along x
      const eave = topAt(m, 8, 0);
      const ridge = topAt(m, 8, 5);
      expect(ridge - eave, roof).toBeGreaterThanOrEqual(3);
      expect(count(m, "roof-metal", "roof-tile", "tile-brown"), roof).toBeGreaterThan(50);
      // a hipped roof slopes down to its ends too; a gabled one keeps the ridge's height to its gable walls
      const end = topAt(m, 0, 5);
      if (roof === "hipped") expect(end, roof).toBeLessThan(ridge);
      else expect(end, roof).toBe(ridge);
    }
  });

  it("puts a block wall along a kodate's yard, open for the car", () => {
    let walls = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const m = gen("building.kodate", seed, rect(12, 18), 18, { front: 2, floors: 2 });
      const front = [...Array(12).keys()].map((x) => topAt(m, x, 17));
      if (front.some((z) => z >= 0 && z <= 2) && front.some((z) => z < 0)) walls++;
    }
    expect(walls).toBe(10);
  });

  it("draws the Meiji Shrine's halls in cypress under copper", () => {
    const m = gen("building.shrine", 2, rect(20, 14), 20, { floors: 1 });
    expect(count(m, "copper")).toBeGreaterThan(100);
    expect(count(m, "glass", "lit")).toBe(0);
  });
});

describe("Tokyo's wires (D-095)", () => {
  /** A wire span's line object as the pipeline gives it: a band of half-width lw around a → b (cells), and its frame. */
  function span(a: [number, number], b: [number, number], rise: [number, number] = [0, 0]) {
    const voxel = 1 / 16;
    const lw = 0.06;
    const [ux, uy] = [b[0] - a[0], b[1] - a[1]];
    const len = Math.hypot(ux, uy);
    const [nx, ny] = [(uy / len) * lw, (-ux / len) * lw];
    const fp: [number, number][] = [
      [a[0] + nx, a[1] + ny],
      [b[0] + nx, b[1] + ny],
      [b[0] - nx, b[1] - ny],
      [a[0] - nx, a[1] - ny],
    ];
    const { mask, x0, y0 } = footprintMask(fp, voxel);
    const model = generateModel(style.assets, rampIds, "prop.wire", { seed: 1, mask, frame: { x0, y0, voxel, line: { a, b, half: lw, rise } } });
    // a line's point in world cells and voxels up
    const world = (p: [number, number, number]) => [x0 + p[0] * voxel, y0 + p[1] * voxel, p[2]];
    return { model, world };
  }

  it("is a one-pixel line from pole to pole at any angle, unbroken, sagging between them", () => {
    for (const [a, b] of [
      [[0.5, 0.5], [3.5, 0.5]],
      [[0.5, 0.5], [2.6, 2.6]],
      [[0.5, 0.5], [3.1, 1.8]],
    ] as [number, number][][]) {
      const { model, world } = span(a!, b!);
      expect(model.data.every((v) => v === 0)).toBe(true); // lines, not voxels
      const { lines } = model;
      expect(lines.length).toBeGreaterThan(4);
      for (let k = 1; k < lines.length; k++) expect(lines[k]!.a).toEqual(lines[k - 1]!.b); // unbroken
      // from one pole to the other, 25 voxels up at each, lower between them
      const [sa, sb] = [world(lines[0]!.a), world(lines[lines.length - 1]!.b)];
      expect(sa[0]).toBeCloseTo(a![0], 6);
      expect(sa[1]).toBeCloseTo(a![1], 6);
      expect(sb[0]).toBeCloseTo(b![0], 6);
      expect(sb[1]).toBeCloseTo(b![1], 6);
      expect([sa[2], sb[2]]).toEqual([25, 25]);
      expect(Math.min(...lines.map((l) => l.b[2]))).toBeCloseTo(23, 0);
      expect(rampName.get(model.materials[lines[0]!.m]!)).toBe("wire");
    }
  });

  it("hangs its poles' arms, and on some a stay wire, as one-pixel lines (D-095)", () => {
    let stays = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const m = generateModel(style.assets, rampIds, "prop.pole", { seed });
      const [arm, low, ...rest] = m.lines;
      expect(arm!.a[2]).toBe(arm!.b[2]); // the crossarm level, across the street (x)
      expect(Math.abs(arm!.b[0] - arm!.a[0])).toBe(4);
      expect(low!.a[2]).toBeLessThan(arm!.a[2]);
      if (rest.length) {
        stays++;
        expect(rest[0]!.b[2]).toBe(0); // down to the ground
      }
      // the pole itself stays a column of voxels
      expect(m.count()).toBeGreaterThanOrEqual(26);
    }
    expect(stays).toBeGreaterThan(2);
    expect(stays).toBeLessThan(15);
  });

  it("climbs from a pole on low ground to one on higher ground", () => {
    const { model } = span([0.5, 0.5], [3.5, 0.5], [0, 8]);
    expect(model.lines[0]!.a[2]).toBe(25);
    expect(model.lines[model.lines.length - 1]!.b[2]).toBe(33);
  });
});
