import { getGenerator, listGenerators, loadPlugin, registerPlugin, type PluginDescriptor } from "@pixelworlds/generators";
import { hashString, type PluginRef } from "@pixelworlds/runtime";
import type { WorldViewOptions } from "./types";

/**
 * A view's plugins (D-071, docs/plugins.md §9): which to load, given what the
 * style pack names, and their registration on the main thread. The bake
 * service loads them in its worker.
 */

/** The plugins a style pack names (`"plugins": ["@pixelworlds/city-sf"]`). */
export function stylePlugins(style: object): string[] {
  const p = (style as { plugins?: unknown }).plugins;
  return Array.isArray(p) ? p.filter((n): n is string => typeof n === "string") : [];
}

export interface ViewPlugins {
  descriptors: PluginDescriptor[];
  /** For the bake worker: names and absolute module URLs. */
  refs: PluginRef[];
  /** Plugins the style pack names that the view doesn't load. */
  missing: string[];
}

/**
 * The plugins to load: the option as given, or what its function returns for
 * the names the style pack asks for. A name the style asks for that isn't
 * among them is warned about: its generators won't be there.
 */
export function viewPlugins(option: WorldViewOptions["plugins"], styleJson: object, styleId: string): ViewPlugins {
  const wanted = stylePlugins(styleJson);
  const descriptors = (typeof option === "function" ? option(wanted) : option) ?? [];
  const missing = wanted.filter((n) => !descriptors.some((d) => d.name === n));
  if (missing.length)
    console.warn(
      `the style pack ${styleId} needs the plugin${missing.length > 1 ? "s" : ""} ${missing.join(", ")}, ` +
        `which this view didn't load: models drawn by ${missing.length > 1 ? "their" : "its"} generators will fail to bake ` +
        `(each is drawn as a missing-model marker). ` +
        `Pass ${missing.length > 1 ? "them" : "it"} to createWorldView({ plugins }) (docs/plugins.md).`,
    );
  const refs = descriptors.map((d) => ({ name: d.name, url: new URL(d.url, location.href).href }));
  return { descriptors, refs, missing };
}

/** Register the plugins on this thread (entity models, the inline baker): the plugin itself, or its module. */
export async function registerOnMainThread(p: ViewPlugins): Promise<void> {
  await Promise.all(p.descriptors.map((d, i) => (d.plugin ? registerPlugin(d.plugin) : loadPlugin(p.refs[i]!))));
}

/** Fetches a module's text (the default: `fetch`); tests give their own. */
export type FetchText = (url: string) => Promise<string>;

const fetchText: FetchText = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

/** Most modules followed from one plugin's module: a bundled plugin is one, a dev server's a few dozen. */
const MAX_MODULES = 400;

/** A dev server's HMR timestamps (`?t=…`): not code, and they change when nothing else does. */
const stamps = (s: string) => s.replace(/([?&])t=\d+&?/g, "$1").replace(/[?&]$/, "");

/** The URLs a module imports that are part of its code: relative or same-origin, not a dev server's own or npm's. */
function importsOf(text: string, base: URL): URL[] {
  const code = text.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, "$1"); // comments
  const out: URL[] = [];
  for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"'\n]+)\1/g)) {
    const spec = m[2]!;
    if (!/^(\.{1,2}\/|\/(?!\/)|https?:)/.test(spec)) continue; // bare: from npm, versioned in the importer's URL
    const url = new URL(spec, base);
    if (url.origin !== base.origin || /^\/(@vite|@id|node_modules)\//.test(url.pathname)) continue;
    out.push(url);
  }
  return out;
}

/**
 * The text of a plugin's module and the modules it imports by URL: a bundled
 * plugin is one file, a dev server serves each source module on its own.
 * What can't be fetched counts as its URL and the error.
 */
export async function moduleCode(url: string, fetchFn: FetchText = fetchText): Promise<string> {
  const seen = new Set<string>();
  const parts: string[] = [];
  let queue = [new URL(url, typeof location === "undefined" ? undefined : location.href)];
  while (queue.length && seen.size < MAX_MODULES) {
    const next: URL[] = [];
    const batch = queue.filter((u) => {
      const k = stamps(u.href);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const texts = await Promise.all(batch.map((u) => fetchFn(u.href).catch((e: unknown) => `!${String(e)}`)));
    batch.forEach((u, i) => {
      const text = stamps(texts[i]!);
      parts.push(`${stamps(u.href)}\n${text}`);
      if (!text.startsWith("!")) next.push(...importsOf(text, u));
    });
    queue = next;
  }
  return parts.sort().join("\0");
}

/**
 * The plugins' part of the tile cache key (D-072), or nothing without
 * plugins: each plugin's name, its `version` if it gives one, and a hash of
 * its code, so an edit to a plugin's generators makes its old tiles
 * unreachable in a dev server as after a release. The code is the source
 * text of the generators it registered on this thread (registerOnMainThread
 * first) and the text of its module and what that imports by URL (moduleCode).
 */
export async function pluginsKey(descriptors: PluginDescriptor[], fetchFn: FetchText = fetchText): Promise<string[]> {
  if (!descriptors.length) return [];
  const registered = listGenerators();
  const ids = await Promise.all(
    descriptors.map(async (d) => {
      const generators = registered
        .filter((g) => g.source === d.name)
        .map((g) => `${g.name}=${getGenerator(g.name).toString()}`)
        .join("\0");
      const module = await moduleCode(String(d.url), fetchFn);
      const code = hashString(`${generators}\u0001${module}`);
      return `${d.version ? `${d.name}@${d.version}` : d.name}#${code}`;
    }),
  );
  return [`plugins:${ids.sort().join(",")}`];
}
