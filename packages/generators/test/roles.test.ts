import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generatorIssues, type StylePack } from "@pixelworlds/style";
import { describe, expect, it } from "vitest";
import {
  KNOWN_PLUGIN_GENERATORS,
  MissingRoleError,
  listGenerators,
  VoxelModel,
  buildObjects,
  generateModel,
  objectVoxelScale,
  registerGenerators,
  unregisterGenerators,
  type AssetCatalog,
  type Generator,
} from "../src/index";

/** Roles (D-075): a generator asks for ramps by role, and a role the style asset lacks says which asset, generator and role. */

const SOURCE = "roles-test";
const house: Generator = ({ ramp, ramps }) => {
  const m = new VoxelModel(1, 1, 2);
  m.set(0, 0, 0, m.material(ramp("wall")));
  const doors = ramps("door"); // optional: none is fine
  m.set(0, 0, 1, m.material(doors[0] ?? ramp("roof")));
  return m;
};
const careless: Generator = ({ ramps }) => {
  const m = new VoxelModel(1, 1, 1);
  m.set(0, 0, 0, m.material(ramps("wall")[0]!)); // not checked: undefined when the asset has no wall
  return m;
};
registerGenerators({ testHouse: house, testCareless: careless }, { source: SOURCE });

const rampIds = new Map([
  ["stone", 1],
  ["clay", 2],
  ["oak", 3],
]);
const catalog: AssetCatalog = {
  "building.residential": { generator: "testHouse", ramps: { wall: "stone", "wall.red": "clay", roof: "clay" } },
  "building.shed": { generator: "testHouse", ramps: { roof: "oak", door: "oak" } },
  "building.barn": { generator: "testHouse", ramps: { wall: "brick", roof: "oak" } },
  "building.hut": { generator: "testCareless", ramps: { roof: "oak" } },
};

describe("roles", () => {
  it("draws with the roles an asset has, and treats ramps() of one it lacks as optional", () => {
    const m = generateModel(catalog, rampIds, "building.residential.terrace", { seed: 1 });
    expect(m.materials).toEqual([0, 1, 2]); // wall stone, no door: the roof's clay
  });

  it("names the asset, generator and role a model needs, and the roles the asset has", () => {
    const missing = () => generateModel(catalog, rampIds, "building.shed", { seed: 1 });
    expect(missing).toThrow(MissingRoleError);
    expect(missing).toThrow(
      `assets["building.shed"] has no ramp for the role 'wall', which its generator 'testHouse' draws with: ` +
        `add "wall": "<ramp>" to its "ramps" (it has roof, door)`,
    );
    try {
      missing();
    } catch (e) {
      expect(e).toMatchObject({ role: "wall", generator: "testHouse", asset: "building.shed" });
    }
  });

  it("says when a role names a ramp the palette doesn't have", () => {
    expect(() => generateModel(catalog, rampIds, "building.barn", { seed: 1 })).toThrow(
      `assets["building.barn"].ramps["wall"] names the ramp 'brick', which isn't in the palette (generator 'testHouse')`,
    );
  });

  it("names the asset in a world's bake too, as a contained failure (D-072)", () => {
    const opts = { catalog, rampIds, voxel: objectVoxelScale(1), voxelMeters: 1, heightStretch: 1, heightAt: () => 0 };
    const shed = { g: "building.shed.garden", x: 1, y: 1, s: 3, fp: [[0, 0], [1, 0], [1, 1], [0, 1]] as [number, number][], hm: 3 };
    // the bake goes on, the model drawn as a marker; its failure carries the role error
    const out = buildObjects([shed], opts);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]!.group).toBe("building.shed.garden");
    expect(out.failures[0]!.error).toMatch(/assets\["building\.shed"\] has no ramp for the role 'wall'/);
  });

  it("refuses a material that isn't a ramp id, rather than drawing in no colour", () => {
    expect(() => generateModel(catalog, rampIds, "building.hut", { seed: 1 })).toThrow(
      /VoxelModel\.material\(undefined\): not a ramp id\. Was it ctx\.ramps\(role\)\[0\] for a role the style asset doesn't have\?/,
    );
    expect(() => new VoxelModel(1, 1, 1).material(-1)).toThrow(/not a ramp id/);
    expect(new VoxelModel(1, 1, 1).material(0)).toBe(1);
  });

  it("every committed pack names generators that are built in or come with a plugin it names", () => {
    const root = fileURLToPath(new URL("../../../worlds/_styles/", import.meta.url));
    const ids = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(ids.length).toBeGreaterThan(1);
    for (const id of ids) {
      const pack = JSON.parse(readFileSync(`${root}${id}/style.json`, "utf8")) as StylePack;
      const fromPlugins = Object.entries(KNOWN_PLUGIN_GENERATORS).filter(([, plugin]) => pack.plugins?.includes(plugin));
      const known = [...listGenerators().map((g) => g.name), ...fromPlugins.map(([name]) => name)];
      expect(generatorIssues(pack, known), id).toEqual([]);
    }
  });

  it("cleans up", () => {
    expect(unregisterGenerators(SOURCE).sort()).toEqual(["testCareless", "testHouse"]);
  });
});
