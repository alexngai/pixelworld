import type { Generator } from "pixelworld/generators";
import { BUILDING_GENERATORS } from "./buildings";
import { TEMPLE_GENERATORS } from "./temples";

/** The plugin's name: the npm package's, and what style packs name in `plugins`. */
export const PLUGIN_NAME = "@pixelworlds/city-kyoto";

/**
 * Kyoto's generators: the street fabric (`machiya`, `midrise`, `kura`, `utilityPole`) and its
 * temples and shrines (`templeHall`, `towerGate`, `pagoda`) its torii (`torii`), Kinkaku-ji's type (`goldenPavilion`) and Kyoto Tower's (`candleTower`). A function, so a
 * page that only names the plugin (`cityPlugin`) doesn't bundle them.
 */
export function kyotoGenerators(): Record<string, Generator> {
  return { ...BUILDING_GENERATORS, ...TEMPLE_GENERATORS };
}
