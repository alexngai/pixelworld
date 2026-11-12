import { registerPlugin, type PluginApi, type PluginDescriptor, type PluginReport } from "pixelworld/generators";
import { version } from "../package.json";
import { PLUGIN_NAME } from "./generators";
import { plugin } from "./plugin";
// In the workspace, Vite builds the worker module on its own (dependencies included) and
// gives its URL. The package build (build.mjs) replaces this line with
// new URL("./worker.js", import.meta.url), which Vite, webpack 5 and Rollup follow.
import workerUrl from "./worker?worker&url";

/**
 * @pixelworlds/city-sf: San Francisco's city pack (D4 in docs/library.md,
 * D-071, D-074). The pipeline half (DataSF facts) is the pipeline's built-in
 * `datasf` facts source; this is the browser half, San Francisco's generators.
 *
 *   import { cityPlugin } from "@pixelworlds/city-sf";
 *   const view = await createWorldView({ canvas, worldUrl: "/sf/", style: bayArea, plugins: [cityPlugin] });
 *
 *   import { register } from "@pixelworlds/city-sf";
 *   register(); // the generators on this thread, without a view (tests, tools)
 *
 * Where the page has its own copy of the generators package (a bundled
 * build), register through that copy's API instead: `registerPlugin(plugin)`
 * from it, or `register(api)`.
 */

/**
 * For createWorldView({ plugins }): the worker module the bake worker imports,
 * by URL, and the pack's version, which keys the tile cache.
 */
export const cityPlugin: PluginDescriptor = { name: PLUGIN_NAME, url: workerUrl, version };

/**
 * Register San Francisco's generators on this thread: through `api` (a
 * registry's plugin API), or else in the registry of the generators package
 * this one imports (`pixelworld/generators`; once, later calls are no-ops).
 */
export function register(api?: PluginApi): Promise<PluginReport | void> {
  return api ? Promise.resolve(plugin.register(api)) : registerPlugin(plugin);
}

export { plugin, PLUGIN_NAME };
export { sfGenerators } from "./generators";
export { FACADE_GENERATORS, facadeOf, type Facade } from "./facades";
export { TOWER_GENERATORS, footprintDepth } from "./towers";
export { CHINATOWN_GENERATORS } from "./chinatown";
