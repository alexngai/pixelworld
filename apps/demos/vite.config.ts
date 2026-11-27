import { cpSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { bakeCode } from "../../tools/bake-code.mjs";

/**
 * The three demos on one server (D-143), as play.pixelworld.site runs them:
 * `pnpm --filter @pixelworlds/demos build` builds their pages
 * (dist/client: /dogfight/, /race/ and /rts/, a page linking them at /, and
 * the world packages they are on; Hold the Block, apps/tactics, is built into
 * /tactics/ by its own config, D-184) and one server for all their rooms and
 * lobbies (dist/server/serve.js, one file, everything bundled), which
 * `pnpm --filter @pixelworlds/demos start` runs. Each demo's own config is its dev server.
 */

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const FIXTURES = here("../../fixtures");
/** The world packages the demos are on (DOGFIGHT_WORLD, RACE_WORLD, Fogfront's MAPS, Hold the Block's cities, D-184): the only ones a build copies. */
export const WORLDS = ["southwest-fly", "southwest", "sf", "nyc-walk", "kyoto-walk", "hongkong-walk", "southwest-walk", "sf-walk", "paris-walk", "tokyo-walk"];
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
  root: here("src"),
  publicDir: false,
  worker: { format: "es" },
  plugins: [bakeCode(), worlds], // the bake code's identity keys the tile cache (D-072)
  define: isSsrBuild ? undefined : { "import.meta.env.PLAY_BUILD": JSON.stringify(BUILD) },
  ssr: isSsrBuild ? { noExternal: true, target: "node" as const } : undefined,
  build: {
    outDir: isSsrBuild ? here("dist/server") : here("dist/client"),
    emptyOutDir: true,
    rollupOptions: isSsrBuild
      ? undefined
      : { input: { index: here("src/index.html"), dogfight: here("src/dogfight/index.html"), race: here("src/race/index.html"), rts: here("src/rts/index.html") } },
  },
}));
