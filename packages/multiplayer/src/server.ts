import { randomInt } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { SERVER, type RoomInfo, type ServerMessage } from "./index";

export * from "./static";
export * from "./tick";

/**
 * Rooms of players on one HTTP server's WebSocket path (Node).
 *
 * - **A relay** (D-112): each player's messages go to everyone else in its
 *   room, as they are, with who sent them. It keeps no game state and decides
 *   nothing, so a game runs its rules on its clients.
 * - **Hosted rooms** (`host`, D-113): players' messages go to a game the
 *   server runs for the room instead (a `TickRoom`), which answers them
 *   (`from` is `SERVER`) and may send a page away (`kick`, `close`, with a
 *   reason). A throw in a game closes its room, not the server (D-118).
 * - **A lobby** (D-118): rooms opened with a code (`open`), listed (`list`),
 *   quick play (`quick`), over HTTP with `lobbyHandler`; an empty room stays
 *   open a while for its players to come back.
 *
 *   attachRelay(createServer().listen(8080));                    // on its own
 *   configureServer(server) { attachRelay(server.httpServer!) }  // beside Vite's dev server
 */

/** A room the server runs (`RelayOptions.host`): what its game can do with its players. */
export interface HostedRoom {
  readonly name: string;
  /** The settings it was opened with (`Relay.open`, as the lobby checked them); undefined for a room a page opened by naming it. */
  readonly settings: unknown;
  readonly isPublic: boolean;
  /** To one player. */
  send(to: string, data: unknown): void;
  /** To every player in the room but `except` (serialized once). */
  broadcast(data: unknown, except?: ReadonlySet<string>): void;
  players(): string[];
  /** Send a player away, saying why (its page's `onClose` gets the reason). */
  kick(id: string, why: string): void;
  /** Send every player away, saying why: the room goes once it is empty. */
  close(why: string): void;
  /** The game threw: the room closes ("the game hit an error") and the server's log hears why; the other rooms go on. */
  fail(e: unknown): void;
  /** A line for the server's log, with the room's name. */
  log(message: string): void;
}

/** A room's game on the server: its players' messages come here instead of going to the others. */
export interface RoomHost {
  join?(id: string): void;
  message(id: string, data: unknown): void;
  leave?(id: string): void;
  /** The room is gone (empty, or failed): stop its clock. */
  close?(): void;
  /** What the lobby lists for the room besides its name and players (a mode, a map, time left). */
  info?(): object;
}

/** A line for the server's log (`RelayOptions.log`). */
export interface RelayLog {
  room: string;
  kind: "open" | "close" | "join" | "leave" | "error" | "game";
  id?: string;
  message?: string;
  error?: unknown;
}

export interface RelayOptions {
  /** The WebSocket path (default "/relay"); a room is its `?room=` (default "lobby"). Other upgrades, Vite's HMR among them, are left alone. */
  path?: string;
  /** Most players in a room (default 16); one more is told the room is full. */
  maxPlayers?: number;
  /** Most rooms at once (default 64): each hosted one runs a clock. */
  maxRooms?: number;
  /** Largest message a player may send (bytes, default 4 KB). */
  maxMessage?: number;
  /** Messages a connection may send a second, and in a burst (default 90 and 180: inputs at 60 a second and some): past it they are dropped, and one that keeps on is sent away. */
  rate?: { perSecond: number; burst: number };
  /** Hold every message back this many ms on each hop (to a player, and to a hosted room's game): lag to try a game under (default 0). */
  lag?: number;
  /** Run a game for each room (made when it opens) instead of relaying (D-113). */
  host?: (room: HostedRoom) => RoomHost;
  /** How long an empty room stays open for its players to come back (ms): one opened by naming it (default 0), and the lobby's public (60 s) and private (10 min). */
  idle?: { named?: number; public?: number; private?: number };
  /** Rooms only from the lobby (`open`, `quick`): a page naming one that isn't open is told so (default false: naming one opens it). */
  lobbyOnly?: boolean;
  /** The server's log: rooms opening and closing, players coming and going, a game's errors and notes (default: errors to the console). */
  log?: (line: RelayLog) => void;
}

export interface Relay {
  /** Players per open room. */
  rooms(): Map<string, number>;
  /** Open a room for the lobby: its code (4 letters and digits, none that look alike), or null at `maxRooms`. */
  open(opts?: { public?: boolean; settings?: unknown }): string | null;
  /** The public rooms, busiest first, with what their games say of them. */
  list(): RoomInfo[];
  /** Quick play: the busiest public room with space whose info `fits`, else a new public one (null at `maxRooms`). */
  quick(fits?: (info: RoomInfo) => boolean, settings?: unknown): string | null;
  /** Send every page away, saying why (default: the server is going down), and stop. */
  close(why?: string): void;
}

/** A dead connection (a closed laptop, a lost network) is dropped after at most two of these. */
const HEARTBEAT_MS = 5000;
const ROOM_NAME_MAX = 64;
/** Room codes: no 0/O, 1/I/L, 2/Z, 5/S, 6/G, 8/B to mistake for one another. */
const CODE_LETTERS = "ACDEFHJKMNPQRTUVWXY3479";

interface OpenRoom {
  name: string;
  isPublic: boolean;
  settings: unknown;
  members: Map<string, WebSocket>;
  host: RoomHost | null;
  /** Its game threw: it takes nothing more, and goes once its pages have. */
  dead: boolean;
  idleMs: number;
  idle: ReturnType<typeof setTimeout> | null;
}

export function attachRelay(server: Server, opts: RelayOptions = {}): Relay {
  const path = opts.path ?? "/relay";
  const maxPlayers = opts.maxPlayers ?? 16;
  const maxRooms = opts.maxRooms ?? 64;
  const lag = opts.lag ?? 0;
  const rate = opts.rate ?? { perSecond: 90, burst: 180 };
  const log =
    opts.log ??
    ((l: RelayLog) => {
      if (l.kind === "error") console.error(`room "${l.room}": the game hit an error:`, l.error);
    });
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxMessage ?? 4 * 1024 });
  const rooms = new Map<string, OpenRoom>();
  let next = 1;

  const later = (f: () => void) => (lag > 0 ? void setTimeout(f, lag) : f());
  const sendText = (ws: WebSocket, text: string) =>
    later(() => {
      if (ws.readyState === ws.OPEN) ws.send(text);
    });
  const send = (ws: WebSocket, msg: ServerMessage) => sendText(ws, JSON.stringify(msg));
  const byeNow = (ws: WebSocket, why: string) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "bye", why } satisfies ServerMessage));
    ws.close();
  };
  const bye = (ws: WebSocket, why: string) => later(() => byeNow(ws, why));

  /** A call into a room's game: a throw closes that room, not the server. */
  const call = (r: OpenRoom, f: (host: RoomHost) => void) => {
    if (!r.host || r.dead) return;
    try {
      f(r.host);
    } catch (e) {
      fail(r, e);
    }
  };
  const fail = (r: OpenRoom, e: unknown) => {
    if (r.dead) return;
    r.dead = true;
    log({ room: r.name, kind: "error", error: e, message: e instanceof Error ? e.message : String(e) });
    if (rooms.get(r.name) === r) rooms.delete(r.name); // a page naming it again gets a new one
    for (const ws of r.members.values()) bye(ws, "the game hit an error");
    try {
      r.host?.close?.();
    } catch {
      // it is gone either way
    }
  };
  const shut = (r: OpenRoom) => {
    if (rooms.get(r.name) === r) rooms.delete(r.name);
    if (!r.dead) call(r, (h) => h.close?.());
    r.dead = true;
    log({ room: r.name, kind: "close" });
  };

  const open = (name: string, isPublic: boolean, settings: unknown, idleMs: number): OpenRoom => {
    const r: OpenRoom = { name, isPublic, settings, members: new Map(), host: null, dead: false, idleMs, idle: null };
    rooms.set(name, r);
    log({ room: name, kind: "open" });
    try {
      r.host =
        opts.host?.({
          name,
          settings,
          isPublic,
          send: (to, data) => {
            const ws = r.members.get(to);
            if (ws) send(ws, { t: "msg", from: SERVER, data });
          },
          broadcast: (data, except) => {
            const text = JSON.stringify({ t: "msg", from: SERVER, data } satisfies ServerMessage);
            for (const [id, ws] of r.members) if (!except?.has(id)) sendText(ws, text);
          },
          players: () => [...r.members.keys()],
          kick: (id, why) => {
            const ws = r.members.get(id);
            if (ws) bye(ws, why);
          },
          close: (why) => {
            for (const ws of r.members.values()) bye(ws, why);
          },
          fail: (e) => fail(r, e),
          log: (message) => log({ room: name, kind: "game", message }),
        }) ?? null;
    } catch (e) {
      fail(r, e);
    }
    if (idleMs > 0) r.idle = setTimeout(() => r.members.size === 0 && shut(r), idleMs);
    return r;
  };

  const code = (): string => {
    for (;;) {
      const c = Array.from({ length: 4 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join("");
      if (!rooms.has(c)) return c;
    }
  };

  const join = (ws: WebSocket, name: string) => {
    const room = rooms.get(name);
    if (!room && opts.lobbyOnly) return bye(ws, `there is no room "${name}" open: it may have closed`);
    if (!room && rooms.size >= maxRooms) return bye(ws, "the server has all the rooms it can take: join one that is open");
    if (room && room.members.size >= maxPlayers) {
      ws.send(JSON.stringify({ t: "full" } satisfies ServerMessage));
      ws.close();
      return;
    }
    // a socket's own errors (a message over the size, a broken frame): the connection closes; unheard, they would end the process
    ws.on("error", () => ws.terminate());
    const r = room ?? open(name, false, undefined, opts.idle?.named ?? 0);
    if (r.idle) clearTimeout(r.idle);
    r.idle = null;
    const id = String(next++);
    ws.send(JSON.stringify({ t: "welcome", id, peers: [...r.members.keys()] } satisfies ServerMessage));
    for (const other of r.members.values()) send(other, { t: "join", id });
    r.members.set(id, ws);
    log({ room: name, kind: "join", id });
    call(r, (h) => h.join?.(id));

    let alive = true;
    ws.on("pong", () => (alive = true));
    const beat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);

    // a bucket of messages it may send, refilled at `rate.perSecond`
    let tokens = rate.burst;
    let filled = performance.now();
    let dropped = 0;
    ws.on("message", (raw, binary) => {
      const now = performance.now();
      tokens = Math.min(rate.burst, tokens + ((now - filled) / 1000) * rate.perSecond);
      filled = now;
      if (tokens < 1) {
        if (++dropped > rate.burst) byeNow(ws, "too many messages");
        return;
      }
      tokens--;
      if (binary) return;
      let data: unknown;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return; // not JSON: the others' clients couldn't read it
      }
      if (r.host) later(() => r.members.has(id) && call(r, (h) => h.message(id, data)));
      else for (const [other, peer] of r.members) if (other !== id) send(peer, { t: "msg", from: id, data });
    });
    ws.on("close", () => {
      clearInterval(beat);
      if (!r.members.delete(id)) return;
      log({ room: name, kind: "leave", id });
      call(r, (h) => h.leave?.(id));
      for (const peer of r.members.values()) send(peer, { t: "leave", id });
      if (r.members.size > 0) return;
      if (r.idleMs > 0 && !r.dead) r.idle = setTimeout(() => r.members.size === 0 && shut(r), r.idleMs);
      else shut(r);
    });
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://relay");
    if (url.pathname !== path) return;
    const name = (url.searchParams.get("room") || "lobby").slice(0, ROOM_NAME_MAX);
    wss.handleUpgrade(req, socket, head, (ws) => join(ws, name));
  };
  server.on("upgrade", onUpgrade);

  const infoOf = (r: OpenRoom): RoomInfo => {
    let info: object = {};
    call(r, (h) => (info = h.info?.() ?? {}));
    return { name: r.name, players: r.members.size, max: maxPlayers, info };
  };
  const relay: Relay = {
    rooms: () => new Map([...rooms].map(([name, r]) => [name, r.members.size])),
    open({ public: isPublic = false, settings } = {}) {
      if (rooms.size >= maxRooms) return null;
      const c = code();
      open(c, isPublic, settings, isPublic ? (opts.idle?.public ?? 60_000) : (opts.idle?.private ?? 600_000));
      return c;
    },
    list: () =>
      [...rooms.values()]
        .filter((r) => r.isPublic && !r.dead)
        .map(infoOf)
        .sort((a, b) => b.players - a.players || a.name.localeCompare(b.name)),
    quick(fits = () => true, settings) {
      const room = relay.list().find((r) => r.players < r.max && fits(r));
      return room?.name ?? relay.open({ public: true, settings });
    },
    close(why = "the server is going down") {
      server.off("upgrade", onUpgrade);
      for (const r of rooms.values()) {
        if (r.idle) clearTimeout(r.idle);
        for (const ws of r.members.values()) byeNow(ws, why);
        if (!r.dead) call(r, (h) => h.close?.());
      }
      rooms.clear();
      wss.close();
    },
  };
  return relay;
}

// ---------------------------------------------------------------- the lobby over HTTP

export interface LobbyOptions {
  /** The lobby's paths (default "/api"): GET `<base>/rooms`, POST `<base>/rooms` and `<base>/quick`. */
  base?: string;
  /** A room's settings from a page, when it gives some (untrusted JSON): checked, or null to refuse. Default: none taken. */
  settings?: (body: unknown) => unknown | null;
  /** Quick play: which listed rooms a page may be put in (default any with space). */
  fits?: (room: RoomInfo) => boolean;
}

/**
 * The lobby over HTTP (D-118), beside the rooms and the game's files on one
 * server: `GET /api/rooms` lists the public rooms; `POST /api/rooms` opens one
 * from a page's settings (`{ public, settings }`) and answers its code;
 * `POST /api/quick` answers the code of the room to play in. It answers
 * whether it took the request, so it chains:
 *
 *   createServer((req, res) => lobby(req, res) || files(req, res))
 */
export function lobbyHandler(relay: Relay, opts: LobbyOptions = {}): (req: IncomingMessage, res: ServerResponse) => boolean {
  const base = opts.base ?? "/api";
  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const body = (req: IncomingMessage) =>
    new Promise<unknown>((resolve) => {
      let text = "";
      req.on("data", (c: Buffer) => {
        text += c;
        if (text.length > 4096) req.destroy();
      });
      req.on("end", () => {
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch {
          resolve(null);
        }
      });
    });
  return (req, res) => {
    const path = new URL(req.url ?? "/", "http://lobby").pathname;
    if (path === `${base}/rooms` && req.method === "GET") {
      json(res, 200, relay.list());
      return true;
    }
    if ((path === `${base}/rooms` || path === `${base}/quick`) && req.method === "POST") {
      void body(req).then((b) => {
        if (b === null) return json(res, 400, { error: "that isn't JSON" });
        const asked = b as { public?: unknown; settings?: unknown };
        // settings are checked when a page gives some; none, and the game's defaults
        const settings = asked.settings !== undefined && opts.settings ? opts.settings(asked.settings) : undefined;
        if (asked.settings !== undefined && (!opts.settings || settings === null)) return json(res, 400, { error: "those settings won't do" });
        const room = path.endsWith("/quick") ? relay.quick(opts.fits, settings) : relay.open({ public: asked.public === true, settings });
        if (room === null) return json(res, 503, { error: "the server has all the rooms it can take" });
        json(res, 200, { room });
      });
      return true;
    }
    return false;
  };
}
