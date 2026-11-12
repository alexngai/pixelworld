import type { Plugin } from "pixelworld/generators";
import { PLUGIN_NAME, parisGenerators } from "./generators";

/** The city pack as a plugin: it registers Paris's generators in the realm it is given. */
export const plugin: Plugin = {
  name: PLUGIN_NAME,
  register(api) {
    api.registerGenerators(parisGenerators());
  },
};
