import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { SERVER, type ServerMessage } from "./index";

/**
 * Rooms of players on one HTTP server's WebSocket path (Node).
 *
 * - **A relay** (D-112): each player's messages go to everyone else in its
 *   room, as they are, with who sent them. It keeps no game state and decides
 *   nothing, so a game runs its rules on its clients.
 * - **Hosted rooms** (`host`, D-113): players' messages go to a game the
 *   server runs for the room instead, which answers them (`from` is `SERVER`).
 *   The server owns the state; clients predict their own vehicle (`Prediction`).
 *
 *   attachRelay(createServer().listen(8080));                    // on its own
 *   configureServer(server) { attachRelay(server.httpServer!) }  // beside Vite's dev server
 */

/** A room the server runs (`RelayOptions.host`): what its game can do with its players. */
export interface HostedRoom {
  readonly name: string;
  /** To one player. */
  send(to: string, data: unknown): void;
  /** To every player in the room. */
  broadcast(data: unknown): void;
  players(): string[];
}

/** A room's game on the server: its players' messages come here instead of going to the others. */
export interface RoomHost {
  join?(id: string): void;
  message(id: string, data: unknown): void;
  leave?(id: string): void;
  /** The room emptied and is gone: stop its clock. */
  close?(): void;
}

export interface RelayOptions {
  /** The WebSocket path (default "/relay"); a room is its `?room=` (default "lobby"). Other upgrades, Vite's HMR among them, are left alone. */
  path?: string;
  /** Most players in a room (default 16); one more is told the room is full. */
  maxPlayers?: number;
  /** Largest message a player may send (bytes, default 16 KB). */
  maxMessage?: number;
  /** Hold every message back this many ms on each hop (to a player, and to a hosted room's game): lag to try a game under (default 0). */
  lag?: number;
  /** Run a game for each room (made when its first player arrives) instead of relaying (D-113). */
  host?: (room: HostedRoom) => RoomHost;
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
  const hosts = new Map<string, RoomHost>();
  let next = 1;

  const later = (f: () => void) => (lag > 0 ? void setTimeout(f, lag) : f());
  const send = (ws: WebSocket, msg: ServerMessage) =>
    later(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    });

  const hostFor = (name: string, members: Map<string, WebSocket>): RoomHost | null => {
    if (!opts.host) return null;
    let host = hosts.get(name);
    if (!host) {
      host = opts.host({
        name,
        send: (to, data) => {
          const ws = members.get(to);
          if (ws) send(ws, { t: "msg", from: SERVER, data });
        },
        broadcast: (data) => {
          for (const ws of members.values()) send(ws, { t: "msg", from: SERVER, data });
        },
        players: () => [...members.keys()],
      });
      hosts.set(name, host);
    }
    return host;
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
    const host = hostFor(name, members);
    host?.join?.(id);

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
      if (host) later(() => members.has(id) && host.message(id, data));
      else for (const [other, peer] of members) if (other !== id) send(peer, { t: "msg", from: id, data });
    });
    ws.on("close", () => {
      clearInterval(beat);
      members.delete(id);
      host?.leave?.(id);
      if (members.size === 0) {
        rooms.delete(name);
        host?.close?.();
        hosts.delete(name);
      } else for (const peer of members.values()) send(peer, { t: "leave", id });
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
      for (const host of hosts.values()) host.close?.();
      hosts.clear();
    },
  };
}
