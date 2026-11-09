import type { Plugin } from "@pixelworld/generators";
import { PLUGIN_NAME, sfGenerators } from "./generators";

/** The city pack as a plugin: it registers San Francisco's generators in the realm it is given. */
export const plugin: Plugin = {
  name: PLUGIN_NAME,
  register(api) {
    api.registerGenerators(sfGenerators());
  },
};
