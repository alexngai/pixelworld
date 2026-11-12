import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openWorld } from "../src/index";

/**
 * `openWorld` (D-111): a committed package's queries in Node, with no page,
 * canvas or GPU, as a game server would open it.
 */

const ROOT = new URL("../../../", import.meta.url);
const style = (id: string) => JSON.parse(readFileSync(new URL(`worlds/_styles/${id}/style.json`, ROOT), "utf8")) as object;

/** fixtures/ at https://pixelworld.test/, read from disk (Node's fetch can't read file: URLs). */
function serveFixtures(): void {
  vi.stubGlobal("fetch", async (url: string | URL) => {
    try {
      return new Response(readFileSync(new URL(`fixtures${new URL(String(url)).pathname}`, ROOT)));
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openWorld: a world's queries without a view (D-111)", () => {
  it("opens a package with no page, canvas or GPU, and answers as a view's queries do", async () => {
    serveFixtures();
    expect(globalThis.location).toBeUndefined();
    const { world, query } = await openWorld({ worldUrl: "southwest-fly/", base: "https://pixelworld.test/", style });
    expect(world.manifest.id).toBe("southwest-fly");
    expect([world.cellsX, world.cellsY]).toEqual([339, 219]);

    // the Grand Canyon: the South Rim at the village stands far over the river at Phantom Ranch
    const rim = query.lonLatToCell(-112.14, 36.057)!;
    const river = query.lonLatToCell(-112.0937, 36.1055)!;
    await query.ensure(Math.min(rim[0], river[0]) - 2, Math.min(rim[1], river[1]) - 2, Math.max(rim[0], river[0]) + 2, Math.max(rim[1], river[1]) + 2);
    expect(query.heightAt(rim[0], rim[1])).toBeGreaterThan(query.heightAt(river[0], river[1])!);
    expect(query.elevationAt(rim[0], rim[1])! - query.elevationAt(river[0], river[1])!).toBeGreaterThan(500);
    const [lon, lat] = query.cellToLonLat(rim[0], rim[1])!;
    expect(lon).toBeCloseTo(-112.14, 3);
    expect(lat).toBeCloseTo(36.057, 3);

    // occupancy: the placed objects the style draws
    const dam = query.landmarks().find((l) => l.id === "hoover-dam")!;
    await query.ensure(dam.x - 1, dam.y - 1, dam.x + 1, dam.y + 1);
    expect(query.objectsAt(dam.x, dam.y).map((o) => o.id)).toContain("hoover-dam");

    expect(() => query.pick(0, 0)).toThrow("pick needs a world view");
  });

  it("asks for an absolute URL or a base where there is no page", async () => {
    await expect(openWorld({ worldUrl: "/southwest-fly/", style })).rejects.toThrow(/"\/southwest-fly\/" is relative, and there is no page/);
  });
});
