#!/usr/bin/env node
/**
 * A Vite dev server for one app, as the e2e suite starts it (playwright.config.ts):
 *
 *   node tools/e2e-server.mjs <web|editor|game> <port>
 *
 * It is the app's own vite.config.ts on the given port (strict), plus one
 * header on every response naming the checkout it serves:
 * `X-Pixelworld-Checkout: <this checkout's root directory>`. The suite's
 * global setup (e2e/global-setup.ts) checks it, so a run never tests another
 * checkout's server by mistake. Start one yourself and run the suite with
 * PW_REUSE=1 to keep it between runs.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const APPS = ["web", "editor", "game"];
const [app, portArg] = process.argv.slice(2);
const port = Number(portArg);
if (!APPS.includes(app ?? "") || !Number.isInteger(port) || port <= 0) {
  console.error(`usage: node tools/e2e-server.mjs <${APPS.join("|")}> <port>`);
  process.exit(2);
}

const checkout = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const root = fileURLToPath(new URL(`../apps/${app}/`, import.meta.url));

const server = await createServer({
  root,
  configFile: `${root}vite.config.ts`,
  server: { port, strictPort: true },
  plugins: [
    {
      name: "pixelworld-checkout",
      configureServer(s) {
        s.middlewares.use((_req, res, next) => {
          res.setHeader("X-Pixelworld-Checkout", checkout);
          next();
        });
      },
    },
  ],
});
await server.listen();
server.printUrls();
