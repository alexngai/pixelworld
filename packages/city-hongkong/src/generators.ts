import type { Generator } from "pixelworld/generators";
import { BUILDING_GENERATORS } from "./buildings";
import { LANDMARK_GENERATORS } from "./landmarks";
import { PROP_GENERATORS } from "./props";

/** The plugin's name: the npm package's, and what style packs name in `plugins`. */
export const PLUGIN_NAME = "@pixelworlds/city-hongkong";

/**
 * Hong Kong's generators (D-108): the street fabric of Kowloon, `tongLau`
 * (the tenement of the 1950s and 60s, rows of them), `compositeTower` (the
 * slender commercial-residential block of the 60s to 80s, and the low malls
 * and podiums) and `pencilTower` (the slim residential tower); the landmark
 * shapes `curvedRoofHall` and `grandHotel`; and `neonSign`, the signs that
 * hang over the street from both sides. A function, so a page that only
 * names the plugin (`cityPlugin`) doesn't bundle them.
 */
export function hongKongGenerators(): Record<string, Generator> {
  return { ...BUILDING_GENERATORS, ...LANDMARK_GENERATORS, ...PROP_GENERATORS };
}
