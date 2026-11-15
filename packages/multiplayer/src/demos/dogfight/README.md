# The dogfight demo

Planes over the Grand Canyon, on [`@pixelworlds/multiplayer`](../../../README.md) (D-113, D-114, D-116). The server runs the game: it flies every plane through the example game's flight model (`apps/game/src/plane.ts`) over the flying level, opened with `openWorld`; it fires the guns, judges hits against where the shooter saw its target, and decides health, kills and respawns. Each page predicts its own plane and draws the others a little behind, on the server's clock; shots, hits and planes going down show when the page shows that time of them. A pilot alone gets a bot (the example game's autopilot, after the nearest plane), which leaves when another pilot arrives. `&watch=1` watches instead of flying (Space for the next plane).

A match: a 10 s countdown with the guns cold, play to 10 kills or 5 minutes, 10 s of the result, and the next with the scores back to nothing. With no `?room=`, the page plays quick (the lobby's busiest room with space and over a minute left, or a new one) and puts the room's code in the address; the board has the invite link, the match's clock, ping and the prediction's last correction. Each page's own rounds are drawn at once, named by the input they were fired on, and end where the server says they hit.

| File | |
|---|---|
| `rules.ts` | the rules and messages both sides share: the tick, the guns, the rounds |
| `server.ts` | the game: a `TickRoom` per room on `/dogfight?room=`, and `attachDogfight(server)` |
| `client.ts` | the page's part: a `TickClient` flying the example game's plane, the others as `RemotePlayers`, tracers, tags, the board |
| `main.ts`, `index.html` | the page: the example game in the air at the canyon |
| `vite.config.ts` | the dev server, with the rooms and the lobby beside it (the production build is the three demos', `../vite.config.ts`) |

## Play

```sh
pnpm --filter @pixelworlds/multiplayer demo:dogfight      # http://localhost:5253/?name=You: quick play (alone: a bot; share the code: each other; &watch=1 to watch)
```

The example game's plane keys (W/S pull and push, A/D roll, Q/E rudder, Shift and Z throttle); Space fires. `DOGFIGHT_LAG=80` before the command holds every message back 80 ms each way. The board (bottom left) shows how many inputs the page is ahead of the server and the last correction (0.000 when the prediction was right). An edit to the server takes a restart of the dev server.

## Production

Built and served with the other demos on one server, at https://play.pixelworld.site/dogfight/ (D-143): the page at `/dogfight/`, its lobby on `/dogfight/api`, its rooms on `/dogfight`. `demos:build`, `demos:start` and the image are in [the package's README](../../../README.md#online-d-143).
