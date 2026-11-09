import type { Generator } from "./assets";
import { hasGenerator, registerGenerators, unregisterGenerators } from "./registry";

/**
 * Plugins (D-071, docs/plugins.md §9): packages that add generators, such as
 * the city pack @pixelworlds/city-sf. A plugin is registered once in every
 * realm that generates models: each bake worker (which imports the plugin's
 * module by URL before its first bake) and the main thread (entities, the
 * inline baker, tests).
 *
 * The module a worker imports defines its plugin with `definePlugin`, which
 * also announces it to the realm. A loader finds it there even when a bundler
 * dropped the module's exports (Vite does for worker bundles) or the module
 * carries its own copy of this package; the plugin then registers into the
 * loader's registry through the API it is given, never through its own copy.
 */

/** The plugin API's version; a plugin may check it. */
export const PLUGIN_API_VERSION = 1;

/** What a plugin's `register` gets: the registry of the realm it is registered in. */
export interface PluginApi {
  readonly apiVersion: number;
  /** Register generators under the plugin's name (see registerGenerators). */
  registerGenerators(record: Record<string, Generator>, opts?: { replace?: boolean }): void;
  hasGenerator(name: string): boolean;
}

/** A plugin: its name (style packs name it in `plugins`) and what it registers. */
export interface Plugin {
  name: string;
  register(api: PluginApi): void | Promise<void>;
}

/** How a world view finds a plugin (createWorldView({ plugins })). */
export interface PluginDescriptor {
  /** The plugin's name, e.g. "@pixelworlds/city-sf". */
  name: string;
  /**
   * An ES module that defines the plugin (`definePlugin`, or a `register`
   * export), self-contained or importing only absolute URLs (a bundled file):
   * the bake worker imports it. Relative URLs resolve against the page.
   */
  url: string | URL;
  /** The plugin itself, when the page has it already: registered on the main thread instead of importing `url` there. */
  plugin?: Plugin;
  /** Changes when the plugin draws differently: it keys the tile cache. */
  version?: string;
}

/** What registering a plugin added. */
export interface PluginReport {
  name: string;
  generators: string[];
}

/** A plugin that can't be loaded or registered. */
export class PluginError extends Error {
  override name = "PluginError";
}

const ANNOUNCED = Symbol.for("pixelworld.plugins");

/** Plugins defined in this realm, by any copy of this package (definePlugin). */
function announced(): Plugin[] {
  const g = globalThis as unknown as Record<symbol, Plugin[] | undefined>;
  return (g[ANNOUNCED] ??= []);
}

function isPlugin(x: unknown): x is Plugin {
  return (
    typeof x === "object" && x !== null && typeof (x as Plugin).name === "string" && typeof (x as Plugin).register === "function"
  );
}

/**
 * Define a plugin in the module a bake worker imports:
 *
 *   export default definePlugin({ name: "my-city", register: (api) => api.registerGenerators(GENERATORS) });
 *
 * Returns it, and announces it to the realm so `loadPlugin` finds it.
 */
export function definePlugin<P extends Plugin>(plugin: P): P {
  if (!isPlugin(plugin)) throw new PluginError("definePlugin needs { name, register }");
  announced().push(plugin);
  return plugin;
}

/** The API a plugin registers through in this realm. */
export function pluginApi(name: string): PluginApi {
  return {
    apiVersion: PLUGIN_API_VERSION,
    registerGenerators: (record, opts) => {
      registerGenerators(record, { source: name, replace: opts?.replace });
    },
    hasGenerator,
  };
}

const byName = new Map<string, Promise<PluginReport>>();
const byUrl = new Map<string, { name: string; report: Promise<PluginReport> }>();

/**
 * Register a plugin in this realm: once per name, so a second call (or the
 * same plugin from another copy) gets the first one's report. The plugin's
 * generators are registered before this returns, unless its `register` is
 * asynchronous.
 */
export function registerPlugin(plugin: Plugin): Promise<PluginReport> {
  const had = byName.get(plugin.name);
  if (had) return had;
  const generators: string[] = [];
  const api = pluginApi(plugin.name);
  const tracking: PluginApi = {
    ...api,
    registerGenerators: (record, opts) => {
      api.registerGenerators(record, opts);
      generators.push(...Object.keys(record));
    },
  };
  let done: Promise<PluginReport>;
  try {
    const r = plugin.register(tracking);
    done = Promise.resolve(r).then(() => ({ name: plugin.name, generators: [...new Set(generators)].sort() }));
  } catch (e) {
    done = Promise.reject(e);
  }
  const report = done.catch((e: unknown) => {
    byName.delete(plugin.name);
    throw new PluginError(`plugin ${plugin.name} failed to register: ${e instanceof Error ? e.message : String(e)}`);
  });
  byName.set(plugin.name, report);
  return report;
}

/** The plugins registered in this realm, by name. */
export function registeredPlugins(): string[] {
  return [...byName.keys()].sort();
}

/** Forget a plugin and remove its generators (tests, hot reloads). */
export function unregisterPlugin(name: string): void {
  byName.delete(name);
  for (const [url, e] of byUrl) if (e.name === name) byUrl.delete(url);
  unregisterGenerators(name);
}

// both comments: bundlers must leave this import to the browser (webpack would emit a broken chunk)
const nativeImport = (url: string): Promise<unknown> => import(/* @vite-ignore */ /* webpackIgnore: true */ url);

/** The plugin a module exports: as its default export, or as named `register` (and `name`) exports. */
function exportedPlugin(mod: unknown, name: string): Plugin | null {
  const m = mod as { default?: unknown; name?: unknown; register?: unknown } | null;
  if (isPlugin(m?.default)) return m.default;
  if (typeof m?.register === "function")
    return { name: typeof m.name === "string" ? m.name : name, register: m.register as Plugin["register"] };
  return null;
}

/**
 * Import a plugin's module and register the plugin it defines (what it
 * exports: a default plugin, or `register` and `name`; else what it announced
 * with definePlugin), once per URL. `url` must
 * be absolute where the realm has no base (a worker resolves against its own
 * script). `importer` replaces `import()` (tests).
 */
export function loadPlugin(
  ref: { name: string; url: string },
  importer: (url: string) => Promise<unknown> = nativeImport,
): Promise<PluginReport> {
  const had = byUrl.get(ref.url);
  if (had) return had.report;
  const report = (async () => {
    const before = announced().length;
    let mod: unknown;
    try {
      mod = await importer(ref.url);
    } catch (e) {
      throw new PluginError(`plugin ${ref.name} (${ref.url}) failed to import: ${e instanceof Error ? e.message : String(e)}`);
    }
    const all = announced();
    const plugin = exportedPlugin(mod, ref.name) ?? all.findLast((p) => p.name === ref.name);
    if (!plugin) {
      const other = all.slice(before)[0];
      throw new PluginError(
        other
          ? `${ref.url} defines the plugin ${other.name}, not ${ref.name}`
          : `${ref.url} defines no plugin: the module must call definePlugin({ name, register }) (docs/plugins.md §9)`,
      );
    }
    if (plugin.name !== ref.name) throw new PluginError(`${ref.url} defines the plugin ${plugin.name}, not ${ref.name}`);
    return registerPlugin(plugin);
  })();
  byUrl.set(ref.url, { name: ref.name, report });
  report.catch(() => byUrl.delete(ref.url));
  return report;
}
