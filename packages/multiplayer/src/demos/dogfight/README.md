# The dogfight demo

Planes over the Grand Canyon, on [`@pixelworlds/multiplayer`](../../../README.md) (D-113, D-114, D-116). The server runs the game: it flies every plane through the example game's flight model (`apps/game/src/plane.ts`) over the flying level, opened with `openWorld`; it fires the guns, judges hits against where the shooter saw its target, and decides health, kills and respawns. Each page predicts its own plane and draws the others a little behind, on the server's clock; shots, hits and planes going down show when the page shows that time of them. A pilot alone gets a bot (the example game's autopilot, after the nearest plane), which leaves when another pilot arrives. `&watch=1` watches instead of flying (Space for the next plane).

| File | |
|---|---|
| `rules.ts` | the rules and messages both sides share: the tick, the guns, the rounds |
| `server.ts` | the game: a `TickRoom` per room on `/dogfight?room=`, and `attachDogfight(server)` |
| `client.ts` | the page's part: a `TickClient` flying the example game's plane, the others as `RemotePlayers`, tracers, tags, the board |
| `main.ts`, `index.html` | the page: the example game in the air at the canyon |
| `serve.ts` | the production server: the built page and its world, and the rooms, on one port |
| `vite.config.ts` | the dev server (the rooms beside it) and both builds |
| `Dockerfile`, `fly.toml` | the image, and Fly.io |

## Play

```sh
pnpm --filter @pixelworlds/multiplayer demo:dogfight      # http://localhost:5253/?room=canyon&name=You (alone: a bot; two windows: each other; &watch=1 to watch)
```

The example game's plane keys (W/S pull and push, A/D roll, Q/E rudder, Shift and Z throttle); Space fires. `DOGFIGHT_LAG=80` before the command holds every message back 80 ms each way. The board (bottom left) shows how many inputs the page is ahead of the server and the last correction (0.000 when the prediction was right). An edit to the server takes a restart of the dev server.

## Production

```sh
pnpm --filter @pixelworlds/multiplayer demo:dogfight:build   # dist/client (the page and southwest-fly) and dist/server/serve.js (one file)
pnpm --filter @pixelworlds/multiplayer demo:dogfight:start   # http://localhost:8080/?room=canyon; PORT, DOGFIGHT_LAG
```

Docker, from the repository's root:

```sh
docker build -f packages/multiplayer/src/demos/dogfight/Dockerfile -t pixelworld-dogfight .
docker run --rm -p 8080:8080 pixelworld-dogfight
```

Fly.io: the commands are at the top of `fly.toml`. Rooms live in the server's memory, so run exactly one machine. It stops when idle and wakes on the next visit.
