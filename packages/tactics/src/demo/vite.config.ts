import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { bakeCode } from "../../../../tools/bake-code.mjs";

/** The tactics sandbox (D-147–D-149): `pnpm --filter @pixelworlds/tactics demo`, http://localhost:5290. */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // the committed world packages, served as static files (/nyc-walk/, /kyoto-walk/, …)
  publicDir: fileURLToPath(new URL("../../../../fixtures", import.meta.url)),
  server: { port: 5290, strictPort: true },
  worker: { format: "es" },
  plugins: [bakeCode()], // the bake code's identity keys the tile cache (D-072)
});
