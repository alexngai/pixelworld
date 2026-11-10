import { StyleError, describe, styleIssuesError } from "./issues";

/**
 * Loading style packs (D-075): JSON text with the file and line in its
 * errors, and `extends`, a pack written as changes to another.
 *
 * The merge rule (as region specs' `extends:`): objects merge key by key, the
 * child's value winning; anything else (a ramp's colours, strata bands, fog
 * areas, plugins) replaces whole; `null` deletes the parent's key. Keys keep
 * the parent's order and new ones follow, so the parent's ramps keep their
 * palette indices and the child's come after. `extends` itself isn't
 * inherited, and the child needs its own `id`.
 */

/** A chain of packs extending each other this long is surely a mistake. */
export const MAX_EXTENDS_DEPTH = 8;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Where JSON text stops being JSON: the offset of the first character that can't continue it, or -1. */
export function jsonErrorOffset(text: string): number {
  let i = 0;
  const fail = (): never => {
    throw new RangeError(String(i));
  };
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const str = () => {
    i++;
    for (; i < text.length && text[i] !== '"'; i++) {
      if (text.charCodeAt(i) < 32) fail();
      if (text[i] === "\\") i++;
    }
    if (i >= text.length) fail();
    i++;
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      i++;
      ws();
      if (text[i] === close) return void i++;
      for (;;) {
        ws();
        if (c === "{") {
          if (text[i] !== '"') fail();
          str();
          ws();
          if (text[i] !== ":") fail();
          i++;
        }
        value();
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === close) return void i++;
        else fail();
      }
    }
    if (c === '"') return str();
    for (const w of ["true", "false", "null"]) if (text.startsWith(w, i)) return void (i += w.length);
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (!m) fail();
    i += m![0].length;
  };
  try {
    value();
    ws();
    if (i < text.length) fail();
    return -1;
  } catch (e) {
    if (e instanceof RangeError) return Number(e.message);
    throw e;
  }
}

/**
 * Parse a pack's JSON text; a syntax error names `source` (a file or URL) and
 * the line and column: `worlds/_styles/bay-area/style.json: invalid JSON at
 * line 725, column 28: Expected double-quoted property name`.
 */
export function parseStyleJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    const offset = jsonErrorOffset(text);
    const before = text.slice(0, offset < 0 ? text.length : offset).split("\n");
    const where = `line ${before.length}, column ${before[before.length - 1]!.length + 1}`;
    // the engine's words without its own position (V8, Firefox and Safari word it differently)
    const what = (e instanceof Error ? e.message : String(e))
      .replace(/^JSON(?:\.parse:| Parse error:)\s*/, "")
      .replace(/,? ?(?:in JSON )?at position \d+(?: \(line \d+ column \d+\))?/, "")
      .replace(/ at line \d+ column \d+ of the JSON data/, "");
    throw new StyleError(`${source}: invalid JSON at ${where}: ${what}`, { cause: e });
  }
}

function mergeValue(base: unknown, over: unknown): unknown {
  if (!isObject(over)) return over;
  const out: Record<string, unknown> = isObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete out[k];
    else out[k] = mergeValue(out[k], v);
  }
  return out;
}

/** A pack written over its parent (the merge rule above), without `extends`. */
export function mergeStylePacks(parent: object, child: object): Record<string, unknown> {
  const { extends: _extends, ...own } = child as Record<string, unknown>;
  const { extends: _parentExtends, ...base } = parent as Record<string, unknown>;
  return mergeValue(base, own) as Record<string, unknown>;
}

/** Loads a pack by id (a resolver): the pack, or null/undefined if there is none. */
export type StyleLoader = (id: string) => unknown;

/**
 * A pack with its `extends` chain merged in, its parents loaded by id with
 * `load`; a pack without `extends` is returned as it is. Errors name the
 * chain: `style pack "desert-adobe" extends "desert-southwst", which …`.
 */
export async function resolveStyleExtends(pack: unknown, load: StyleLoader, chain: readonly string[] = []): Promise<unknown> {
  if (!isObject(pack) || !("extends" in pack)) return pack;
  const parentId = pack.extends;
  const id = typeof pack.id === "string" ? pack.id : null;
  const fail = (path: string, message: string) => styleIssuesError(id ?? chain[chain.length - 1] ?? null, [{ path, message }]);
  if (typeof parentId !== "string" || !parentId) throw fail("extends", `want a pack's id, not ${describe(parentId)}`);
  if (id === null) throw fail("id", `a pack that extends another needs its own id (this one extends ${JSON.stringify(parentId)})`);
  const seen = [...chain, id];
  // a chain's errors name the pack that was asked for
  const chainError = (message: string) => styleIssuesError(seen[0]!, [{ path: "extends", message }]);
  if (seen.includes(parentId)) throw chainError(`the packs extend each other in a circle: ${[...seen, parentId].join(" → ")}`);
  if (seen.length >= MAX_EXTENDS_DEPTH) throw chainError(`more than ${MAX_EXTENDS_DEPTH} packs extend each other: ${seen.join(" → ")}`);
  const what = `style pack ${JSON.stringify(id)} extends ${JSON.stringify(parentId)}`;
  let parent: unknown;
  try {
    parent = await load(parentId);
  } catch (e) {
    throw new StyleError(`${what}, which failed to load: ${e instanceof Error ? e.message : String(e)}`, { pack: id, cause: e });
  }
  if (parent === null || parent === undefined) throw new StyleError(`${what}, which there's no pack for`, { pack: id });
  if (!isObject(parent)) throw new StyleError(`${what}, which is ${describe(parent)}, not a pack`, { pack: id });
  return mergeStylePacks((await resolveStyleExtends(parent, load, seen)) as object, pack);
}
