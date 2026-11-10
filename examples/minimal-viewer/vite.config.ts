import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { bakeCode } from "../../tools/bake-code.mjs";

export default defineConfig({
  // the committed world packages, served as static files (/sf/, /southwest/, …)
  publicDir: fileURLToPath(new URL("../../fixtures", import.meta.url)),
  server: { port: 5180, strictPort: true },
  preview: { port: 4180, strictPort: true },
  worker: { format: "es" },
  plugins: [bakeCode()], // the bake code's identity keys the tile cache (D-072)
});
