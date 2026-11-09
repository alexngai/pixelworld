import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginsKey, stylePlugins, viewPlugins } from "../src/plugins";
import type { PluginDescriptor } from "../src/types";

/** Which plugins a view loads (D-071): the option, or its answer to the names the style pack asks for. */

const city: PluginDescriptor = { name: "pixelworld-city-sf", url: "/assets/worker-sf.js" };
const extra: PluginDescriptor = { name: "my-props", url: new URL("https://cdn.example.test/props.js"), version: "2" };
const bayArea = { id: "bay-area", plugins: ["pixelworld-city-sf"] };

describe("a view's plugins", () => {
  vi.stubGlobal("location", { href: "https://pixelworld.test/viewer/?world=/sf/" });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => warn.mockClear());

  it("reads the plugins a style pack names", () => {
    expect(stylePlugins(bayArea)).toEqual(["pixelworld-city-sf"]);
    expect(stylePlugins({ id: "desert-southwest" })).toEqual([]);
    expect(stylePlugins({ plugins: ["a", 3, null] })).toEqual(["a"]);
  });

  it("loads what it is given, with absolute URLs for the worker", () => {
    const p = viewPlugins([city, extra], bayArea, "bay-area");
    expect(p.descriptors).toEqual([city, extra]);
    expect(p.refs).toEqual([
      { name: "pixelworld-city-sf", url: "https://pixelworld.test/assets/worker-sf.js" },
      { name: "my-props", url: "https://cdn.example.test/props.js" },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("asks a function for the plugins the style names", () => {
    const known: Record<string, PluginDescriptor> = { [city.name]: city };
    const pick = vi.fn((names: string[]) => names.flatMap((n) => known[n] ?? []));
    expect(viewPlugins(pick, bayArea, "bay-area").descriptors).toEqual([city]);
    expect(pick).toHaveBeenCalledWith(["pixelworld-city-sf"]);
    expect(viewPlugins(pick, { id: "desert-southwest" }, "desert-southwest").descriptors).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when the style names a plugin the view doesn't load", () => {
    expect(viewPlugins(undefined, bayArea, "bay-area").refs).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^the style pack bay-area needs the plugin pixelworld-city-sf, which this view didn't load/));
  });

  it("keys the tile cache by plugin, and not at all without plugins", () => {
    expect(pluginsKey([])).toEqual([]);
    expect(pluginsKey([extra, city])).toEqual(["plugins:my-props@2,pixelworld-city-sf"]);
  });
});
