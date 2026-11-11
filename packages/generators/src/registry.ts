import type { Generator } from "./assets";
import { builtinGenerators } from "./builtins";

/**
 * The generator registry (D-030, D-071): the name a style pack gives an
 * asset's `generator` → the function that draws it. It holds the built-in
 * generators (builtins.ts) and whatever plugins registered, such as San
 * Francisco's facades, towers and Chinatown from the city pack
 * @pixelworlds/city-sf. Each realm has its own: the main thread, and every
 * bake worker (a plugin is registered in each, docs/plugins.md §9).
 */

/** The source the built-in generators are registered under. */
export const BUILTIN_SOURCE = "@pixelworlds/generators";

/**
 * Generators that the city packs in this repository provide, and which
 * plugin: a style that names one without its plugin loaded gets an error that
 * says what to load (as the pipeline's registry does for `datasf`).
 */
export const KNOWN_PLUGIN_GENERATORS: Readonly<Record<string, string>> = {
  rowhouse: "@pixelworlds/city-sf",
  block: "@pixelworlds/city-sf",
  decoTower: "@pixelworlds/city-sf",
  sfTower: "@pixelworlds/city-sf",
  gate: "@pixelworlds/city-sf",
  lanterns: "@pixelworlds/city-sf",
  brownstone: "@pixelworlds/city-nyc",
  tenement: "@pixelworlds/city-nyc",
  castIronLoft: "@pixelworlds/city-nyc",
  prewarBlock: "@pixelworlds/city-nyc",
  haussmann: "@pixelworlds/city-paris",
  faubourg: "@pixelworlds/city-paris",
  hbm: "@pixelworlds/city-paris",
  cathedral: "@pixelworlds/city-paris",
  triumphalArch: "@pixelworlds/city-paris",
  latticeArchTower: "@pixelworlds/city-paris",
  operaHouse: "@pixelworlds/city-paris",
  steelArchBridge: "@pixelworlds/city-paris",
  domedChurch: "@pixelworlds/city-paris",
  glassPalace: "@pixelworlds/city-paris",
  stoneArchBridge: "@pixelworlds/city-paris",
  palace: "@pixelworlds/city-paris",
  zakkyo: "@pixelworlds/city-tokyo",
  mansion: "@pixelworlds/city-tokyo",
  kodate: "@pixelworlds/city-tokyo",
  twinTowerHall: "@pixelworlds/city-tokyo",
  cylinderTower: "@pixelworlds/city-tokyo",
  myojinTorii: "@pixelworlds/city-tokyo",
  utilityPoles: "@pixelworlds/city-tokyo",
};

export interface GeneratorInfo {
  name: string;
  /** Who registered it: BUILTIN_SOURCE, a plugin's name, or `source` given to registerGenerators. */
  source: string;
}

export interface RegisterOptions {
  /** Who registers them (a plugin's name); listed by listGenerators and named in errors. Default "app". */
  source?: string;
  /** Replace generators another source registered (default: that is an error). */
  replace?: boolean;
}

/** A registration that would clash with another source's generator, or isn't a function. */
export class GeneratorRegistryError extends Error {
  override name = "GeneratorRegistryError";
}

/** A style asks for a generator that isn't registered in this realm. */
export class MissingGeneratorError extends Error {
  override name = "MissingGeneratorError";
  /** The plugin known to provide it (KNOWN_PLUGIN_GENERATORS), if any. */
  readonly plugin: string | null;

  constructor(
    readonly generator: string,
    readonly group?: string,
  ) {
    const plugin = KNOWN_PLUGIN_GENERATORS[generator] ?? null;
    const what = `no generator named '${generator}'${group ? ` (asked for by ${group})` : ""}`;
    super(
      plugin
        ? `${what}. '${generator}' comes with the plugin ${plugin}, which isn't loaded here: ` +
            `pass it to createWorldView({ plugins }), which loads it in the bake worker and on the main thread, ` +
            `or register it with registerPlugin() where models are generated outside a view. See docs/plugins.md.`
        : `${what}. No plugin known here provides it: load the plugin that does (createWorldView({ plugins }), ` +
            `registerPlugin()), or register it with registerGenerators(). ` +
            `Registered generators: ${listGenerators().map((g) => g.name).join(", ")}. See docs/plugins.md.`,
    );
    this.plugin = plugin;
  }
}

interface Entry {
  fn: Generator;
  source: string;
}

const table = new Map<string, Entry>();
let seeded = false;

/** The table, with the built-ins in it the first time it is read (no work at import). */
function entries(): Map<string, Entry> {
  if (!seeded) {
    seeded = true;
    for (const [name, fn] of Object.entries(builtinGenerators())) table.set(name, { fn, source: BUILTIN_SOURCE });
  }
  return table;
}

/**
 * Register generators by name. Registering a name again from the same source
 * replaces it (a plugin registered twice, a hot reload); another source's
 * name is an error unless `replace` is set. Nothing is registered if any
 * entry fails. Returns the names.
 */
export function registerGenerators(record: Record<string, Generator>, opts: RegisterOptions = {}): string[] {
  const source = opts.source ?? "app";
  const t = entries();
  const names = Object.keys(record);
  for (const name of names) {
    const fn = record[name];
    if (!name) throw new GeneratorRegistryError(`${source} registers a generator without a name`);
    if (typeof fn !== "function") throw new GeneratorRegistryError(`generator '${name}' from ${source} is not a function`);
    const had = t.get(name);
    if (had && had.fn !== fn && had.source !== source && !opts.replace)
      throw new GeneratorRegistryError(
        `generator '${name}' is already registered by ${had.source}, so ${source} can't register it too ` +
          `(pass { replace: true } to replace it)`,
      );
  }
  for (const name of names) {
    const fn = record[name]!;
    if (t.get(name)?.fn !== fn) t.set(name, { fn, source });
  }
  return names;
}

/** Register one generator (registerGenerators with one entry). */
export function registerGenerator(name: string, fn: Generator, opts: RegisterOptions = {}): void {
  registerGenerators({ [name]: fn }, opts);
}

export function hasGenerator(name: string): boolean {
  return entries().has(name);
}

/** Every registered generator and who registered it, by name. */
export function listGenerators(): GeneratorInfo[] {
  return [...entries()]
    .map(([name, e]) => ({ name, source: e.source }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The generator registered as `name`; a MissingGeneratorError (naming `group`) if there is none. */
export function getGenerator(name: string, group?: string): Generator {
  const e = entries().get(name);
  if (!e) throw new MissingGeneratorError(name, group);
  return e.fn;
}

/** Remove every generator a source registered (tests, hot reloads). Returns their names. */
export function unregisterGenerators(source: string): string[] {
  const t = entries();
  const names = [...t].filter(([, e]) => e.source === source).map(([name]) => name);
  for (const name of names) t.delete(name);
  return names;
}
