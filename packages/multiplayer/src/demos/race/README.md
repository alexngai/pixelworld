# The race demo

Cars round the Las Vegas Strip, on [`@pixelworlds/multiplayer`](../../../README.md) (D-119). The server runs the game: it drives every car through the example game's car physics (`apps/game/src/car.ts`) over the Southwest's driving level, opened with `openWorld`, with its routes for the road decks; it judges the checkpoints, laps and bumps, and times each car in its own steps. Each page predicts its own car and draws the others a little behind, on the server's clock. Bots (the example game's `CarPilot`) make up the field to four. `&watch=1` watches instead of driving (Space for the next car). There is no traffic: the race closes the streets.

**The course,** clockwise, about 127 cells (a lap ~25 s): north up the Strip past Flamingo and Caesars to Sahara, east to Paradise Road and south down it, west along Tropicana, and north up the Strip again. It is planned on the level's routes through five waypoints (`COURSE` in `rules.ts`). Eight checkpoints are evenly round it, each passed within 2.5 cells, in order; the first is the start and finish line, on the Strip's straight between Tropicana and Flamingo, with the grid behind it in single file.

**A race:** waiting for drivers; an 8 s countdown on the grid, the cars held; three laps (at most 5 minutes, and 30 s for the rest once the winner is in); 12 s of the results (times and best laps); and the next. A car's clock is its own steps since the start, so the page's lap times are the server's to the tick. R puts the car back at its last checkpoint. A car whose page goes quiet for half a second is stalled, and the others drive through it, as through a finished car. A driver who arrives mid-race waits on the grid for the next one; quick play skips rooms that are racing.

**Bumps:** a car bumps into the others where its driver saw them (rewound by its lag, at most 0.3 s), never where they moved this tick, so the order cars are stepped in doesn't matter, and a page's prediction holds through a bump. Whatever the server still judges otherwise (a car let go at the start, frozen at the end, or another car's reset) is drawn easing out, not snapped. The car in front isn't slowed by one behind it (the game's rule).

| File | |
|---|---|
| `rules.ts` | the rules and messages both sides share: the course, checkpoints, laps, the grid, a racer's tick, bumps |
| `server.ts` | the game: a `RaceRoom` (a `TickRoom`) per room on `/race?room=`, the bots, and `attachRace(server)` |
| `client.ts` | the page's part: a `TickClient` driving the example game's car, the others as `RemotePlayers`, the gates, tags, the board |
| `main.ts`, `index.html` | the page: the example game in the car at the Strip, without traffic |
| `serve.ts` | the production server: the built page and its world, and the rooms, on one port |
| `vite.config.ts` | the dev server (the rooms beside it) and both builds |
| `Dockerfile` | the image |

## Play

```sh
pnpm --filter @pixelworlds/multiplayer demo:race      # http://localhost:5254/?name=You: quick play (bots make up the field; share the code: each other; &watch=1 to watch)
```

The example game's car keys (W/↑ throttle, S/↓ brake and reverse, A/D or ←/→ steer, G the road assist), R back to the last checkpoint, 1–6 the zoom. `RACE_LAG=80` before the command holds every message back 80 ms each way. The board (bottom left) shows your place, lap and time, the standings, how many inputs the page is ahead of the server and the last correction (0.000 when the prediction was right). An edit to the server takes a restart of the dev server.

## Production

```sh
pnpm --filter @pixelworlds/multiplayer demo:race:build   # dist/client (the page and the southwest package) and dist/server/serve.js (one file)
pnpm --filter @pixelworlds/multiplayer demo:race:start   # http://localhost:8080/; PORT, RACE_LAG; the lobby on /api, a log line per room event, and a reason to every page when stopped
```

Docker, from the repository's root:

```sh
docker build -f packages/multiplayer/src/demos/race/Dockerfile -t pixelworld-race .
docker run --rm -p 8080:8080 pixelworld-race
```

Rooms live in the server's memory, so run exactly one instance (the dogfight's `fly.toml` works for it with the names changed).
