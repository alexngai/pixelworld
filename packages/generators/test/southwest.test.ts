import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { damProfile, generateModel, type AssetCatalog, type VoxelModel } from "../src/index";

const style = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../worlds/_styles/desert-southwest/style.json", import.meta.url)), "utf8"),
) as { assets: AssetCatalog; ramps: Record<string, string[]> };
const rampIds = new Map(Object.keys(style.ramps).map((name, i) => [name, i + 1]));

const topOf = (m: VoxelModel, x: number, y: number) => {
  for (let z = m.sz - 1; z >= 0; z--) if (m.get(x, y, z)) return z;
  return -1;
};
const full = (sx: number, sy: number) => ({ sx, sy, on: new Uint8Array(sx * sy).fill(1) });
const v = 1 / 16;

describe("the dam", () => {
  // a straight band along +x, 12 voxels across: its line runs at y = 6 voxels, so
  // the left of the line (upstream) is −y, the band's first rows
  const mask = full(40, 12);
  const frame = { x0: 0, y0: 0, voxel: v, line: { a: [0, 6 * v] as [number, number], b: [40 * v, 6 * v] as [number, number], half: 6 * v } };

  it("without a crest thickness, is the footprint extruded to the crest", () => {
    const top = damProfile(mask, frame, 0, 1.6, 30);
    expect([...top].every((h) => h === 30)).toBe(true);
    // and without its line too (no way to tell upstream from downstream)
    expect([...damProfile(mask, undefined, 2, 1.6, 30)].every((h) => h === 30)).toBe(true);
  });

  it("stands sheer upstream and falls away downstream to its foot", () => {
    const top = damProfile(mask, frame, 2, 1.6, 30);
    const column = (y: number) => top[y * mask.sx + 20]!;
    expect(column(0)).toBe(30); // the crest: two voxels thick, upstream
    expect(column(1)).toBe(30);
    for (let y = 2; y < 12; y++) expect(column(y)).toBeLessThanOrEqual(column(y - 1));
    expect(column(2)).toBeLessThan(30);
    expect(column(11)).toBeLessThan(5); // the foot
    // concave: the face drops fast below the crest, then flattens toward the foot
    expect(column(2) - column(4)).toBeGreaterThan(column(9) - column(11));
    // the same at every place along it
    for (let x = 0; x < mask.sx; x++) expect(top[5 * mask.sx + x]).toBe(column(5));
  });

  it("is generated with the style's battered face, crest on top", () => {
    const m = generateModel(style.assets, rampIds, "landmark.dam", { seed: 4, mask, heightVox: 30, frame });
    expect(topOf(m, 20, 0)).toBe(30);
    expect(topOf(m, 20, 11)).toBeLessThan(5);
    expect(m.materials[m.get(20, 0, 30)]).toBe(rampIds.get("roof-flat")); // the crest road
  });
});

describe("city blocks", () => {
  const block = (x0: number, y0: number, seed: number) =>
    generateModel(style.assets, rampIds, "city.blocks", {
      seed,
      mask: full(16, 16),
      heightVox: 1,
      frame: { x0: x0 * 16 * v, y0: y0 * 16 * v, voxel: v },
    });

  it("leaves streets on the world's voxel grid and builds low between them", () => {
    const m = block(3, 7, 1);
    const pitch = 5;
    let built = 0;
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const gx = 3 * 16 + x;
        const gy = 7 * 16 + y;
        const street = gx % pitch === 0 || gy % pitch === 0;
        if (street) expect(topOf(m, x, y)).toBe(-1);
        if (topOf(m, x, y) >= 0) built++;
        expect(topOf(m, x, y)).toBeLessThanOrEqual(2); // low-rise: a few voxels at most
      }
    expect(built).toBeGreaterThan(60);
  });

  it("draws a block the same on both sides of a cell edge, whatever the seed", () => {
    // voxel columns 15 of cell 3 and 0 of cell 4 are in the same block (x = 63, 64)
    const a = block(3, 7, 1);
    const b = block(4, 7, 99);
    for (let y = 0; y < 16; y++) expect(topOf(a, 15, y)).toBe(topOf(b, 0, y));
    // blocks are picked by place alone
    const again = block(3, 7, 99);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++)
        for (let z = 0; z < a.sz; z++) expect(again.materials[again.get(x, y, z)]).toBe(a.materials[a.get(x, y, z)]);
  });
});

describe("the lookout tower", () => {
  const width = (m: VoxelModel) => {
    let n = 0;
    for (let x = 0; x < m.sx; x++) if (m.get(x, Math.floor(m.sy / 2), Math.floor(m.sz / 2))) n++;
    return n;
  };

  it("keeps its proportions when drawn taller", () => {
    const short = generateModel(style.assets, rampIds, "landmark.tower.lookout", { seed: 6, heightVox: 20 });
    const tall = generateModel(style.assets, rampIds, "landmark.tower.lookout", { seed: 6, heightVox: 44 });
    expect(width(short)).toBe(5); // the style's least radius, 2.5
    expect(width(tall)).toBeGreaterThanOrEqual(9); // 0.1 voxel of radius per voxel of height
    expect(tall.sx).toBeGreaterThan(short.sx); // and its round room at its foot grows with it
  });

  it("without radiusPerHeight, keeps a fixed radius", () => {
    const catalog: AssetCatalog = {
      t: { generator: "lookoutTower", ramps: { stone: "toroweap", detail: "vishnu" }, params: { radius: 2.5 } },
    };
    const m = generateModel(catalog, rampIds, "t", { seed: 6, heightVox: 44 });
    expect(width(m)).toBe(5);
  });
});
