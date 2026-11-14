import { SERVER, type Room } from "./index";
import type { HostedRoom, RoomHost } from "./server";

/**
 * A room and its pages in memory, on a made-up clock (D-118): a game's
 * netcode tested whole (prediction, lag, a stalled server, a backed-up
 * connection) without sockets and without waiting. Every message is copied
 * through JSON, as on the wire, and arrives `latency` seconds after it was
 * sent; the room ticks as a `TickRoom`'s clock would, catching up at most a
 * quarter second after a stall.
 *
 *   const lb = loopback((room) => new MyRoom(room, world, false));
 *   const page = lb.join(0.05);
 *   const client = new TickClient(page.room, { tick, step, restore, now: lb.now });
 *   lb.run(2, (dt) => client.advance(dt, () => input));
 */

export interface LoopbackPage {
  readonly room: Room;
  /** Seconds a message takes each way: change it to slow the page's connection. */
  latency: number;
  /** Server messages delivered to it so far. */
  readonly received: unknown[];
  /** Why it was sent away, once it was. */
  readonly why: string | null;
}

export interface Loopback<R> {
  readonly host: R;
  /** A page in the room (a `Room`, as `joinRoom` gives), `latency` seconds each way (default 0.05). */
  join(latency?: number): LoopbackPage;
  /** Run `seconds` of the made-up clock, `fps` frames a second: what comes due arrives, the room ticks, then `frame(dt)`. */
  run(seconds: number, frame?: (dt: number) => void): void;
  /** Stop the room's clock for `seconds` from now: a stalled server. */
  stall(seconds: number): void;
  /** The made-up clock (s): give it to `TickClient` as `now`, and to `RemotePlayers.update`. */
  now(): number;
  /** The room's log lines, and the error it failed on, if it did. */
  readonly log: string[];
  readonly failed: unknown;
}

/** A host with a clock the loopback runs (a `TickRoom` made with `clock: false`). */
type Ticking = RoomHost & { tick(): void; readonly tickLength: number };

export function loopback<R extends Ticking>(make: (room: HostedRoom) => R, opts: { fps?: number; name?: string; settings?: unknown; isPublic?: boolean } = {}): Loopback<R> {
  const fps = opts.fps ?? 60;
  let t = 0;
  let order = 0;
  let stalledUntil = -Infinity;
  let owed = 0;
  let failed: unknown = undefined;
  const log: string[] = [];
  const due: { at: number; n: number; f: () => void }[] = [];
  const later = (delay: number, f: () => void) => {
    due.push({ at: t + delay, n: order++, f });
    due.sort((a, b) => a.at - b.at || a.n - b.n);
  };
  const copy = (data: unknown) => (data instanceof Uint8Array ? data.slice() : (JSON.parse(JSON.stringify(data)) as unknown));

  interface Page extends LoopbackPage {
    room: Room & { deliver(data: unknown): void; gone(why: string | null): void };
    received: unknown[];
    why: string | null;
    open: boolean;
  }
  const pages = new Map<string, Page>();
  let next = 1;

  const leave = (id: string) => {
    const p = pages.get(id);
    if (!p?.open) return;
    p.open = false;
    host.leave?.(id);
  };
  const hosted: HostedRoom = {
    name: opts.name ?? "loopback",
    settings: opts.settings,
    isPublic: opts.isPublic ?? false,
    // copied as they are sent, as the wire does: a message holding the game's live state carries it as it was then
    send: (to, data) => {
      const p = pages.get(to);
      const sent = copy(data);
      if (p?.open) later(p.latency, () => p.room.deliver(sent));
    },
    sendTo: (ids, data) => {
      const sent = copy(data);
      for (const id of ids) {
        const p = pages.get(id);
        if (p?.open) later(p.latency, () => p.room.deliver(copy(sent)));
      }
    },
    broadcast: (data, except) => {
      const sent = copy(data);
      for (const [id, p] of pages) if (p.open && !except?.has(id)) later(p.latency, () => p.room.deliver(copy(sent)));
    },
    players: () => [...pages].filter(([, p]) => p.open).map(([id]) => id),
    kick: (id, why) => {
      const p = pages.get(id);
      if (!p?.open) return;
      later(p.latency, () => p.room.gone(why));
      leave(id);
    },
    close: (why) => {
      for (const id of pages.keys()) hosted.kick(id, why);
    },
    fail: (e) => {
      failed = e;
      hosted.close("the game hit an error");
    },
    log: (message) => log.push(message),
  };
  const host = make(hosted);

  return {
    host,
    join(latency = 0.05) {
      const id = String(next++);
      const page: Page = {
        latency,
        received: [],
        why: null,
        open: true,
        room: {
          id,
          name: hosted.name,
          peers: new Set(),
          onMessage: null,
          onJoin: null,
          onLeave: null,
          onClose: null,
          send: (data) => {
            const sent = copy(data);
            if (page.open) later(page.latency, () => page.open && host.message(id, sent));
          },
          close: () => leave(id),
          deliver(data) {
            page.received.push(data);
            this.onMessage?.(SERVER, data);
          },
          gone(why) {
            page.why = why;
            this.onClose?.(why);
          },
        },
      };
      pages.set(id, page);
      host.join?.(id);
      return page;
    },
    run(seconds, frame) {
      const dt = 1 / fps;
      for (let n = Math.round(seconds * fps); n > 0; n--) {
        t += dt;
        while (due.length && due[0]!.at <= t + 1e-9) due.shift()!.f();
        owed += dt;
        // a stalled server's clock stops (the pages' don't); after, it catches up at most a quarter second at once, as a TickRoom's does
        if (t >= stalledUntil) {
          owed = Math.min(owed, 0.25 + dt);
          while (owed >= host.tickLength - 1e-9) {
            owed -= host.tickLength;
            host.tick();
          }
        }
        frame?.(dt);
      }
    },
    stall(seconds) {
      stalledUntil = t + seconds;
    },
    now: () => t,
    log,
    get failed() {
      return failed;
    },
  };
}
