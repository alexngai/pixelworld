import { registerPlugin, type PluginApi, type PluginDescriptor, type PluginReport } from "pixelworld/generators";
import { version } from "../package.json";
import { PLUGIN_NAME } from "./generators";
import { plugin } from "./plugin";
// In the workspace, Vite builds the worker module on its own (dependencies included) and
// gives its URL. The package build (build.mjs) replaces this line with
// new URL("./worker.js", import.meta.url), which Vite, webpack 5 and Rollup follow.
import workerUrl from "./worker?worker&url";

/**
 * @pixelworlds/city-nyc: New York's city pack (D-081). The pipeline half
 * (PLUTO and LPC facts) is the Python distribution pixelworld-city-nyc; this
 * is the browser half, New York's generators. The new-york style pack names
 * it beside San Francisco's pack, whose `block` and towers it reuses, so a
 * view loads both (San Francisco's `cityPlugin` and this one):
 *
 *   import { cityPlugin as newYork } from "@pixelworlds/city-nyc";
 *   const view = await createWorldView({ canvas, worldUrl: "/nyc/", style: newYorkStyle, plugins: [sanFrancisco, newYork] });
 *
 *   import { register } from "@pixelworlds/city-nyc";
 *   register(); // the generators on this thread, without a view (tests, tools)
 */

/**
 * For createWorldView({ plugins }): the worker module the bake worker imports,
 * by URL, and the pack's version, which keys the tile cache.
 */
export const cityPlugin: PluginDescriptor = { name: PLUGIN_NAME, url: workerUrl, version };

/**
 * Register New York's generators on this thread: through `api` (a registry's
 * plugin API), or else in the registry of the generators package this one
 * imports (`pixelworld/generators`; once, later calls are no-ops).
 */
export function register(api?: PluginApi): Promise<PluginReport | void> {
  return api ? Promise.resolve(plugin.register(api)) : registerPlugin(plugin);
}

export { plugin, PLUGIN_NAME };
export { nycGenerators } from "./generators";
export { BUILDING_GENERATORS } from "./buildings";
export { facadeOf, type Facade } from "./facade";
