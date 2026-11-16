# @pixelworlds/multiplayer

Several players in one [pixelworld](https://github.com/alexngai/pixelworld): rooms on a WebSocket server, a room client, prediction for the player's own vehicle, and other players drawn as smoothed entities in a world view. The engine has no netcode of its own (D-111); this package is optional.

A room is one of two kinds:

- **Relayed** (D-112): each client runs its own vehicle and tells the others where it is, so a game's rules run on its clients. Good for playing with friends.
- **Hosted** (D-113): the server runs a game for the room. Players send inputs; the server steps every vehicle (over the world, from `openWorld` in `pixelworld/engine`) and sends snapshots; each client predicts its own vehicle (`Prediction`) and draws the others smoothed. The server owns the state, so a client can't fly faster than the clock or claim hits.

```ts
// the relay, in Node: on its own, or on a dev server's HTTP server
import { createServer } from "node:http";
import { attachRelay } from "@pixelworlds/multiplayer/server";
attachRelay(createServer().listen(8080));             // ws://host:8080/relay?room=…

// a page
import { joinRoom, RemotePlayers } from "@pixelworlds/multiplayer";
const room = await joinRoom("ws://localhost:8080/relay", "canyon");
const others = new RemotePlayers(view.entities, () => ({ model: { group: "vehicle.plane", seed: 1, size } }));
room.onMessage = (from, m) => others.push(from, m.t, m.pose);
room.onLeave = (id) => others.remove(id);
setInterval(() => room.send({ t: performance.now() / 1000, pose: myPose() }), 50);
view.onFrame(() => others.update());
```

- **`attachRelay(server, { path, maxPlayers, maxRooms, maxMessage, rate, lag, host, idle, lobbyOnly, log, version, sameOrigin })`:** rooms by `?room=` on one path (default `/relay`); other upgrades (Vite's HMR) are left alone.
  - **Limits:** at most `maxRooms` (64) rooms; messages of at most `maxMessage` (4 KB), at most `rate` a second per connection (90, a burst of 180: past it they are dropped, and a page that keeps on is sent away).
  - **Hosted:** with `host(room)`, each room's messages go to a game the server runs (`RoomHost`: `join`, `message`, `leave`, `close`, `info`), which answers with `room.send(to, data)` and `room.broadcast(data, except?)` (serialized once), seen `from` `SERVER`, and may send pages away with a reason (`room.kick(id, why)`, `room.close(why)`: the page's `onClose(why)`). **A throw in a game closes its room ("the game hit an error"), not the server.**
  - **The lobby:** `relay.open({ public, settings })` opens a room with a 4-character code (no letters that look alike); `relay.list()` lists the public ones, busiest first, with what their games say (`info`); `relay.quick(fits?)` is quick play. An empty room stays open a while (`idle`: public 60 s, private 10 min; a named one 0 by default). `lobbyOnly`: pages can't open rooms by naming them. `lobbyHandler(relay, { base, settings, fits })` answers `GET <base>/rooms`, `POST <base>/rooms` and `POST <base>/quick` beside the game's files (`base` default `/api`; games sharing a server each take their own, D-143).
  - **Ops:** `log` hears rooms opening and closing, pages coming and going, a game's errors and notes (a late clock, a slow tick); `relay.close(why)` sends every page away saying why (a deploy). `lag` holds every message back on each hop, to try a game under lag.
  - **Pages from elsewhere** (D-143): with `version` (the server's build), a page joining with another (`joinRoom`'s `version`, or none) is sent away: "the game has been updated: reload the page", since it would predict with other physics. `sameOrigin` refuses a browser's socket from a page on another site (its `Origin` against the request's `Host`; a client that sends no `Origin` isn't a browser, and gets in).
- **`TickRoom<I, J, W, E>`** (server, D-114, D-116, D-118): a hosted room's game at a fixed tick, over the game's world `W` (from `ready`; if it fails, the room closes saying why).
  - **Joining:** a page says who it is (`hello`, the game's join data `J`, checked by `parseJoin`); once the world is ready, `added` makes it a `"player"`, a `"spectator"` (gets the shared snapshot, its group's if `groupOf` gives it one; sends no inputs) or turns it away.
  - **Inputs:** a player's numbered inputs queue (15 at most, the oldest dropped) and are stepped one a tick with a little credit over (1.02), so a page can't play faster than the clock and a backlog after a stall drains rather than lagging for good. `input` validates each.
  - **Commands:** `cmd` messages (a team pick, a ready, a build) reach `command`, from players and spectators, reliably and once.
  - **Commands acknowledged** (D-121): a `TickClient` numbers its commands (`n`), and each of the player's snapshots says the last one the game took (`cmd`), so a page can show an order at once and know which snapshot has it. A game run by commands alone (a strategy game) sends no inputs: its `input` gives null, and its bots' `drive` can give orders for `step` to carry out.
  - **Bots:** `addBot(id, join, drive)` is a player the server drives each tick; `removeBot`.
  - **Snapshots:** `shared()` to every page at once (`world`, serialized once), and `snapshot(id)` to each player (`snap`, with `t` and its `ack`).
  - **Interest (D-120):** with `groupOf(id)` (say `Interest.groupOf`), each group of pages gets its own `shared(group)`, built and serialized once for the group, and pages in none (a watcher, a page not yet admitted) the whole. The page's `onWorld` then has only who is near: call `RemotePlayers.retain` with them, and a player that comes back into range is drawn where it is at once.
  - **Teams and spectators (D-127):** groups serve a team as well as a neighbourhood: `groupOf` gives a player its team and a spectator the team it watches (or a group of its own for everything), and `shared(group)` adds what that team sees. A player's own snapshot comes after its group's of the same time, so its `cmd` says the view a page already has includes the order. Fogfront plays two against two and seats watchers this way.
  - **Events:** `emit(e, to?)` to every page, one, or a list (`Interest.around(x, y)`: the pages near it), stamped with the server time, for pages to show at that time of the others.
  - **Compact (D-123):** set `replicator` (a `Replicator`) and the shared snapshot goes in binary: each group of pages gets a keyframe when it is new to its group (or back from being skipped), then only what changed; near things every snapshot, far ones every `farEvery`th; each thing's state written at most twice a snapshot (whole and as a diff), whatever the groups; `shared(group)` rides along as JSON. Set `snapSchema` and each player's own snapshot goes in binary too (`exact` fields keep its prediction exact). `roster()` (names, teams, scores) goes to every page when it changes, and to each as it connects.
  - **Waiting (D-120):** a `step` that returns false hasn't happened (its ground is still loading: `Areas.ready`): the input stays first in its queue for the next tick, spends no credit and isn't acknowledged, and the backlog drains after as after a stall.
  - **A backed-up connection:** a player whose page shows the others more than `behind` (0.25 s) later than its own best gets only every 10th snapshot until it catches up (`isBehind`).
  - **Health:** `stats()` (tick time, overruns, players behind); late clocks and slow ticks go to the server's log.
  - **A page gone quiet** (D-119): `idleFor(id)` is how long since a player's last input was stepped (a hidden tab, a stalled connection: its vehicle stands where it was). The policy is the game's: the race marks the car stalled and lets the others drive through it.
  - Also `step(id, input, seen, seq)` (the input's number, to match a page's at-once effects), `update`, `removed`, `describe` (for the lobby), `lagOf(seen, max)`, `roleOf`, `joinOf`, `isBot`, `playerIds`, `spectatorIds`, `kick`.
- **`Schema({ field: kind })`** (D-123): how one kind of thing goes on the wire: `fixed(step)` (a position to a 64th of a cell is two or three bytes), `angle(steps)` (read back in [−π, π)), `int`, `bool`, `str`, `exact` (eight bytes). `wire`/`value`, whole (`writeFull`) or what changed (`writeDiff`); `Writer` and `Reader` underneath.
- **`Replicator(schema, { states, view, farEvery })`** (D-123, for `TickRoom.replicator`) and **`Replica(schema)`** (the page's; `TickClient` makes one from its `schema` and passes what it read as `onWorld`'s `entities`: `states`, `gone`, `keyframe`). `view(group)` gives a group's `near` and `far` (`Interest.near(group, reach)` for two rings). `readSnap` reads a binary own snapshot.
- **`Areas(query, { radius, ahead, reach })`** (server, D-120): the world around each player loaded ahead of where it is going, for a world too big to load whole (`openWorld({ chunkBudgetMB })` then lets go of the areas no one is near). `track(id, x, y, vx, vy)` each tick (cheap while its area is loaded: a check that keeps it in use), `ready(x, y)` for a step that waits, `forget(id)`, `pending`, `failed`.
- **`Interest(cell, reach, { slack, diamond })`** (server, D-120, D-123): who is near whom, in squares `cell` cells across: `place(id, x, y)`, `remove`, `groupOf(id)` (its square: a page's group), `near(group, reach?)` (what is within `reach` squares of it; a larger reach for a far ring), `around(x, y)` (who should hear of an event there). A page sees everything within `cell × reach` cells of it. `slack`: a thing keeps its square until it is that far past its edge, so a page on an edge doesn't change group (and get a keyframe) back and forth. `diamond`: an isometric view's shape, everything within `cell × reach` counted across plus down; it saves area with squares finer than the view.
- **`Phases<P>`** (server, D-118): a match's phases on the server's clock (`set(phase, now, seconds)`, `left`, `over`, `net()` for the shared snapshot).
- **`History`** (server): where something was, by server time, to test a shot against where its shooter saw the target, or a bump against where its driver saw the others. A place may carry a `heading`, rewound the short way round (D-119), for oriented contact. Recorded with each shared snapshot, a rewind falls between the same samples a page's `Smoothing` draws between, so a page predicting against what it draws ends where the server says.
- **`fileFetch(root)`** (server, D-123): a world package's files read from disk, for `openWorld({ fetch })`: a server opens its world without HTTP to itself; nothing outside `root`.
- **`serveStatic(root)`** (server): a request handler for a built game's directory, beside the rooms on the same port: GET and HEAD, nothing outside `root`, hashed `/assets/` cached for good, world package files as stored.
- **`TickClient<I, S, W, E, R>`** (page, D-114, D-116, D-118, D-123): a page in a `TickRoom`; it takes the room's messages, JSON or binary (`schema`, `snapSchema`; `onRoster`). `hello(join)`, `command(c)`; `advance(dt, input, after?)` puts the newest snapshot of its own in place once a frame (`restore`, then the inputs the server hasn't stepped are stepped again; `reconciled` after) and steps the fixed ticks the time holds, each input predicted, numbered (`after(input, seq)`) and sent with `seen`. `onWorld` gets the shared snapshot; `due()` lets events out at their time; `ping` is the round trip from an input to its snapshot. `clock` is the server's: give it to `RemotePlayers`.
  - **A page with no vehicle of its own** (D-121): `command(c)` returns the command's number (the snapshot whose `cmd` is at least it has it); `sync()` puts the newest snapshot in place without stepping anything, called each frame instead of `advance`; `ping` comes from commands' round trips too.
- **`EventQueue<E>`** (page): events held until the page shows their time.
- **`cleanName(raw, max)`:** a name safe to show the others (letters, digits, spaces, `-_.'`; no control or direction characters).
- **`listRooms(base)`, `openRoom(opts, base)`, `quickRoom(settings, base)`** (page): the lobby's HTTP API.
- **`loopback(makeRoom)`** (`@pixelworlds/multiplayer/testing`, D-118): a room and its pages in memory on a made-up clock, messages copied through JSON as they are sent and delivered after each page's `latency`, `stall(seconds)` for a stalled server: a game's netcode tested whole, without sockets or waiting.
- **`ServerClock`** (page, D-116): another clock as the page sees it, from the quickest message in the last 10 s, so it comes back after a stall.
- **`Correction`** (page, D-119): a prediction's corrections drawn smoothly. `moved(before, after)` on each reconcile; the vehicle is drawn at its state plus `offset`, which `update(dt)` eases out (`halfLife`, 0.1 s), so a bump the server judged otherwise doesn't snap the vehicle or the camera; past `snap` cells (a respawn) it is drawn there at once.
- **`Prediction(step)`:** `apply(input)` steps the player's vehicle at once and numbers the input for the server; `reconcile(ack, restore)` puts the server's state back and steps the inputs it hasn't yet. `TickClient` is built on it.
- **`joinRoom(url, room, { version })`:** `version` is the page's build, for a server that checks it (D-143). `id`, `peers`, `send(data)`, `onMessage(from, data)`, `onJoin`, `onLeave`, `onClose`, `close()`.
- **`Smoothing`:** poses stamped with the sender's clock (one `ServerClock` for a hosted room, else one per sender), drawn `delay` seconds behind (default 0.1 s) and in between; a pose on a new `life` (a respawn) is drawn there at once, not slid to. `time(id, now)` is when what is drawn happened, on the sender's clock.
- **`RemotePlayers(view.entities, spec, { delay, clock })`:** an entity per player (`wait: false`), moved by `update()` each frame; `pose(id)` is where it was drawn, to aim and hit at; `retain(ids)` keeps only the players a snapshot has.
- **`vehiclesNet(poses, area?)`** (server, D-126): a level's traffic, run by the server (`TrafficSim` from `pixelworld/traffic`, in Node over `loadRoutes(world.url, world.manifest)`), for a snapshot. It keeps the cars inside `area` and puts each on the wire as `[id, kind, variant, part, x, y, h, heading]`, in under 45 bytes.
- **`RemoteTraffic({ delay, clock })`** (page, D-126): the server's cars drawn a little in the past on its clock and in between snapshots, as `RemotePlayers` draws the others. Call `push(t, cars)` with each snapshot that has them. Give `poses()` to the traffic layer as its feed: `trafficLayer({ feed: () => remote.poses() })`. A car a snapshot no longer has is drawn until the page shows the time it was last there, so every page sees the same cars.

## Demos

Games built on the package, in `src/demos/` (not part of what the package ships):

- **[The race](src/demos/race/README.md)** (D-119): cars round the Las Vegas Strip on the example game's car physics, run by the server: a start grid, checkpoints, three laps timed in each car's own steps, a countdown and the results; bots (the game's `CarPilot`) make up the field and overtake; bumps judged against where each driver saw the others, so prediction holds through them; quick play, room codes and spectators. `pnpm --filter @pixelworlds/multiplayer demo:race`, then open `http://localhost:5254/`.
- **[The dogfight](src/demos/dogfight/README.md)** (D-113, D-114, D-116, D-118, D-120): planes over the Grand Canyon on the example game's flight model, run by the server; matches, quick play and room codes, spectators, and a bot when a pilot is alone. `pnpm --filter @pixelworlds/multiplayer demo:dogfight`, then open `http://localhost:5253/` (quick play) and share the room's code. Its server loads the level around the start and each plane (`Areas`), not whole, within 64 MB and without the layers only drawing reads; a plane clear above the coarse heights flies on over ground still loading. Its planes go in binary, its pilots' names and scores in the roster: with 8 pilots a page gets 5.6 KB/s, where JSON was 38 KB/s.
- **[Fogfront](src/demos/rts/README.md)** (D-121): a small real-time strategy game on the Presidio (San Francisco's driving level), run by commands: two guilds gather glim, raise lodges, train wardens and take each other's hearth, with the fog of war, A* paths over the level's cells, and a bot; two against two and watching a side or all (D-127). `pnpm --filter @pixelworlds/multiplayer demo:rts`, then open `http://localhost:5255/` (quick play; `?vs=bot` for the bot at once; `?room=code&size=2` from four pages; `&watch=kiln|tide|all`).

### Online (D-143)

The three demos run together on one server at **https://play.pixelworld.site/**: each page at its own path (`/dogfight/`, `/race/`, `/rts/`), with its lobby beside it (`/dogfight/api`, …), its rooms on its socket path (`/dogfight`, …) and the world packages they are on. pixelworld.site's games page links there.

```sh
pnpm --filter @pixelworlds/multiplayer demos:build   # src/demos/dist: client/ (the pages and seven world packages, 29 MB) and server/serve.js (one file)
pnpm --filter @pixelworlds/multiplayer demos:start   # http://localhost:8080/; PORT, DOGFIGHT_LAG, RACE_LAG, RTS_LAG, RTS_DAY=40,20
docker build -f packages/multiplayer/src/demos/Dockerfile -t pixelworld-demos .   # from the repository's root; docker run --rm -p 8080:8080 pixelworld-demos
```

- **One build:** a page predicts with the server's physics over the same world package, so the pages, the worlds and the server ship in one image. Each build has an id (`version.txt` for the server, `import.meta.env.PLAY_BUILD` in the pages); a page from another build is told to reload.
- **Same origin:** the server refuses a socket from a page on another site, and the lobby sends no CORS headers, so only its own pages use it.
- **Fly.io:** `src/demos/fly.toml` has the commands (launch, the certificate for play.pixelworld.site, deploy); every push to main deploys it, with the site (`.github/workflows/site.yml`, D-144). One machine, since rooms live in its memory; it stops when idle, and the page's own request wakes it in a few seconds. It used 110 MB with a room of each game open; the VM has 512 MB.
- **Each demo's own config** (`demo:dogfight` and the rest) is its dev server, with its rooms and lobby at the same paths.

### On a big world (D-120)

32 bots and 8 pages spread over the whole southwest (228 chunks), 20 s, in `test/bigworld.test.ts` (`BIGWORLD_LOG=1 BIGWORLD_SECONDS=20`; ranges over several runs):

| | everyone everywhere, the world loaded whole | `Areas` within 40 MB, `Interest(128)` |
|---|---|---|
| terrain held | 228 chunks, 112 MB | 81 chunks, 40 MB (156–171 let go) |
| server memory (heap + buffers, over before it opened) | 26 + 113 MB | 8–10 + 41 MB |
| a tick (mean, p99) | 0.035–0.043, 0.10–0.20 ms | 0.058–0.088, 0.20–0.48 ms |
| a page gets | 82 KB/s, 39 others | 12 KB/s, at most 6 others |
| steps that waited for their ground | 0 | ~2,500 in the first second (all on unloaded ground), then 50–230 of 48,000 |
