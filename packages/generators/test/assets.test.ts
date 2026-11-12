import { describe, expect, it } from "vitest";
import {
  DIRECT_RAMP_BASE,
  FACE_LINE,
  FACE_TEXELS,
  MeshBuilder,
  TEXEL_ROW,
  VoxelModel,
  buildObjects,
  generateModel,
  footprintMask,
  meshVoxels,
  objectVoxelScale,
  registerGenerators,
  resolveAsset,
  rotateModel,
  unregisterGenerators,
  type AssetCatalog,
  type MeshData,
} from "../src/index";

const unit = { h: 1, v: 1 };

/** Every voxel face a mesh draws (unit voxels), and its ramp and owning cell: "axis,dir,plane,a,b" → "ramp@cx,cy". */
function voxelFaces(m: MeshData): Map<string, string> {
  const out = new Map<string, string>();
  for (let q = 0; q < m.vertexCount; q += 6) {
    const p = (k: number) => [0, 1, 2].map((i) => m.position[(q + k) * 3 + i]!);
    const n = [0, 1, 2].map((i) => m.normal[q * 3 + i]!);
    const d = n.findIndex((x) => x !== 0);
    const [u, v] = [(d + 1) % 3, (d + 2) % 3];
    const [a, c] = [p(0), p(2)];
    const mat = m.material[q * 3]!;
    const ref = m.faceRef?.slice(q * 4, q * 4 + 4);
    if (mat === FACE_TEXELS) expect([m.faceUv![(q + 2) * 2], m.faceUv![(q + 2) * 2 + 1]]).toEqual([c[u]! - a[u]!, c[v]! - a[v]!]);
    for (let j = 0; j < c[v]! - a[v]!; j++)
      for (let i = 0; i < c[u]! - a[u]!; i++) {
        const ramp = mat === FACE_TEXELS ? m.texels![ref![0]! * TEXEL_ROW + ref![1]! + j * ref![2]! + i]! : mat - DIRECT_RAMP_BASE;
        out.set(`${d},${n[d]},${a[d]},${a[u]! + i},${a[v]! + j}`, `${ramp}@${m.cell[q * 2]},${m.cell[q * 2 + 1]}`);
      }
  }
  return out;
}

describe("voxel meshing", () => {
  it("emits six faces for one voxel", () => {
    const m = new VoxelModel(1, 1, 1, [0, 7]);
    m.set(0, 0, 0, 1);
    const mesh = meshVoxels(m, unit, [0, 0, 0], [0, 0]).build();
    expect(mesh.vertexCount).toBe(36);
    expect(mesh.material[0]).toBe(107); // direct ramp 7
  });

  it("merges coplanar faces of the same material", () => {
    const m = new VoxelModel(3, 2, 1, [0, 1]);
    m.fill(0, 0, 0, 3, 2, 1, 1);
    expect(meshVoxels(m, unit, [0, 0, 0], [0, 0]).build().vertexCount).toBe(36); // still a box
    const two = new VoxelModel(2, 1, 1, [0, 1, 2]);
    two.set(0, 0, 0, 1);
    two.set(1, 0, 0, 2); // different material: top and sides split
    expect(meshVoxels(two, unit, [0, 0, 0], [0, 0]).build().vertexCount).toBe(60);
  });

  it("draws faces of several colours from texels, each voxel face as without them", () => {
    // a block with windows of two colours, a recess and a hole through it
    const m = new VoxelModel(9, 7, 11, [0, 3, 5, 8]);
    m.fill(0, 0, 0, 9, 7, 11, 1);
    for (let z = 1; z < 10; z += 2) for (let x = 1; x < 8; x += 2) m.set(x, 0, z, (x + z) % 4 ? 2 : 3);
    m.set(4, 6, 5, 0);
    m.fill(3, 2, 0, 5, 4, 11, 0);
    for (const cell of [[2, 3], "column"] as const) {
      const plain = meshVoxels(m, unit, [0, 0, 0], cell).build();
      const texels = meshVoxels(m, unit, [0, 0, 0], cell, new MeshBuilder({ texels: true })).build();
      expect(voxelFaces(texels)).toEqual(voxelFaces(plain));
      expect(texels.vertexCount).toBeLessThan(plain.vertexCount);
      expect(texels.texels!.length).toBeGreaterThan(0);
    }
  });

  it("rotates models by quarter turns", () => {
    const m = new VoxelModel(3, 1, 1, [0, 1]);
    m.set(0, 0, 0, 1);
    const r = rotateModel(m, 1);
    expect([r.sx, r.sy]).toEqual([1, 3]);
    expect(r.count()).toBe(1);
    expect(rotateModel(m, 4).get(0, 0, 0)).toBe(1);
  });
});

describe("assets", () => {
  const catalog: AssetCatalog = {
    tree: { generator: "blob", ramps: { body: "pine", trunk: "bark" } },
    "tree.conifer": { generator: "conifer", ramps: { crown: "pine", trunk: "bark" } },
    "building.lowrise": { generator: "building", ramps: { wall: "bark", roof: "pine", window: "pine" }, params: { style: 1 } },
    "building.tower": {
      generator: "building",
      ramps: { wall: "bark", "wall.alt": "pine", roof: "pine", window: "pine", lit: "glow", trim: "glow" },
      params: { style: 2, litFraction: 1 },
    },
    "tree.palm": { generator: "palm", ramps: { trunk: "bark", fronds: "pine" }, params: { reach: 2 } },
  };
  const rampIds = new Map([
    ["pine", 3],
    ["bark", 5],
    ["glow", 9],
  ]);

  it("resolves groups by longest prefix", () => {
    expect(resolveAsset(catalog, "tree.conifer.ponderosa")?.generator).toBe("conifer");
    expect(resolveAsset(catalog, "tree.oak")?.generator).toBe("blob");
    expect(resolveAsset(catalog, "rock.boulder")).toBeNull();
  });

  it("rasterizes footprints into voxel columns", () => {
    const { mask, x0, y0 } = footprintMask(
      [
        [0, 0],
        [2, 0],
        [2, 1],
        [0, 1],
      ],
      0.5,
    );
    expect([mask.sx, mask.sy, x0, y0]).toEqual([4, 2, 0, 0]);
    expect(mask.on.every((v) => v === 1)).toBe(true);
  });

  it("leaves a footprint's courtyards out of its mask (D-088)", () => {
    const ring = (a: number, b: number): [number, number][] => [
      [a, a],
      [b, a],
      [b, b],
      [a, b],
    ];
    const { mask } = footprintMask(ring(0, 3), 0.5, [ring(1, 2)]);
    expect([mask.sx, mask.sy]).toEqual([6, 6]);
    const at = (i: number, j: number) => mask.on[j * mask.sx + i];
    // the court (cells 1–2, voxels 2–3) is open; the wings round it are not
    expect([at(2, 2), at(3, 3), at(2, 3)]).toEqual([0, 0, 0]);
    expect([at(0, 0), at(1, 2), at(4, 3), at(5, 5)]).toEqual([1, 1, 1, 1]);
    expect(mask.on.reduce((s, v) => s + v, 0)).toBe(36 - 4);
  });

  it("instances repeated objects per variant and merges unique ones", () => {
    const out = buildObjects(
      [
        { g: "tree.conifer", x: 1.5, y: 1.5, s: 1 },
        { g: "tree.conifer", x: 4.5, y: 1.5, s: 7 }, // same variant as s=1 with 6 variants
        { g: "tree.conifer", x: 2.5, y: 3.5, s: 2 },
        { g: "building.lowrise", x: 6, y: 6, s: 3, hm: 12, fp: [[5, 5], [7, 5], [7, 7], [5, 7]] },
        { g: "unknown.thing", x: 0, y: 0, s: 0 },
      ],
      { catalog, rampIds, voxel: { h: 0.25, v: 0.5 }, voxelMeters: 4, heightStretch: 1, heightAt: () => 10 },
    );
    expect(out.skipped).toBe(1);
    expect(out.batches.length).toBe(2);
    const sizes = out.batches.map((b) => b.offsets.length / 3).sort();
    expect(sizes).toEqual([1, 2]);
    expect(out.batches[0]!.offsets[2]).toBe(10); // base height from heightAt
    expect(out.merged.vertexCount).toBeGreaterThan(0);
    expect(Math.min(...Array.from(out.merged.cell))).toBe(6);
  });

  const opts = { catalog, rampIds, voxel: { h: 0.25, v: 0.5 }, voxelMeters: 4, heightStretch: 1, heightAt: () => 0 };
  const rampsUsed = (mesh: { material: Float32Array; vertexCount: number }) =>
    new Set(Array.from({ length: mesh.vertexCount }, (_, v) => mesh.material[v * 3]! - 100));

  it("lights tower windows and trims the roof with the emissive roles", () => {
    const fp: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2]];
    const out = buildObjects([{ g: "building.tower", x: 1, y: 1, s: 4, hm: 40, fp }], opts);
    const used = rampsUsed(out.merged);
    expect(used.has(9)).toBe(true); // lit windows and neon trim
    expect(used.has(3) || used.has(5)).toBe(true); // a wall variant
  });

  it("draws a model's one-pixel lines as a lines mesh, placed as its voxels, with its line's ground heights (D-098)", () => {
    registerGenerators(
      {
        strung: ({ mask, frame, ramp }) => {
          const m = new VoxelModel(mask!.sx, mask!.sy, 1);
          const [ra, rb] = frame!.line!.rise!;
          m.line([0, 0, ra], [2, 1, rb], m.material(ramp("wire")));
          return m;
        },
      },
      { source: "test-lines" },
    );
    const wired = { ...catalog, "prop.wire": { generator: "strung", ramps: { wire: "glow" } } } as AssetCatalog;
    const fp: [number, number][] = [[0, 0], [2, 0], [2, 0.5], [0, 0.5]];
    const slope = { ...opts, catalog: wired, heightAt: (x: number) => 10 + x };
    const out = buildObjects([{ g: "prop.wire", x: 1, y: 0.25, s: 1, fp, ln: [0, 0.25, 2, 0.25], lw: 0.25 }], slope);
    expect(out.merged.vertexCount).toBe(0);
    expect(out.lines.primitive).toBe("lines");
    expect(out.lines.vertexCount).toBe(2);
    // voxel (0, 0, 0) at the frame's corner and base; (2, 1) voxels on, at the far end's ground
    expect(Array.from(out.lines.position)).toEqual([0, 0, 10, 0.5, 0.25, 10 + 2 * 0.5 * 2]);
    expect(out.lines.material[1]).toBe(FACE_LINE);
    unregisterGenerators("test-lines");
  });

  it("draws an instanced model's lines as an instanced lines batch of their own (D-098)", () => {
    registerGenerators({ mast: ({ ramp }) => { const m = new VoxelModel(1, 1, 2); const c = m.material(ramp("wire")); m.set(0, 0, 0, c); m.line([0.5, 0.5, 1], [0.5, 0.5, 9], c); return m; } }, { source: "test-mast" });
    const masts = { ...catalog, "prop.mast": { generator: "mast", ramps: { wire: "glow" } } } as AssetCatalog;
    const out = buildObjects(
      [0, 1, 2].map((k) => ({ g: "prop.mast", x: 1.5 + k, y: 1.5, s: 6 })), // one variant
      { ...opts, catalog: masts, heightAt: () => 3 },
    );
    const [voxels, lines] = [out.batches.find((b) => !b.mesh.primitive)!, out.batches.find((b) => b.mesh.primitive === "lines")!];
    expect(voxels.offsets.length / 3).toBe(3);
    expect(lines.mesh.vertexCount).toBe(2);
    expect(Array.from(lines.offsets)).toEqual(Array.from(voxels.offsets));
    expect(lines.offsets).not.toBe(voxels.offsets); // its own copy: a render scale scales each batch's
    // the line stands where the voxel does: from the model's bottom centre, 1 to 9 voxels up
    expect(Array.from(lines.mesh.position)).toEqual([0, 0, 0.5, 0, 0, 4.5]);
    unregisterGenerators("test-mast");
  });

  it("draws street lights and signals in one-pixel lines with `lines` (D-098), as voxels without", () => {
    const props = {
      ...catalog,
      "prop.light": { generator: "streetLight", ramps: { pole: "glow", lamp: "glow" } },
      "prop.light.thin": { generator: "streetLight", ramps: { pole: "glow", lamp: "glow" }, params: { lines: 1, height: 12, reach: 3 } },
      "prop.signal": { generator: "trafficSignal", ramps: { pole: "glow", head: "pine", light: "glow" } },
      "prop.signal.thin": { generator: "trafficSignal", ramps: { pole: "glow", head: "pine", light: "glow" }, params: { lines: 1, height: 10, reach: 4 } },
    } as AssetCatalog;
    const gen = (g: string) => generateModel(props, rampIds, g, { seed: 1 });
    expect([gen("prop.light").count(), gen("prop.light").lines.length]).toEqual([8, 0]); // the voxel light as it was
    expect([gen("prop.signal").count(), gen("prop.signal").lines.length]).toEqual([8, 0]);
    const light = gen("prop.light.thin");
    expect(light.count()).toBe(1); // the lamp; mast and arm are lines
    expect(light.lines[0]!.a).toEqual([0.5, 0.5, 0]); // the mast from the ground
    expect(light.lines.at(-1)!.b[0]).toBeCloseTo(3.5, 6); // the arm out to the lamp
    const signal = gen("prop.signal.thin");
    expect(signal.lines.length).toBe(2); // the pole and its arm
    expect(signal.count()).toBe(6); // three lamps under a hood
  });

  it("sits footprints on their lowest corner", () => {
    const fp: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2]];
    const slope = { ...opts, heightAt: (x: number) => 10 + x };
    const out = buildObjects([{ g: "building.lowrise", x: 1, y: 1, s: 1, hm: 8, fp }], slope);
    let minZ = Infinity;
    for (let v = 0; v < out.merged.vertexCount; v++) minZ = Math.min(minZ, out.merged.position[v * 3 + 2]!);
    expect(minZ).toBe(10);
  });

  it("sizes palms by their reach parameter", () => {
    const out = buildObjects([{ g: "tree.palm", x: 0, y: 0, s: 0 }], opts);
    const xs = Array.from({ length: out.batches[0]!.mesh.vertexCount }, (_, v) => out.batches[0]!.mesh.position[v * 3]!);
    const span = (Math.max(...xs) - Math.min(...xs)) / 0.25;
    expect(span).toBeGreaterThanOrEqual(5); // fronds reach 2 voxels each side of the trunk
    expect(span).toBeLessThanOrEqual(6); // plus one for a leaning crown
  });

  it("keeps objects at a fixed pixel size at any render scale", () => {
    expect(objectVoxelScale(1)).toEqual({ h: 1 / 16, v: 1 / 8 });
    const fine = objectVoxelScale(0.125);
    expect(fine.h * 0.125).toBeCloseTo(1 / 16);
    expect(fine.v * 0.125).toBeCloseTo(1 / 8);
  });
});
