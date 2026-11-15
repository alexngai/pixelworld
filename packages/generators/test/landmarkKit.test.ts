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

  it("draws braced towers, X-braced between their legs and on their sides, and a double deck", () => {
    const H = 40;
    const m = bridge("landmark.bridge.suspension.double", H);
    const T = Math.round(H * 2.7);
    const A = Math.round(400 * 0.125); // the first tower's middle
    // between the legs, in their front plane: struts over the deck, and in each panel
    // between two struts diagonals that move across as they climb
    const between = (z: number) =>
      [...Array(23).keys()].filter((x) => x > 5 && x < 17 && [0, 1, 2, 3, 4, 5].some((k) => m.get(x, A + k, z)));
    const struts = [...Array(T - H).keys()].map((k) => H + 1 + k).filter((z) => between(z).length === 11);
    expect(struts.length).toBeGreaterThanOrEqual(4);
    const gaps = struts.flatMap((z, i) => (i > 0 && z - struts[i - 1]! > 4 ? [[struts[i - 1]! + 1, z - 1] as const] : []));
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    for (const [lo, hi] of gaps.slice(1)) {
      expect(between(Math.round((lo + hi) / 2))).toContain(11); // the diagonals cross in the middle
      expect(between(lo + 3).length).toBeGreaterThan(0);
      expect(between(lo + 3)).not.toContain(11);
    }
    // and none of it in the middle of the tower's depth, so from the side it hides behind the legs
    for (let z = H + 2; z < T; z++) expect(m.get(11, A, z), `z ${z}`).toBe(0);
    // each leg's outer face: posts at its front and back, and X-braced panels plated behind
    const face = (z: number, ramp: string) => [...Array(7).keys()].map((k) => A - 3 + k).filter((y) => rampAt(m, 0, y, z) === ramp);
    const panels: [number, number][] = [];
    for (let z = H + 1; z < T; z++)
      if (face(z, "asphalt").length) {
        const last = panels[panels.length - 1];
        if (last && last[1] === z - 1) last[1] = z;
        else panels.push([z, z]);
      }
    expect(panels.length).toBeGreaterThanOrEqual(3);
    for (const [lo, hi] of panels) {
      // the diagonals cross in the middle of the panel, and meet the posts at its ends
      const z = Math.round((lo + hi) / 2);
      expect(face(z, "bridge-grey")).toEqual(expect.arrayContaining([A - 1, A]));
      expect(face(lo + 3, "bridge-grey")).not.toContain(A);
      // the face's front and back edges are steel posts (stepping in as the legs taper)
      const solid = [...Array(15).keys()].map((k) => A - 7 + k).filter((y) => m.get(0, y, z));
      expect(rampAt(m, 0, solid[0]!, z)).toBe("bridge-grey");
      expect(rampAt(m, 0, solid[solid.length - 1]!, z)).toBe("bridge-grey");
    }
    // a lower deck inside the truss at the first bridge's mid-span
    const lower = runs(m, 11, 100, 0, H - 1);
    expect(lower.length).toBe(1);
    expect(lower[0]![0]).toBeLessThan(H - 3);
    expect(rampAt(m, 11, 100, H)).toBe("roof-flat");
  });

  it("hangs the cables: sagging between the towers and down the side spans, onto a raised central anchorage", () => {
    const H = 40;
    const m = bridge("landmark.bridge.suspension.double", H);
    const T = Math.round(H * 2.7);
    const cable = (y: number) => topOf(m, 1, y); // the cable plane, between the hangers
    // mid-span: the cable stays clear of the deck (sag 0.06 of the towers over it)
    expect(cable(101)).toBeGreaterThanOrEqual(H + 5);
    expect(cable(101)).toBeLessThan(H + 9);
    // the main span is a parabola: half way to mid-span it has dropped three quarters
    const top = cable(Math.round(400 * 0.125) + 7);
    expect(cable(75)).toBeLessThan(cable(101) + (top - cable(101)) * 0.4);
    // the central anchorage stands well above the deck under the cables
    const anchor = topOf(m, 1, 200);
    expect(anchor).toBeGreaterThan(H + 0.15 * (T - H));
    // its road stays open
    expect(rampAt(m, 11, 200, H + 1)).toBeNull();
    // the side spans sag below the straight line from the tower top to the anchorages
    expect(cable(175)).toBeLessThan((anchor + T - 1) / 2 - 3);
    expect(cable(25)).toBeLessThan((H + 1 + T - 1) / 2 - 3);
    // and still climb from them all the way
    for (let y = 157; y < 190; y += 4) expect(cable(y)).toBeGreaterThanOrEqual(cable(y + 4));
  });

  it("brings a bridge's deck down its approaches to the ground", () => {
    // 25 cells of line at 1/16 cell a voxel: 3 of approach at a, landing on the ground (0
    // voxels up), none at b; the suspension spans between the anchorages
    const v = 1 / 16;
    const line = {
      a: [4.5 * v, 0] as [number, number],
      b: [4.5 * v, 400 * v] as [number, number],
      half: 4.5 * v,
      rise: [0, 0] as [number, number],
      approach: [3, 0] as [number, number],
    };
    const m = generateModel(style.assets, rampIds, "landmark.bridge.suspension", {
      seed: 1,
      mask: band(9, 400),
      heightVox: 40,
      frame: { x0: 0, y0: 0, voxel: v, line },
    });
    // down the middle of the road: on the ground at the approach's foot, up to the deck at the
    // anchorage (48 voxels on), level from there over the water, and level to b
    expect(topOf(m, 4, 1)).toBeLessThanOrEqual(1);
    for (let y = 1; y < 44; y += 4) expect(topOf(m, 4, y + 4)).toBeGreaterThanOrEqual(topOf(m, 4, y));
    expect(topOf(m, 4, 60)).toBe(40);
    expect(topOf(m, 4, 200)).toBe(40);
    expect(topOf(m, 4, 398)).toBe(40);
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
  }, 30_000); // a 400-voxel bridge in pieces: a few seconds alone, longer on a loaded machine

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

  it("draws the coast's landmarks: a windmill, a lighthouse and a cellhouse", () => {
    // the windmill: a tower to its cap, sails reaching past it on the windward (west) side only
    const w = generateModel(style.assets, rampIds, "landmark.windmill", { seed: 1, heightVox: 30 });
    const c = (w.sx - 1) / 2;
    expect(topOf(w, c, c)).toBeGreaterThanOrEqual(29);
    const sailCols = (x0: number, x1: number) => {
      let n = 0;
      for (let x = x0; x < x1; x++) for (let y = 0; y < w.sy; y++) for (let z = 0; z < w.sz; z++) if (rampAt(w, x, y, z) === "paint-white") n++;
      return n;
    };
    expect(sailCols(0, Math.floor(c))).toBeGreaterThan(20);
    expect(sailCols(Math.ceil(c) + 1, w.sx)).toBe(0);
    let above = 0; // the upper sails rise above the cap
    for (let y = 0; y < w.sy; y++) for (let x = 0; x < w.sx; x++) if (topOf(w, x, y) > 32) above++;
    expect(above).toBeGreaterThan(2);
    // turned to face north, the sails go to −y
    const n = generateModel({ ...style.assets, "landmark.windmill": { ...style.assets["landmark.windmill"]!, params: { face: 1 } } }, rampIds, "landmark.windmill", {
      seed: 1,
      heightVox: 30,
    });
    let north = 0;
    for (let y = 0; y < Math.floor((n.sy - 1) / 2); y++) for (let x = 0; x < n.sx; x++) for (let z = 0; z < n.sz; z++) if (rampAt(n, x, y, z) === "paint-white") north++;
    expect(north).toBeGreaterThan(20);
    // the lighthouse: a white shaft, a glazed lantern under a dark cap
    const l = generateModel(style.assets, rampIds, "landmark.lighthouse", { seed: 1, heightVox: 30 });
    const lc = (l.sx - 1) / 2;
    expect(topOf(l, lc, lc)).toBeGreaterThanOrEqual(29);
    const column = [...Array(l.sz).keys()].map((z) => rampAt(l, lc, lc, z));
    expect(column.slice(0, 10).every((r) => r === "paint-white" || r === "concrete")).toBe(true);
    expect(column).toContain("lit");
    expect(column[topOf(l, lc, lc)]).toBe("roof-slate");
    // the cellhouse: a long hall with barred windows, its head block taller at the band's east end
    const h = generateModel(style.assets, rampIds, "landmark.cellhouse", { seed: 1, mask: band(90, 24), heightVox: 16 });
    expect(topOf(h, 85, 12)).toBeGreaterThan(topOf(h, 45, 12));
    expect(topOf(h, 45, 12)).toBeGreaterThan(topOf(h, 5, 12));
    expect(topOf(h, 5, 1)).toBe(-1); // the tail wing is narrower than the band
    let windows = 0;
    for (let x = 20; x < 75; x++) for (let z = 0; z < 16; z++) if (rampAt(h, x, 0, z) === "glass") windows++;
    expect(windows).toBeGreaterThan(100);
  });

  it("draws stone arches open under their span, and a boulder balanced on a neck (D-139)", () => {
    const ids = new Map([["entrada", 1], ["dewey-bridge", 2], ["moab-tongue", 3]]);
    const rock = { rock: "entrada", base: "dewey-bridge", cap: "moab-tongue" };
    const catalog = {
      "landmark.arch": { generator: "stoneArch", ramps: rock, params: { span: 1, opening: 0.6, clear: 0.85, waist: 0.35, skew: 0.25 } },
      "landmark.arch.double": { generator: "stoneArch", ramps: rock, params: { span: 1.5, opening: 1, clear: 0.8, double: 1 } },
      "landmark.rock.balanced": { generator: "balancedRock", ramps: rock },
    } as AssetCatalog;
    const rampOf = (m: VoxelModel, x: number, y: number, z: number) => [...ids].find(([, i]) => m.get(x, y, z) && i === m.materials[m.get(x, y, z)])?.[0];
    const solidAt = (m: VoxelModel, x: number, z: number) => [...Array(m.sy).keys()].some((y) => m.get(x, y, z) > 0);
    const a = generateModel(catalog, ids, "landmark.arch", { seed: 1, heightVox: 26 });
    const mid = Math.floor(a.sx / 2);
    let top = 0;
    for (let x = 0; x < a.sx; x++) for (let y = 0; y < a.sy; y++) top = Math.max(top, topOf(a, x, y));
    expect(top).toBeGreaterThanOrEqual(24);
    expect(solidAt(a, mid, 0) || solidAt(a, mid, 10)).toBe(false); // open under the span
    expect(solidAt(a, mid, 24)).toBe(true); // the span over it
    expect(solidAt(a, 3, 0) && solidAt(a, a.sx - 4, 0)).toBe(true); // both legs on the ground
    expect([...Array(a.sy).keys()].map((y) => rampOf(a, 3, y, 0)).filter(Boolean)[0]).toBe("dewey-bridge"); // at the foot
    // the double arch: a second span along y sharing the corner leg, open under both
    const d = generateModel(catalog, ids, "landmark.arch.double", { seed: 1, heightVox: 40 });
    const [c, far] = [Math.floor(d.sx / 2), d.sx - 4];
    expect(d.get(c, far, 2) || d.get(far, c, 2)).toBe(0);
    const spanAt = (x: (k: number) => number, y: (k: number) => number) =>
      [...Array(12).keys()].some((k) => [35, 36, 37, 38].some((z) => d.get(x(k), y(k), z) > 0));
    expect(spanAt(() => c, (k) => d.sx - 1 - k)).toBe(true); // the span along x, over the far side
    expect(spanAt((k) => d.sx - 1 - k, () => c)).toBe(true); // and along y
    // turned along the diagonal x = y: open under the middle, its legs at the diagonal's ends
    const g = generateModel({ ...catalog, "landmark.arch": { ...catalog["landmark.arch"]!, params: { span: 1.6, opening: 0.8, clear: 0.6, diagonal: 1 } } }, ids, "landmark.arch", {
      seed: 1,
      heightVox: 30,
    });
    const gc = Math.floor(g.sx / 2);
    expect(g.sx).toBe(g.sy);
    expect(g.get(gc, gc, 1)).toBe(0);
    expect(topOf(g, gc, gc)).toBeGreaterThanOrEqual(25);
    expect(g.get(gc - 14, gc - 14, 1) || g.get(gc - 13, gc - 13, 1)).toBeGreaterThan(0);
    expect(g.get(gc + 14, gc - 14, 1)).toBe(0); // nothing across the other diagonal
    // the balanced rock: the boulder overhangs a neck of the pedestal's rock
    const b = generateModel(catalog, ids, "landmark.rock.balanced", { seed: 1, heightVox: 62 });
    const width = (z: number) => [...Array(b.sx).keys()].filter((x) => b.get(x, Math.floor(b.sy / 2), z)).length;
    const neck = 62 - Math.round(62 * 0.42) - 1;
    expect(width(neck + 12)).toBeGreaterThan(width(neck) + 6);
    expect(width(0)).toBeGreaterThan(width(neck) + 10);
    expect(rampOf(b, Math.floor(b.sx / 2), Math.floor(b.sy / 2), neck)).toBe("dewey-bridge");
    expect(rampOf(b, Math.floor(b.sx / 2), Math.floor(b.sy / 2), neck + 12)).toBe("entrada");
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
