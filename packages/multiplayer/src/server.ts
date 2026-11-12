import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { ServerMessage } from "./index";

/**
 * The relay (Node): rooms of players on one HTTP server's WebSocket path.
 * Each player's messages go to everyone else in its room, as they are, with
 * who sent them; the relay keeps no game state and decides nothing, so a game
 * runs its rules on its clients (relay-first, D-112).
 *
 *   attachRelay(createServer().listen(8080));                    // on its own
 *   configureServer(server) { attachRelay(server.httpServer!) }  // beside Vite's dev server
 */

export interface RelayOptions {
  /** The WebSocket path (default "/relay"); a room is its `?room=` (default "lobby"). Other upgrades, Vite's HMR among them, are left alone. */
  path?: string;
  /** Most players in a room (default 16); one more is told the room is full. */
  maxPlayers?: number;
  /** Largest message a player may send (bytes, default 16 KB). */
  maxMessage?: number;
  /** Hold every message back this many ms: lag to try a game's smoothing under (default 0). */
  lag?: number;
}

export interface Relay {
  /** Players per room. */
  rooms(): Map<string, number>;
  close(): void;
}

/** A dead connection (a closed laptop, a lost network) is dropped after at most two of these. */
const HEARTBEAT_MS = 5000;
const ROOM_NAME_MAX = 64;

export function attachRelay(server: Server, opts: RelayOptions = {}): Relay {
  const path = opts.path ?? "/relay";
  const maxPlayers = opts.maxPlayers ?? 16;
  const lag = opts.lag ?? 0;
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxMessage ?? 16 * 1024 });
  const rooms = new Map<string, Map<string, WebSocket>>();
  let next = 1;

  const send = (ws: WebSocket, msg: ServerMessage) => {
    const go = () => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    if (lag > 0) setTimeout(go, lag);
    else go();
  };

  const join = (ws: WebSocket, name: string) => {
    let room = rooms.get(name);
    if (room && room.size >= maxPlayers) {
      ws.send(JSON.stringify({ t: "full" } satisfies ServerMessage));
      ws.close();
      return;
    }
    if (!room) rooms.set(name, (room = new Map()));
    const members = room;
    const id = String(next++);
    ws.send(JSON.stringify({ t: "welcome", id, peers: [...members.keys()] } satisfies ServerMessage));
    for (const other of members.values()) send(other, { t: "join", id });
    members.set(id, ws);

    let alive = true;
    ws.on("pong", () => (alive = true));
    const beat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);

    ws.on("message", (raw, binary) => {
      if (binary) return;
      let data: unknown;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return; // not JSON: the others' clients couldn't read it
      }
      for (const [other, peer] of members) if (other !== id) send(peer, { t: "msg", from: id, data });
    });
    ws.on("close", () => {
      clearInterval(beat);
      members.delete(id);
      if (members.size === 0) rooms.delete(name);
      else for (const peer of members.values()) send(peer, { t: "leave", id });
    });
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://relay");
    if (url.pathname !== path) return;
    const name = (url.searchParams.get("room") || "lobby").slice(0, ROOM_NAME_MAX);
    wss.handleUpgrade(req, socket, head, (ws) => join(ws, name));
  };
  server.on("upgrade", onUpgrade);

  return {
    rooms: () => new Map([...rooms].map(([name, members]) => [name, members.size])),
    close() {
      server.off("upgrade", onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
