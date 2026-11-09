import type { Generator } from "@pixelworld/generators";
import { CHINATOWN_GENERATORS } from "./chinatown";
import { FACADE_GENERATORS } from "./facades";
import { TOWER_GENERATORS } from "./towers";

/** The plugin's name: the npm package's, the Python distribution's, and what style packs name in `plugins`. */
export const PLUGIN_NAME = "pixelworld-city-sf";

/**
 * San Francisco's generators (D-055): the street fabric (`rowhouse`, whose
 * types 2 and 3 are the Sunset's stucco rows, and `block`), the towers by era
 * (`decoTower`, `sfTower`) and Chinatown's gate and lanterns. A function, so
 * a page that only names the plugin (`cityPlugin`) doesn't bundle them.
 */
export function sfGenerators(): Record<string, Generator> {
  return { ...FACADE_GENERATORS, ...TOWER_GENERATORS, ...CHINATOWN_GENERATORS };
}
