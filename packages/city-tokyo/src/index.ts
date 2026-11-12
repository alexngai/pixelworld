import { registerPlugin, type PluginApi, type PluginDescriptor, type PluginReport } from "pixelworld/generators";
import { version } from "../package.json";
import { PLUGIN_NAME } from "./generators";
import { plugin } from "./plugin";
// In the workspace, Vite builds the worker module on its own (dependencies included) and
// gives its URL. The package build (build.mjs) replaces this line with
// new URL("./worker.js", import.meta.url), which Vite, webpack 5 and Rollup follow.
import workerUrl from "./worker?worker&url";

/**
 * @pixelworlds/city-tokyo: Tokyo's city pack (D-092). The pipeline half
 * (PLATEAU's facts and GSI's elevation tiles) is the pipeline's built-in
 * `plateau` facts and `gsi-dem` terrain sources; this is the browser half, Tokyo's generators. The
 * tokyo style pack names it beside San Francisco's pack, whose `block` and
 * towers it reuses, so a view loads both:
 *
 *   import { cityPlugin as tokyo } from "@pixelworlds/city-tokyo";
 *   const view = await createWorldView({ canvas, worldUrl: "/tokyo-walk/", style: tokyoStyle, plugins: [sanFrancisco, tokyo] });
 *
 *   import { register } from "@pixelworlds/city-tokyo";
 *   register(); // the generators on this thread, without a view (tests, tools)
 */

/**
 * For createWorldView({ plugins }): the worker module the bake worker imports,
 * by URL, and the pack's version, which keys the tile cache.
 */
export const cityPlugin: PluginDescriptor = { name: PLUGIN_NAME, url: workerUrl, version };

/**
 * Register Tokyo's generators on this thread: through `api` (a registry's
 * plugin API), or else in the registry of the generators package this one
 * imports (`pixelworld/generators`; once, later calls are no-ops).
 */
export function register(api?: PluginApi): Promise<PluginReport | void> {
  return api ? Promise.resolve(plugin.register(api)) : registerPlugin(plugin);
}

export { plugin, PLUGIN_NAME };
export { tokyoGenerators } from "./generators";
export { BUILDING_GENERATORS } from "./buildings";
export { LANDMARK_GENERATORS } from "./landmarks";
export { PROP_GENERATORS } from "./props";
export { facadeOf, type Facade } from "./facade";
