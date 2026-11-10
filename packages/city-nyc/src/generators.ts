import type { Generator } from "pixelworld/generators";
import { BUILDING_GENERATORS } from "./buildings";

/** The plugin's name: the npm package's, and what style packs name in `plugins` (the Python half is pixelworld-city-nyc). */
export const PLUGIN_NAME = "@pixelworlds/city-nyc";

/**
 * New York's generators (D-081): the street fabric San Francisco's `rowhouse`
 * and `block` can't draw. `brownstone` (stoops, bracketed cornices),
 * `tenement` (fire escapes, shopfronts), `castIronLoft` (columns and big
 * windows) and `prewarBlock` (base, shaft and cap, water tanks). A function,
 * so a page that only names the plugin (`cityPlugin`) doesn't bundle them.
 */
export function nycGenerators(): Record<string, Generator> {
  return { ...BUILDING_GENERATORS };
}
