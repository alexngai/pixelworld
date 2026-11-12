import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { attachRelay } from "@pixelworlds/multiplayer/server";
import { defineConfig } from "vite";
import { bakeCode } from "../../tools/bake-code.mjs";

export default defineConfig({
  // the committed world packages, served as static files (/southwest/, /southwest-fly/, /sf/, …)
  publicDir: fileURLToPath(new URL("../../fixtures", import.meta.url)),
  server: { port: 5252, strictPort: true },
  preview: { port: 4252, strictPort: true },
  worker: { format: "es" },
  plugins: [
    bakeCode(), // the bake code's identity keys the tile cache (D-072)
    {
      // the dogfight's relay (D-112), on the dev and preview servers' own port: ws://…/relay?room=
      name: "relay",
      configureServer: (s) => void (s.httpServer && attachRelay(s.httpServer as Server)),
      configurePreviewServer: (s) => void attachRelay(s.httpServer as Server),
    },
  ],
});
