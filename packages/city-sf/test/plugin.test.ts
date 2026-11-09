import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KNOWN_PLUGIN_GENERATORS, hasGenerator, listGenerators, loadPlugin, type AssetCatalog } from "@pixelworld/generators";
import { describe, expect, it } from "vitest";
import { PLUGIN_NAME, cityPlugin, plugin, register, sfGenerators } from "../src/index";

/** The city pack as a plugin (D-071): its worker module, its main-thread register(), and the style that needs it. */

const bayArea = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../worlds/_styles/bay-area/style.json", import.meta.url)), "utf8"),
) as { plugins?: string[]; assets: AssetCatalog };

describe("pixelworld-city-sf", () => {
  it("is the plugin core names for San Francisco's generators", () => {
    expect(PLUGIN_NAME).toBe("pixelworld-city-sf");
    const known = Object.entries(KNOWN_PLUGIN_GENERATORS).filter(([, p]) => p === PLUGIN_NAME).map(([g]) => g);
    expect(Object.keys(sfGenerators()).sort()).toEqual(known.sort());
    expect(cityPlugin.name).toBe(PLUGIN_NAME);
    expect(typeof cityPlugin.url).toBe("string");
  });

  it("registers through its worker module, as a bake worker loads it", async () => {
    for (const g of Object.keys(sfGenerators())) expect(hasGenerator(g), g).toBe(false);
    const report = await loadPlugin({ name: PLUGIN_NAME, url: "https://example.test/worker-sf.js" }, () => import("../src/worker"));
    expect(report).toEqual({ name: PLUGIN_NAME, generators: Object.keys(sfGenerators()).sort() });
    for (const g of Object.keys(sfGenerators())) expect(listGenerators().find((e) => e.name === g)?.source).toBe(PLUGIN_NAME);
    expect(await register()).toBe(report); // registered once per realm, whichever way
    expect((await import("../src/worker")).default).toBe(plugin);
  });

  it("covers every generator the bay-area pack names that core doesn't", () => {
    expect(bayArea.plugins).toEqual([PLUGIN_NAME]);
    for (const a of Object.values(bayArea.assets)) expect(hasGenerator(a.generator), a.generator).toBe(true);
  });
});
