import { definePlugin } from "@pixelworld/generators";
import { plugin } from "./plugin";

/**
 * The module a bake worker imports (by URL, `cityPlugin.url`) before its
 * first bake. `definePlugin` announces the plugin to the worker, which then
 * registers it into its own registry; the default export is the same plugin,
 * for loaders that keep exports.
 */
export default definePlugin(plugin);
