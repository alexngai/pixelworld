import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { serveStatic } from "../../server";
import { attachDogfight, dogfightLobby } from "./server";

/**
 * The dogfight demo in production (D-114, D-118): the built page and the
 * world package, the lobby (/api), and the dogfight's rooms, on one port.
 * Built into one file with everything in it (dist/server/serve.js) beside the
 * page (dist/client), so it runs on Node alone: `node dist/server/serve.js`.
 * `PORT` (default 8080), `DOGFIGHT_LAG` (ms each way, to try it under lag).
 * Stopped (a deploy), it tells every page why before it goes.
 */
const client = fileURLToPath(new URL("../client/", import.meta.url));
const files = serveStatic(client);
let lobby: ReturnType<typeof dogfightLobby> | null = null;
const server = createServer((req, res) => lobby?.(req, res) || files(req, res));
// the world packages beside the page, read from disk (D-123)
const relay = attachDogfight(server, { lag: Number(process.env.DOGFIGHT_LAG ?? 0), worlds: client });
lobby = dogfightLobby(relay);
const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => console.log(`dogfight: http://localhost:${port}/ (rooms on /dogfight?room=, the lobby on /api)`));
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    relay.close("the server is restarting: come back in a moment");
    setTimeout(() => process.exit(0), 200); // the goodbyes out first
  });
