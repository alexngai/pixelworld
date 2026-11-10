import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_SOURCE,
  VoxelModel,
  buildObjects,
  missingModel,
  registerGenerators,
  unregisterGenerators,
  type AssetCatalog,
  type GenContext,
  type ObjectInstance,
} from "../src/index";

/**
 * Failure containment (D-072): a model whose generator is missing, throws or
 * returns no model is drawn as a missing-model marker, and recorded with
 * what's needed to find and reproduce it; the rest of the bake goes on.
 */

const MARKER = 15;
const rampIds = new Map([
  ["pine", 3],
  ["bark", 5],
  ["stucco", 7],
  ["marker", MARKER],
]);
const catalog: AssetCatalog = {
  "building.lowrise": { generator: "building", ramps: { wall: "stucco", roof: "bark", window: "pine" } },
  "building.adobe": { generator: "adobe", ramps: { wall: "stucco", roof: "bark" } },
  "building.hollow": { generator: "hollow", ramps: { wall: "stucco" } },
  "building.rowhouse": { generator: "rowhouse", ramps: { wall: "stucco" } },
  "landmark.adobe": { generator: "adobe", ramps: { wall: "bark" } },
  "tree.adobe": { generator: "adobe", ramps: { crown: "pine" } },
  "tree.conifer": { generator: "conifer", ramps: { crown: "pine", trunk: "bark" } },
};
const opts = { catalog, rampIds, voxel: { h: 0.25, v: 0.5 }, voxelMeters: 4, heightStretch: 1, heightAt: () => 0 };
const square = (x: number, y: number, w: number, h: number): [number, number][] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];
/** The direct ramps a mesh's vertices use. */
const rampsUsed = (mesh: { material: Float32Array; vertexCount: number }) =>
  new Set(Array.from({ length: mesh.vertexCount }, (_, v) => mesh.material[v * 3]! - 100));

describe("a model that fails to generate", () => {
  afterEach(() => void unregisterGenerators("@pixelworlds/city-demo"));
  const adobe = (ctx: GenContext): VoxelModel => {
    const { sx = 0, sy = 0 } = ctx.mask ?? {};
    if (sx * sy > 40) throw new Error(`adobe: lot too big (${sx}x${sy})`);
    const m = new VoxelModel(Math.max(sx, 1), Math.max(sy, 1), 2);
    m.fill(0, 0, 0, m.sx, m.sy, 2, m.material(ctx.ramp("wall")));
    return m;
  };

  it("is drawn as a marker, recorded with its group, generator, seed and footprint, and the rest still bakes", () => {
    registerGenerators({ adobe, hollow: () => undefined as unknown as VoxelModel }, { source: "@pixelworlds/city-demo" });
    const insts: ObjectInstance[] = [
      { g: "building.lowrise", x: 1, y: 1, s: 1, hm: 8, fp: square(0, 0, 2, 2) },
      { g: "building.adobe", x: 11, y: 11, s: 42, hm: 8, fp: square(10, 10, 3, 4) }, // 12 × 16 voxels: too big
      { g: "building.adobe", x: 21, y: 21, s: 43, hm: 8, fp: square(20, 20, 1, 1) }, // fits
      { g: "building.hollow", x: 31, y: 31, s: 44, hm: 8, fp: square(30, 30, 1, 1) },
    ];
    const out = buildObjects(insts, opts);
    expect(out.failures).toEqual([
      {
        group: "building.adobe",
        generator: "adobe",
        seed: 42,
        x: 11,
        y: 11,
        footprint: { cells: [3, 4], voxels: [12, 16] },
        heightVox: 2, // 8 m of 4 m voxels
        source: "@pixelworlds/city-demo",
        plugin: null,
        error: "Error: adobe: lot too big (12x16)",
      },
      {
        group: "building.hollow",
        generator: "hollow",
        seed: 44,
        x: 31,
        y: 31,
        footprint: { cells: [1, 1], voxels: [4, 4] },
        heightVox: 2, // 8 m of 4 m voxels
        source: "@pixelworlds/city-demo",
        plugin: null,
        error: "TypeError: generator 'hollow' returned undefined, not a VoxelModel",
      },
    ]);
    // the marker is in the style's marker ramp; the good models are drawn as ever
    const used = rampsUsed(out.merged);
    expect(used.has(MARKER)).toBe(true);
    expect(used.has(7)).toBe(true);
    const cells = new Set(Array.from(out.merged.cell).filter((_, i) => i % 2 === 0));
    expect([...cells].sort((a, b) => a - b)).toEqual([1, 11, 21, 31]);
  });

  it("names the plugin known to provide a generator that isn't registered", () => {
    const out = buildObjects([{ g: "building.rowhouse", x: 3, y: 4, s: 9, hm: 6, fp: square(2, 3, 1, 2) }], opts);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toMatchObject({ generator: "rowhouse", source: null, plugin: "@pixelworlds/city-sf" });
    expect(out.failures[0]!.error).toMatch(/^MissingGeneratorError: no generator named 'rowhouse' \(asked for by building.rowhouse\)/);
    expect(out.merged.vertexCount).toBeGreaterThan(0); // the marker
  });

  it("draws a landmark's or a repeated object's marker as a small block, once per variant", () => {
    const insts: ObjectInstance[] = [
      { g: "landmark.adobe", x: 5.5, y: 5.5, s: 3, hm: 30 },
      { g: "tree.adobe", x: 1.5, y: 1.5, s: 1 },
      { g: "tree.adobe", x: 3.5, y: 1.5, s: 7 }, // the same variant as s = 1
      { g: "tree.conifer", x: 2.5, y: 2.5, s: 2 },
    ];
    const out = buildObjects(insts, opts);
    expect(out.failures.map((f) => [f.group, f.source, f.repeated ?? false])).toEqual([
      ["landmark.adobe", null, false],
      ["tree.adobe", null, true],
    ]);
    expect(out.failures[1]!.seed).not.toBe(1); // the variant's seed, as the generator gets it
    expect(out.failures[0]!.plugin).toBeNull(); // nobody known provides 'adobe'
    // the trees' marker is instanced at both places, beside the conifer
    const sizes = out.batches.map((b) => b.offsets.length / 3).sort();
    expect(sizes).toEqual([1, 2]);
  });

  it("names the built-ins as the source of a built-in that throws", () => {
    registerGenerators({ adobe }, { source: "@pixelworlds/city-demo" });
    const ok = buildObjects([{ g: "tree.conifer", x: 1, y: 1, s: 1 }, { g: "building.adobe", x: 2, y: 2, s: 1, hm: 8, fp: square(2, 2, 1, 1) }], opts);
    expect(ok.failures).toEqual([]); // every model generated: nothing recorded
    // the generic building asks for its window role; this asset has none
    const broken = { ...catalog, "building.lowrise": { generator: "building", ramps: { wall: "stucco" } } };
    const out = buildObjects([{ g: "building.lowrise", x: 1, y: 1, s: 1, hm: 40, fp: square(0, 0, 2, 2) }], { ...opts, catalog: broken });
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toMatchObject({ generator: "building", source: BUILTIN_SOURCE, plugin: null });
  });
});

describe("the missing-model marker", () => {
  it("checkers a footprint in 4-voxel squares, the marker's raised", () => {
    const on = new Uint8Array(8 * 4).fill(1);
    const m = missingModel({ sx: 8, sy: 4, on }, MARKER, 7);
    expect([m.sx, m.sy, m.sz]).toEqual([8, 4, 4]);
    const top = (x: number, y: number) => [3, 2, 1, 0].find((z) => m.get(x, y, z)) ?? -1;
    expect([top(0, 0), top(4, 0), top(3, 3)]).toEqual([3, 1, 3]);
    expect(m.materials[m.get(0, 0, 0)]).toBe(MARKER);
    expect(m.materials[m.get(4, 0, 0)]).toBe(7);
    // only the footprint's columns
    const hole = new Uint8Array(4).fill(1);
    hole[3] = 0;
    expect(missingModel({ sx: 2, sy: 2, on: hole }, MARKER, 7).get(1, 1, 0)).toBe(0);
  });

  it("is an 8-voxel 3D checkerboard where there is no footprint", () => {
    const m = missingModel(undefined, MARKER, 7);
    expect([m.sx, m.sy, m.sz, m.count()]).toEqual([8, 8, 8, 512]);
    expect(m.materials[m.get(0, 0, 0)]).toBe(MARKER);
    expect(m.materials[m.get(4, 0, 0)]).toBe(7);
    expect(m.materials[m.get(4, 0, 4)]).toBe(MARKER);
  });
});
