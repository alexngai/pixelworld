import { cpSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { bakeCode } from "../../../../../tools/bake-code.mjs";

/**
 * The dogfight demo (D-114): `pnpm --filter @pixelworlds/multiplayer demo:dogfight`
 * serves the page with the dogfight's rooms on the same port (ws://…/dogfight?room=);
 * `demo:dogfight:build` builds the page (dist/client, the world packages in it)
 * and the production server (dist/server/serve.js, one file, everything
 * bundled), which `demo:dogfight:start` runs.
 */

/**
 * The rooms on the dev server, loaded through Vite's module runner once it
 * listens (the config loader leaves workspace packages to Node, which can't
 * load their TypeScript). An edit to the server takes a restart.
 * DOGFIGHT_LAG=ms holds every message back that long each way.
 */
const rooms: Plugin = {
  name: "dogfight-rooms",
  configureServer(s) {
    const http = s.httpServer as Server | null;
    let lobby: ((req: IncomingMessage, res: ServerResponse) => boolean) | null = null;
    s.middlewares.use((req, res, next) => void (lobby?.(req, res) || next()));
    http?.once("listening", async () => {
      const { attachDogfight, dogfightLobby } = (await s.ssrLoadModule("/server.ts")) as typeof import("./server");
      lobby = dogfightLobby(attachDogfight(http, { lag: Number(process.env.DOGFIGHT_LAG ?? 0), worlds: FIXTURES }));
    });
  },
};

const FIXTURES = fileURLToPath(new URL("../../../../../fixtures", import.meta.url));
/** The world packages the demo flies (rules.ts's DOGFIGHT_WORLD): the only ones a build copies. */
const WORLDS = ["southwest-fly"];

/** A build of the page: only the demo's world packages beside it, not every one in fixtures/. */
const worlds: Plugin = {
  name: "dogfight-worlds",
  apply: (_, env) => env.command === "build" && !env.isSsrBuild,
  writeBundle(out) {
    for (const w of WORLDS) cpSync(`${FIXTURES}/${w}`, `${out.dir}/${w}`, { recursive: true });
  },
};

export default defineConfig(({ isSsrBuild }) => ({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // the committed world packages, served as static files by the dev server (/southwest-fly/ and the rest)
  publicDir: FIXTURES,
  server: { port: 5253, strictPort: true },
  preview: { port: 4253, strictPort: true },
  worker: { format: "es" },
  plugins: [bakeCode(), rooms, worlds], // the bake code's identity keys the tile cache (D-072)
  ssr: isSsrBuild ? { noExternal: true, target: "node" as const } : undefined,
  build: { outDir: isSsrBuild ? "dist/server" : "dist/client", emptyOutDir: true, copyPublicDir: false },
}));
