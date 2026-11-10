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
  it("starts with the built-ins, and none of San Francisco's", () => {
    const list = listGenerators();
    expect(list.map((g) => g.name)).toEqual([...list.map((g) => g.name)].sort());
    for (const name of Object.keys(builtinGenerators())) {
      expect(hasGenerator(name)).toBe(true);
      expect(list.find((g) => g.name === name)?.source).toBe(BUILTIN_SOURCE);
    }
    for (const name of ["building", "cityBlocks", "conifer", "dam", "suspensionBridge", "car", "cableCar", "streetcar"])
      expect(hasGenerator(name), name).toBe(true);
    for (const name of Object.keys(KNOWN_PLUGIN_GENERATORS)) expect(hasGenerator(name), name).toBe(false);
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
    expect(() => registerGenerator("building", dot, { source: "b" })).toThrow(/by @pixelworlds\/generators/);
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
    const sf = pack("bay-area");
    const mask = { sx: 6, sy: 10, on: new Uint8Array(60).fill(1) };
    const ids = new Map(Object.keys(sf.ramps).map((name, i) => [name, i + 1]));
    let err: unknown;
    try {
      generateModel(sf.assets, ids, "building.rowhouse.victorian", { seed: 1, mask, heightVox: 12 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MissingGeneratorError);
    const e = err as MissingGeneratorError;
    expect([e.generator, e.group, e.plugin]).toEqual(["rowhouse", "building.rowhouse.victorian", "@pixelworlds/city-sf"]);
    expect(e.message).toMatch(/no generator named 'rowhouse' \(asked for by building\.rowhouse\.victorian\)/);
    expect(e.message).toMatch(/comes with the plugin @pixelworlds\/city-sf.*createWorldView\(\{ plugins \}\)/);
  });

  it("lists what is registered when no known plugin has the generator", () => {
    const e = new MissingGeneratorError("adobe", "building.residential.adobe");
    expect(e.plugin).toBeNull();
    expect(e.message).toMatch(/No plugin known here provides it/);
    expect(e.message).toMatch(/Registered generators: .*building, .*cityBlocks/);
  });

  it("fails a model that needs a missing generator with that error, not the whole bake (D-072)", () => {
    const voxel = objectVoxelScale(1);
    const opts = { catalog, rampIds, voxel, voxelMeters: 1, heightStretch: 1, heightAt: () => 0 };
    const fp: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const out = buildObjects([{ g: "thing.dot", x: 0.5, y: 0.5, s: 1, fp }], opts);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]!.error).toMatch(/^MissingGeneratorError: no generator named 'testDot' \(asked for by thing\.dot\)/);
    expect(out.merged.vertexCount).toBeGreaterThan(0); // its missing-model marker
  });
});

describe("style packs and plugins", () => {
  const named = (p: { assets: AssetCatalog }) => new Set(Object.values(p.assets).map((a) => a.generator));

  it("the Southwest needs only built-in generators, and names no plugin", () => {
    const sw = pack("desert-southwest");
    expect(sw.plugins).toBeUndefined();
    for (const g of named(sw)) expect(hasGenerator(g), g).toBe(true);
  });

  it("the bay-area pack names the city pack its other generators come with", () => {
    const sf = pack("bay-area");
    expect(sf.plugins).toEqual(["@pixelworlds/city-sf"]);
    const missing = [...named(sf)].filter((g) => !hasGenerator(g)).sort();
    const fromSf = Object.keys(KNOWN_PLUGIN_GENERATORS).filter((g) => KNOWN_PLUGIN_GENERATORS[g] === "@pixelworlds/city-sf");
    expect(missing).toEqual(fromSf.sort());
  });

  it("the new-york pack names both city packs, and every generator it needs comes with one of them", () => {
    const ny = pack("new-york");
    expect(ny.plugins).toEqual(["@pixelworlds/city-sf", "@pixelworlds/city-nyc"]);
    const missing = [...named(ny)].filter((g) => !hasGenerator(g));
    for (const g of missing) expect(ny.plugins, g).toContain(KNOWN_PLUGIN_GENERATORS[g]);
    expect(missing).toEqual(expect.arrayContaining(["brownstone", "tenement", "castIronLoft", "prewarBlock", "block", "sfTower"]));
  });
});
