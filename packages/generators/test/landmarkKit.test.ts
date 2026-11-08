import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MeshBuilder, generateModel, meshVoxels, type AssetCatalog, type VoxelModel } from "../src/index";

const style = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../worlds/_styles/bay-area/style.json", import.meta.url)), "utf8"),
) as { assets: AssetCatalog; ramps: Record<string, string[]> };
const rampIds = new Map(Object.keys(style.ramps).map((name, i) => [name, i + 1]));

/** A band along +y: a long, thin footprint (a bridge). */
function band(sx: number, sy: number) {
  return { sx, sy, on: new Uint8Array(sx * sy).fill(1) };
}

const topOf = (m: VoxelModel, x: number, y: number) => {
  for (let z = m.sz - 1; z >= 0; z--) if (m.get(x, y, z)) return z;
  return -1;
};

describe("landmark kit", () => {
  it("draws a suspension bridge: towers above the deck, the deck along the whole span", () => {
    const m = generateModel(style.assets, rampIds, "landmark.bridge.suspension", { seed: 1, mask: band(9, 400), heightVox: 40 });
    const tops = Array.from({ length: 400 }, (_, y) => topOf(m, 0, y));
    expect(Math.max(...tops)).toBeGreaterThanOrEqual(3 * 40); // towers about 3.3× the deck
    // every column carries the deck
    for (let y = 0; y < 400; y++) expect(m.get(4, y, 40)).toBeGreaterThan(0);
    // the cable sags toward mid-span
    expect(tops[200]!).toBeLessThan(tops[Math.round(400 * 0.175)]!);
    // the double bridge has a central anchorage
    const d = generateModel(style.assets, rampIds, "landmark.bridge.suspension.double", { seed: 1, mask: band(9, 400), heightVox: 40 });
    expect(d.get(4, 200, 20)).toBeGreaterThan(0);
  });

  it("draws a long bridge in pieces that join up", () => {
    // the whole band: 9 × 400 voxels at 1/16 cell, from (0, 0); its line runs down the middle
    const v = 1 / 16;
    const line = { a: [4.5 * v, 0] as [number, number], b: [4.5 * v, 400 * v] as [number, number], half: 4.5 * v };
    const whole = generateModel(style.assets, rampIds, "landmark.bridge.suspension", {
      seed: 1,
      mask: band(9, 400),
      heightVox: 40,
      frame: { x0: 0, y0: 0, voxel: v, line },
    });
    const pieces = [0, 200].map((y0) =>
      generateModel(style.assets, rampIds, "landmark.bridge.suspension", {
        seed: 1,
        mask: band(9, 200),
        heightVox: 40,
        frame: { x0: 0, y0: y0 * v, voxel: v, line },
      }),
    );
    for (let y = 0; y < 400; y += 7)
      for (const x of [0, 4, 8]) {
        const piece = pieces[y < 200 ? 0 : 1]!;
        expect(topOf(piece, x, y % 200), `column ${x},${y}`).toBe(topOf(whole, x, y));
      }
  });

  it("draws every point landmark at its height", () => {
    for (const [g, H] of [
      ["landmark.tower.pyramid", 160],
      ["landmark.tower.column", 40],
      ["landmark.hall.domed", 60],
      ["landmark.tower.mast", 180],
    ] as const) {
      const m = generateModel(style.assets, rampIds, g, { seed: 2, heightVox: H });
      let top = 0;
      for (let y = 0; y < m.sy; y++) for (let x = 0; x < m.sx; x++) top = Math.max(top, topOf(m, x, y));
      expect(top, g).toBeGreaterThanOrEqual(H - 2);
    }
    const hall = generateModel(style.assets, rampIds, "landmark.hall.clock", { seed: 3, mask: band(30, 120), heightVox: 50 });
    expect(topOf(hall, 15, 60)).toBeGreaterThan(40); // the tower at the middle
    expect(topOf(hall, 15, 5)).toBeLessThan(20); // the hall
  });

  it("owns a big model per voxel column, never merging faces across cells", () => {
    const m = generateModel(style.assets, rampIds, "landmark.bridge.suspension", { seed: 1, mask: band(9, 400), heightVox: 20 });
    const voxel = { h: 1 / 16, v: 1 / 8 };
    const data = meshVoxels(m, voxel, [10, 20, 0], "column", new MeshBuilder()).build();
    const cells = new Set<string>();
    for (let i = 0; i < data.cell.length; i += 2) cells.add(`${data.cell[i]},${data.cell[i + 1]}`);
    // 400 voxels along y at 1/16 cell: 25 cells from y = 20
    expect(cells.size).toBeGreaterThanOrEqual(25);
    for (const c of cells) {
      const [cx, cy] = c.split(",").map(Number) as [number, number];
      expect(cx).toBe(10);
      expect(cy).toBeGreaterThanOrEqual(20);
      expect(cy).toBeLessThan(45);
    }
  });
});
