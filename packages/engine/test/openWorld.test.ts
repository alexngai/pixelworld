import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openWorld } from "../src/index";
import { loadWorld, worldQuery } from "../src/world";

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

  it("loads placed objects by chunk with their terrain, and answers as the whole objects file does (D-123)", async () => {
    serveFixtures();
    const { world, query, stats } = await openWorld({ worldUrl: "https://pixelworld.test/southwest-fly/", style });
    const whole = await loadWorld({ worldUrl: "https://pixelworld.test/southwest-fly/", style });
    const wholeQuery = worldQuery(whole, null);
    expect(world.objectCount).toBe(whole.objects!.instances.length);
    expect(query.landmarks()).toEqual(wholeQuery.landmarks());
    // nothing loaded: no objects but the landmarks (whose ground isn't loaded either)
    const somewhere = whole.objects!.instances.find((i) => !i.id)!;
    expect(query.objectsAt(somewhere.x, somewhere.y)).toEqual([]);
    await Promise.all([query.ensure(0, 0, world.cellsX, world.cellsY), wholeQuery.ensure(0, 0, world.cellsX, world.cellsY)]);
    expect(stats().chunksLoaded).toBe(stats().chunksTotal);
    const key = (h: { group: string; x: number; y: number; base: number | null; top: number | null }) => `${h.group} ${h.x} ${h.y} ${h.base} ${h.top}`;
    let hits = 0;
    // at every object's anchor, and just inside each footprint's corners
    for (const inst of whole.objects!.instances) {
      const points = [[inst.x, inst.y], ...(inst.fp ?? []).map(([x, y]) => [x + (inst.x - x) * 0.01, y + (inst.y - y) * 0.01])];
      for (const [x, y] of points) {
        const a = query.objectsAt(x!, y!).map(key).sort();
        expect(a).toEqual(wholeQuery.objectsAt(x!, y!).map(key).sort());
        hits += a.length;
      }
    }
    expect(hits).toBeGreaterThan(3000);
  });

  it("gives coarse heights everywhere, loaded or not, which hold the drawn ground and water between them (D-123)", async () => {
    serveFixtures();
    const { world, query } = await openWorld({ worldUrl: "https://pixelworld.test/southwest-fly/", style });
    const far = query.coarseHeightAt(world.cellsX - 3, world.cellsY - 3)!;
    expect(query.heightAt(world.cellsX - 3, world.cellsY - 3)).toBeNull(); // not loaded, but the coarse heights are there
    expect(far.lo).toBeLessThanOrEqual(far.hi);
    await query.ensure(0, 0, world.cellsX, world.cellsY);
    let n = 0;
    for (let y = 0.25; y < world.cellsY; y += 1.7)
      for (let x = 0.25; x < world.cellsX; x += 1.3) {
        const c = query.coarseHeightAt(x, y)!;
        const g = query.heightAt(x, y)!;
        const w = query.surfaceAt(x, y)!.waterLevel;
        expect(g).toBeGreaterThanOrEqual(c.lo - 1e-9);
        expect(Math.max(g, w ?? -Infinity)).toBeLessThanOrEqual(c.hi + 1e-9);
        n++;
      }
    expect(n).toBeGreaterThan(30_000);
    expect(query.coarseHeightAt(-1, 0)).toBeNull();
  });
});

