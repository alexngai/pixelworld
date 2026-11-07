import { describe, expect, it } from "vitest";
import {
  VoxelModel,
  buildObjects,
  footprintMask,
  meshVoxels,
  resolveAsset,
  rotateModel,
  type AssetCatalog,
} from "../src/index";

const unit = { h: 1, v: 1 };

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
  };
  const rampIds = new Map([
    ["pine", 3],
    ["bark", 5],
  ]);

  it("resolves groups by longest prefix", () => {
    expect(resolveAsset(catalog, "tree.conifer.ponderosa")?.generator).toBe("conifer");
    expect(resolveAsset(catalog, "tree.palm")?.generator).toBe("blob");
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
});
