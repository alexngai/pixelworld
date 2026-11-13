import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { serveStatic } from "../../server";
import { attachDogfight } from "./server";

/**
 * The dogfight demo in production (D-114): the built page and the world
 * packages, and the dogfight's rooms, on one port. Built into one file with
 * everything in it (dist/server/serve.js) beside the page (dist/client), so
 * it runs on Node alone: `node dist/server/serve.js`. `PORT` (default 8080),
 * `DOGFIGHT_LAG` (ms each way, to try it under lag).
 */
const root = fileURLToPath(new URL("../client/", import.meta.url));
const server = createServer(serveStatic(root));
attachDogfight(server, { lag: Number(process.env.DOGFIGHT_LAG ?? 0) });
const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => console.log(`dogfight: http://localhost:${port}/ (rooms on /dogfight?room=)`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
