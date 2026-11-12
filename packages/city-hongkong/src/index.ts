import { registerPlugin, type PluginApi, type PluginDescriptor, type PluginReport } from "pixelworld/generators";
import { version } from "../package.json";
import { PLUGIN_NAME } from "./generators";
import { plugin } from "./plugin";
// In the workspace, Vite builds the worker module on its own (dependencies included) and
// gives its URL. The package build (build.mjs) replaces this line with
// new URL("./worker.js", import.meta.url), which Vite, webpack 5 and Rollup follow.
import workerUrl from "./worker?worker&url";

/**
 * @pixelworlds/city-hongkong: Hong Kong's city pack (D-108), the browser
 * half (its generators). The hongkong style pack names it beside San
 * Francisco's pack, whose `block` and `sfTower` it reuses, so a view loads both:
 *
 *   import { cityPlugin as hongKong } from "@pixelworlds/city-hongkong";
 *   const view = await createWorldView({ canvas, worldUrl: "/hongkong-walk/", style: hongKongStyle, plugins: [sanFrancisco, hongKong] });
 *
 *   import { register } from "@pixelworlds/city-hongkong";
 *   register(); // the generators on this thread, without a view (tests, tools)
 */

/**
 * For createWorldView({ plugins }): the worker module the bake worker imports,
 * by URL, and the pack's version, which keys the tile cache.
 */
export const cityPlugin: PluginDescriptor = { name: PLUGIN_NAME, url: workerUrl, version };

/**
 * Register Hong Kong's generators on this thread: through `api` (a registry's
 * plugin API), or else in the registry of the generators package this one
 * imports (`pixelworld/generators`; once, later calls are no-ops).
 */
export function register(api?: PluginApi): Promise<PluginReport | void> {
  return api ? Promise.resolve(plugin.register(api)) : registerPlugin(plugin);
}

export { plugin, PLUGIN_NAME };
export { hongKongGenerators } from "./generators";
export { BUILDING_GENERATORS } from "./buildings";
export { LANDMARK_GENERATORS } from "./landmarks";
export { PROP_GENERATORS } from "./props";
