import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { serveStatic } from "../server";
import { attachDogfight, dogfightLobby } from "./dogfight/server";
import { attachRace, raceLobby } from "./race/server";
import { DAY } from "./rts/rules";
import { attachRts, rtsLobby } from "./rts/server";

/**
 * The three demos in production (D-143), as play.pixelworld.site runs them:
 * their built pages (/dogfight/, /race/, /rts/) and world packages, each
 * game's lobby (/dogfight/api, /race/api, /rts/api) and rooms (/dogfight,
 * /race, /rts), on one port. Built into one file with everything in it
 * (dist/server/serve.js) beside the pages (dist/client), so it runs on Node
 * alone. A page from another build is told to reload; a socket from a page on
 * another site is refused.
 *
 * `PORT` (default 8080); `DOGFIGHT_LAG`, `RACE_LAG`, `RTS_LAG` (ms each way,
 * to try a game under lag); `RTS_DAY` (seconds of day and of night, `240,90`
 * by default). Stopped (a deploy), it tells every page why before it goes.
 */
const client = fileURLToPath(new URL("../client/", import.meta.url));
const files = serveStatic(client);
const version = readFileSync(`${client}version.txt`, "utf8").trim();
// RTS_DAY=day,night (seconds): a quicker day and night, to see the night come (D-125)
const [day, night] = (process.env.RTS_DAY ?? "").split(",").map(Number);
if (day! > 0 && night! > 0) Object.assign(DAY, { day, night });

let lobbies: ((req: IncomingMessage, res: ServerResponse) => boolean)[] = [];
const server = createServer((req, res) => lobbies.some((lobby) => lobby(req, res)) || files(req, res));
const lag = (name: string) => Number(process.env[name] ?? 0);
const checks = { version, sameOrigin: true };
// the dogfight reads its world from disk (D-123); the race and Fogfront fetch theirs from this server
const dogfight = attachDogfight(server, { ...checks, lag: lag("DOGFIGHT_LAG"), worlds: client });
const race = attachRace(server, { ...checks, lag: lag("RACE_LAG") });
const rts = attachRts(server, { ...checks, lag: lag("RTS_LAG") });
lobbies = [dogfightLobby(dogfight), raceLobby(race), rtsLobby(rts)];

const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => console.log(`demos (build ${version}): http://localhost:${port}/ (/dogfight/, /race/, /rts/)`));
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    for (const relay of [dogfight, race, rts]) relay.close("the server is restarting: come back in a moment");
    setTimeout(() => process.exit(0), 200); // the goodbyes out first
  });
