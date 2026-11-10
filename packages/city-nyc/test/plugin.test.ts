import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KNOWN_PLUGIN_GENERATORS, hasGenerator, listGenerators, loadPlugin, type AssetCatalog } from "pixelworld/generators";
import { describe, expect, it } from "vitest";
import { register as registerSf } from "@pixelworlds/city-sf";
import { PLUGIN_NAME, cityPlugin, nycGenerators, plugin, register } from "../src/index";

/** The city pack as a plugin (D-071, D-081): its worker module, its main-thread register(), and the style that needs it. */

const newYork = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../worlds/_styles/new-york/style.json", import.meta.url)), "utf8"),
) as { plugins?: string[]; assets: AssetCatalog };

describe("@pixelworlds/city-nyc", () => {
  it("is the plugin core names for New York's generators", () => {
    expect(PLUGIN_NAME).toBe("@pixelworlds/city-nyc");
    const known = Object.entries(KNOWN_PLUGIN_GENERATORS).filter(([, p]) => p === PLUGIN_NAME).map(([g]) => g);
    expect(Object.keys(nycGenerators()).sort()).toEqual(known.sort());
    expect(cityPlugin.name).toBe(PLUGIN_NAME);
    expect(typeof cityPlugin.url).toBe("string");
  });

  it("registers through its worker module, as a bake worker loads it", async () => {
    for (const g of Object.keys(nycGenerators())) expect(hasGenerator(g), g).toBe(false);
    const report = await loadPlugin({ name: PLUGIN_NAME, url: "https://example.test/worker-nyc.js" }, () => import("../src/worker"));
    expect(report).toEqual({ name: PLUGIN_NAME, generators: Object.keys(nycGenerators()).sort() });
    for (const g of Object.keys(nycGenerators())) expect(listGenerators().find((e) => e.name === g)?.source).toBe(PLUGIN_NAME);
    expect(await register()).toBe(report); // registered once per realm, whichever way
    const mod = await import("../src/worker");
    expect([mod.default, mod.name, mod.register]).toEqual([plugin, PLUGIN_NAME, plugin.register]);
  });

  it("registers through a registry's API it is handed", async () => {
    const got: string[] = [];
    const api = { apiVersion: 1, hasGenerator: () => false, registerGenerators: (r: object) => void got.push(...Object.keys(r)) };
    await register(api);
    expect(got.sort()).toEqual(Object.keys(nycGenerators()).sort());
  });

  it("with San Francisco's, covers every generator the new-york pack names that core doesn't", async () => {
    expect(newYork.plugins).toEqual(["@pixelworlds/city-sf", PLUGIN_NAME]);
    await registerSf();
    for (const a of Object.values(newYork.assets)) expect(hasGenerator(a.generator), a.generator).toBe(true);
  });
});
