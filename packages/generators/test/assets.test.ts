import { describe, expect, it } from "vitest";
import {
  DIRECT_RAMP_BASE,
  FACE_TEXELS,
  MeshBuilder,
  TEXEL_ROW,
  VoxelModel,
  buildObjects,
  footprintMask,
  meshVoxels,
  objectVoxelScale,
  resolveAsset,
  rotateModel,
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
