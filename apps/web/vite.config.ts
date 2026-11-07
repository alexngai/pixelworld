import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const fixturesDir = fileURLToPath(new URL("../../fixtures", import.meta.url));

export default defineConfig({
  // M0 serves the committed fixture world packages as static files.
  publicDir: fixturesDir,
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  worker: { format: "es" },
});
