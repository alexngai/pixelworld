# @pixelworlds/multiplayer

Several players in one [pixelworld](https://github.com/alexngai/pixelworld): a WebSocket relay with rooms, a room client, and other players drawn as smoothed entities in a world view. The engine has no netcode of its own (D-111); this package is optional.

It is relay-first (D-112): each client runs its own vehicle and tells the others where it is, so a game's rules run on its clients. Good for playing with friends; a game that must stop cheating needs a server that runs the game.

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

- **`attachRelay(server, { path, maxPlayers, maxMessage, lag })`:** rooms by `?room=` on one path (default `/relay`); other upgrades (Vite's HMR) are left alone. `lag` holds every message back, to try a game under lag.
- **`joinRoom(url, room)`:** `id`, `peers`, `send(data)`, `onMessage(from, data)`, `onJoin`, `onLeave`, `onClose`, `close()`.
- **`Smoothing`:** poses stamped with the sender's clock, drawn `delay` seconds behind (default 0.1 s) and in between; `jump` for a respawn, which isn't slid to.
- **`RemotePlayers(view.entities, spec, delay?)`:** an entity per player (`wait: false`), moved by `update()` each frame; `pose(id)` is where it was drawn, to aim and hit at.

The example game's dogfight uses all of it: `pnpm --filter @pixelworlds/game dev`, then open `http://localhost:5252/?dogfight=canyon` in two windows.
