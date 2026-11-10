import { maybeGunzip } from "./chunk";

/**
 * Fetching a world package's files (D-072). Every error names the URL and
 * what was expected there, so a wrong `worldUrl` reads as one: dev servers and
 * single-page hosts answer a path they don't have with their index.html (200,
 * an HTML page), where a parser would only say "Unexpected token '<'".
 */

/** A world package's file that couldn't be fetched, or isn't what was expected. */
export class WorldFetchError extends Error {
  override name = "WorldFetchError";

  constructor(
    message: string,
    /** The URL as it was fetched. */
    readonly url: string,
    /** The HTTP status, when the server answered. */
    readonly status?: number,
  ) {
    super(message);
  }
}

/** What a fetch is for, in its errors. */
export interface WorldFileInfo {
  /** Leads the message: what failed, e.g. "not a world package", "world chunk 3,4". */
  label: string;
  /** What should be at the URL, e.g. "a world manifest, JSON". */
  expected: string;
  /** What to check when the file is missing or wrong, e.g. "check worldUrl". */
  hint?: string;
}

/** Whether a response is an HTML page: by its type, or by its first byte where it has none. */
function isHtml(res: Response, bytes: ArrayBuffer): boolean {
  if (/\btext\/html\b/i.test(res.headers.get("content-type") ?? "")) return true;
  const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 64));
  for (const b of head) {
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0xef || b === 0xbb || b === 0xbf) continue; // space, BOM
    return b === 0x3c; // "<": no world file starts so (JSON, gzip, PNG and chunks don't)
  }
  return false;
}

/** An error's message, after its name where that says more than "Error". */
const errorText = (e: unknown): string =>
  e instanceof Error ? (e.name && e.name !== "Error" ? `${e.name}: ${e.message}` : e.message) : String(e);

/** The message of a fetch error: `label: url problem (expected …): cause; hint`. */
export function worldFileMessage(url: string, info: WorldFileInfo, problem: string, cause?: unknown): string {
  const why = cause === undefined ? "" : `: ${errorText(cause)}`;
  return `${info.label}: ${url} ${problem} (expected ${info.expected})${why}${info.hint ? `; ${info.hint}` : ""}`;
}

/**
 * Fetch a world package's file as bytes. A network failure, an HTTP error or
 * an HTML page where data was expected is a WorldFetchError naming the URL.
 */
export async function fetchWorldFile(url: string | URL, info: WorldFileInfo): Promise<ArrayBuffer> {
  const href = String(url);
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    // no answer at all: the file's advice (an incomplete package…) doesn't apply
    const hint = "is the server up, and does a server on another origin send CORS headers?";
    throw new WorldFetchError(worldFileMessage(href, { ...info, hint }, "couldn't be fetched", e), href);
  }
  if (!res.ok) {
    const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
    throw new WorldFetchError(worldFileMessage(href, info, `answered ${status}`), href, res.status);
  }
  const bytes = await res.arrayBuffer();
  if (isHtml(res, bytes)) throw new WorldFetchError(worldFileMessage(href, info, "returned an HTML page"), href, res.status);
  return bytes;
}

/** Fetch a world package's JSON file, plain or gzip: as fetchWorldFile, and JSON that doesn't parse names the URL too. */
export async function fetchWorldJson(url: string | URL, info: WorldFileInfo): Promise<unknown> {
  const href = String(url);
  const bytes = await fetchWorldFile(url, info);
  let text: string;
  try {
    text = new TextDecoder().decode(await maybeGunzip(bytes));
  } catch (e) {
    throw new WorldFetchError(worldFileMessage(href, info, "isn't readable gzip", e), href);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new WorldFetchError(worldFileMessage(href, info, "isn't valid JSON", e), href);
  }
}

/**
 * Parse what a fetch returned (a manifest, objects, routes, a chunk), so that
 * a parser's error names the URL too: `label: url: error`.
 */
export async function parseWorldFile<T>(url: string | URL, label: string, parse: () => T | Promise<T>): Promise<T> {
  try {
    return await parse();
  } catch (e) {
    throw new WorldFetchError(`${label}: ${String(url)}: ${errorText(e)}`, String(url));
  }
}
