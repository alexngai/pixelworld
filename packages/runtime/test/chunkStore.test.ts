import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_WATER, TerrainGrid, emptyMicro } from "@pixelworlds/grid";
import { DRAW_ONLY_LAYERS, encodeChunk, type WorldManifest } from "@pixelworlds/world-format";
import { ChunkStore, loadManifest, loadObjects } from "../src/chunkStore";
import { loadWorld } from "../src/world";

/**
 * Loading a world package with a wrong `worldUrl` or missing files (D-072):
 * every error names the URL and what was expected, never just a parser's
 * "Unexpected token '<'" or "HTTP 404".
 */

const INDEX_HTML = "<!doctype html>\n<html><body><div id=app></div></body></html>";

/** A server: path → response; anything else is Vite's answer to an unknown path, its index.html. */
function serve(files: Record<string, () => Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
      return files[path]?.() ?? new Response(INDEX_HTML, { headers: { "content-type": "text/html" } });
    }),
  );
}

const manifest = {
  format: "pixelworld-world",
  formatVersion: 0,
  id: "tiny",
  name: "Tiny",
  style: "desert-southwest",
  chunkSize: 4,
  cellsX: 4,
  cellsY: 4,
  chunks: [{ x: 0, y: 0, path: "chunks/0_0.bin.gz", sha256: "0123456789abcdef0123" }],
  scale: { metersPerStep: 10, metersPerCell: 100, elevationDatumMeters: 0 },
  surfaces: {},
  attribution: [],
  objects: { path: "objects.json.gz" },
};
const json = (v: unknown) => () => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });

describe("loading a world package", () => {
  afterEach(() => void vi.unstubAllGlobals());

  it("says a wrong worldUrl is not a world package, behind a server that answers with its index.html", async () => {
    serve({});
    await expect(loadManifest("/worlds/nope/")).rejects.toThrow(
      'not a world package: /worlds/nope/manifest.json returned an HTML page (expected a world manifest); check worldUrl ("/worlds/nope/")',
    );
  });

  it("names the manifest's URL on a 404 (without a trailing slash, too)", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 404, statusText: "Not Found" }));
    await expect(loadManifest("https://cdn.example.test/worlds/sf")).rejects.toThrow(
      "not a world package: https://cdn.example.test/worlds/sf/manifest.json answered HTTP 404 Not Found " +
        '(expected a world manifest); check worldUrl ("https://cdn.example.test/worlds/sf")',
    );
  });

  it("names the manifest's URL when it isn't a manifest this version reads", async () => {
    serve({ "/tiny/manifest.json": json({ ...manifest, formatVersion: 99 }) });
    await expect(loadManifest("/tiny/")).rejects.toThrow("world manifest: /tiny/manifest.json: unsupported formatVersion 99");
    serve({ "/tiny/manifest.json": json({ hello: "world" }) });
    await expect(loadManifest("/tiny/")).rejects.toThrow("world manifest: /tiny/manifest.json: unexpected format undefined");
  });

  it("names a missing objects file's URL", async () => {
    serve({ "/tiny/manifest.json": json(manifest) });
    const m = await loadManifest("/tiny/");
    await expect(loadObjects("/tiny/", m)).rejects.toThrow(
      "world objects: /tiny/objects.json.gz returned an HTML page (expected the objects file the manifest names); " +
        "the package is incomplete, or its files are from different builds",
    );
  });

  it("names a missing or broken chunk's URL", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 404, statusText: "Not Found" }));
    const store = new ChunkStore(manifest as unknown as WorldManifest, "/tiny");
    await expect(store.ensure(0, 0)).rejects.toThrow(
      "world chunk 0,0: /tiny/chunks/0_0.bin.gz?v=0123456789abcdef answered HTTP 404 Not Found (expected a chunk the manifest lists)",
    );
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array([1, 2, 3, 4])));
    await expect(store.ensure(0, 0)).rejects.toThrow("world chunk 0,0: /tiny/chunks/0_0.bin.gz?v=0123456789abcdef: truncated header");
    await expect(loadWorld("/tiny/")).rejects.toThrow("not a world package: /tiny/manifest.json");
  });
});

describe("a chunk store's memory budget (D-120)", () => {
  /** A world four chunks across, one down; each chunk's ground stands at its column. */
  function strip(missing: number[] = [], delay = false) {
    const fetched: string[] = [];
    const m = {
      ...manifest,
      cellsX: 16,
      chunks: [0, 1, 2, 3].filter((x) => !missing.includes(x)).map((x) => ({ x, y: 0, path: `c${x}.bin` })),
    } as unknown as WorldManifest;
    const store = new ChunkStore(m, "/strip", async (url) => {
      const x = Number(/c(\d)\.bin/.exec(url)![1]);
      if (delay) await new Promise((r) => setTimeout(r, 4 - x)); // each in its own task, the later chunks first
      fetched.push(`c${x}`);
      const terrain = new TerrainGrid(4, 4);
      terrain.base.fill(x);
      return encodeChunk({ x, y: 0, size: 4, terrain });
    });
    return { store, fetched };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("lets the least recently used chunks go past the budget, and loads them again when asked", async () => {
    const { store, fetched } = strip();
    await store.ensure(0, 0);
    const one = store.loadedBytes;
    expect(one).toBe(16 * 94); // 22 bytes of layers a cell, and 72 of road, path and rail pieces
    store.maxBytes = 2 * one;
    await store.ensure(1, 0);
    expect(store.surfaceHeightAt(0.5, 0.5)).toBe(0); // reading chunk 0 makes chunk 1 the least recently used
    await store.ensure(2, 0);
    expect([store.loadedCount, store.loadedBytes, store.evicted]).toEqual([2, 2 * one, 1]);
    expect(store.get(1, 0)).toBeUndefined();
    expect(store.surfaceHeightAt(4.5, 0.5)).toBeNull();
    expect(store.isLoadedRect(0, 0, 4, 4)).toBe(true); // a check is a use: chunk 0 stays over chunk 2
    await store.ensureRect(4, 0, 8, 4);
    await tick();
    expect(store.surfaceHeightAt(4.5, 0.5)).toBe(1);
    expect(store.get(2, 0)).toBeUndefined();
    expect(fetched).toEqual(["c0", "c1", "c2", "c1"]);
  });

  it("holds what an ensureRect loads past the budget until the caller has read it, then trims", async () => {
    const { store } = strip();
    store.maxBytes = 16 * 94;
    await store.ensureRect(0, 0, 16, 4);
    // after the await, all four are there for the caller's slice, though only one fits
    const { grid } = store.slice(0, 0, 16, 4);
    expect([0, 4, 8, 12].map((x) => grid.base[x])).toEqual([0, 1, 2, 3]);
    expect(store.loadedCount).toBe(4);
    await tick();
    expect([store.loadedCount, store.evicted]).toEqual([1, 3]);
  });

  it("holds each of overlapping ensureRects' chunks for its own caller, loads landing in separate tasks", async () => {
    const { store, fetched } = strip([], true);
    store.maxBytes = 16 * 94;
    const [a, b] = [store.ensureRect(0, 0, 8, 4), store.ensureRect(4, 0, 16, 4)];
    const read = (x0: number, x1: number) => {
      const { grid } = store.slice(x0, 0, x1, 4);
      return Array.from({ length: (x1 - x0) / 4 }, (_, i) => grid.base[i * 4]);
    };
    const [ra, rb] = await Promise.all([a.then(() => read(0, 8)), b.then(() => read(4, 16))]);
    expect([ra, rb]).toEqual([[0, 1], [1, 2, 3]]);
    expect(fetched.sort()).toEqual(["c0", "c1", "c2", "c3"]); // chunk 1, wanted by both, loaded once
    await tick();
    await tick();
    expect([store.loadedCount, store.loadedBytes]).toEqual([1, 16 * 94]); // both let go: trimmed to the budget
  });

  it("leaves out the layers only drawing reads when asked, which read as empty and cost nothing (D-123)", async () => {
    const { store } = strip();
    store.dropLayers = new Set(DRAW_ONLY_LAYERS);
    await store.ensureRect(0, 0, 8, 4);
    expect(store.loadedBytes).toBe(2 * 16 * 19); // 94 bytes a cell less 72 of pieces, 1 of geology, 2 of rails
    const [a, b] = [store.get(0, 0)!.terrain, store.get(1, 0)!.terrain];
    expect(a.roadSeg).toBe(b.roadSeg); // one empty array for all
    expect([a.roadSeg.length, a.roadSeg.some(Boolean), a.rail.length]).toEqual([16 * 6, false, 16]);
    expect(store.surfaceHeightAt(4.5, 0.5)).toBe(1); // what queries read is all there
  });

  it("takes a chunk the package lacks as loaded: there is nothing to wait for", async () => {
    const { store } = strip([2]);
    await store.ensureRect(4, 0, 12, 4);
    expect(store.isLoadedRect(4, 0, 12, 4)).toBe(true);
    expect(store.isLoadedRect(0, 0, 4, 4)).toBe(false);
  });
});

describe("terrain edits in a chunk store (D-147)", () => {
  /** Two chunks of 4 × 4 side by side, with micro-terrain (k = 2) or without; the ground at 0. */
  function pair(micro: boolean) {
    const m = {
      ...manifest,
      cellsX: 8,
      chunks: [0, 1].map((x) => ({ x, y: 0, path: `c${x}.bin` })),
      ...(micro ? { micro: { k: 2 } } : {}),
    } as unknown as WorldManifest;
    let loads = 0;
    const store = new ChunkStore(m, "/pair", async (url) => {
      loads++;
      const x = Number(/c(\d)\.bin/.exec(url)![1]);
      const terrain = new TerrainGrid(4, 4, micro ? { micro: emptyMicro(2, 4, 4) } : undefined);
      return encodeChunk({ x, y: 0, size: 4, terrain });
    });
    return { store, loads: () => loads };
  }

  it("edits what is loaded at once, and a chunk let go comes back edited", async () => {
    const { store, loads } = pair(false);
    await store.ensureRect(0, 0, 8, 4);
    store.editCells([{ x: 1, y: 1, surface: 3, water: 5 }, { x: 6, y: 2, height: 4 }, { x: 99, y: 0, surface: 1 }]);
    expect(store.cell(1, 1)!.terrain.surface[store.cell(1, 1)!.i]).toBe(3);
    expect(store.isWater(1.5, 1.5)).toBe(true);
    expect(store.surfaceHeightAt(6.5, 2.5)).toBe(4);
    // a later edit of the cell keeps the fields it doesn't name
    store.editCells([{ x: 1, y: 1, water: NO_WATER }]);
    expect(store.isWater(1.5, 1.5)).toBe(false);
    expect(store.cell(1, 1)!.terrain.surface[store.cell(1, 1)!.i]).toBe(3);
    // let both go, and load them again from the package
    store.maxBytes = 0;
    await store.ensure(0, 0);
    await new Promise((r) => setTimeout(r, 0));
    store.maxBytes = Infinity;
    await store.ensureRect(0, 0, 8, 4);
    expect(loads()).toBeGreaterThan(2);
    expect(store.surfaceHeightAt(6.5, 2.5)).toBe(4);
    expect(store.cell(1, 1)!.terrain.surface[store.cell(1, 1)!.i]).toBe(3);
    // what a rectangle holds: the cells in it and the ring round it, in the order stamped
    expect(store.editsIn(0, 0, 4, 4)).toBe(`1,1,3,${NO_WATER},`);
    expect(store.editsIn(7, 0, 8, 4)).toBe("6,2,,,4");
    expect(store.editsIn(0, 0, 8, 4)).toBe(`6,2,,,4;1,1,3,${NO_WATER},`);
    expect(store.editsIn(3, 3, 4, 4)).toBe("");
  });

  it("levels micro-terrain at a chunk's edge in both chunks that hold its corners", async () => {
    const { store } = pair(true);
    await store.ensureRect(0, 0, 8, 4);
    store.editCells([{ x: 3, y: 1, height: 2 }]); // the last column of chunk 0: its east corners are chunk 1's first
    expect(store.surfaceHeightAt(3.5, 1.5)).toBe(2);
    expect(store.slice(0, 0, 8, 4).grid.micro!.corners[2 * 17 + 8]).toBe(4); // micro-steps, from either chunk
    expect(store.get(1, 0)!.terrain.micro!.corners[2 * 9 + 0]).toBe(4);
    expect(store.surfaceHeightAt(4.05, 1.5)).toBeGreaterThan(0); // the neighbour slopes up to meet it
  });
});
