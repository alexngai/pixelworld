import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { bakeCode } from "../../tools/bake-code.mjs";

/** The co-op rooms (D-179) on the dev server, ws://…/hold?room=, loaded through Vite's module runner once it listens. */
const rooms: Plugin = {
  name: "tactics-rooms",
  configureServer(s) {
    const http = s.httpServer as Server | null;
    http?.once("listening", async () => {
      const { attachCoop } = (await s.ssrLoadModule("/src/coopServer.ts")) as typeof import("./src/coopServer");
      attachCoop(http);
    });
  },
};

/** The tactics game (D-153): `pnpm --filter @pixelworlds/tactics-game dev`, http://localhost:5300. */
export default defineConfig({
  // the committed world packages, served as static files (/nyc-walk/, /kyoto-walk/, …)
  publicDir: fileURLToPath(new URL("../../fixtures", import.meta.url)),
  server: { port: 5300, strictPort: true },
  preview: { port: 4300, strictPort: true },
  worker: { format: "es" },
  plugins: [bakeCode(), rooms], // the bake code's identity keys the tile cache (D-072)
});
