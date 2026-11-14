import { cpSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { bakeCode } from "../../../../../tools/bake-code.mjs";

/**
 * Fogfront (D-121): `pnpm --filter @pixelworlds/multiplayer demo:rts` serves
 * the page with the rooms on the same port (ws://…/rts?room=); `demo:rts:build`
 * builds the page (dist/client, with San Francisco's driving level) and the
 * production server (dist/server/serve.js, one file), which `demo:rts:start`
 * runs. As the dogfight's (D-114).
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

const FIXTURES = fileURLToPath(new URL("../../../../../fixtures", import.meta.url));
/** The world packages the match is on (rules.ts's RTS_WORLD): the only ones a build copies. */
const WORLDS = ["sf"];

const worlds: Plugin = {
  name: "rts-worlds",
  apply: (_, env) => env.command === "build" && !env.isSsrBuild,
  writeBundle(out) {
    for (const w of WORLDS) cpSync(`${FIXTURES}/${w}`, `${out.dir}/${w}`, { recursive: true });
  },
};

export default defineConfig(({ isSsrBuild }) => ({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: FIXTURES,
  server: { port: 5255, strictPort: true },
  preview: { port: 4255, strictPort: true },
  worker: { format: "es" },
  plugins: [bakeCode(), rooms, worlds],
  ssr: isSsrBuild ? { noExternal: true, target: "node" as const } : undefined,
  build: { outDir: isSsrBuild ? "dist/server" : "dist/client", emptyOutDir: true, copyPublicDir: false },
}));
