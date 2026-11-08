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

/** The ramp a voxel is drawn with (by name), or null where it's empty. */
const rampAt = (m: VoxelModel, x: number, y: number, z: number) => {
  const v = m.get(x, y, z);
  if (!v) return null;
  const id = m.materials[v]!;
  return [...rampIds].find(([, i]) => i === id)![0];
};

/** Solid runs up a voxel column between two heights: [bottom, top] each. */
const runs = (m: VoxelModel, x: number, y: number, z0: number, z1: number) => {
  const out: [number, number][] = [];
  for (let z = z0; z <= z1; z++)
    if (m.get(x, y, z)) {
      if (out.length && out[out.length - 1]![1] === z - 1) out[out.length - 1]![1] = z;
      else out.push([z, z]);
    }
  return out;
};

/** A whole bridge band along +y, 23 voxels across, with its line (as the pipeline gives pieces). */
function bridge(group: string, H: number) {
  const v = 1 / 16;
  const line = { a: [11.5 * v, 0] as [number, number], b: [11.5 * v, 400 * v] as [number, number], half: 11.5 * v };
  return generateModel(style.assets, rampIds, group, { seed: 1, mask: band(23, 400), heightVox: H, frame: { x0: 0, y0: 0, voxel: v, line } });
}

describe("landmark kit", () => {
  it("draws a suspension bridge: towers above the deck, the deck along the whole span", () => {
    const m = generateModel(style.assets, rampIds, "landmark.bridge.suspension", { seed: 1, mask: band(9, 400), heightVox: 40 });
    const tops = Array.from({ length: 400 }, (_, y) => Math.max(...Array.from({ length: 9 }, (_, x) => topOf(m, x, y))));
    expect(Math.max(...tops)).toBeGreaterThanOrEqual(3 * 40); // towers about 3.3× the deck
    // every column carries the deck
    for (let y = 0; y < 400; y++) expect(m.get(4, y, 40)).toBeGreaterThan(0);
    // the cable sags toward mid-span
    expect(tops[200]!).toBeLessThan(tops[Math.round(400 * 0.175)]!);
    // the double bridge has a central anchorage
    const d = generateModel(style.assets, rampIds, "landmark.bridge.suspension.double", { seed: 1, mask: band(9, 400), heightVox: 40 });
    expect(d.get(4, 200, 20)).toBeGreaterThan(0);
  });

  it("draws portal towers: legs stepping in, struts with stepped corners, an orange deck edge", () => {
    const H = 40;
    const m = bridge("landmark.bridge.suspension", H);
    const T = Math.round(H * 3.3);
    const y = Math.round(400 * 0.175); // the first tower's middle
    // the deck carries the road; its edges are the truss's
    expect(rampAt(m, 11, 200, H)).toBe("asphalt");
    const edge = [...Array(23).keys()].find((x) => rampAt(m, x, 200, H - 1) !== null)!;
    expect(rampAt(m, edge, 200, H - 1)).toBe("bridge-orange");
    // the legs step in: their outer faces reach the band's edge over the deck, not near the top
    const outer = (z: number) => [...Array(11).keys()].filter((k) => m.get(0, y - 5 + k, z)).length;
    expect(outer(H + 4)).toBeGreaterThan(3);
    expect(outer(T - 4)).toBe(0);
    // between the legs: four struts above the deck, with openings between them
    const struts = runs(m, 11, y, H + 1, T);
    expect(struts.length).toBe(4);
    expect(struts[3]![1]).toBeGreaterThanOrEqual(T - 3);
    // each opening's top corners step down toward the legs
    const legInner = [...Array(12).keys()].reverse().find((x) => m.get(x, y, H + 4))!; // the left leg's inner face
    const under = (x: number) => runs(m, x, y, H + 1, T)[0]![0];
    expect(under(legInner + 1)).toBeLessThan(under(11));
    // no X-bracing above the deck: the openings are clear
    expect(runs(m, 11, y, struts[0]![1] + 1, struts[1]![0] - 1)).toEqual([]);
  });

  it("draws braced towers and a double deck", () => {
    const H = 40;
    const m = bridge("landmark.bridge.suspension.double", H);
    const T = Math.round(H * 2.7);
    const y = Math.round(400 * 0.125); // the first tower's middle
    // X-bracing: in a panel between struts, the diagonals move across as they climb
    const solidAt = (z: number) => [...Array(23).keys()].filter((x) => m.get(x, y, z) && x > 5 && x < 17);
    const struts = runs(m, 11, y, H + 1, T);
    expect(struts.length).toBeGreaterThanOrEqual(3);
    const lo = struts[1]![1] + 2;
    const hi = struts[2]![0] - 2;
    expect(solidAt(lo)).not.toEqual(solidAt(hi));
    expect(solidAt(Math.round((lo + hi) / 2)).length).toBeGreaterThan(0);
    // a lower deck inside the truss at the first bridge's mid-span
    const lower = runs(m, 11, 100, 0, H - 1);
    expect(lower.length).toBe(1);
    expect(lower[0]![0]).toBeLessThan(H - 3);
    expect(rampAt(m, 11, 100, H)).toBe("roof-flat");
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

  it("joins every voxel of both bridge types across pieces, towers included", () => {
    const v = 1 / 16;
    const line = { a: [11.5 * v, 0] as [number, number], b: [11.5 * v, 400 * v] as [number, number], half: 11.5 * v };
    for (const group of ["landmark.bridge.suspension", "landmark.bridge.suspension.double"]) {
      const whole = bridge(group, 40);
      // cut through the first tower (t = 0.125 or 0.175)
      const cut = 60;
      const pieces = [
        [0, cut],
        [cut, 400 - cut],
      ].map(([y0, n]) =>
        generateModel(style.assets, rampIds, group, { seed: 1, mask: band(23, n!), heightVox: 40, frame: { x0: 0, y0: y0! * v, voxel: v, line } }),
      );
      for (let y = 0; y < 400; y += y > 40 && y < 90 ? 1 : 9)
        for (let x = 0; x < 23; x += 2) {
          const piece = y < cut ? pieces[0]! : pieces[1]!;
          const py = y < cut ? y : y - cut;
          for (let z = 0; z < whole.sz; z++)
            expect(rampAt(piece, x, py, z), `${group} voxel ${x},${y},${z}`).toBe(rampAt(whole, x, y, z));
        }
    }
  });

  it("draws every point landmark at its height", () => {
    for (const [g, H] of [
      ["landmark.tower.pyramid", 160],
      ["landmark.tower.obelisk", 300],
      ["landmark.tower.obelisk.diagonal", 300],
      ["landmark.tower.column", 40],
      ["landmark.hall.domed", 60],
      ["landmark.rotunda", 48],
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

  it("shapes the towers: pyramid wings, an obelisk's taper and open crown, a clock tower's stages", () => {
    const along = (m: VoxelModel, fx: (k: number) => [number, number], n: number, z: number) =>
      [...Array(n).keys()].filter((k) => m.get(...fx(k), z));
    // the pyramid's wings stand clear of its east and west faces high up, not of the others
    const p = generateModel(style.assets, rampIds, "landmark.tower.pyramid", { seed: 2, heightVox: 200 });
    const c = Math.round((p.sx - 1) / 2);
    const wx = along(p, (x) => [x, c], p.sx, 140);
    const wy = along(p, (y) => [c, y], p.sy, 140);
    expect(wx.length).toBeGreaterThan(wy.length + 6);
    // the obelisk narrows toward the top; its crown is an open lattice around a hollow top
    const o = generateModel(style.assets, rampIds, "landmark.tower.obelisk", { seed: 2, heightVox: 300 });
    const oc = (o.sx - 1) / 2;
    expect(along(o, (x) => [x, oc], o.sx, 10).length).toBeGreaterThan(along(o, (x) => [x, oc], o.sx, 260).length + 4);
    expect(o.get(oc, oc, 260)).toBeGreaterThan(0);
    expect(o.get(oc, oc, 297)).toBe(0);
    const face = along(o, (x) => [x, oc], o.sx, 296)[0]!; // the crown's west face, at a row of openings
    const lattice = [...Array(o.sy).keys()].filter((y) => Math.abs(y - oc) < 8).map((y) => o.get(face, y, 296) > 0);
    expect(lattice).toContain(true);
    expect(lattice).toContain(false);
    // the clock tower: clock faces on the shaft, open arches above
    const hall = generateModel(style.assets, rampIds, "landmark.hall.clock", { seed: 3, mask: band(30, 120), heightVox: 80 });
    let clocks = 0;
    for (let z = 0; z < hall.sz; z++)
      for (let y = 40; y < 80; y++) for (let x = 0; x < 30; x++) if (rampAt(hall, x, y, z) === "paint-white") clocks++;
    expect(clocks).toBeGreaterThan(8);
    const hallTop = topOf(hall, 15, 5);
    expect([...Array(30).keys()].some((x) => runs(hall, x, 60, hallTop + 1, 80).length > 1)).toBe(true); // arches
    // the rotunda: a dome over the middle, the colonnade's arc behind it to the west, open to the east
    const r = generateModel(style.assets, rampIds, "landmark.rotunda", { seed: 4, heightVox: 50 });
    const [cx, cy] = [(r.sx - 1) / 2, (r.sy - 1) / 2];
    expect(rampAt(r, cx + 3, cy, topOf(r, cx + 3, cy))).toBe("roof-tile");
    const apex = Math.round(50 * (1.6 - 1.16)); // the arc passes this far behind the rotunda's centre
    expect(topOf(r, cx - apex, cy)).toBeGreaterThanOrEqual(Math.round(50 * 0.4) - 1);
    expect(topOf(r, cx - apex, cy)).toBeLessThan(25);
    expect(topOf(r, cx + apex, cy)).toBe(-1);
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
