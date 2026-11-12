import type { Plugin } from "pixelworld/generators";
import { PLUGIN_NAME, tokyoGenerators } from "./generators";

/** The city pack as a plugin: it registers Tokyo's generators in the realm it is given. */
export const plugin: Plugin = {
  name: PLUGIN_NAME,
  register(api) {
    api.registerGenerators(tokyoGenerators());
  },
};
