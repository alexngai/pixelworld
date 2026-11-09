import { registerPlugin, type PluginDescriptor, type PluginReport } from "@pixelworld/generators";
import { PLUGIN_NAME } from "./generators";
import { plugin } from "./plugin";
// Vite builds the worker module on its own (dependencies included) and gives its URL;
// a library build turns this into new URL("…", import.meta.url), which bundlers follow.
import workerUrl from "./worker?worker&url";

/**
 * pixelworld-city-sf: San Francisco's city pack (D4 in docs/library.md,
 * D-071). The pipeline half (DataSF facts) is the Python distribution of the
 * same name; this is the browser half, San Francisco's generators.
 *
 *   import { cityPlugin } from "pixelworld-city-sf";
 *   const view = await createWorldView({ canvas, worldUrl: "/sf/", style: bayArea, plugins: [cityPlugin] });
 *
 *   import { register } from "pixelworld-city-sf";
 *   register(); // the generators on this thread, without a view (tests, tools)
 */

/** For createWorldView({ plugins }): the worker module the bake worker imports, by URL. */
export const cityPlugin: PluginDescriptor = { name: PLUGIN_NAME, url: workerUrl };

/** Register San Francisco's generators on this thread (once; later calls are no-ops). */
export function register(): Promise<PluginReport> {
  return registerPlugin(plugin);
}

export { plugin, PLUGIN_NAME };
export { sfGenerators } from "./generators";
export { FACADE_GENERATORS, facadeOf, type Facade } from "./facades";
export { TOWER_GENERATORS, footprintDepth } from "./towers";
export { CHINATOWN_GENERATORS } from "./chinatown";
