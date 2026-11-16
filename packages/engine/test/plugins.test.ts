import { VoxelModel, registerGenerators, unregisterGenerators, type GenContext } from "@pixelworlds/generators";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginsKey, stylePlugins, viewPlugins } from "../src/plugins";
import type { PluginDescriptor } from "../src/types";

/** Which plugins a view loads (D-071): the option, or its answer to the names the style pack asks for. */

const city: PluginDescriptor = { name: "@pixelworlds/city-sf", url: "/assets/worker-sf.js" };
const extra: PluginDescriptor = { name: "my-props", url: new URL("https://cdn.example.test/props.js"), version: "2" };
const bayArea = { id: "bay-area", plugins: ["@pixelworlds/city-sf"] };

describe("a view's plugins", () => {
  vi.stubGlobal("location", { href: "https://pixelworld.test/viewer/?world=/sf/" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => warn.mockClear());

  it("reads the plugins a style pack names", () => {
    expect(stylePlugins(bayArea)).toEqual(["@pixelworlds/city-sf"]);
    expect(stylePlugins({ id: "desert-southwest" })).toEqual([]);
    expect(stylePlugins({ plugins: ["a", 3, null] })).toEqual(["a"]);
  });

  it("loads what it is given, with absolute URLs for the worker", () => {
    const p = viewPlugins([city, extra], bayArea, "bay-area");
    expect(p.descriptors).toEqual([city, extra]);
    expect(p.refs).toEqual([
      { name: "@pixelworlds/city-sf", url: "https://pixelworld.test/assets/worker-sf.js" },
      { name: "my-props", url: "https://cdn.example.test/props.js" },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("asks a function for the plugins the style names", () => {
    const known: Record<string, PluginDescriptor> = { [city.name]: city };
    const pick = vi.fn((names: string[]) => names.flatMap((n) => known[n] ?? []));
    expect(viewPlugins(pick, bayArea, "bay-area").descriptors).toEqual([city]);
    expect(pick).toHaveBeenCalledWith(["@pixelworlds/city-sf"]);
    expect(viewPlugins(pick, { id: "desert-southwest" }, "desert-southwest").descriptors).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when the style names a plugin the view doesn't load", () => {
    expect(viewPlugins(undefined, bayArea, "bay-area").refs).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^the style pack bay-area needs the plugin @pixelworlds\/city-sf, which this view didn't load/));
  });

  it("keys the tile cache by plugin, and not at all without plugins", async () => {
    const fetchText = async (url: string) => `export default definePlugin(/* ${url} */);`;
    expect(await pluginsKey([], fetchText)).toEqual([]);
    expect(await pluginsKey([extra, city], fetchText)).toEqual([
      expect.stringMatching(/^plugins:@pixelworlds\/city-sf#[0-9a-f]{8},my-props@2#[0-9a-f]{8}$/),
    ]);
  });
});

describe("a plugin's code in the tile cache key (D-072)", () => {
  vi.stubGlobal("location", { href: "https://pixelworld.test/viewer/" });
  const demo: PluginDescriptor = { name: "@pixelworlds/city-demo", url: "/src/worker.ts" };
  afterEach(() => void unregisterGenerators(demo.name));

  /** A dev server: each source module on its own URL, importing others; `?t=` stamps after a hot reload. */
  const server = (files: Record<string, string>) => {
    const fetched: string[] = [];
    const fetchText = async (url: string) => {
      fetched.push(url);
      const path = new URL(url).pathname;
      if (!(path in files)) throw new Error(`HTTP 404`);
      return files[path]!;
    };
    return { fetchText, fetched };
  };
  const SOURCES = {
    "/src/worker.ts": 'import { plugin } from "/src/plugin.ts";\nimport { definePlugin } from "/node_modules/.vite/deps/gen.js?v=1a2b";\nexport default definePlugin(plugin);',
    "/src/plugin.ts": 'import { adobe } from "./adobe.ts?t=1700000000000";\n// import { gone } from "./gone.ts"\nexport const plugin = { name: "demo", register: (api) => api.registerGenerators({ adobe }) };',
    "/src/adobe.ts": 'import { lot } from "../lib/lot.ts";\nexport const adobe = (ctx) => lot(ctx, 4);',
    "/lib/lot.ts": "export const lot = (ctx, h) => box(ctx.mask, h);",
  };
  const key = async (fetchText: (url: string) => Promise<string>) => (await pluginsKey([demo], fetchText))[0];
  const adobe = (ctx: GenContext) => new VoxelModel(1, 1, ctx.heightVox ?? 1);

  it("changes when a generator the plugin registered changes", async () => {
    const { fetchText } = server(SOURCES);
    registerGenerators({ adobe }, { source: demo.name });
    const before = await key(fetchText);
    expect(await key(fetchText)).toBe(before); // stable
    unregisterGenerators(demo.name);
    registerGenerators({ adobe: (ctx: GenContext) => new VoxelModel(2, 1, ctx.heightVox ?? 1) }, { source: demo.name });
    expect(await key(fetchText)).not.toBe(before);
  });

  it("follows the module's imports by URL, so an edit to a helper changes it too", async () => {
    registerGenerators({ adobe }, { source: demo.name });
    const { fetchText, fetched } = server(SOURCES);
    const before = await key(fetchText);
    // the module and what it imports from the same server: not npm's deps, not what a comment names
    expect(fetched.map((u) => new URL(u).pathname).sort()).toEqual(["/lib/lot.ts", "/src/adobe.ts", "/src/plugin.ts", "/src/worker.ts"]);
    expect(await key(server({ ...SOURCES, "/lib/lot.ts": "export const lot = (ctx, h) => box(ctx.mask, h + 1);" }).fetchText)).not.toBe(before);
    // a hot reload's timestamps alone change nothing
    const stamped = { ...SOURCES, "/src/plugin.ts": SOURCES["/src/plugin.ts"].replace("t=1700000000000", "t=1700000099999") };
    expect(await key(server(stamped).fetchText)).toBe(before);
    // a dependency from npm counts by its version, in the importer's URL
    expect(await key(server({ ...SOURCES, "/src/worker.ts": SOURCES["/src/worker.ts"].replace("v=1a2b", "v=9z9z") }).fetchText)).not.toBe(before);
  });

  it("is the same for the same build on another origin, so tiles prebaked on one host serve another (D-145)", async () => {
    registerGenerators({ adobe }, { source: demo.name });
    const { fetchText } = server(SOURCES);
    const here = await key(fetchText);
    vi.stubGlobal("location", { href: "http://localhost:4190/viewer/" });
    try {
      expect(await key(fetchText)).toBe(here);
    } finally {
      vi.stubGlobal("location", { href: "https://pixelworld.test/viewer/" });
    }
  });

  it("changes with the plugin's version, and keys a module it can't fetch by its URL", async () => {
    const { fetchText } = server({});
    const a = await key(fetchText);
    expect(a).toMatch(/^plugins:@pixelworlds\/city-demo#[0-9a-f]{8}$/);
    expect((await pluginsKey([{ ...demo, version: "2" }], fetchText))[0]).toMatch(/^plugins:@pixelworlds\/city-demo@2#/);
    expect((await pluginsKey([{ ...demo, url: "/src/other.ts" }], fetchText))[0]).not.toBe(a);
  });
});
