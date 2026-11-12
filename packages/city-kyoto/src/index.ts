import { registerPlugin, type PluginApi, type PluginDescriptor, type PluginReport } from "pixelworld/generators";
import { version } from "../package.json";
import { PLUGIN_NAME } from "./generators";
import { plugin } from "./plugin";
// In the workspace, Vite builds the worker module on its own (dependencies included) and
// gives its URL. The package build (build.mjs) replaces this line with
// new URL("./worker.js", import.meta.url), which Vite, webpack 5 and Rollup follow.
import workerUrl from "./worker?worker&url";

/**
 * @pixelworlds/city-kyoto: Kyoto's city pack, the browser half (its
 * generators). The kyoto style pack names it, and needs no other pack:
 *
 *   import { cityPlugin as kyoto } from "@pixelworlds/city-kyoto";
 *   const view = await createWorldView({ canvas, worldUrl: "/kyoto/", style: kyotoStyle, plugins: [kyoto] });
 *
 *   import { register } from "@pixelworlds/city-kyoto";
 *   register(); // the generators on this thread, without a view (tests, tools)
 */

/**
 * For createWorldView({ plugins }): the worker module the bake worker imports,
 * by URL, and the pack's version, which keys the tile cache.
 */
export const cityPlugin: PluginDescriptor = { name: PLUGIN_NAME, url: workerUrl, version };

/**
 * Register Kyoto's generators on this thread: through `api` (a registry's
 * plugin API), or else in the registry of the generators package this one
 * imports (`pixelworld/generators`; once, later calls are no-ops).
 */
export function register(api?: PluginApi): Promise<PluginReport | void> {
  return api ? Promise.resolve(plugin.register(api)) : registerPlugin(plugin);
}

export { plugin, PLUGIN_NAME };
export { kyotoGenerators } from "./generators";
export { BUILDING_GENERATORS } from "./buildings";
export { TEMPLE_GENERATORS } from "./temples";
export { facadeOf, type Facade } from "./kit";
