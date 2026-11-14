import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { serveStatic } from "../../server";
import { DAY } from "./rules";
import { attachRts, rtsLobby } from "./server";

/**
 * Fogfront in production (D-121): the built page and its level, the lobby
 * (/api), and the rooms (/rts), on one port, as the dogfight's (D-114). Built
 * into one file (dist/server/serve.js) beside the page (dist/client), so it
 * runs on Node alone. `PORT` (default 8080), `RTS_LAG` (ms each way),
 * `RTS_DAY` (seconds of day and of night, `240,90` by default).
 */
// RTS_DAY=day,night (seconds): a quicker day and night, to see the night come (D-125)
const [day, night] = (process.env.RTS_DAY ?? "").split(",").map(Number);
if (day! > 0 && night! > 0) Object.assign(DAY, { day, night });
const files = serveStatic(fileURLToPath(new URL("../client/", import.meta.url)));
let lobby: ReturnType<typeof rtsLobby> | null = null;
const server = createServer((req, res) => lobby?.(req, res) || files(req, res));
const relay = attachRts(server, { lag: Number(process.env.RTS_LAG ?? 0) });
lobby = rtsLobby(relay);
const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => console.log(`fogfront: http://localhost:${port}/ (rooms on /rts?room=, the lobby on /api)`));
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    relay.close("the server is restarting: come back in a moment");
    setTimeout(() => process.exit(0), 200);
  });
