import type { PluginDescriptor } from "@pixelworlds/engine";
import { cityPlugin as sanFrancisco } from "@pixelworlds/city-sf";

/**
 * The city packs the viewer can load (docs/plugins.md §9.7, D-074). A world's
 * style pack names the plugins its generators come from (`"plugins"`), and the
 * viewer loads the ones listed here: San Francisco's for the bay-area pack,
 * nothing for the Southwest.
 *
 * To add a city pack: depend on it in apps/web/package.json (`"workspace:*"`
 * for one in packages/, else its npm version), run `pnpm install`, then import
 * its descriptor and add it to CITY_PACKS.
 */
export const CITY_PACKS: PluginDescriptor[] = [sanFrancisco];

/**
 * For createWorldView({ plugins }): the city packs among `names`, the plugins
 * the style pack asks for. A name not in CITY_PACKS is warned about, once,
 * with where to add it (the view then bakes without its generators).
 */
export function viewerPlugins(names: string[], packs: PluginDescriptor[] = CITY_PACKS): PluginDescriptor[] {
  const found = names.flatMap((name) => packs.filter((p) => p.name === name));
  const missing = names.filter((name) => !packs.some((p) => p.name === name) && !warned.has(name));
  for (const name of missing) warned.add(name);
  if (missing.length)
    console.warn(`viewer: no city pack ${missing.join(", ")} in apps/web/src/plugins.ts; add it to CITY_PACKS to load it (docs/plugins.md §9.7)`);
  return found;
}
const warned = new Set<string>();
