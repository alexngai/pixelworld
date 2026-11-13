import type { Entity, EntityList, EntitySpec } from "pixelworld/engine";

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
 * ready, a build: reliable, once).
 */
export type TickMessage<I> = { k: "hello"; join: unknown } | { k: "in"; seq: number; i: I; seen: number | null } | { k: "cmd"; c: unknown };

/** A `TickRoom`'s snapshot for one player: server time, the last of its inputs stepped, and its own state (the game's fields). */
export interface TickSnapshot {
  k: "snap";
  t: number;
  ack: number;
}

/** A `TickRoom`'s shared snapshot, to every page at once: server time and the game's fields (the others, the score). */
export interface TickShared {
  k: "world";
  t: number;
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
  onMessage: Room["onMessage"] = null;
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

  receive(m: ServerMessage): void {
    if (m.t === "msg") this.onMessage?.(m.from, m.data);
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
  return new Promise((resolve, reject) => {
    let joined: RoomImpl | null = null;
    let why: string | null = null;
    ws.onmessage = (e) => {
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

// ---------------------------------------------------------------- a page in a room the server runs

export interface TickClientOptions<I> {
  /** The room's fixed step (s): the server's `TickRoom` steps at the same. */
  tick: number;
  /** One fixed step of the page's own vehicle with an input (none for a spectator). */
  step?: (input: I) => void;
  /** How far behind the page draws the others (s; default 0.1, `Smoothing`'s): `seen` is the server time it shows. */
  delay?: number;
  /** Ticks one frame may catch up (default 6): a stalled tab doesn't burst inputs at the server. */
  maxTicksPerFrame?: number;
}

/**
 * A page in a `TickRoom` (D-114, D-116): it says who it is (`hello`), sends
 * commands (`command`), and as a player its inputs at the room's fixed tick,
 * stepped at once (`Prediction`), numbered and sent with `seen`;
 * `reconcile` on each of its snapshots. `clock` is the server's, from every
 * snapshot: give it to `RemotePlayers`, and time events by it.
 */
export class TickClient<I> {
  readonly prediction: Prediction<I>;
  readonly clock = new ServerClock();
  private acc = 0;

  constructor(
    readonly room: Room,
    private readonly opts: TickClientOptions<I>,
  ) {
    this.prediction = new Prediction(opts.step ?? (() => {}));
  }

  /** Who this page is: the game's join data (a name, a team, to watch). */
  hello(join: unknown): void {
    this.room.send({ k: "hello", join } satisfies TickMessage<I>);
  }

  /** A command to the room's game: reliable, once (not a tick's input). */
  command(c: unknown): void {
    this.room.send({ k: "cmd", c } satisfies TickMessage<I>);
  }

  /** The server time this page shows of the others at `now` (null before any snapshot). */
  seen(now = performance.now() / 1000): number | null {
    return this.clock.time(now, this.opts.delay ?? 0.1);
  }

  /** The ticks in `dt` seconds: each samples `input()`, steps and sends it, then calls `after` (effects drawn at once). */
  advance(dt: number, input: () => I, after?: (input: I) => void): void {
    const tick = this.opts.tick;
    this.acc = Math.min(this.acc + dt, (this.opts.maxTicksPerFrame ?? 6) * tick);
    while (this.acc >= tick) {
      this.acc -= tick;
      const i = input();
      const seq = this.prediction.apply(i);
      after?.(i);
      this.room.send({ k: "in", seq, i, seen: this.seen() } satisfies TickMessage<I>);
    }
  }

  /** A server message stamped `t` arrived: the clock learns from it (snapshots do this themselves). */
  heard(t: number, now = performance.now() / 1000): void {
    this.clock.sample(t, now);
  }

  /** A snapshot of this page's own: `restore` puts the server's state in place, and the inputs it hasn't stepped yet are stepped again. */
  reconcile(snap: TickSnapshot, restore: () => void, now = performance.now() / 1000): void {
    this.clock.sample(snap.t, now);
    this.prediction.reconcile(snap.ack, restore);
  }
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
