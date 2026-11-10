import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { bakeCode } from "../../tools/bake-code.mjs";

const fixturesDir = fileURLToPath(new URL("../../fixtures", import.meta.url));

export default defineConfig({
  // M0 serves the committed fixture world packages as static files.
  publicDir: fixturesDir,
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  worker: { format: "es" },
  // the bake code's identity, which keys the tile cache: an edit to the bake's code and a reload bakes afresh (D-072)
  plugins: [bakeCode()],
});
