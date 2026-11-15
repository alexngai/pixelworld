import { cpSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { bakeCode } from "../../../../tools/bake-code.mjs";

/**
 * The three demos on one server (D-143), as play.pixelworld.site runs them:
 * `pnpm --filter @pixelworlds/multiplayer demos:build` builds their pages
 * (dist/client: /dogfight/, /race/ and /rts/, a page linking them at /, and
 * the world packages they are on) and one server for all their rooms and
 * lobbies (dist/server/serve.js, one file, everything bundled), which
 * `demos:start` runs. Each demo's own config is its dev server.
 */

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const FIXTURES = here("../../../../fixtures");
/** The world packages the demos are on (DOGFIGHT_WORLD, RACE_WORLD, Fogfront's MAPS): the only ones a build copies. */
export const WORLDS = ["southwest-fly", "southwest", "sf", "nyc-walk", "kyoto-walk", "hongkong-walk", "southwest-walk"];
/** This build (D-143): in the pages (`import.meta.env.PLAY_BUILD`, sent when they join a room) and in version.txt beside them, which the server reads. */
const BUILD = Date.now().toString(36);

const worlds: Plugin = {
  name: "demos-worlds",
  apply: (_, env) => env.command === "build" && !env.isSsrBuild,
  writeBundle(out) {
    for (const w of WORLDS) cpSync(`${FIXTURES}/${w}`, `${out.dir}/${w}`, { recursive: true });
    writeFileSync(`${out.dir}/version.txt`, BUILD);
  },
};

export default defineConfig(({ isSsrBuild }) => ({
  root: here("."),
  publicDir: false,
  worker: { format: "es" },
  plugins: [bakeCode(), worlds], // the bake code's identity keys the tile cache (D-072)
  define: isSsrBuild ? undefined : { "import.meta.env.PLAY_BUILD": JSON.stringify(BUILD) },
  ssr: isSsrBuild ? { noExternal: true, target: "node" as const } : undefined,
  build: {
    outDir: isSsrBuild ? "dist/server" : "dist/client",
    emptyOutDir: true,
    rollupOptions: isSsrBuild
      ? undefined
      : { input: { index: here("index.html"), dogfight: here("dogfight/index.html"), race: here("race/index.html"), rts: here("rts/index.html") } },
  },
}));
