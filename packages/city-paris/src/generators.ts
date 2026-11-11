import type { Generator } from "pixelworld/generators";
import { BUILDING_GENERATORS } from "./buildings";
import { LANDMARK_GENERATORS } from "./landmarks";

/** The plugin's name: the npm package's, and what style packs name in `plugins`. */
export const PLUGIN_NAME = "@pixelworlds/city-paris";

/**
 * Paris's generators: the street fabric (`haussmann`, `faubourg`, `hbm`) and
 * two landmarks (`cathedral`, `triumphalArch`). A function, so a page that
 * only names the plugin (`cityPlugin`) doesn't bundle them.
 */
export function parisGenerators(): Record<string, Generator> {
  return { ...BUILDING_GENERATORS, ...LANDMARK_GENERATORS };
}
