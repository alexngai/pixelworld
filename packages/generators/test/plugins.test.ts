import { describe, expect, it, vi } from "vitest";
import {
  PluginError,
  VoxelModel,
  definePlugin,
  getGenerator,
  hasGenerator,
  listGenerators,
  loadPlugin,
  registerPlugin,
  registeredPlugins,
  unregisterPlugin,
  type Generator,
  type Plugin,
} from "../src/index";

/**
 * Plugins (D-071): what a realm (the main thread, a bake worker) does to
 * register a plugin it is given by URL. The importers here stand in for
 * `import(url)`: a bundled worker module may lose its exports, or carry its
 * own copy of @pixelworld/generators.
 */

const one: Generator = () => {
  const m = new VoxelModel(1, 1, 1);
  m.set(0, 0, 0, m.material(1));
  return m;
};

function samplePlugin(name: string, generators: Record<string, Generator> = { [`${name}Gen`]: one }): Plugin {
  return { name, register: (api) => api.registerGenerators(generators) };
}

describe("plugins", () => {
  it("registers a plugin once per realm, under its name", async () => {
    const plugin = samplePlugin("plugin-a");
    const spy = vi.spyOn(plugin, "register");
    const report = await registerPlugin(plugin);
    expect(report).toEqual({ name: "plugin-a", generators: ["plugin-aGen"] });
    expect(listGenerators().find((g) => g.name === "plugin-aGen")?.source).toBe("plugin-a");
    // again, or the same plugin from another copy of its package: nothing more
    expect(await registerPlugin(plugin)).toBe(report);
    expect(await registerPlugin(samplePlugin("plugin-a"))).toBe(report);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(registeredPlugins()).toContain("plugin-a");
    unregisterPlugin("plugin-a");
    expect(hasGenerator("plugin-aGen")).toBe(false);
  });

  it("finds what a module announced, when its exports were dropped (Vite's worker bundles)", async () => {
    const importer = vi.fn(async () => {
      definePlugin(samplePlugin("plugin-b")); // the module's top level
      return {}; // no exports
    });
    const ref = { name: "plugin-b", url: "https://example.test/assets/worker-b.js" };
    const report = await loadPlugin(ref, importer);
    expect(report.generators).toEqual(["plugin-bGen"]);
    expect(hasGenerator("plugin-bGen")).toBe(true);
    expect(await loadPlugin(ref, importer)).toBe(report); // once per URL
    expect(importer).toHaveBeenCalledTimes(1);
    unregisterPlugin("plugin-b");
  });

  it("takes a module's default export", async () => {
    const plugin = samplePlugin("plugin-c");
    const report = await loadPlugin({ name: "plugin-c", url: "https://example.test/c.js" }, async () => ({ default: plugin }));
    expect(report.name).toBe("plugin-c");
    unregisterPlugin("plugin-c");
  });

  it("registers into the loader's registry, not the plugin's own copy of the package", async () => {
    // a plugin bundled with its own @pixelworld/generators: a second instance of the package
    vi.resetModules();
    const copy = (await import("../src/index")) as typeof import("../src/index");
    expect(copy.definePlugin).not.toBe(definePlugin);
    await loadPlugin({ name: "plugin-d", url: "https://example.test/d.js" }, async () => {
      copy.definePlugin(samplePlugin("plugin-d"));
      return {};
    });
    expect(hasGenerator("plugin-dGen")).toBe(true); // here, where the loader runs
    expect(copy.hasGenerator("plugin-dGen")).toBe(false); // the copy's registry is left alone
    unregisterPlugin("plugin-d");
  });

  it("says what went wrong", async () => {
    const url = "https://example.test/e.js";
    await expect(loadPlugin({ name: "plugin-e", url }, async () => ({}))).rejects.toThrow(
      `${url} defines no plugin: the module must call definePlugin`,
    );
    await expect(
      loadPlugin({ name: "plugin-e", url: "https://example.test/e2.js" }, async () => ({ default: samplePlugin("other") })),
    ).rejects.toThrow("defines the plugin other, not plugin-e");
    await expect(
      loadPlugin({ name: "plugin-e", url: "https://example.test/e3.js" }, () => Promise.reject(new Error("404"))),
    ).rejects.toThrow(PluginError);
    await expect(
      loadPlugin({ name: "plugin-e", url: "https://example.test/e4.js" }, () => Promise.reject(new Error("404"))),
    ).rejects.toThrow("plugin plugin-e (https://example.test/e4.js) failed to import: 404");
    // a failed load isn't kept: the same URL can be tried again
    const report = await loadPlugin({ name: "plugin-e", url }, async () => ({ default: samplePlugin("plugin-e") }));
    expect(report.generators).toEqual(["plugin-eGen"]);
    unregisterPlugin("plugin-e");
  });

  it("reports a plugin whose registration clashes, and can register it later", async () => {
    const clash = samplePlugin("plugin-f", { building: one });
    await expect(registerPlugin(clash)).rejects.toThrow(
      /plugin plugin-f failed to register: generator 'building' is already registered by @pixelworld\/generators/,
    );
    expect(getGenerator("building")).not.toBe(one);
    const fixed = samplePlugin("plugin-f", { plugin_fBuilding: one });
    expect((await registerPlugin(fixed)).generators).toEqual(["plugin_fBuilding"]);
    unregisterPlugin("plugin-f");
  });

  it("rejects something that isn't a plugin", () => {
    expect(() => definePlugin({ name: "x" } as unknown as Plugin)).toThrow(PluginError);
  });
});
