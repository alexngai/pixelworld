import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { bakeCode } from "../../../../tools/bake-code.mjs";

/**
 * Fogfront's dev server (D-121): `pnpm --filter @pixelworlds/multiplayer demo:rts` serves
 * the page with the rooms and lobby on the same port (ws://…/rts?room=,
 * /rts/api). The production build is the three demos' together
 * (../vite.config.ts, D-143).
 */

/** The rooms on the dev server, loaded through Vite's module runner once it listens. RTS_LAG=ms holds every message back that long each way. */
const rooms: Plugin = {
  name: "rts-rooms",
  configureServer(s) {
    const http = s.httpServer as Server | null;
    let lobby: ((req: IncomingMessage, res: ServerResponse) => boolean) | null = null;
    s.middlewares.use((req, res, next) => void (lobby?.(req, res) || next()));
    http?.once("listening", async () => {
      const { attachRts, rtsLobby } = (await s.ssrLoadModule("/server.ts")) as typeof import("./server");
      lobby = rtsLobby(attachRts(http, { lag: Number(process.env.RTS_LAG ?? 0) }));
    });
  },
};

const FIXTURES = fileURLToPath(new URL("../../../../fixtures", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: FIXTURES,
  server: { port: 5255, strictPort: true },
  worker: { format: "es" },
  plugins: [bakeCode(), rooms],
});
