import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mergeConfig, type Plugin } from "vite";
import game from "./vite.config";

/**
 * The map survey's gallery (D-175): the game's dev server on another port,
 * with an endpoint that keeps the ratings in the repo
 * (`apps/tactics/survey/ratings.json`), to fit the survey's weights to.
 *
 *   pnpm --filter @pixelworlds/tactics-game exec vite --config gallery.config.ts
 *   http://localhost:5301/survey.html?world=nyc-walk
 */
const FILE = fileURLToPath(new URL("./survey/ratings.json", import.meta.url));

const ratings = (): Plugin => ({
  name: "survey-ratings",
  configureServer(server) {
    server.middlewares.use("/__survey/ratings", (req, res) => {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => {
          // keys sorted, so the file diffs cleanly as ratings are added
          const data = JSON.parse(body) as Record<string, unknown>;
          const sorted = Object.fromEntries(Object.keys(data).sort().map((k) => [k, data[k]]));
          writeFileSync(FILE, `${JSON.stringify(sorted, null, 1)}\n`);
          res.end("ok");
        });
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(existsSync(FILE) ? readFileSync(FILE) : "{}");
    });
  },
});

export default mergeConfig(game, { server: { port: 5301 }, plugins: [ratings()] });
