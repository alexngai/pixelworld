import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fogSampler, openWorld } from "../src/index";

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

  it("takes a Presidio building out of San Francisco's level, freeing its cells, and puts it back (D-124)", async () => {
    serveFixtures();
    const { query, edits } = await openWorld({ worldUrl: "sf/", base: "https://pixelworld.test/", style });
    // the Presidio, from Baker Beach to Crissy Field (Fogfront's play area)
    await query.ensure(118, 168, 250, 250);
    const cells = (index: number) => {
      const out: string[] = [];
      for (let y = 168; y < 250; y++) for (let x = 118; x < 250; x++) if (query.objectsAt(x + 0.5, y + 0.5).some((o) => o.index === index)) out.push(`${x},${y}`);
      return out;
    };
    let building = null;
    for (let y = 168; y < 250 && !building; y++)
      for (let x = 118; x < 250 && !building; x++) building = query.objectsAt(x + 0.5, y + 0.5).find((o) => o.group.startsWith("building") && o.footprint) ?? null;
    expect(building).not.toBeNull();
    const at = cells(building!.index);
    expect(at.length).toBeGreaterThan(0);
    expect(edits.remove([building!.index])).toEqual({ op: "remove", objects: [building!.index] });
    expect(cells(building!.index)).toEqual([]);
    const [x, y] = at[0]!.split(",").map(Number);
    expect(query.objectsAt(x! + 0.5, y! + 0.5).some((o) => o.index === building!.index)).toBe(false);
    edits.restore();
    expect(cells(building!.index)).toEqual(at);
  });

  it("asks for an absolute URL or a base where there is no page", async () => {
    await expect(openWorld({ worldUrl: "/southwest-fly/", style })).rejects.toThrow(/"\/southwest-fly\/" is relative, and there is no page/);
  });

  it("gives the style's fog as a number, as the fog layer draws it: in its areas, under its ceiling, drifting (D-125)", async () => {
    serveFixtures();
    const { world, query } = await openWorld({ worldUrl: "sf/", base: "https://pixelworld.test/", style });
    const fog = fogSampler(world, query)!;
    expect(fog).not.toBeNull();
    // the Golden Gate, low: fog; the same place over the ceiling, and downtown: none
    const [gx, gy] = query.lonLatToCell(-122.478, 37.81)!;
    const [dx, dy] = query.lonLatToCell(-122.4, 37.788)!;
    const at = (t: number) => fog.at(gx, gy, 0, t);
    expect(at(0)).toBeGreaterThan(0.1);
    expect(fog.at(gx, gy, fog.ceiling + 1, 0)).toBe(0);
    expect(fog.at(dx, dy, 0, 0)).toBe(0);
    // the patches drift: the same place thickens and thins over a few minutes
    const over = Array.from({ length: 60 }, (_, k) => at(k * 10));
    expect(Math.max(...over) - Math.min(...over)).toBeGreaterThan(0.1);
    // no fog in a world whose style has none
    const desert = await openWorld({ worldUrl: "southwest-fly/", base: "https://pixelworld.test/", style });
    expect(fogSampler(desert.world, desert.query)).toBeNull();
  });
});
