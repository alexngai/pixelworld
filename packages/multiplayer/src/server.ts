import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { SERVER, type ServerMessage, type TickMessage, type TickShared, type TickSnapshot } from "./index";

/**
 * Rooms of players on one HTTP server's WebSocket path (Node).
 *
 * - **A relay** (D-112): each player's messages go to everyone else in its
 *   room, as they are, with who sent them. It keeps no game state and decides
 *   nothing, so a game runs its rules on its clients.
 * - **Hosted rooms** (`host`, D-113): players' messages go to a game the
 *   server runs for the room instead (a `TickRoom`), which answers them
 *   (`from` is `SERVER`) and may send a page away (`kick`, `close`, with a
 *   reason). The server owns the state; pages predict their own vehicle.
 *
 *   attachRelay(createServer().listen(8080));                    // on its own
 *   configureServer(server) { attachRelay(server.httpServer!) }  // beside Vite's dev server
 */

/** A room the server runs (`RelayOptions.host`): what its game can do with its players. */
export interface HostedRoom {
  readonly name: string;
  /** To one player. */
  send(to: string, data: unknown): void;
  /** To every player in the room (serialized once). */
  broadcast(data: unknown): void;
  players(): string[];
  /** Send a player away, saying why (its page's `onClose` gets the reason). */
  kick(id: string, why: string): void;
  /** Send every player away, saying why: the room goes once it is empty. */
  close(why: string): void;
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
  /** Most rooms at once (default 64): any page may open one by naming it, and each hosted one runs a clock. */
  maxRooms?: number;
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

interface OpenRoom {
  name: string;
  members: Map<string, WebSocket>;
  host: RoomHost | null;
}

export function attachRelay(server: Server, opts: RelayOptions = {}): Relay {
  const path = opts.path ?? "/relay";
  const maxPlayers = opts.maxPlayers ?? 16;
  const maxRooms = opts.maxRooms ?? 64;
  const lag = opts.lag ?? 0;
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxMessage ?? 16 * 1024 });
  const rooms = new Map<string, OpenRoom>();
  let next = 1;

  const later = (f: () => void) => (lag > 0 ? void setTimeout(f, lag) : f());
  const sendText = (ws: WebSocket, text: string) =>
    later(() => {
      if (ws.readyState === ws.OPEN) ws.send(text);
    });
  const send = (ws: WebSocket, msg: ServerMessage) => sendText(ws, JSON.stringify(msg));
  const bye = (ws: WebSocket, why: string) =>
    later(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "bye", why } satisfies ServerMessage));
      ws.close();
    });

  const open = (name: string): OpenRoom => {
    const room: OpenRoom = { name, members: new Map(), host: null };
    room.host =
      opts.host?.({
        name,
        send: (to, data) => {
          const ws = room.members.get(to);
          if (ws) send(ws, { t: "msg", from: SERVER, data });
        },
        broadcast: (data) => {
          const text = JSON.stringify({ t: "msg", from: SERVER, data } satisfies ServerMessage);
          for (const ws of room.members.values()) sendText(ws, text);
        },
        players: () => [...room.members.keys()],
        kick: (id, why) => {
          const ws = room.members.get(id);
          if (ws) bye(ws, why);
        },
        close: (why) => {
          for (const ws of room.members.values()) bye(ws, why);
        },
      }) ?? null;
    rooms.set(name, room);
    return room;
  };

  const join = (ws: WebSocket, name: string) => {
    const room = rooms.get(name);
    if (!room && rooms.size >= maxRooms) return bye(ws, "the server has all the rooms it can take: join one that is open");
    if (room && room.members.size >= maxPlayers) {
      ws.send(JSON.stringify({ t: "full" } satisfies ServerMessage));
      ws.close();
      return;
    }
    const r = room ?? open(name);
    const id = String(next++);
    ws.send(JSON.stringify({ t: "welcome", id, peers: [...r.members.keys()] } satisfies ServerMessage));
    for (const other of r.members.values()) send(other, { t: "join", id });
    r.members.set(id, ws);
    r.host?.join?.(id);

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
      const host = r.host;
      if (host) later(() => r.members.has(id) && host.message(id, data));
      else for (const [other, peer] of r.members) if (other !== id) send(peer, { t: "msg", from: id, data });
    });
    ws.on("close", () => {
      clearInterval(beat);
      if (!r.members.delete(id)) return;
      r.host?.leave?.(id);
      if (r.members.size === 0) {
        if (rooms.get(name) === r) rooms.delete(name);
        r.host?.close?.();
      } else for (const peer of r.members.values()) send(peer, { t: "leave", id });
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
    rooms: () => new Map([...rooms].map(([name, r]) => [name, r.members.size])),
    close() {
      server.off("upgrade", onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      for (const r of rooms.values()) r.host?.close?.();
      rooms.clear();
    },
  };
}

// ---------------------------------------------------------------- a game at a fixed tick

/** What a page is in a `TickRoom`: one who plays, or one who watches (gets the shared snapshot, sends no inputs). */
export type TickRole = "player" | "spectator";

export interface TickRoomOptions<W> {
  /** The fixed step (s; default 1/60): the pages' `TickClient` steps at the same. */
  tick?: number;
  /** A snapshot every this many ticks (default 3: 20 a second at 60). */
  snapshotEvery?: number;
  /** Inputs a player may have waiting (default 15): past it, the oldest waiting is dropped and its page's prediction corrected. */
  maxQueue?: number;
  /** Inputs a player may step in one tick after a stall (default 8). */
  maxBurst?: number;
  /** Inputs credited a tick (default 1.02): a little over one, so a backlog left by a stall drains instead of lagging for good. */
  credit?: number;
  /** The game's world: players are admitted once it resolves (`world` holds it); if it fails, the room closes saying why. */
  ready?: Promise<W>;
  /** Run in real time (default); off for tests, which call `tick()`. */
  clock?: boolean;
}

interface Seat<I, J> {
  role: TickRole;
  join: J;
  queue: { seq: number; i: I; seen: number | null }[];
  ack: number;
  budget: number;
  /** A bot's driver. */
  drive?: () => I;
}

/**
 * A room whose game the server runs at a fixed tick (D-113, D-114, D-116):
 * the `host` of `attachRelay`.
 *
 * - **Joining:** a page says who it is (`hello`, the game's own join data,
 *   which `parseJoin` checks) and is admitted once the game's world is ready:
 *   `added` makes it a player, a spectator, or turns it away.
 * - **Inputs:** a player's numbered inputs (`TickMessage`, from a
 *   `TickClient`) queue and are stepped one a tick, a little credit over so
 *   a backlog after a stall drains; out-of-order, invalid and excess inputs
 *   are dropped. **Commands** (`cmd`: a team pick, a ready, a build) reach
 *   `command` from players and spectators alike, reliably and once.
 * - **Bots** (`addBot`): players the server drives itself, each tick.
 * - **Snapshots,** every `snapshotEvery` ticks: one shared part for every
 *   page (`shared`, serialized once), and to each player its own (`snapshot`,
 *   with `t` and its `ack`).
 */
export abstract class TickRoom<I, J = unknown, W = undefined> implements RoomHost {
  /** Server time (s): whole ticks. */
  time = 0;
  readonly tickLength: number;
  /** The game's world, from `ready`: in place before any page is admitted. */
  protected world!: W;
  private readonly seats = new Map<string, Seat<I, J>>();
  /** Connected, not admitted: their join (null until their `hello`). */
  private readonly pending = new Map<string, J | null>();
  private isReady: boolean;
  private ticks = 0;
  private last = performance.now();
  private acc = 0;
  private readonly timer: ReturnType<typeof setInterval> | null;

  constructor(
    protected readonly room: HostedRoom,
    private readonly opts: TickRoomOptions<W> = {},
  ) {
    this.tickLength = opts.tick ?? 1 / 60;
    this.isReady = !opts.ready;
    opts.ready?.then(
      (w) => {
        this.world = w;
        this.isReady = true;
        for (const [id, join] of this.pending) if (join !== null) this.admit(id, join);
      },
      (e: unknown) => this.room.close(`the game didn't start: ${e instanceof Error ? e.message : String(e)}`),
    );
    this.timer = opts.clock === false ? null : setInterval(() => this.run(), (this.tickLength * 1000) / 2);
  }

  // ---------------------------------------------------------------- the game's part

  /** A page's join data (untrusted), as the game's own: checked, cleaned; null turns the page away. */
  protected abstract parseJoin(data: unknown): J | null;
  /** A page (or a bot) arrives with its join: a player, a spectator, or null to turn it away. It counts among the seats already. */
  protected abstract added(id: string, join: J): TickRole | null;
  /** A player or spectator went (left, was kicked, or a bot removed). */
  protected abstract removed(id: string): void;
  /** A player's input (untrusted), as the game's own (clamped, checked), or null to drop it. */
  protected abstract input(data: unknown): I | null;
  /** One tick of a player with its input; `seen` as its page sent it (`lagOf` makes it a rewind; null for a bot). */
  protected abstract step(id: string, input: I, seen: number | null): void;
  /** The world's own tick, after the players' steps. */
  protected update(): void {}
  /** What every page's snapshot shares (the others, the score): serialized once. */
  protected shared(): object {
    return {};
  }
  /** What one player's own snapshot carries besides `t` and `ack` (its own state, for its prediction). */
  protected snapshot(_id: string): object {
    return {};
  }
  /** A command from a player or spectator (untrusted): a team pick, a ready, a build. */
  protected command(_id: string, _c: unknown): void {}

  // ---------------------------------------------------------------- RoomHost

  join(id: string): void {
    this.pending.set(id, null);
  }

  leave(id: string): void {
    this.pending.delete(id);
    if (this.seats.delete(id)) this.removed(id);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }

  message(id: string, data: unknown): void {
    const m = data as Partial<TickMessage<unknown>> | null;
    if (!m || typeof m !== "object") return;
    if (m.k === "hello") {
      if (this.pending.get(id) !== null) return; // once, and not once in
      const join = this.parseJoin(m.join);
      if (join === null) return this.room.kick(id, "the game can't take that join");
      this.pending.set(id, join);
      if (this.isReady) this.admit(id, join);
      return;
    }
    const seat = this.seats.get(id);
    if (!seat) return;
    if (m.k === "cmd") return this.command(id, m.c);
    if (m.k !== "in" || seat.role !== "player" || seat.drive || !Number.isInteger(m.seq) || m.seq! <= (seat.queue.at(-1)?.seq ?? seat.ack)) return;
    const i = this.input(m.i);
    if (i === null) return;
    if (seat.queue.length >= (this.opts.maxQueue ?? 15)) seat.queue.shift();
    seat.queue.push({ seq: m.seq!, i, seen: typeof m.seen === "number" && Number.isFinite(m.seen) ? m.seen : null });
  }

  // ---------------------------------------------------------------- for the game

  /** A bot: a player the server drives itself, with `drive()` each tick (no page, no queue). False if the id is taken or the game turns it away. */
  addBot(id: string, join: J, drive: () => I): boolean {
    if (this.seats.has(id) || this.pending.has(id)) return false;
    const seat: Seat<I, J> = { role: "player", join, queue: [], ack: 0, budget: 0, drive };
    this.seats.set(id, seat);
    if (this.added(id, join) !== null) return true;
    this.seats.delete(id);
    return false;
  }

  removeBot(id: string): void {
    if (this.seats.get(id)?.drive && this.seats.delete(id)) this.removed(id);
  }

  /** Send a page away, saying why. */
  kick(id: string, why: string): void {
    this.room.kick(id, why);
  }

  roleOf(id: string): TickRole | null {
    return this.seats.get(id)?.role ?? null;
  }

  joinOf(id: string): J | null {
    return this.seats.get(id)?.join ?? null;
  }

  isBot(id: string): boolean {
    return !!this.seats.get(id)?.drive;
  }

  /** The players (bots among them), in the order they arrived. */
  playerIds(): string[] {
    return [...this.seats].filter(([, s]) => s.role === "player").map(([id]) => id);
  }

  spectatorIds(): string[] {
    return [...this.seats].filter(([, s]) => s.role === "spectator").map(([id]) => id);
  }

  /** The last of a player's inputs stepped. */
  ackOf(id: string): number {
    return this.seats.get(id)?.ack ?? 0;
  }

  /** How far back to rewind for what a page saw at `seen` (s), at most `max`. */
  lagOf(seen: number | null, max: number): number {
    return seen === null ? 0 : Math.max(0, Math.min(max, this.time - seen));
  }

  /** One tick: the players' steps, the world's, and the snapshots every `snapshotEvery`. */
  tick(): void {
    this.time = ++this.ticks * this.tickLength;
    if (!this.isReady) return;
    const burst = this.opts.maxBurst ?? 8;
    const credit = this.opts.credit ?? 1.02;
    for (const [id, seat] of [...this.seats]) {
      if (seat.role !== "player" || !this.seats.has(id)) continue;
      if (seat.drive) {
        this.step(id, seat.drive(), null);
        continue;
      }
      seat.budget = Math.min(burst, seat.budget + credit);
      while (seat.budget >= 1 && seat.queue.length) {
        seat.budget--;
        const next = seat.queue.shift()!;
        seat.ack = next.seq;
        this.step(id, next.i, next.seen);
      }
    }
    this.update();
    if (this.ticks % (this.opts.snapshotEvery ?? 3)) return;
    this.room.broadcast({ k: "world", t: this.time, ...this.shared() } satisfies TickShared);
    for (const [id, seat] of this.seats)
      if (seat.role === "player" && !seat.drive) this.room.send(id, { k: "snap", t: this.time, ack: seat.ack, ...this.snapshot(id) } satisfies TickSnapshot);
  }

  private admit(id: string, join: J): void {
    this.pending.delete(id);
    const seat: Seat<I, J> = { role: "player", join, queue: [], ack: 0, budget: 0 };
    this.seats.set(id, seat);
    const role = this.added(id, join);
    if (role === null) {
      this.seats.delete(id);
      return this.room.kick(id, "the game turned you away");
    }
    seat.role = role;
  }

  /** Whole ticks for the time gone by. */
  private run(): void {
    const now = performance.now();
    this.acc += Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    while (this.acc >= this.tickLength) {
      this.acc -= this.tickLength;
      this.tick();
    }
  }
}

/** A point: cells across, height in steps (as a `Pose`'s). */
export interface Place {
  x: number;
  y: number;
  h: number;
}

/** Where something was, by server time, a few seconds back: to test a shot against where its shooter saw the target (lag compensation). */
export class History {
  private readonly at_: (Place & { t: number })[] = [];

  /** @param keep Seconds kept. */
  constructor(private readonly keep: number) {}

  record(t: number, p: Place): void {
    this.at_.push({ t, x: p.x, y: p.y, h: p.h });
    while (this.at_.length && t - this.at_[0]!.t > this.keep) this.at_.shift();
  }

  /** Where it was at t: between the two records around it; the oldest before them; `now` after the newest. */
  at(t: number, now: Place): Place {
    const hs = this.at_;
    if (!hs.length || t >= hs[hs.length - 1]!.t) return { x: now.x, y: now.y, h: now.h };
    if (t <= hs[0]!.t) return hs[0]!;
    let i = hs.length - 1;
    while (hs[i - 1]!.t > t) i--;
    const [a, b] = [hs[i - 1]!, hs[i]!];
    const f = (t - a.t) / (b.t - a.t);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, h: a.h + (b.h - a.h) * f };
  }

  /** A jump (a respawn): don't rewind across it. */
  clear(): void {
    this.at_.length = 0;
  }
}

// ---------------------------------------------------------------- serving a built game

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * A request handler for a built game's directory (D-114), beside the rooms on
 * the same server: GET and HEAD only, nothing outside `root`, `index.html` for
 * a directory. Vite's hashed `/assets/` are cached for good; the rest is
 * checked each time. World package files (`.gz` and the like) go out as they
 * are stored, for the page to inflate.
 */
export function serveStatic(root: string): (req: IncomingMessage, res: ServerResponse) => void {
  const base = normalize(root.endsWith(sep) ? root : root + sep);
  return (req, res) => {
    const fail = (code: number, text: string) => {
      res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
      res.end(text);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "method not allowed");
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "http://game").pathname);
    } catch {
      return fail(400, "bad path");
    }
    let file = normalize(join(base, path));
    if (path.includes("\0") || !(file + sep).startsWith(base)) return fail(404, "not found");
    let stat = statSync(file, { throwIfNoEntry: false });
    if (stat?.isDirectory()) {
      file = join(file, "index.html");
      stat = statSync(file, { throwIfNoEntry: false });
    }
    if (!stat?.isFile()) return fail(404, "not found");
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "content-length": stat.size,
      "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
  };
}
