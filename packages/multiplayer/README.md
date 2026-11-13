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

- **`attachRelay(server, { path, maxPlayers, maxRooms, maxMessage, lag, host })`:** rooms by `?room=` on one path (default `/relay`); other upgrades (Vite's HMR) are left alone. At most `maxRooms` (64) at once. `lag` holds every message back on each hop, to try a game under lag. With `host(room)`, each room's messages go to a game the server runs (`RoomHost`: `join`, `message`, `leave`, `close`), which answers with `room.send(to, data)` and `room.broadcast(data)` (serialized once), seen `from` `SERVER`, and may send pages away with a reason (`room.kick(id, why)`, `room.close(why)`: the page's `onClose(why)`).
- **`TickRoom<I, J, W>`** (server, D-114, D-116): a hosted room's game at a fixed tick, over the game's world `W` (from `ready`; if it fails, the room closes saying why).
  - **Joining:** a page says who it is (`hello`, the game's join data `J`, checked by `parseJoin`); once the world is ready, `added` makes it a `"player"`, a `"spectator"` (gets the shared snapshot, sends no inputs) or turns it away.
  - **Inputs:** a player's numbered inputs queue (15 at most, the oldest dropped) and are stepped one a tick with a little credit over (1.02), so a page can't play faster than the clock and a backlog after a stall drains rather than lagging for good. `input` validates each.
  - **Commands:** `cmd` messages (a team pick, a ready, a build) reach `command`, from players and spectators, reliably and once.
  - **Bots:** `addBot(id, join, drive)` is a player the server drives each tick; `removeBot`.
  - **Snapshots:** `shared()` to every page at once (`world`, serialized once), and `snapshot(id)` to each player (`snap`, with `t` and its `ack`).
  - Also `step`, `update`, `removed`, `lagOf(seen, max)`, `roleOf`, `joinOf`, `isBot`, `playerIds`, `spectatorIds`, `kick`.
- **`History`** (server): where something was, by server time, to test a shot against where its shooter saw the target.
- **`serveStatic(root)`** (server): a request handler for a built game's directory, beside the rooms on the same port: GET and HEAD, nothing outside `root`, hashed `/assets/` cached for good, world package files as stored.
- **`TickClient<I>`** (page, D-114, D-116): a page in a `TickRoom`. `hello(join)`, `command(c)`; `advance(dt, input, after?)` steps the fixed ticks the time holds, each input predicted, numbered and sent with `seen` (the server time the page shows of the others); `reconcile(snapshot, restore)` on each of its snapshots. `clock` is the server's: give it to `RemotePlayers`, and show events when `seen()` reaches their time.
- **`ServerClock`** (page, D-116): another clock as the page sees it, from the quickest message in the last 10 s, so it comes back after a stall.
- **`Prediction(step)`:** `apply(input)` steps the player's vehicle at once and numbers the input for the server; `reconcile(ack, restore)` puts the server's state back and steps the inputs it hasn't yet. `TickClient` is built on it.
- **`joinRoom(url, room)`:** `id`, `peers`, `send(data)`, `onMessage(from, data)`, `onJoin`, `onLeave`, `onClose`, `close()`.
- **`Smoothing`:** poses stamped with the sender's clock (one `ServerClock` for a hosted room, else one per sender), drawn `delay` seconds behind (default 0.1 s) and in between; a pose on a new `life` (a respawn) is drawn there at once, not slid to. `time(id, now)` is when what is drawn happened, on the sender's clock.
- **`RemotePlayers(view.entities, spec, { delay, clock })`:** an entity per player (`wait: false`), moved by `update()` each frame; `pose(id)` is where it was drawn, to aim and hit at; `retain(ids)` keeps only the players a snapshot has.

## Demos

Games built on the package, in `src/demos/` (not part of what the package ships):

- **[The dogfight](src/demos/dogfight/README.md)** (D-113, D-114, D-116): planes over the Grand Canyon on the example game's flight model, run by the server; spectators, and a bot when a pilot is alone. `pnpm --filter @pixelworlds/multiplayer demo:dogfight`, then open `http://localhost:5253/?room=canyon` in two windows. It builds into one Node server with the page beside it, and a Docker image.
