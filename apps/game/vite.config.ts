import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  // the committed world packages, served as static files (/southwest/, /southwest-fly/, /sf/, …)
  publicDir: fileURLToPath(new URL("../../fixtures", import.meta.url)),
  server: { port: 5252, strictPort: true },
  preview: { port: 4252, strictPort: true },
  worker: { format: "es" },
});
