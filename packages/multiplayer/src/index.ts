import type { Entity, EntityList, EntitySpec } from "pixelworld/engine";

/**
 * @pixelworlds/multiplayer: what a pixelworld game needs to put several
 * players in one world (D-112), kept out of the engine (D-111).
 *
 * - `joinRoom(url, room)`: a room on a relay (`@pixelworlds/multiplayer/server`).
 *   Each player's messages reach every other player in the room.
 * - `Smoothing`: other players' poses, sent at a few per second, drawn a
 *   little in the past and in between, as they moved.
 * - `RemotePlayers`: those poses as entities in a world view.
 *
 * Relay-first: each client runs its own vehicle and tells the others where it
 * is, so a game's rules run on its clients. The game decides what to send.
 */

// ---------------------------------------------------------------- the relay's protocol

/** What the relay sends (JSON text frames). A player sends its own messages as plain JSON. */
export type ServerMessage =
  | { t: "welcome"; id: string; peers: string[] }
  | { t: "join"; id: string }
  | { t: "leave"; id: string }
  | { t: "msg"; from: string; data: unknown }
  | { t: "full" };

// ---------------------------------------------------------------- a room

export interface Room {
  /** This player's id in the room (the relay's). */
  readonly id: string;
  /** The other players in the room. */
  readonly peers: ReadonlySet<string>;
  readonly name: string;
  /** To every other player in the room (JSON). */
  send(data: unknown): void;
  onMessage: ((from: string, data: unknown) => void) | null;
  onJoin: ((id: string) => void) | null;
  onLeave: ((id: string) => void) | null;
  /** The connection closed (the relay went away, or `close`). */
  onClose: (() => void) | null;
  close(): void;
}

class RoomImpl implements Room {
  readonly peers: Set<string>;
  onMessage: Room["onMessage"] = null;
  onJoin: Room["onJoin"] = null;
  onLeave: Room["onLeave"] = null;
  onClose: Room["onClose"] = null;

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
    }
  }

  close(): void {
    this.ws.close();
  }
}

/**
 * Join a room on a relay: `url` is its WebSocket path (`ws:`, `wss:`, or
 * `http(s):` and relative URLs, taken as the page's own host). Rejects when
 * the relay can't be reached or the room is full.
 */
export function joinRoom(url: string | URL, room: string): Promise<Room> {
  const u = new URL(url, globalThis.location?.href);
  u.protocol = u.protocol.replace(/^http/, "ws");
  u.searchParams.set("room", room);
  const ws = new WebSocket(u);
  return new Promise((resolve, reject) => {
    let joined: RoomImpl | null = null;
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as ServerMessage;
      if (m.t === "welcome") resolve((joined = new RoomImpl(ws, m.id, room, m.peers)));
      else if (m.t === "full") reject(new Error(`room "${room}" is full`));
      else joined?.receive(m);
    };
    const unanswered = () => new Error(`no relay answered at ${u.origin}${u.pathname}`);
    // a refused connection: browsers fire error then close; Node's WebSocket only error
    ws.onerror = () => {
      if (!joined) reject(unanswered());
    };
    ws.onclose = () => {
      if (joined) joined.onClose?.();
      else reject(unanswered());
    };
  });
}

// ---------------------------------------------------------------- smoothing

/** Where a vehicle is and how it is turned: cells, steps, radians (as an entity's). */
export interface Pose {
  x: number;
  y: number;
  h: number;
  heading: number;
  pitch?: number;
  roll?: number;
}

interface Sample {
  /** The sender's clock (seconds). */
  t: number;
  pose: Pose;
  /** Don't slide into this one (a respawn or other jump). */
  jump: boolean;
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
  };
}

/**
 * Other players' poses, drawn `delay` seconds in the past so there is nearly
 * always a sample on each side to move between. Each sample carries its
 * sender's own clock; the gap to ours is the smallest one seen, so jitter in
 * the network delays the picture by `delay` rather than shaking it.
 */
export class Smoothing {
  private readonly samples = new Map<string, Sample[]>();
  /** Per player: our clock less theirs, at its smallest (the quickest a message came). */
  private readonly offsets = new Map<string, number>();

  /** @param delay Seconds behind the newest pose (default 0.1: two samples at 20 a second). */
  constructor(readonly delay = 0.1) {}

  /**
   * A pose at `sent` on the sender's clock (seconds), received `now` on
   * ours. `jump`: it got there at once (a respawn), so don't slide to it.
   */
  push(id: string, sent: number, pose: Pose, now: number, jump = false): void {
    // ponytail: the smallest gap ever seen; clocks that drift apart over an hour would want it to age
    this.offsets.set(id, Math.min(this.offsets.get(id) ?? Infinity, now - sent));
    let list = this.samples.get(id);
    if (!list) this.samples.set(id, (list = []));
    if (list.length && sent <= list[list.length - 1]!.t) return; // late or repeated
    list.push({ t: sent, pose, jump });
    if (list.length > KEEP) list.shift();
  }

  /** Where a player is drawn at `now` (our clock, seconds); null for one never heard from. */
  at(id: string, now: number): Pose | null {
    const list = this.samples.get(id);
    if (!list?.length) return null;
    const t = now - this.offsets.get(id)! - this.delay;
    while (list.length > 2 && list[1]!.t <= t) list.shift(); // passed
    const [a, b] = list;
    if (!b || t <= a!.t) return a!.pose; // the oldest, until time reaches it
    if (t >= b.t) return b.pose; // nothing newer yet: hold the newest
    return b.jump ? a!.pose : lerp(a!.pose, b.pose, (t - a!.t) / (b.t - a!.t));
  }

  delete(id: string): void {
    this.samples.delete(id);
    this.offsets.delete(id);
  }

  ids(): string[] {
    return [...this.samples.keys()];
  }
}

// ---------------------------------------------------------------- other players as entities

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
    delay?: number,
  ) {
    this.smoothing = new Smoothing(delay);
  }

  /** A player's pose at `sent` on its clock (seconds); `jump` for a respawn. */
  push(id: string, sent: number, pose: Pose, jump = false, now = performance.now() / 1000): void {
    this.smoothing.push(id, sent, pose, now, jump);
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

  /** A player left: its entity goes. */
  remove(id: string): void {
    this.entities.get(id)?.remove();
    this.entities.delete(id);
    this.drawn.delete(id);
    this.smoothing.delete(id);
  }

  clear(): void {
    for (const id of [...this.entities.keys(), ...this.smoothing.ids()]) this.remove(id);
  }
}
