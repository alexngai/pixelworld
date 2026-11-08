import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateModel, rotateModel, type AssetCatalog, type VoxelModel } from "../src/index";

const style = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../worlds/_styles/bay-area/style.json", import.meta.url)), "utf8"),
) as { assets: AssetCatalog; ramps: Record<string, string[]> };
const rampIds = new Map(Object.keys(style.ramps).map((name, i) => [name, i + 1]));

/** The ramp a voxel is drawn with (by name), or null where it's empty. */
const rampAt = (m: VoxelModel, x: number, y: number, z: number) => {
  const v = m.get(x, y, z);
  if (!v) return null;
  const id = m.materials[v]!;
  return [...rampIds].find(([, i]) => i === id)![0];
};

/** Bounds of the solid voxels: [x0, y0, z0, x1, y1, z1] (inclusive). */
function extent(m: VoxelModel): [number, number, number, number, number, number] {
  const b: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let z = 0; z < m.sz; z++)
    for (let y = 0; y < m.sy; y++)
      for (let x = 0; x < m.sx; x++)
        if (m.get(x, y, z)) {
          b[0] = Math.min(b[0], x);
          b[1] = Math.min(b[1], y);
          b[2] = Math.min(b[2], z);
          b[3] = Math.max(b[3], x);
          b[4] = Math.max(b[4], y);
          b[5] = Math.max(b[5], z);
        }
  return b;
}

const model = (group: string, seed = 1) => generateModel(style.assets, rampIds, group, { seed });

describe("vehicles", () => {
  it("draws a cable car: open ends with benches and running boards, a cabin with windows, a roof", () => {
    const m = model("prop.cablecar");
    const [x0, y0, , x1, y1, z1] = extent(m);
    const length = x1 - x0 + 1;
    const width = y1 - y0 + 1;
    expect(length).toBe(14);
    expect(width).toBe(6); // a body 4 wide and a running board on each side
    expect(z1).toBeGreaterThanOrEqual(6);
    // the roof covers the whole car
    for (let x = 0; x < 14; x++) expect(rampAt(m, x, 2, 6)).toBe("roof-slate");
    // an open end: a bench at the side, open in the middle, a post at the corner, a board outside
    expect(rampAt(m, 1, 1, 2)).toBe("bark");
    expect(m.get(1, 2, 3)).toBe(0);
    expect(rampAt(m, 0, 1, 3)).toBe("paint-cream");
    expect(rampAt(m, 1, 0, 1)).toBe("bark");
    // the cabin: windows in its sides, lower panels in the body colour, no running board
    const side = Array.from({ length: 6 }, (_, k) => rampAt(m, 4 + k, 1, 3));
    expect(side).toContain("glass");
    expect(rampAt(m, 7, 2, 1)).toBe("chinatown-red");
    expect(m.get(7, 0, 1)).toBe(0);
    // riders stand on the running boards at the open ends, never along the cabin
    let riders = 0;
    for (let s = 0; s < 16; s++) {
      const c = model("prop.cablecar", s);
      for (const y of [0, 5])
        for (let x = 0; x < 14; x++)
          if (c.get(x, y, 3)) {
            riders++;
            expect(x < 3 || x >= 11).toBe(true);
            expect(rampAt(c, x, y, 4)).toBe("sand");
          }
    }
    expect(riders).toBeGreaterThan(8);
  });

  it("draws a streetcar longer than a cable car, in one of its paired liveries", () => {
    const liveries = new Set<string>();
    for (let s = 0; s < 24; s++) {
      const m = model("prop.streetcar", s);
      const [x0, , , x1] = extent(m);
      expect(x1 - x0 + 1).toBe(22);
      liveries.add(`${rampAt(m, 10, 0, 1)}/${rampAt(m, 10, 0, 5)}`);
      // rounded ends: the corners are cut
      expect(m.get(0, 0, 2)).toBe(0);
      expect(m.get(0, 1, 2)).toBeGreaterThan(0);
      // a trolley pole stands above the roof
      expect(extent(m)[5]).toBeGreaterThan(6);
    }
    expect(liveries.size).toBeGreaterThan(1);
    for (const l of liveries) expect(["jade/paint-cream", "chinatown-red/paint-cream", "bridge-orange/paint-butter", "paint-slate/paint-cream"]).toContain(l);
  });

  it("draws an articulated light-rail car: dark bellows between its sections, a pantograph, no pole", () => {
    const m = model("prop.lightrail");
    const [x0, , , x1, , z1] = extent(m);
    expect(x1 - x0 + 1).toBe(30);
    expect(rampAt(m, 15, 0, 3)).toBe("asphalt"); // the bellows at mid-length
    expect(rampAt(m, 10, 0, 1)).toBe("chinatown-red");
    expect(z1).toBe(8); // the pantograph's bar
    // the bar spans the roof's middle, not its edges
    const bar = [...Array(m.sx).keys()].filter((x) => m.get(x, 1, 8));
    expect(bar.length).toBe(1);
    expect(m.get(bar[0]!, 0, 8)).toBe(0);
  });

  it("lays the diagonal variants along (1, 1), solid and as long as the straight ones", () => {
    for (const [group, length] of [
      ["prop.cablecar", 14],
      ["prop.streetcar", 22],
    ] as const) {
      const d = model(`${group}.diagonal`);
      // along the diagonal: x + y spans the length, x − y only the width
      let lo = Infinity;
      let hi = -Infinity;
      let across = 0;
      for (let y = 0; y < d.sy; y++)
        for (let x = 0; x < d.sx; x++)
          if (d.get(x, y, 3) || d.get(x, y, 2)) {
            lo = Math.min(lo, x + y);
            hi = Math.max(hi, x + y);
            across = Math.max(across, Math.abs(x - y));
          }
      expect((hi - lo) / Math.SQRT2).toBeGreaterThan(length - 3);
      expect(across).toBeLessThanOrEqual(5);
      // no holes along the roof's middle line
      const c = Math.floor(d.sx / 2);
      for (let t = -Math.floor(length / 3); t <= Math.floor(length / 3); t++) expect(d.get(c + t, c + t, 6)).toBeGreaterThan(0);
    }
  });

  it("turns with quarter turns to the other directions", () => {
    const m = model("prop.cablecar");
    const r = rotateModel(m, 1);
    expect([r.sx, r.sy]).toEqual([m.sy, m.sx]);
  });
});
