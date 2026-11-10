import { afterEach, describe, expect, it, vi } from "vitest";
import { openTileCache, resolveStyle, tileCacheKey, type LoadedWorld } from "../src/world";
import type { TileStore } from "../src/types";

describe("loading a world for a view", () => {
  it("names the style pack when the app's resolver fails, and what an HTML answer means (D-072)", async () => {
    // (resolving and checking a pack that loads: styles.test.ts, D-075)
    // a resolver that fetched the pack from a wrong URL and parsed the dev server's index.html
    const fetched = async () => JSON.parse("<!doctype html><html></html>") as object;
    await expect(resolveStyle(fetched, "bay-area")).rejects.toThrow(
      /^style pack "bay-area" \(from your style resolver\): SyntaxError: .*\(it got an HTML page, not JSON: is the pack's URL right\?\)$/,
    );
    await expect(
      resolveStyle(() => {
        throw new Error("no style pack bay-aera");
      }, "bay-area"),
    ).rejects.toThrow('style pack "bay-area" (from your style resolver): no style pack bay-aera');
  });
});

describe("the tile cache key (D-072)", () => {
  const world = {
    manifest: { id: "sf", packageHash: "p1" },
    styleJson: { id: "bay-area", ramps: { marker: ["#000000"] }, atmosphere: { fog: 1 } },
    objects: { instances: [] },
    renderScale: 1,
    scaleOverridden: false,
  } as unknown as LoadedWorld;
  const tile = { rotation: 1, tx: 2, ty: 3 } as const;
  const plugins = ["plugins:@pixelworlds/city-sf#0badc0de"];
  const key = (w = world, p = plugins, code: string | null = "c0de") => tileCacheKey(w, p, code)(tile);

  it("is the same for the same world, style, bake code and plugins", () => {
    expect(key()).toBe(key());
    expect(key()).toMatch(/^sf\|p1\|[0-9a-f]{8}\|bake:c0de\|objects\|plugins:@pixelworlds\/city-sf#0badc0de\|1:2,3$/);
    // the fog is drawn over tiles, never into them
    expect(key({ ...world, styleJson: { ...world.styleJson, atmosphere: { fog: 2 } } } as LoadedWorld)).toBe(key());
  });

  it("changes with the bake code's identity: a generator, the baker, its shaders, the bake pipeline", () => {
    expect(key(world, plugins, "c0de2")).not.toBe(key());
    expect(key(world, plugins, null)).toContain("|bake:unknown|");
  });

  it("changes with a plugin's code, and with the package, the style and the tile", () => {
    expect(key(world, ["plugins:@pixelworlds/city-sf#feedface"])).not.toBe(key());
    expect(key(world, [])).not.toBe(key());
    expect(key({ ...world, manifest: { id: "sf", packageHash: "p2" } } as LoadedWorld)).not.toBe(key());
    expect(key({ ...world, styleJson: { ...world.styleJson, ramps: { marker: ["#111111"] } } } as LoadedWorld)).not.toBe(key());
    expect(tileCacheKey(world, plugins, "c0de")({ rotation: 1, tx: 2, ty: 4 })).not.toBe(key());
  });
});

describe("the persistent tile cache", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  afterEach(() => info.mockClear());

  it("is off without the bake code's identity, which keeps old tiles from showing after a code change", async () => {
    expect(await openTileCache(undefined, null)).toBeNull();
    expect(await openTileCache(true, null)).toBeNull();
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/^pixelworld: no tiles are kept in IndexedDB: .*no bake code identity/));
  });

  it("is what the app asks for otherwise", async () => {
    const own = { get: async () => null, put: async () => {}, writes: 0 } as unknown as TileStore;
    expect(await openTileCache(false, "c0de")).toBeNull();
    expect(await openTileCache(own, null)).toBe(own);
    expect(await openTileCache(undefined, "c0de")).toBeNull(); // IndexedDB, where there is one (not in node)
    expect(info).not.toHaveBeenCalled();
  });
});
