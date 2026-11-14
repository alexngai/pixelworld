import { createReadStream, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * A request handler for a built game's directory (D-114), beside the rooms on
 * the same server: GET and HEAD only, nothing outside `root`, `index.html` for
 * a directory. Vite's hashed `/assets/` are cached for good; the rest is
 * checked each time. World package files (`.gz` and the like) go out as they
 * are stored, for the page to inflate.
 */
export function serveStatic(root: string): (req: IncomingMessage, res: ServerResponse) => void {
  const base = normalize(root.endsWith(sep) ? root : root + sep);
  return (req, res) => {
    const fail = (code: number, text: string) => {
      res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
      res.end(text);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "method not allowed");
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "http://game").pathname);
    } catch {
      return fail(400, "bad path");
    }
    let file = normalize(join(base, path));
    if (path.includes("\0") || !(file + sep).startsWith(base)) return fail(404, "not found");
    let stat = statSync(file, { throwIfNoEntry: false });
    if (stat?.isDirectory()) {
      file = join(file, "index.html");
      stat = statSync(file, { throwIfNoEntry: false });
    }
    if (!stat?.isFile()) return fail(404, "not found");
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "content-length": stat.size,
      "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
  };
}

/**
 * A world package's files read from disk, for `openWorld({ fetch })` (D-123):
 * a URL's path under `root` (any origin), nothing outside it. A server opens
 * its world this way rather than over HTTP from itself.
 */
export function fileFetch(root: string): (url: string) => Promise<Response> {
  const base = normalize(root.endsWith(sep) ? root : root + sep);
  const missing = () => new Response("not found", { status: 404, statusText: "Not Found" });
  return async (url) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(url).pathname);
    } catch {
      return missing();
    }
    const file = normalize(join(base, path));
    if (path.includes("\0") || !(file + sep).startsWith(base)) return missing();
    try {
      return new Response(await readFile(file));
    } catch {
      return missing();
    }
  };
}
