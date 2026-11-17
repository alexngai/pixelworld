import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { bakeCode } from "../../tools/bake-code.mjs";

/** The tactics game (D-153): `pnpm --filter @pixelworlds/tactics-game dev`, http://localhost:5300. */
export default defineConfig({
  // the committed world packages, served as static files (/nyc-walk/, /kyoto-walk/, …)
  publicDir: fileURLToPath(new URL("../../fixtures", import.meta.url)),
  server: { port: 5300, strictPort: true },
  preview: { port: 4300, strictPort: true },
  worker: { format: "es" },
  plugins: [bakeCode()], // the bake code's identity keys the tile cache (D-072)
});
