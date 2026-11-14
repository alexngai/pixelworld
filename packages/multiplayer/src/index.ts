import type { Entity, EntityList, EntitySpec } from "pixelworld/engine";
import { Reader, type Schema } from "./codec";
import { Replica, SNAP_BYTE, WORLD_BYTE, type ReplicaUpdate } from "./replica";

export * from "./codec";
export * from "./replica";

/**
 * @pixelworlds/multiplayer: what a pixelworld game needs to put several
 * players in one world (D-112), kept out of the engine (D-111).
 *
 * - `joinRoom(url, room)`: a room on a server (`@pixelworlds/multiplayer/server`),
 *   relayed (each player's messages reach the others) or run by the server.
 * - `TickClient`: a page in a room the server runs at a fixed tick (D-114,
 *   D-116): its join, its commands, and its inputs, stepped at once
 *   (`Prediction`) and put right by each snapshot.
 * - `ServerClock`, `Smoothing`, `RemotePlayers`: the others, drawn a little
 *   in the past and in between, as entities in a world view.
 */

// ---------------------------------------------------------------- protocol

/** `from` on what a hosted room's game sends (D-113). */
export const SERVER = "server";

/**
 * A page to a `TickRoom` (D-114, D-116): who it is (`hello`, the game's own
 * join data), its inputs, numbered, with `seen` (when what it shows of the
 * others happened, on the server's clock), and commands (a team pick, a
 * ready, a build: reliable, once), numbered `n` by a `TickClient` (D-121).
 */
export type TickMessage<I> = { k: "hello"; join: unknown } | { k: "in"; seq: number; i: I; seen: number | null } | { k: "cmd"; c: unknown; n?: number };

/** A `TickRoom`'s snapshot for one player: server time, the last of its inputs stepped, and its own state (the game's fields). */
export interface TickSnapshot {
  k: "snap";
  t: number;
  ack: number;
  /** The last numbered command the game took from this page (D-121): its state here has it. Absent until one. */
  cmd?: number;
}

/** A `TickRoom`'s shared snapshot, to every page at once: server time and the game's fields (the others, the score). */
export interface TickShared {
  k: "world";
  t: number;
}

/** A `TickRoom`'s roster (D-123): the game's fields (`roster()`), sent when they change. */
export interface TickRoster {
  k: "roster";
  t: number;
}

/** A `TickRoom`'s event (`emit`): the game's own, at server time `t`; a page shows it when it shows that time of the others (`TickClient.due`). */
export interface TickEvent<E> {
  k: "ev";
  t: number;
  e: E;
}

/** A room as the lobby lists it (`Relay.list`, `listRooms`): its code, players, room for more, and what its game says of it. */
export interface RoomInfo {
  name: string;
  players: number;
  max: number;
  info: object;
}

/** What the server sends (JSON text frames). A player sends its own messages as plain JSON. */
export type ServerMessage =
  | { t: "welcome"; id: string; peers: string[] }
  | { t: "join"; id: string }
  | { t: "leave"; id: string }
  | { t: "msg"; from: string; data: unknown }
  | { t: "full" }
  /** Sent away, and why (kicked, the room closed, the server full); the connection closes. */
  | { t: "bye"; why: string };

// ---------------------------------------------------------------- a room

export interface Room {
  /** This player's id in the room (the server's). */
  readonly id: string;
  /** The other players in the room. */
  readonly peers: ReadonlySet<string>;
  readonly name: string;
  /** To the others (relayed), or to the room's game (hosted): JSON. */
  send(data: unknown): void;
  onMessage: ((from: string, data: unknown) => void) | null;
  onJoin: ((id: string) => void) | null;
  onLeave: ((id: string) => void) | null;
  /** The connection closed: why, when the server said (kicked, the room closed), else null. */
  onClose: ((why: string | null) => void) | null;
  close(): void;
}

class RoomImpl implements Room {
  readonly peers: Set<string>;
  /** What came before there was a handler: a keyframe the page then diffs from (D-123) mustn't be lost. */
  private held: [string, unknown][] = [];
  private handler: Room["onMessage"] = null;
  onJoin: Room["onJoin"] = null;
  onLeave: Room["onLeave"] = null;
  onClose: Room["onClose"] = null;
  why: string | null = null;

  constructor(
    private readonly ws: WebSocket,
    readonly id: string,
    readonly name: string,
    peers: string[],
  ) {
    this.peers = new Set(peers);
  }

  send(data: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data));
  }

  get onMessage(): Room["onMessage"] {
    return this.handler;
  }

  set onMessage(f: Room["onMessage"]) {
    this.handler = f;
    if (!f) return;
    const held = this.held;
    this.held = [];
    for (const [from, data] of held) f(from, data);
  }

  /** A message for the page: to its handler, or held until it has one. */
  deliver(from: string, data: unknown): void {
    if (this.handler) this.handler(from, data);
    else this.held.push([from, data]);
  }

  receive(m: ServerMessage): void {
    if (m.t === "msg") this.deliver(m.from, m.data);
    else if (m.t === "join") {
      this.peers.add(m.id);
      this.onJoin?.(m.id);
    } else if (m.t === "leave") {
      this.peers.delete(m.id);
      this.onLeave?.(m.id);
    } else if (m.t === "bye") this.why = m.why;
  }

  close(): void {
    this.ws.close();
  }
}

/**
 * Join a room: `url` is the server's WebSocket path (`ws:`, `wss:`, or
 * `http(s):` and relative URLs, taken as the page's own host). Rejects when
 * no server answers, the room is full, or the server sends the page away.
 */
export function joinRoom(url: string | URL, room: string): Promise<Room> {
  const u = new URL(url, globalThis.location?.href);
  u.protocol = u.protocol.replace(/^http/, "ws");
  u.searchParams.set("room", room);
  const ws = new WebSocket(u);
  ws.binaryType = "arraybuffer";
  return new Promise((resolve, reject) => {
    let joined: RoomImpl | null = null;
    let why: string | null = null;
    ws.onmessage = (e) => {
      // binary: a hosted game's (D-123)
      if (typeof e.data !== "string") return joined?.deliver(SERVER, new Uint8Array(e.data as ArrayBuffer));
      const m = JSON.parse(String(e.data)) as ServerMessage;
      if (m.t === "welcome") resolve((joined = new RoomImpl(ws, m.id, room, m.peers)));
      else if (m.t === "full") why = `room "${room}" is full`;
      else if (m.t === "bye" && !joined) why = m.why;
      else joined?.receive(m);
    };
    const unanswered = () => new Error(why ?? `no server answered at ${u.origin}${u.pathname}`);
    // a refused connection: browsers fire error then close; Node's WebSocket only error
    ws.onerror = () => {
      if (!joined) reject(unanswered());
    };
    ws.onclose = () => {
      if (joined) joined.onClose?.(joined.why);
      else reject(unanswered());
    };
  });
}

// ---------------------------------------------------------------- clocks and smoothing

/**
 * Another clock as this page sees it: theirs less ours, taken at its
 * smallest (the quickest a message came) over the last `window` seconds, so
 * jitter in the network doesn't shake it and it comes back after a stall
 * (D-116). One for a room the server runs: everything there carries the
 * server's time.
 */
export class ServerClock {
  /** (our time, their time less ours), the last `window` seconds. */
  private readonly samples: [number, number][] = [];
  private offset: number | null = null;

  /** @param window Seconds over which the smallest gap is taken (default 10). */
  constructor(readonly window = 10) {}

  /** A message stamped `t` on their clock arrived at `now` on ours (seconds). */
  sample(t: number, now: number): void {
    const gap = t - now;
    this.samples.push([now, gap]);
    while (this.samples.length && now - this.samples[0]![0] > this.window) this.samples.shift();
    let best = -Infinity;
    for (const [, g] of this.samples) best = Math.max(best, g); // their clock less ours, at the quickest message
    this.offset = best;
  }

  /** Their time at our `now`, less `delay` (null before any message). */
  time(now: number, delay = 0): number | null {
    return this.offset === null ? null : now + this.offset - delay;
  }
}

/** Where a vehicle is and how it is turned: cells, steps, radians (as an entity's). */
export interface Pose {
  x: number;
  y: number;
  h: number;
  heading: number;
  pitch?: number;
  roll?: number;
  /** Which life this is (a count of respawns, say): when it changes, the vehicle is drawn there at once, not slid there. */
  life?: number;
}

interface Sample {
  /** The sender's clock (seconds). */
  t: number;
  pose: Pose;
}

/** Samples kept per player: a few seconds at 20 a second. */
const KEEP = 60;

/** Toward b by f, the short way round. */
function turn(a: number, b: number, f: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * f;
}

function lerp(a: Pose, b: Pose, f: number): Pose {
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    h: a.h + (b.h - a.h) * f,
    heading: turn(a.heading, b.heading, f),
    pitch: turn(a.pitch ?? 0, b.pitch ?? 0, f),
    roll: turn(a.roll ?? 0, b.roll ?? 0, f),
    life: a.life,
  };
}

/**
 * Other players' poses, drawn `delay` seconds in the past so there is nearly
 * always a sample on each side to move between. Each sample carries its
 * sender's clock: one `ServerClock` for all of them (a room the server runs),
 * or one per sender (a relayed room, where each page stamps its own).
 */
export class Smoothing {
  private readonly samples = new Map<string, Sample[]>();
  private readonly clocks = new Map<string, ServerClock>();

  /**
   * @param delay Seconds behind the newest pose (default 0.1: two samples at 20 a second).
   * @param clock The one clock every sample carries (a room the server runs); else one per sender.
   */
  constructor(
    readonly delay = 0.1,
    private readonly clock: ServerClock | null = null,
  ) {}

  private clockOf(id: string): ServerClock {
    if (this.clock) return this.clock;
    let c = this.clocks.get(id);
    if (!c) this.clocks.set(id, (c = new ServerClock()));
    return c;
  }

  /** A pose at `sent` on the sender's clock (seconds), received `now` on ours. */
  push(id: string, sent: number, pose: Pose, now: number): void {
    this.clockOf(id).sample(sent, now);
    let list = this.samples.get(id);
    if (!list) this.samples.set(id, (list = []));
    if (list.length && sent <= list[list.length - 1]!.t) return; // late or repeated
    list.push({ t: sent, pose });
    if (list.length > KEEP) list.shift();
  }

  /** Where a player is drawn at `now` (our clock, seconds); null for one never heard from. */
  at(id: string, now: number): Pose | null {
    const list = this.samples.get(id);
    if (!list?.length) return null;
    const t = this.clockOf(id).time(now, this.delay)!;
    while (list.length > 2 && list[1]!.t <= t) list.shift(); // passed
    const [a, b] = list;
    if (!b || t <= a!.t) return a!.pose; // the oldest, until time reaches it
    if (t >= b.t) return b.pose; // nothing newer yet: hold the newest
    if ((a!.pose.life ?? 0) !== (b.pose.life ?? 0)) return a!.pose; // a respawn: there at once, not slid there
    return lerp(a!.pose, b.pose, (t - a!.t) / (b.t - a!.t));
  }

  /** When what `at` draws at `now` happened, on the sender's clock: what this page sees of it (null for one never heard from). */
  time(id: string, now: number): number | null {
    return this.samples.has(id) ? this.clockOf(id).time(now, this.delay) : null;
  }

  delete(id: string): void {
    this.samples.delete(id);
    this.clocks.delete(id);
  }

  ids(): string[] {
    return [...this.samples.keys()];
  }
}

// ---------------------------------------------------------------- prediction

/**
 * Prediction, for a room the server runs (D-113): the player's own vehicle
 * steps at once with each input (`apply`), and the input goes to the server
 * with its number. A snapshot says the last input the server has stepped and
 * the state after it (`reconcile`): that state goes back in place and the
 * inputs the server hasn't stepped yet are stepped again, so the vehicle
 * answers the keys at once and still ends where the server says. Both sides
 * step the same code at the same fixed time step.
 */
export class Prediction<I> {
  private readonly pending: { seq: number; input: I }[] = [];
  private seq = 0;

  /**
   * @param step One fixed step of the player's own vehicle with an input.
   * @param keep Inputs kept for the server at most (default 600: 10 s at 60 a second).
   */
  constructor(
    private readonly step: (input: I) => void,
    private readonly keep = 600,
  ) {}

  /** Step with an input; send it to the server with the number this returns. */
  apply(input: I): number {
    const seq = ++this.seq;
    this.pending.push({ seq, input });
    if (this.pending.length > this.keep) this.pending.shift();
    this.step(input);
    return seq;
  }

  /** The server has stepped every input up to `ack`: `restore` puts its state in place, and the later ones are stepped again. */
  reconcile(ack: number, restore: () => void): void {
    while (this.pending.length && this.pending[0]!.seq <= ack) this.pending.shift();
    restore();
    for (const p of this.pending) this.step(p.input);
  }

  /** Inputs stepped here that the server hasn't yet. */
  get unacknowledged(): number {
    return this.pending.length;
  }
}

/**
 * A prediction's corrections, drawn smoothly (D-119). When a snapshot moves
 * the page's own vehicle (a bump the server judged otherwise), it is drawn
 * where it was and eases to where it is, so neither it nor the camera
 * following it snaps; its state, which the next inputs step from, is the
 * server's at once. A jump past `snap` cells (a respawn, the grid) is drawn
 * there at once.
 *
 *   restore: (snap) => { before = { ...me }; Object.assign(me, snap.you) },
 *   reconciled: () => correction.moved(before, me),
 *   each frame: correction.update(dt); draw at me + correction.offset
 */
export class Correction {
  /** Draw the vehicle this far off its state: cells, steps, radians. */
  readonly offset = { x: 0, y: 0, h: 0, heading: 0 };

  /**
   * @param halfLife Seconds for an offset to halve (default 0.1).
   * @param snap Cells past which a correction is drawn at once (default 3).
   */
  constructor(
    readonly halfLife = 0.1,
    readonly snap = 3,
  ) {}

  /** A reconcile moved the vehicle from `before` to `after`: it is drawn on from where it was. */
  moved(before: Pose, after: Pose): void {
    const o = this.offset;
    const x = o.x + before.x - after.x;
    const y = o.y + before.y - after.y;
    if (Math.hypot(x, y) > this.snap) return this.reset();
    o.x = x;
    o.y = y;
    o.h += before.h - after.h;
    o.heading += Math.atan2(Math.sin(before.heading - after.heading), Math.cos(before.heading - after.heading));
  }

  /** Ease out over a frame of `dt` seconds. */
  update(dt: number): void {
    const k = 0.5 ** (dt / this.halfLife);
    const o = this.offset;
    for (const key of ["x", "y", "h", "heading"] as const) o[key] = Math.abs(o[key] * k) < 1e-4 ? 0 : o[key] * k;
  }

  reset(): void {
    Object.assign(this.offset, { x: 0, y: 0, h: 0, heading: 0 });
  }

  /** How far off it is drawn now (cells across). */
  get size(): number {
    return Math.hypot(this.offset.x, this.offset.y);
  }
}

// ---------------------------------------------------------------- events at their time

/**
 * Events held until their time (D-118): each stamped with the time it
 * happened on another clock (the server's), and let out (`due`) once the page
 * shows that time of the others, so a shot or an explosion doesn't run ahead
 * of the planes it belongs to.
 */
export class EventQueue<E> {
  private readonly held: { t: number; e: E }[] = [];

  push(t: number, e: E): void {
    let i = this.held.length;
    while (i > 0 && this.held[i - 1]!.t > t) i--;
    this.held.splice(i, 0, { t, e });
  }

  /** The events up to `shown` (that clock's time the page shows), oldest first; none before the page knows the time. */
  due(shown: number | null): E[] {
    if (shown === null) return [];
    let n = 0;
    while (n < this.held.length && this.held[n]!.t <= shown) n++;
    return this.held.splice(0, n).map((h) => h.e);
  }

  get size(): number {
    return this.held.length;
  }
}

// ---------------------------------------------------------------- a page in a room the server runs

export interface TickClientOptions<I, S, W, R extends object = object> {
  /** The room's fixed step (s): the server's `TickRoom` steps at the same. */
  tick: number;
  /** One fixed step of the page's own vehicle with an input (none for a spectator). */
  step?: (input: I) => void;
  /** A snapshot of the page's own: put the server's state for it in place (the inputs not yet stepped there are stepped again after). */
  restore?: (snap: TickSnapshot & S) => void;
  /** After a snapshot is put in place and the inputs stepped again: to see how far the prediction was off. */
  reconciled?: (snap: TickSnapshot & S) => void;
  /** The shared snapshot (the others, the score), as it arrives; with `schema`, the replicated things in `entities` (D-123). */
  onWorld?: (world: TickShared & W & { entities?: ReplicaUpdate<R> }) => void;
  /** The schema of what the room replicates in binary (its `Replicator`'s), D-123. */
  schema?: Schema<R>;
  /** The schema of the page's own snapshot in binary (its `TickRoom.snapSchema`), D-123. */
  snapSchema?: Schema<S & object>;
  /** The roster (names, scores), when it changes (D-123). */
  onRoster?: (roster: TickRoster & Record<string, unknown>) => void;
  /** Anything else the room's game sends. */
  onMessage?: (data: unknown) => void;
  /** How far behind the page draws the others (s; default 0.1, `Smoothing`'s): `seen` is the server time it shows, and events wait for it. */
  delay?: number;
  /** Ticks one frame may catch up (default 6): a stalled tab doesn't burst inputs at the server. */
  maxTicksPerFrame?: number;
  /** The page's clock (s; default `performance.now()`): tests pass their own. */
  now?: () => number;
}

/** A player's own snapshot in binary (`TickRoom.snapSchema`, D-123), read back: `t` from its tick and the room's tick length. */
export function readSnap<S extends object>(data: Uint8Array, schema: Schema<S>, tick: number): TickSnapshot & S {
  const r = new Reader(data);
  if (r.byte() !== SNAP_BYTE) throw new Error("not a binary snapshot");
  const t = r.uint() * tick;
  const ack = r.uint();
  const cmd = r.uint();
  return { ...schema.value(schema.readFull(r)), k: "snap", t, ack, ...(cmd ? { cmd } : {}) };
}

/**
 * A page in a `TickRoom` (D-114, D-116, D-118). It takes the room's server
 * messages: the shared snapshot (`onWorld`), its own snapshots (put in place
 * once a frame, at the next `advance`: a burst after a stall replays its
 * inputs once, not once each), and events (`due` lets them out at their
 * time). It says who it is (`hello`), sends commands (`command`), and as a
 * player its inputs at the room's fixed tick, stepped at once (`Prediction`),
 * numbered and sent with `seen`. `clock` is the server's: give it to
 * `RemotePlayers`. `ping` is the round trip from an input (or a command) to
 * the snapshot that has it.
 *
 * A page with no vehicle of its own (a strategy game's, D-121) sends no
 * inputs: it calls `sync` each frame instead of `advance`, and its numbered
 * commands come back acknowledged (`TickSnapshot.cmd`), so it can show an
 * order at once and know which snapshot has it.
 */
export class TickClient<I, S = unknown, W = unknown, E = unknown, R extends object = object> {
  readonly prediction: Prediction<I>;
  /** What the room replicates to this page, with `schema` (D-123). */
  readonly replica: Replica<R> | null;
  readonly clock = new ServerClock();
  readonly events = new EventQueue<E>();
  /** The round trip from an input or a command to the snapshot that has it (ms, recent average), or null before one. */
  ping: number | null = null;
  private acc = 0;
  private latest: (TickSnapshot & S) | null = null;
  private readonly sentAt = new Map<number, number>();
  private cmdSeq = 0;
  private readonly cmdSentAt = new Map<number, number>();
  private readonly now: () => number;

  constructor(
    readonly room: Room,
    private readonly opts: TickClientOptions<I, S, W, R>,
  ) {
    this.prediction = new Prediction(opts.step ?? (() => {}));
    this.now = opts.now ?? (() => performance.now() / 1000);
    this.replica = opts.schema ? new Replica(opts.schema) : null;
    room.onMessage = (from, data) => {
      if (from !== SERVER) return;
      if (data instanceof Uint8Array) {
        if (data[0] === SNAP_BYTE) {
          if (!opts.snapSchema) return;
          const snap = readSnap(data, opts.snapSchema, opts.tick);
          this.clock.sample(snap.t, this.now());
          this.snapshot(snap);
          return;
        }
        if (data[0] !== WORLD_BYTE || !this.replica) return opts.onMessage?.(data);
        const u = this.replica.read(data);
        const t = u.tick * opts.tick;
        this.clock.sample(t, this.now());
        opts.onWorld?.({ ...(u.extras as W), k: "world", t, entities: u });
        return;
      }
      const m = data as { k?: unknown; t?: unknown };
      const t = typeof m?.t === "number" ? m.t : null;
      if (t !== null && (m.k === "world" || m.k === "snap" || m.k === "ev")) this.clock.sample(t, this.now());
      if (m.k === "world") opts.onWorld?.(data as TickShared & W);
      else if (m.k === "snap") this.snapshot(data as TickSnapshot & S);
      else if (m.k === "ev") this.events.push((data as TickEvent<E>).t, (data as TickEvent<E>).e);
      else if (m.k === "roster") opts.onRoster?.(data as TickRoster & Record<string, unknown>);
      else opts.onMessage?.(data);
    };
  }

  /** Who this page is: the game's join data (a name, a team, to watch). */
  hello(join: unknown): void {
    this.room.send({ k: "hello", join } satisfies TickMessage<I>);
  }

  /** A command to the room's game: reliable, once (not a tick's input). Its number: the first snapshot whose `cmd` is at least it has it. */
  command(c: unknown): number {
    const n = ++this.cmdSeq;
    this.cmdSentAt.set(n, this.now());
    if (this.cmdSentAt.size > 100) this.cmdSentAt.delete(this.cmdSentAt.keys().next().value!); // a spectator's: no snapshot of its own acknowledges them
    this.room.send({ k: "cmd", c, n } satisfies TickMessage<I>);
    return n;
  }

  /** The server time this page shows of the others now (null before any message). */
  seen(now = this.now()): number | null {
    return this.clock.time(now, this.opts.delay ?? 0.1);
  }

  /** The events whose time the page now shows of the others, oldest first. */
  due(now = this.now()): E[] {
    return this.events.due(this.seen(now));
  }

  /**
   * A frame: the newest snapshot of the page's own put in place (and the
   * inputs the server hasn't stepped yet stepped again), then the ticks in
   * `dt` seconds: each samples `input()`, steps and sends it, then calls
   * `after` with it and its number (effects drawn at once, which the server's
   * events will name by that number).
   */
  advance(dt: number, input: () => I, after?: (input: I, seq: number) => void): void {
    this.sync();
    const tick = this.opts.tick;
    this.acc = Math.min(this.acc + dt, (this.opts.maxTicksPerFrame ?? 6) * tick);
    while (this.acc >= tick) {
      this.acc -= tick;
      const i = input();
      const seq = this.prediction.apply(i);
      this.sentAt.set(seq, this.now());
      after?.(i, seq);
      this.room.send({ k: "in", seq, i, seen: this.seen() } satisfies TickMessage<I>);
    }
  }

  /**
   * The newest snapshot of the page's own put in place (`restore`, the inputs
   * the server hasn't stepped yet stepped again, `reconciled`), if one came
   * since: what `advance` does first. A page with no vehicle calls it each
   * frame instead.
   */
  sync(): void {
    const snap = this.latest;
    if (!snap) return;
    this.latest = null;
    this.prediction.reconcile(snap.ack, () => this.opts.restore?.(snap));
    this.opts.reconciled?.(snap);
  }

  private snapshot(snap: TickSnapshot & S): void {
    if (this.latest && snap.t < this.latest.t) return;
    this.latest = snap;
    this.measure(this.sentAt, snap.ack);
    if (typeof snap.cmd === "number") this.measure(this.cmdSentAt, snap.cmd);
  }

  /** The round trip to a snapshot that has what was sent as `n`, and what it has let go. */
  private measure(sentAt: Map<number, number>, n: number): void {
    const sent = sentAt.get(n);
    if (sent !== undefined) {
      const ms = (this.now() - sent) * 1000;
      this.ping = this.ping === null ? ms : this.ping * 0.8 + ms * 0.2;
    }
    for (const k of sentAt.keys()) if (k <= n) sentAt.delete(k);
  }
}

// ---------------------------------------------------------------- names and the lobby

/**
 * A player's name made safe to show the others (D-118): letters, digits,
 * spaces and `-_.'`, no control or direction-changing characters, at most
 * `max` long; empty if nothing is left.
 */
export function cleanName(raw: unknown, max = 20): string {
  if (typeof raw !== "string") return "";
  return raw
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} _.'-]/gu, "")
    .replace(/ +/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

const lobbyJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `the lobby answered ${res.status}`);
  return body;
};

/** The public rooms, busiest first (`lobbyHandler`'s `GET <base>/rooms`). */
export function listRooms(base = "/api"): Promise<RoomInfo[]> {
  return lobbyJson(`${base}/rooms`);
}

/** Open a room: its code, to join and to share (`POST <base>/rooms`). */
export async function openRoom(opts: { public?: boolean; settings?: unknown } = {}, base = "/api"): Promise<string> {
  return (await lobbyJson<{ room: string }>(`${base}/rooms`, { method: "POST", body: JSON.stringify(opts) })).room;
}

/** Quick play: the code of the room to join (`POST <base>/quick`). */
export async function quickRoom(settings?: unknown, base = "/api"): Promise<string> {
  return (await lobbyJson<{ room: string }>(`${base}/quick`, { method: "POST", body: JSON.stringify({ settings }) })).room;
}

// ---------------------------------------------------------------- other players as entities

export interface RemotePlayersOptions {
  /** Seconds behind the newest pose (default 0.1). */
  delay?: number;
  /** The server's clock (a room the server runs: `TickClient.clock`); else one per sender. */
  clock?: ServerClock;
}

/**
 * Other players in a world view: an entity each (with `wait: false`, D-111),
 * made on its first pose and moved by `update` every frame.
 */
export class RemotePlayers {
  readonly smoothing: Smoothing;
  private readonly entities = new Map<string, Entity>();
  private readonly drawn = new Map<string, Pose>();

  /**
   * @param list The view's entities (`view.entities`).
   * @param spec Each player's entity, but where it is: its model, headings, silhouette…
   */
  constructor(
    private readonly list: EntityList,
    private readonly spec: (id: string) => Omit<EntitySpec, "x" | "y" | "h" | "heading" | "pitch" | "roll" | "wait">,
    opts: RemotePlayersOptions = {},
  ) {
    this.smoothing = new Smoothing(opts.delay, opts.clock ?? null);
  }

  /** A player's pose at `sent` on its clock (seconds); a new `life` is drawn there at once. */
  push(id: string, sent: number, pose: Pose, now = performance.now() / 1000): void {
    this.smoothing.push(id, sent, pose, now);
  }

  /** Move every player's entity to where it is drawn now (call it each frame). */
  update(now = performance.now() / 1000): void {
    for (const id of this.smoothing.ids()) {
      const p = this.smoothing.at(id, now)!;
      let e = this.entities.get(id);
      if (!e) {
        e = this.list.add({ ...this.spec(id), x: p.x, y: p.y, h: p.h, heading: p.heading, pitch: p.pitch, roll: p.roll, wait: false });
        this.entities.set(id, e);
      }
      e.moveTo(p.x, p.y, p.h);
      e.heading = p.heading;
      e.pitch = p.pitch ?? 0;
      e.roll = p.roll ?? 0;
      this.drawn.set(id, p);
    }
  }

  /** Where a player was drawn last `update`: what this player sees, to aim and hit at. */
  pose(id: string): Pose | null {
    return this.drawn.get(id) ?? null;
  }

  entity(id: string): Entity | null {
    return this.entities.get(id) ?? null;
  }

  ids(): string[] {
    return [...this.drawn.keys()];
  }

  /** Keep only these players (the ones a snapshot has): the rest go, as when they leave. */
  retain(ids: Iterable<string>): void {
    const keep = new Set(ids);
    for (const id of [...this.entities.keys(), ...this.smoothing.ids()]) if (!keep.has(id)) this.remove(id);
  }

  /** A player left: its entity goes. */
  remove(id: string): void {
    this.entities.get(id)?.remove();
    this.entities.delete(id);
    this.drawn.delete(id);
    this.smoothing.delete(id);
  }

  clear(): void {
    this.retain([]);
  }
}
