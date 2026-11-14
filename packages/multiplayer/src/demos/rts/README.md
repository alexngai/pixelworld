# Fogfront

A small real-time strategy game on [`@pixelworlds/multiplayer`](../../../README.md) (D-121), the basis of a base-building mode: gather a resource, place buildings, train units, and send groups to move and fight. Two guilds, **the Kiln** (red) and **the Tide** (blue), race for **glim** on the Presidio, on San Francisco's driving level at 25 m a cell: the Kiln starts on Baker Beach, the Tide on Crissy Field, with three glim seeps by each hearth and two in clearings of the woods between.

- **Runners** carry glim from a seep to their hearth (10 a trip, 2 s to mine). A new runner goes to the nearest seep by itself.
- **The hearth** (3×3 cells) trains runners. If it falls, its side loses.
- **A lodge** (2×2, 120 glim, 15 s to rise) trains **wardens** (80 glim), who fight: 9 a blow, a blow a second, within 1.4 cells. A lodge goes up within 12 cells of one's own buildings, on dry, level ground with no woods, building, unit or seep on it.
- **The level's buildings** stand in the way until wardens knock them down (D-124): each has hit points from its size and height (130–560 on the Presidio). One that falls is taken out of every page's world (`view.edits`, its tiles baked again) and leaves rubble, and its cells open for paths and lodges. A new match puts them all back.
- **The map** is read from the level's own queries: water and the level's buildings are walls, a step may climb at most 1.5 height steps (the bluffs are walls), roads are 1.5× quicker and woods 0.6× (and can't be built on). Units walk A* paths over those cells.
- **The fog of war:** each side sees the other's units only within sight of its own (6–8 cells); the hearths are known from the start, and other buildings once seen.
- **Orders:** move, fight-move (taking on whatever comes into sight on the way), attack, gather, stop. Idle wardens take on foes that come into sight.
- **A match:** two pages play each other; a page alone gets the bot after 20 s, or at once with `?vs=bot`. A side whose hearth falls, or whose player leaves, loses; after 15 s of the result the next match starts with whoever is there. A third page is told the match is full.

Units in woods or behind a building show through it as a silhouette in their side's colour.

The server runs the game (a `TickRoom` at 20 ticks a second, 10 snapshots a second). Pages send orders, never per-tick inputs, and draw what their side sees a little behind on the server's clock. An order shows at once (a marker and lines to where the units go) and holds until a snapshot says it was taken.

| File | |
|---|---|
| `rules.ts` | the rules and messages both sides share; the map's cells from the world's queries, A* paths, placing a building |
| `game.ts` | the match itself, with no network in it: orders, walking, gathering, fights, training, sight |
| `bot.ts` | the bot: a side the server plays through the same orders |
| `server.ts` | the room: a `TickRoom` per room on `/rts?room=`, the match's phases, per-side snapshots; `attachRts(server)` |
| `client.ts` | the page: the view and its camera, units and buildings as entities, selecting and ordering, the HUD |
| `main.ts`, `index.html` | the page's entry: quick play or `?room=`, `&name=`, `&vs=bot` |
| `serve.ts` | the production server: the built page and its level, the lobby, and the rooms, on one port |
| `vite.config.ts` | the dev server (the rooms beside it) and both builds |

## Play

```sh
pnpm --filter @pixelworlds/multiplayer demo:rts      # http://localhost:5254/?name=You: quick play (share the room's code; alone, the bot comes in 20 s; &vs=bot at once)
```

- **Mouse:** left click selects a unit (or shows a building, one of the level's, or a foe), a left drag selects your units in the box; right click orders: on a foe, attack it; on one of the level's buildings, wardens knock it down; on a seep, runners gather there; elsewhere, move. Middle drag pans; the wheel zooms.
- **Keys:** WASD or the arrows pan, Q/E turn the view, +/− zoom. **R** trains a runner, **B** places a lodge (click to place, Shift-click for more, Esc or right click to stop), **T** trains a warden (at the lodge with the shortest queue). **F** then a click: fight your way there. **X** stops. Esc lets go of the selection. The buttons at the bottom do R, B and T.
- `RTS_LAG=80` before the command holds every message back 80 ms each way. An edit to the server takes a restart of the dev server.

## Production

```sh
pnpm --filter @pixelworlds/multiplayer demo:rts:build   # dist/client (the page and the sf level) and dist/server/serve.js (one file)
pnpm --filter @pixelworlds/multiplayer demo:rts:start   # http://localhost:8080/; PORT, RTS_LAG; the lobby on /api
```

Rooms live in the server's memory, so run one process. The dogfight's `Dockerfile` and `fly.toml` show how to put it in an image.
