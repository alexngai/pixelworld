import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { serveStatic } from "../../server";
import { attachRace, raceLobby } from "./server";

/**
 * The race demo in production (D-119): the built page and the world
 * package, the lobby (/api), and the race's rooms, on one port. Built into
 * one file with everything in it (dist/server/serve.js) beside the page
 * (dist/client), so it runs on Node alone: `node dist/server/serve.js`.
 * `PORT` (default 8080), `RACE_LAG` (ms each way, to try it under lag).
 * Stopped (a deploy), it tells every page why before it goes.
 */
const files = serveStatic(fileURLToPath(new URL("../client/", import.meta.url)));
let lobby: ReturnType<typeof raceLobby> | null = null;
const server = createServer((req, res) => lobby?.(req, res) || files(req, res));
const relay = attachRace(server, { lag: Number(process.env.RACE_LAG ?? 0) });
lobby = raceLobby(relay);
const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => console.log(`race: http://localhost:${port}/ (rooms on /race?room=, the lobby on /api)`));
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    relay.close("the server is restarting: come back in a moment");
    setTimeout(() => process.exit(0), 200); // the goodbyes out first
  });
