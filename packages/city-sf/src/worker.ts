import { definePlugin } from "@pixelworlds/generators";
import { plugin } from "./plugin";

/**
 * The module a bake worker imports (by URL, `cityPlugin.url`) before its
 * first bake. `definePlugin` announces the plugin to the worker, which then
 * registers it through its own registry's API: a bundle that drops this
 * module's exports (Vite's worker bundles do) still works. Loaders that keep
 * exports take the default export, or `name` and `register`.
 */
export default definePlugin(plugin);
export const name = plugin.name;
export const register = plugin.register;
