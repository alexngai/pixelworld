import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { SERVER, type ServerMessage, type TickMessage, type TickSnapshot } from "./index";

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

// ---------------------------------------------------------------- a game at a fixed tick

export interface TickRoomOptions {
  /** The fixed step (s; default 1/60): the pages' `TickClient` steps at the same. */
  tick?: number;
  /** A snapshot every this many ticks (default 3: 20 a second at 60). */
  snapshotEvery?: number;
  /** Inputs a player may have waiting (default 120), and steps it may catch up in one tick after a stall (default 8). */
  maxQueue?: number;
  maxBurst?: number;
  /** Players are added once this resolves (the game's world, say); until then they wait. */
  ready?: Promise<unknown>;
  /** Run in real time (default); off for tests, which call `tick()`. */
  clock?: boolean;
}

interface TickPlayer<I> {
  name: string;
  queue: { seq: number; i: I; seen: number | null }[];
  ack: number;
  budget: number;
}

/**
 * A room whose game the server runs at a fixed tick (D-113, D-114): the
 * `host` of `attachRelay`. Each player's inputs (`TickMessage`, from a
 * `TickClient`) queue, numbered, and are stepped one a tick, a backlog caught
 * up a few at a time, so a page can't play faster than the clock; out-of-order
 * and excess inputs are dropped, and the game validates each (`input`). Every
 * `snapshotEvery` ticks each player gets a snapshot: the server time, the last
 * of its inputs stepped, and the game's fields for it.
 *
 * A game says what an input is (`input`), what a player's step does (`step`),
 * what the world does each tick (`update`) and what a snapshot carries
 * (`snapshot`).
 */
export abstract class TickRoom<I> implements RoomHost {
  /** Server time (s): whole ticks. */
  time = 0;
  readonly tickLength: number;
  private readonly tickPlayers = new Map<string, TickPlayer<I>>();
  private readonly waiting = new Map<string, string>();
  private isReady: boolean;
  private ticks = 0;
  private last = performance.now();
  private acc = 0;
  private readonly timer: ReturnType<typeof setInterval> | null;

  constructor(
    protected readonly room: HostedRoom,
    private readonly opts: TickRoomOptions = {},
  ) {
    this.tickLength = opts.tick ?? 1 / 60;
    this.isReady = !opts.ready;
    opts.ready?.then(
      () => {
        this.isReady = true;
        for (const [id, name] of this.waiting) this.add(id, name);
        this.waiting.clear();
      },
      () => {}, // the game says why
    );
    this.timer = opts.clock === false ? null : setInterval(() => this.run(), (this.tickLength * 1000) / 2);
  }

  /** An untrusted input from a page, as the game's own (clamped, checked), or null to drop it. */
  protected abstract input(data: unknown): I | null;
  /** A player arrives (its name sanitized) once the room is ready. */
  protected abstract added(id: string, name: string): void;
  protected abstract removed(id: string): void;
  /** One tick of a player with its input; `seen` as its page sent it (`lagOf` turns it into a rewind). */
  protected abstract step(id: string, input: I, seen: number | null): void;
  /** The world's own tick, after the players' steps. */
  protected update(): void {}
  /** What a player's snapshot carries besides `t` and `ack`. */
  protected abstract snapshot(id: string): object;
  /** A player named itself. */
  protected renamed(_id: string, _name: string): void {}

  join(id: string): void {
    if (this.isReady) this.add(id, `Pilot ${id}`);
    else this.waiting.set(id, `Pilot ${id}`);
  }

  leave(id: string): void {
    this.waiting.delete(id);
    if (this.tickPlayers.delete(id)) this.removed(id);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }

  message(id: string, data: unknown): void {
    const m = data as Partial<TickMessage<unknown>> | null;
    if (!m || typeof m !== "object") return;
    if (m.k === "hello" && typeof m.name === "string") {
      const name = m.name.trim().slice(0, 20) || `Pilot ${id}`;
      if (this.waiting.has(id)) this.waiting.set(id, name);
      const p = this.tickPlayers.get(id);
      if (p) {
        p.name = name;
        this.renamed(id, name);
      }
      return;
    }
    const p = this.tickPlayers.get(id);
    if (m.k !== "in" || !p || !Number.isInteger(m.seq) || m.seq! <= (p.queue.at(-1)?.seq ?? p.ack) || p.queue.length >= (this.opts.maxQueue ?? 120)) return;
    const i = this.input(m.i);
    if (i === null) return;
    p.queue.push({ seq: m.seq!, i, seen: typeof m.seen === "number" && Number.isFinite(m.seen) ? m.seen : null });
  }

  /** A player's name, as it gave it. */
  nameOf(id: string): string {
    return this.tickPlayers.get(id)?.name ?? this.waiting.get(id) ?? `Pilot ${id}`;
  }

  /** The last of a player's inputs stepped. */
  ackOf(id: string): number {
    return this.tickPlayers.get(id)?.ack ?? 0;
  }

  /** The players in the game (not those waiting for it). */
  playerIds(): string[] {
    return [...this.tickPlayers.keys()];
  }

  /** How far back to rewind for what a page saw at `seen` (s), at most `max`. */
  lagOf(seen: number | null, max: number): number {
    return seen === null ? 0 : Math.max(0, Math.min(max, this.time - seen));
  }

  /** One tick: the players' steps, the world's, and a snapshot every `snapshotEvery`. */
  tick(): void {
    this.time = ++this.ticks * this.tickLength;
    if (!this.isReady) return;
    const burst = this.opts.maxBurst ?? 8;
    for (const [id, p] of this.tickPlayers) {
      p.budget = Math.min(burst, p.budget + 1);
      while (p.budget >= 1 && p.queue.length) {
        p.budget--;
        const next = p.queue.shift()!;
        p.ack = next.seq;
        this.step(id, next.i, next.seen);
      }
    }
    this.update();
    if (this.ticks % (this.opts.snapshotEvery ?? 3) === 0)
      for (const [id, p] of this.tickPlayers) this.room.send(id, { k: "snap", t: this.time, ack: p.ack, ...this.snapshot(id) } satisfies TickSnapshot);
  }

  private add(id: string, name: string): void {
    this.tickPlayers.set(id, { name, queue: [], ack: 0, budget: 0 });
    this.added(id, name);
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
