import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorldFetchError, fetchWorldFile, fetchWorldJson, parseWorldFile } from "../src/fetch";
import { GeoGrid } from "../src/geo";
import type { WorldManifest } from "../src/manifest";

/** Fetch errors name the URL and what was expected there (D-072). */

const INFO = { label: "world objects", expected: "the objects file the manifest names", hint: "the package is incomplete" };
const INDEX_HTML = '<!doctype html>\n<html><head><script type="module" src="/@vite/client"></script></head></html>';

/** Answer every fetch with this response (or throw this error). */
function serve(answer: Response | Error): ReturnType<typeof vi.fn> {
  const f = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer.clone();
  });
  vi.stubGlobal("fetch", f);
  return f;
}

const bytes = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

describe("fetching a world package's files", () => {
  afterEach(() => void vi.unstubAllGlobals());

  it("returns the bytes and parses JSON, plain or gzip", async () => {
    serve(new Response(JSON.stringify({ version: 2 }), { headers: { "content-type": "application/json" } }));
    expect(await fetchWorldJson("/sf/objects.json", INFO)).toEqual({ version: 2 });
    serve(new Response(bytes(gzipSync(Buffer.from('{"a":1}'))), { headers: { "content-type": "application/gzip" } }));
    expect(await fetchWorldJson("/sf/objects.json.gz", INFO)).toEqual({ a: 1 });
    serve(new Response(new Uint8Array([1, 2, 3])));
    expect(new Uint8Array(await fetchWorldFile("/sf/chunks/0_0.bin", INFO))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("names the URL of an HTTP error, and what was expected there", async () => {
    serve(new Response("Not Found", { status: 404, statusText: "Not Found" }));
    const err = await fetchWorldJson("/sf/objects.json.gz", INFO).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorldFetchError);
    expect((err as WorldFetchError).message).toBe(
      "world objects: /sf/objects.json.gz answered HTTP 404 Not Found (expected the objects file the manifest names); " +
        "the package is incomplete",
    );
    expect((err as WorldFetchError).url).toBe("/sf/objects.json.gz");
    expect((err as WorldFetchError).status).toBe(404);
  });

  it("says when a server answered with an HTML page, by its type or its first byte", async () => {
    serve(new Response(INDEX_HTML, { headers: { "content-type": "text/html; charset=utf-8" } }));
    await expect(fetchWorldJson("/nope/objects.json", INFO)).rejects.toThrow(
      "world objects: /nope/objects.json returned an HTML page (expected the objects file the manifest names)",
    );
    serve(new Response(new TextEncoder().encode("\n  " + INDEX_HTML))); // no content type
    await expect(fetchWorldFile("/nope/chunk.bin", INFO)).rejects.toThrow("returned an HTML page");
  });

  it("names the URL of a network failure", async () => {
    serve(new TypeError("Failed to fetch"));
    await expect(fetchWorldFile("https://cdn.example.test/w/manifest.json", INFO)).rejects.toThrow(
      "world objects: https://cdn.example.test/w/manifest.json couldn't be fetched " +
        "(expected the objects file the manifest names): TypeError: Failed to fetch; is the server up, and does a server on another origin send CORS headers?",
    );
  });

  it("names the URL of JSON that doesn't parse, and of a parser's error", async () => {
    serve(new Response('{"version": 2,'));
    await expect(fetchWorldJson("/sf/objects.json", INFO)).rejects.toThrow(
      /^world objects: \/sf\/objects\.json isn't valid JSON \(expected the objects file the manifest names\): SyntaxError: /,
    );
    await expect(
      parseWorldFile("/sf/objects.json", "world objects", () => {
        throw new RangeError("unsupported objects file version 9");
      }),
    ).rejects.toThrow("world objects: /sf/objects.json: RangeError: unsupported objects file version 9");
  });

  it("names the geo grid's URL", async () => {
    serve(new Response("", { status: 403, statusText: "Forbidden" }));
    const manifest = { geo: { path: "geo.bin.gz", size: [2, 2], step: 4 }, cellsX: 4, cellsY: 4 } as unknown as WorldManifest;
    await expect(GeoGrid.load(manifest, "https://worlds.example.test/sf/")).rejects.toThrow(
      "world geo grid: https://worlds.example.test/sf/geo.bin.gz answered HTTP 403 Forbidden (expected the geo grid the manifest names)",
    );
  });
});
