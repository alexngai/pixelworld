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

- **`attachRelay(server, { path, maxPlayers, maxRooms, maxMessage, rate, lag, host, idle, lobbyOnly, log })`:** rooms by `?room=` on one path (default `/relay`); other upgrades (Vite's HMR) are left alone.
  - **Limits:** at most `maxRooms` (64) rooms; messages of at most `maxMessage` (4 KB), at most `rate` a second per connection (90, a burst of 180: past it they are dropped, and a page that keeps on is sent away).
  - **Hosted:** with `host(room)`, each room's messages go to a game the server runs (`RoomHost`: `join`, `message`, `leave`, `close`, `info`), which answers with `room.send(to, data)` and `room.broadcast(data, except?)` (serialized once), seen `from` `SERVER`, and may send pages away with a reason (`room.kick(id, why)`, `room.close(why)`: the page's `onClose(why)`). **A throw in a game closes its room ("the game hit an error"), not the server.**
  - **The lobby:** `relay.open({ public, settings })` opens a room with a 4-character code (no letters that look alike); `relay.list()` lists the public ones, busiest first, with what their games say (`info`); `relay.quick(fits?)` is quick play. An empty room stays open a while (`idle`: public 60 s, private 10 min; a named one 0 by default). `lobbyOnly`: pages can't open rooms by naming them. `lobbyHandler(relay, { settings, fits })` answers `GET /api/rooms`, `POST /api/rooms` and `POST /api/quick` beside the game's files.
  - **Ops:** `log` hears rooms opening and closing, pages coming and going, a game's errors and notes (a late clock, a slow tick); `relay.close(why)` sends every page away saying why (a deploy). `lag` holds every message back on each hop, to try a game under lag.
- **`TickRoom<I, J, W, E>`** (server, D-114, D-116, D-118): a hosted room's game at a fixed tick, over the game's world `W` (from `ready`; if it fails, the room closes saying why).
  - **Joining:** a page says who it is (`hello`, the game's join data `J`, checked by `parseJoin`); once the world is ready, `added` makes it a `"player"`, a `"spectator"` (gets the shared snapshot, sends no inputs) or turns it away.
  - **Inputs:** a player's numbered inputs queue (15 at most, the oldest dropped) and are stepped one a tick with a little credit over (1.02), so a page can't play faster than the clock and a backlog after a stall drains rather than lagging for good. `input` validates each.
  - **Commands:** `cmd` messages (a team pick, a ready, a build) reach `command`, from players and spectators, reliably and once.
  - **Bots:** `addBot(id, join, drive)` is a player the server drives each tick; `removeBot`.
  - **Snapshots:** `shared()` to every page at once (`world`, serialized once), and `snapshot(id)` to each player (`snap`, with `t` and its `ack`).
  - **Events:** `emit(e, to?)`, stamped with the server time, for pages to show at that time of the others.
  - **A backed-up connection:** a player whose page shows the others more than `behind` (0.25 s) later than its own best gets only every 10th snapshot until it catches up (`isBehind`).
  - **Health:** `stats()` (tick time, overruns, players behind); late clocks and slow ticks go to the server's log.
  - **A page gone quiet** (D-119): `idleFor(id)` is how long since a player's last input was stepped (a hidden tab, a stalled connection: its vehicle stands where it was). The policy is the game's: the race marks the car stalled and lets the others drive through it.
  - Also `step(id, input, seen, seq)` (the input's number, to match a page's at-once effects), `update`, `removed`, `describe` (for the lobby), `lagOf(seen, max)`, `roleOf`, `joinOf`, `isBot`, `playerIds`, `spectatorIds`, `kick`.
- **`Phases<P>`** (server, D-118): a match's phases on the server's clock (`set(phase, now, seconds)`, `left`, `over`, `net()` for the shared snapshot).
- **`History`** (server): where something was, by server time, to test a shot against where its shooter saw the target, or a bump against where its driver saw the others. A place may carry a `heading`, rewound the short way round (D-119), for oriented contact. Recorded with each shared snapshot, a rewind falls between the same samples a page's `Smoothing` draws between, so a page predicting against what it draws ends where the server says.
- **`serveStatic(root)`** (server): a request handler for a built game's directory, beside the rooms on the same port: GET and HEAD, nothing outside `root`, hashed `/assets/` cached for good, world package files as stored.
- **`TickClient<I, S, W, E>`** (page, D-114, D-116, D-118): a page in a `TickRoom`; it takes the room's messages. `hello(join)`, `command(c)`; `advance(dt, input, after?)` puts the newest snapshot of its own in place once a frame (`restore`, then the inputs the server hasn't stepped are stepped again; `reconciled` after) and steps the fixed ticks the time holds, each input predicted, numbered (`after(input, seq)`) and sent with `seen`. `onWorld` gets the shared snapshot; `due()` lets events out at their time; `ping` is the round trip from an input to its snapshot. `clock` is the server's: give it to `RemotePlayers`.
- **`EventQueue<E>`** (page): events held until the page shows their time.
- **`cleanName(raw, max)`:** a name safe to show the others (letters, digits, spaces, `-_.'`; no control or direction characters).
- **`listRooms()`, `openRoom()`, `quickRoom()`** (page): the lobby's HTTP API.
- **`loopback(makeRoom)`** (`@pixelworlds/multiplayer/testing`, D-118): a room and its pages in memory on a made-up clock, messages copied through JSON as they are sent and delivered after each page's `latency`, `stall(seconds)` for a stalled server: a game's netcode tested whole, without sockets or waiting.
- **`ServerClock`** (page, D-116): another clock as the page sees it, from the quickest message in the last 10 s, so it comes back after a stall.
- **`Correction`** (page, D-119): a prediction's corrections drawn smoothly. `moved(before, after)` on each reconcile; the vehicle is drawn at its state plus `offset`, which `update(dt)` eases out (`halfLife`, 0.1 s), so a bump the server judged otherwise doesn't snap the vehicle or the camera; past `snap` cells (a respawn) it is drawn there at once.
- **`Prediction(step)`:** `apply(input)` steps the player's vehicle at once and numbers the input for the server; `reconcile(ack, restore)` puts the server's state back and steps the inputs it hasn't yet. `TickClient` is built on it.
- **`joinRoom(url, room)`:** `id`, `peers`, `send(data)`, `onMessage(from, data)`, `onJoin`, `onLeave`, `onClose`, `close()`.
- **`Smoothing`:** poses stamped with the sender's clock (one `ServerClock` for a hosted room, else one per sender), drawn `delay` seconds behind (default 0.1 s) and in between; a pose on a new `life` (a respawn) is drawn there at once, not slid to. `time(id, now)` is when what is drawn happened, on the sender's clock.
- **`RemotePlayers(view.entities, spec, { delay, clock })`:** an entity per player (`wait: false`), moved by `update()` each frame; `pose(id)` is where it was drawn, to aim and hit at; `retain(ids)` keeps only the players a snapshot has.

## Demos

Games built on the package, in `src/demos/` (not part of what the package ships):

- **[The race](src/demos/race/README.md)** (D-119): cars round the Las Vegas Strip on the example game's car physics, run by the server: a start grid, checkpoints, three laps timed in each car's own steps, a countdown and the results; bots (the game's `CarPilot`) make up the field and overtake; bumps judged against where each driver saw the others, so prediction holds through them; quick play, room codes and spectators. `pnpm --filter @pixelworlds/multiplayer demo:race`, then open `http://localhost:5254/`.
- **[The dogfight](src/demos/dogfight/README.md)** (D-113, D-114, D-116, D-118): planes over the Grand Canyon on the example game's flight model, run by the server; matches, quick play and room codes, spectators, and a bot when a pilot is alone. `pnpm --filter @pixelworlds/multiplayer demo:dogfight`, then open `http://localhost:5253/` (quick play) and share the room's code. It builds into one Node server with the page beside it, and a Docker image.
