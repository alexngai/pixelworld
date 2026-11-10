import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorldManifest } from "@pixelworlds/world-format";
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
