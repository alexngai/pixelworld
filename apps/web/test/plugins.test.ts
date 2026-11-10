import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CITY_PACKS, viewerPlugins } from "../src/plugins";

/** The viewer's city packs (src/plugins.ts, D-074): what it loads for the plugins a style pack names. */

const STYLES = fileURLToPath(new URL("../../../worlds/_styles/", import.meta.url));
const stylePlugins = (id: string) =>
  (JSON.parse(readFileSync(`${STYLES}${id}/style.json`, "utf8")) as { plugins?: string[] }).plugins ?? [];

describe("the viewer's city packs", () => {
  afterEach(() => void vi.restoreAllMocks());

  it("loads San Francisco's for the bay-area pack, and nothing for the Southwest", () => {
    expect(viewerPlugins(stylePlugins("bay-area")).map((p) => p.name)).toEqual(["@pixelworlds/city-sf"]);
    expect(viewerPlugins(stylePlugins("desert-southwest"))).toEqual([]);
  });

  it("has every plugin a style pack in the repository names", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const id of readdirSync(STYLES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
      const names = stylePlugins(id);
      expect(viewerPlugins(names).map((p) => p.name), id).toEqual(names);
    }
    expect(warn).not.toHaveBeenCalled();
    expect(new Set(CITY_PACKS.map((p) => p.name)).size).toBe(CITY_PACKS.length);
  });

  it("warns once about a plugin it doesn't have, naming where to add it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nyc = { name: "@my-org/city-nyc", url: "https://example.test/worker.js" };
    expect(viewerPlugins(["@my-org/city-nyc"])).toEqual([]);
    expect(viewerPlugins(["@my-org/city-nyc"])).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/no city pack @my-org\/city-nyc in apps\/web\/src\/plugins\.ts; add it to CITY_PACKS/);
    expect(viewerPlugins(["@my-org/city-nyc"], [...CITY_PACKS, nyc])).toEqual([nyc]);
  });
});
