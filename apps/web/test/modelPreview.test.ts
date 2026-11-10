import { describe, expect, it } from "vitest";
import type { BakedImage } from "@pixelworlds/bake";
import { hasGenerator } from "@pixelworlds/generators";
import { buildPalette, validateStyle, type StylePack } from "@pixelworlds/style";
import bayAreaJson from "../../../worlds/_styles/bay-area/style.json";
import southwestJson from "../../../worlds/_styles/desert-southwest/style.json";
import {
  DEFAULT_SPEC,
  MAX_MODELS,
  defaultVehicleSize,
  modelKind,
  paletteImage,
  parseHints,
  parseList,
  parseSizes,
  parseSpec,
  previewCatalog,
  previewModels,
  previewScene,
  registerWorkspacePlugins,
  specParams,
  type PreviewSpec,
} from "../src/modelPreview";

const southwest = validateStyle(southwestJson as unknown as StylePack);
const bayArea = validateStyle(bayAreaJson as unknown as StylePack);
const spec = (q: string): PreviewSpec => parseSpec(new URLSearchParams(q));

describe("the model preview", () => {
  it("reads its parameters, and writes them back the same", () => {
    expect(parseList("1-4, 9,x,-2--1")).toEqual([1, 2, 3, 4, 9, -2, -1]);
    expect(parseList("6-4")).toEqual([4, 5, 6]);
    expect(parseSizes("8x6, 12×10, 3x, 0x4", 2)).toEqual([
      [8, 6],
      [12, 10],
    ]);
    expect(parseHints("front:2,floors:3,corner:1,roof:gabled,bogus:1")).toEqual({ front: 2, floors: 3, corner: true, roof: "gabled" });
    expect(parseHints("")).toBeUndefined();
    expect(spec("")).toEqual(DEFAULT_SPEC);
    const s = spec("style=bay-area&group=building.house&generator=rowhouse&seeds=1-3&fp=6x16,8x8&h=30,40&hints=front:2,corner:1&rot=0,2&palette=night&zoom=4&ground=0");
    expect(s).toMatchObject({
      style: "bay-area",
      group: "building.house",
      generator: "rowhouse",
      seeds: [1, 2, 3],
      footprints: [
        [6, 16],
        [8, 8],
      ],
      heights: [30, 40],
      hints: { front: 2, corner: true },
      rotations: [0, 2],
      palettes: ["night"],
      zoom: 4,
      ground: null,
    });
    expect(parseSpec(specParams(s))).toEqual(s);
    const v = spec("group=vehicle.bus&size=20x6x8&part=1&variant=2&ground=asphalt&zoom=99");
    expect(parseSpec(specParams(v))).toEqual(v);
    expect(v).toMatchObject({ size: { length: 20, width: 6, height: 8 }, part: 1, variant: 2, ground: "asphalt", zoom: 3 });
  });

  it("generates a building for each seed, footprint and height, with the pack's roles", () => {
    const palette = buildPalette(southwest);
    const models = previewModels(southwest, palette, spec("group=building.residential&seeds=1,2&fp=8x6,14x10&h=24"));
    expect(models.map((m) => m.label)).toEqual([
      "seed 1 · 8×6 · h 24",
      "seed 1 · 14×10 · h 24",
      "seed 2 · 8×6 · h 24",
      "seed 2 · 14×10 · h 24",
    ]);
    const roles = southwest.assets!["building.residential"]!.ramps;
    for (const m of models) {
      expect(m.error).toBeNull();
      const model = m.model!;
      expect([model.sx, model.sy]).toEqual(m.footprint);
      expect(model.count()).toBeGreaterThan(0);
      // its materials are the asset's ramps (wall, roof, window)
      const ramps = new Set(Object.values(roles).map((r) => palette.rampIds.get(r)));
      for (const id of model.materials.slice(1)) expect(ramps.has(id)).toBe(true);
    }
    // the same seed is the same model
    const again = previewModels(southwest, palette, spec("group=building.residential&seeds=1&fp=8x6&h=24"))[0]!.model!;
    expect(again.data).toEqual(models[0]!.model!.data);
    // capped
    expect(previewModels(southwest, palette, spec("seeds=1-100"))).toHaveLength(MAX_MODELS);
  });

  it("gives vehicles a size and vegetation only a seed", () => {
    expect(modelKind("vehicle.car.player")).toBe("vehicle");
    expect(modelKind("tree.conifer")).toBe("seed");
    expect(modelKind("prop.streetlight")).toBe("seed");
    expect(modelKind("landmark.tower.observation")).toBe("footprint");
    const palette = buildPalette(southwest);
    const bus = defaultVehicleSize("vehicle.bus");
    expect(bus.length).toBeGreaterThan(defaultVehicleSize("vehicle.car").length);
    const [b] = previewModels(southwest, palette, spec("group=vehicle.bus&seeds=4"));
    expect(b!.label).toBe(`seed 4 · ${bus.length}×${bus.width}×${bus.height}`);
    expect(b!.model!.sx).toBe(bus.length);
    const trees = previewModels(southwest, palette, spec("group=tree.conifer&seeds=1-3&fp=8x6,4x4"));
    expect(trees.map((t) => t.label)).toEqual(["seed 1", "seed 2", "seed 3"]);
  });

  it("previews a city pack's generators, also on another pack's group, and shows a generator's error", async () => {
    expect(hasGenerator("rowhouse")).toBe(false);
    const { reports, errors } = await registerWorkspacePlugins();
    expect(errors).toEqual([]);
    expect(reports.find((r) => r.name === "@pixelworlds/city-sf")?.generators).toContain("rowhouse");
    const [row] = previewModels(bayArea, buildPalette(bayArea), spec("style=bay-area&group=building.rowhouse.victorian&fp=6x16&h=30&hints=front:2"));
    expect(row!.error).toBeNull();
    expect(row!.model!.count()).toBeGreaterThan(100);
    // the Southwest's residential roles drawn by San Francisco's rowhouse generator
    expect(previewCatalog(southwest, "building.residential", "rowhouse")["building.residential"]).toMatchObject({
      generator: "rowhouse",
      ramps: southwest.assets!["building.residential"]!.ramps,
    });
    expect(previewCatalog(southwest, "building.residential", null)).toBe(southwest.assets);
    expect(() => previewCatalog(southwest, "no.such.group", null)).toThrow(/no asset for no.such.group/);
    const [missing] = previewModels(southwest, buildPalette(southwest), spec("generator=nope"));
    expect(missing!.model).toBeNull();
    expect(missing!.error).toMatch(/nope/);
  });

  it("builds the bake scene on a ground plate, and colours a baked image by a palette", () => {
    const palette = buildPalette(southwest);
    const model = previewModels(southwest, palette, spec("seeds=1"))[0]!.model!;
    const withGround = previewScene(model, 3);
    expect(withGround.meshes).toHaveLength(2);
    expect(withGround.meshes.every((m) => m.vertexCount > 0)).toBe(true);
    expect(previewScene(model, null).meshes).toHaveLength(1);
    // R = palette index, A = coverage
    const image: BakedImage = { left: 0, top: 0, width: 2, height: 1, depthBase: 0, pixels: Uint8Array.of(7, 0, 0, 255, 7, 0, 0, 0) };
    const night = buildPalette(southwest, "night");
    for (const p of [palette, night])
      expect([...paletteImage(image, p)]).toEqual([...p.rgba.subarray(28, 31), 255, 0, 0, 0, 0]);
  });
});
