import type { Generator } from "pixelworld/generators";
import { BUILDING_GENERATORS } from "./buildings";
import { LANDMARK_GENERATORS } from "./landmarks";
import { PROP_GENERATORS } from "./props";

/** The plugin's name: the npm package's, and what style packs name in `plugins` (the Python half is pixelworld-city-jp). */
export const PLUGIN_NAME = "@pixelworlds/city-tokyo";

/**
 * Tokyo's generators (D-092): the street fabric no other pack draws.
 * `zakkyo` (the narrow mixed-use mid-rise under stacked signs), `mansion`
 * (the apartment slab with continuous balconies) and `kodate` (the small
 * detached house); the landmark shapes `twinTowerHall`, `cylinderTower` and
 * `myojinTorii`; and `utilityPoles` and `wireSpan`, the poles and the wires
 * strung between them over residential streets. A function, so a page that only names the plugin (`cityPlugin`)
 * doesn't bundle them.
 */
export function tokyoGenerators(): Record<string, Generator> {
  return { ...BUILDING_GENERATORS, ...LANDMARK_GENERATORS, ...PROP_GENERATORS };
}
