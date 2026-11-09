import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_SOURCE,
  GeneratorRegistryError,
  KNOWN_PLUGIN_GENERATORS,
  MissingGeneratorError,
  VoxelModel,
  buildObjects,
  builtinGenerators,
  generateModel,
  getGenerator,
  hasGenerator,
  listGenerators,
  objectVoxelScale,
  registerGenerator,
  registerGenerators,
  unregisterGenerators,
  type AssetCatalog,
  type Generator,
} from "../src/index";

/** The generator registry (D-071): built-ins, registration by source, and errors that say what to load. */

const pack = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../worlds/_styles/${name}/style.json`, import.meta.url)), "utf8")) as {
    assets: AssetCatalog;
    ramps: Record<string, string[]>;
    plugins?: string[];
  };

const dot: Generator = ({ ramp }) => {
  const m = new VoxelModel(1, 1, 1);
  m.set(0, 0, 0, m.material(ramp("body")));
  return m;
};
const catalog: AssetCatalog = { "thing.dot": { generator: "testDot", ramps: { body: "stone" } } };
const rampIds = new Map([["stone", 1]]);

describe("the generator registry", () => {
  it("starts with the built-ins", () => {
    const list = listGenerators();
    expect(list.map((g) => g.name)).toEqual([...list.map((g) => g.name)].sort());
    for (const name of Object.keys(builtinGenerators())) {
      expect(hasGenerator(name)).toBe(true);
      expect(list.find((g) => g.name === name)?.source).toBe(BUILTIN_SOURCE);
    }
    for (const name of ["building", "cityBlocks", "conifer", "dam", "suspensionBridge", "car", "cableCar", "streetcar"])
      expect(hasGenerator(name), name).toBe(true);
  });

  it("registers generators under a source, and generates with them", () => {
    expect(() => generateModel(catalog, rampIds, "thing.dot", { seed: 1 })).toThrow(MissingGeneratorError);
    expect(registerGenerators({ testDot: dot }, { source: "test-pack" })).toEqual(["testDot"]);
    expect(listGenerators().find((g) => g.name === "testDot")).toEqual({ name: "testDot", source: "test-pack" });
    expect(generateModel(catalog, rampIds, "thing.dot.big", { seed: 1 }).count()).toBe(1);
    expect(getGenerator("testDot")).toBe(dot);
    expect(unregisterGenerators("test-pack")).toEqual(["testDot"]);
    expect(hasGenerator("testDot")).toBe(false);
  });

  it("lets a source register again, but not take another source's name", () => {
    const other: Generator = (ctx) => dot(ctx);
    registerGenerator("testDot", dot, { source: "a" });
    registerGenerator("testDot", other, { source: "a" }); // the same source again (a hot reload): replaced
    expect(getGenerator("testDot")).toBe(other);
    registerGenerator("testDot", other, { source: "b" }); // the same function: nothing to do
    expect(() => registerGenerator("testDot", dot, { source: "b" })).toThrow(GeneratorRegistryError);
    expect(() => registerGenerator("testDot", dot, { source: "b" })).toThrow(/already registered by a, so b can't/);
    expect(() => registerGenerator("building", dot, { source: "b" })).toThrow(/by @pixelworld\/generators/);
    registerGenerator("testDot", dot, { source: "b", replace: true });
    expect(listGenerators().find((g) => g.name === "testDot")?.source).toBe("b");
    unregisterGenerators("b");
  });

  it("registers nothing when one entry is bad", () => {
    expect(() =>
      registerGenerators({ testOk: dot, testBad: "nope" as unknown as Generator }, { source: "bad-pack" }),
    ).toThrow(/testBad.*not a function/);
    expect(hasGenerator("testOk")).toBe(false);
  });

  it("names the plugin a missing generator comes with", () => {
    const e = new MissingGeneratorError("rowhouse", "building.rowhouse.victorian");
    expect([e.generator, e.group, e.plugin]).toEqual(["rowhouse", "building.rowhouse.victorian", KNOWN_PLUGIN_GENERATORS.rowhouse]);
    expect(e.message).toMatch(/no generator named 'rowhouse' \(asked for by building\.rowhouse\.victorian\)/);
    expect(e.message).toMatch(/comes with the plugin pixelworld-city-sf/);
  });

  it("lists what is registered when no known plugin has the generator", () => {
    const e = new MissingGeneratorError("brownstone", "building.rowhouse.brownstone");
    expect(e.plugin).toBeNull();
    expect(e.message).toMatch(/No plugin known here provides it/);
    expect(e.message).toMatch(/Registered generators: .*building, .*cityBlocks/);
  });

  it("fails a bake that needs a missing generator with that error", () => {
    const voxel = objectVoxelScale(1);
    const opts = { catalog, rampIds, voxel, voxelMeters: 1, heightStretch: 1, heightAt: () => 0 };
    const fp: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    expect(() => buildObjects([{ g: "thing.dot", x: 0.5, y: 0.5, s: 1, fp }], opts)).toThrow(
      /no generator named 'testDot' \(asked for by thing\.dot\)/,
    );
  });
});

describe("style packs and plugins", () => {
  const named = (p: { assets: AssetCatalog }) => new Set(Object.values(p.assets).map((a) => a.generator));

  it("the Southwest needs only built-in generators, and names no plugin", () => {
    const sw = pack("desert-southwest");
    expect(sw.plugins).toBeUndefined();
    for (const g of named(sw)) expect(hasGenerator(g), g).toBe(true);
  });
});
