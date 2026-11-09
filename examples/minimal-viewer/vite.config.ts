import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  // the committed world packages, served as static files (/sf/, /southwest/, …)
  publicDir: fileURLToPath(new URL("../../fixtures", import.meta.url)),
  server: { port: 5180, strictPort: true },
  preview: { port: 4180, strictPort: true },
  worker: { format: "es" },
});
