import { loadPlugin, registerPlugin, type PluginDescriptor } from "@pixelworlds/generators";
import type { PluginRef } from "@pixelworlds/runtime";
import type { WorldViewOptions } from "./types";

/**
 * A view's plugins (D-071, docs/plugins.md §9): which to load, given what the
 * style pack names, and their registration on the main thread. The bake
 * service loads them in its worker.
 */

/** The plugins a style pack names (`"plugins": ["@pixelworlds/city-sf"]`). */
export function stylePlugins(style: object): string[] {
  const p = (style as { plugins?: unknown }).plugins;
  return Array.isArray(p) ? p.filter((n): n is string => typeof n === "string") : [];
}

export interface ViewPlugins {
  descriptors: PluginDescriptor[];
  /** For the bake worker: names and absolute module URLs. */
  refs: PluginRef[];
}

/**
 * The plugins to load: the option as given, or what its function returns for
 * the names the style pack asks for. A name the style asks for that isn't
 * among them is warned about: its generators won't be there.
 */
export function viewPlugins(option: WorldViewOptions["plugins"], styleJson: object, styleId: string): ViewPlugins {
  const wanted = stylePlugins(styleJson);
  const descriptors = (typeof option === "function" ? option(wanted) : option) ?? [];
  const missing = wanted.filter((n) => !descriptors.some((d) => d.name === n));
  if (missing.length)
    console.warn(
      `the style pack ${styleId} needs the plugin${missing.length > 1 ? "s" : ""} ${missing.join(", ")}, ` +
        `which this view didn't load: models drawn by ${missing.length > 1 ? "their" : "its"} generators will fail to bake. ` +
        `Pass ${missing.length > 1 ? "them" : "it"} to createWorldView({ plugins }) (docs/plugins.md).`,
    );
  const refs = descriptors.map((d) => ({ name: d.name, url: new URL(d.url, location.href).href }));
  return { descriptors, refs };
}

/** Register the plugins on this thread (entity models, the inline baker): the plugin itself, or its module. */
export async function registerOnMainThread(p: ViewPlugins): Promise<void> {
  await Promise.all(p.descriptors.map((d, i) => (d.plugin ? registerPlugin(d.plugin) : loadPlugin(p.refs[i]!))));
}

/** The plugins' part of the tile cache key: names and versions, or nothing without plugins. */
export function pluginsKey(descriptors: PluginDescriptor[]): string[] {
  if (!descriptors.length) return [];
  const ids = descriptors.map((d) => (d.version ? `${d.name}@${d.version}` : d.name)).sort();
  return [`plugins:${ids.join(",")}`];
}
