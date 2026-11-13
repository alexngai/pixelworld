import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { bakeCode } from "../../tools/bake-code.mjs";

/**
 * The dogfight's server (D-113), on the dev server's own port: ws://…/dogfight?room=.
 * Loaded through Vite's module runner once the server listens, as Vitest runs
 * it: the engine's sources are TypeScript, which the config loader leaves to
 * Node. An edit to it takes a restart. DOGFIGHT_LAG=ms holds every message
 * back that long each way, to try it under lag.
 */
const dogfight: Plugin = {
  name: "dogfight",
  configureServer(s) {
    const http = s.httpServer as Server | null;
    http?.once("listening", async () => {
      const { attachDogfight } = (await s.ssrLoadModule("/src/dogfightServer.ts")) as typeof import("./src/dogfightServer");
      attachDogfight(http, { styles: new URL("../../worlds/_styles/", import.meta.url), lag: Number(process.env.DOGFIGHT_LAG ?? 0) });
    });
  },
};

export default defineConfig({
  // the committed world packages, served as static files (/southwest/, /southwest-fly/, /sf/, …)
  publicDir: fileURLToPath(new URL("../../fixtures", import.meta.url)),
  server: { port: 5252, strictPort: true },
  preview: { port: 4252, strictPort: true },
  worker: { format: "es" },
  plugins: [
    bakeCode(), // the bake code's identity keys the tile cache (D-072)
    dogfight,
  ],
});
