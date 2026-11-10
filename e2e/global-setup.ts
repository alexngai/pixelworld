import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SERVERS } from "../playwright.config";

const canonical = (dir: string) => {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
};

/**
 * Before any test: every server the suite talks to must serve this checkout.
 * tools/e2e-server.mjs marks its responses with the checkout's root; a server
 * from another checkout, or one started some other way, fails the run here
 * instead of being tested silently (PW_REUSE=1 reuses servers already up).
 */
export default async function globalSetup(): Promise<void> {
  const here = canonical(fileURLToPath(new URL("..", import.meta.url)));
  for (const { app, port } of SERVERS) {
    const url = `http://localhost:${port}/`;
    const res = await fetch(url);
    await res.body?.cancel();
    const served = res.headers.get("x-pixelworld-checkout");
    const fix = "stop it, or run on other ports with PW_PORT (playwright.config.ts)";
    if (served === null)
      throw new Error(`${url} (${app}) doesn't say which checkout it serves: it wasn't started by tools/e2e-server.mjs. ${fix}`);
    if (canonical(served) !== here) throw new Error(`${url} (${app}) serves another checkout, ${served}: ${fix}`);
  }
}
