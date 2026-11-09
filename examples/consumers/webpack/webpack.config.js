import { fileURLToPath } from "node:url";

/**
 * Nothing pixelworld-specific: webpack 5 sees the engine's
 * `new Worker(new URL("./bake.worker.js", import.meta.url), { type: "module" })`
 * and emits the bake worker as its own chunk. Serve dist/ and public/ together.
 */
export default {
  mode: "production",
  entry: "./src/main.js",
  output: {
    path: fileURLToPath(new URL("./dist/", import.meta.url)),
    filename: "main.js",
    clean: true,
  },
  devtool: "source-map",
  performance: { hints: false },
};
