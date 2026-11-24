import { joinRoom } from "@pixelworlds/multiplayer";
import { frontAct, newFront, type Front, type FrontMessage } from "@pixelworlds/tactics";
import { sitesOf, type Block } from "./sites";

/**
 * The city's front as a page plays it (D-179): its own when playing alone, or
 * a co-op room's, which the server keeps (coopServer.ts) and sends after
 * every change. The same calls either way: the page sends the front's
 * messages and hears when it changed.
 */

/** A squad defending the city: who plays it, and which squad. */
export interface Crew {
  name: string;
  squad: string;
}

/** A page to a co-op room: who it is and which city, first; then the front's messages. */
export type CoopIn = ({ k: "hello"; world: string } & Crew) | FrontMessage;
/**
 * A co-op room to a page: the city's boards, once, as the room has them (its
 * front's sites are places in this list, so the page takes the room's, not
 * its own, which a newer survey may have changed); the front after every
 * change, with who's defending it; or why a message wasn't taken.
 */
export type CoopOut = { k: "pool"; pool: Block[] } | { k: "front"; front: Front; crews: Record<string, Crew> } | { k: "no"; why: string };

/** The rooms' WebSocket path on the game's server. */
export const COOP_PATH = "/hold";

export interface Campaign {
  /** This page's id among the crews. */
  readonly me: string;
  /** The room's code, or null alone. */
  readonly room: string | null;
  /** The city's boards the front's sites are places in. */
  readonly pool: readonly Block[];
  readonly front: Front;
  readonly crews: Readonly<Record<string, Crew>>;
  send(m: FrontMessage): void;
  /** Called after every change; returns its undoing. */
  listen(f: () => void): () => void;
  /** Why the room's connection was lost, or null. */
  readonly lost: string | null;
}

class Listeners {
  private readonly set = new Set<() => void>();
  listen(f: () => void): () => void {
    this.set.add(f);
    return () => this.set.delete(f);
  }
  tell(): void {
    for (const f of this.set) f();
  }
}

/** The front played alone: kept on this page. */
export function soloCampaign(pool: readonly Block[], crew: Crew, seed: number): Campaign {
  const me = "me";
  const ls = new Listeners();
  const sites = sitesOf(pool);
  const front = newFront(sites, { seed });
  return {
    me,
    room: null,
    pool,
    front,
    crews: { [me]: crew },
    lost: null,
    send(m) {
      const why = frontAct(front, sites, [me], me, m);
      if (why) console.warn(`the front: ${why}`);
      ls.tell();
    },
    listen: (f) => ls.listen(f),
  };
}

/** A co-op room's front: resolves once the room has sent it. */
export async function coopCampaign(room: string, hello: { world: string } & Crew): Promise<Campaign> {
  const r = await joinRoom(new URL(COOP_PATH, location.href), room);
  const ls = new Listeners();
  const c = { me: r.id, room, pool: [] as Block[], front: null as unknown as Front, crews: {} as Record<string, Crew>, lost: null as string | null };
  const campaign: Campaign = {
    get me() {
      return c.me;
    },
    room,
    get pool() {
      return c.pool;
    },
    get front() {
      return c.front;
    },
    get crews() {
      return c.crews;
    },
    get lost() {
      return c.lost;
    },
    send: (m) => r.send(m satisfies CoopIn),
    listen: (f) => ls.listen(f),
  };
  return new Promise((resolve, reject) => {
    r.onMessage = (_from, data) => {
      const m = data as CoopOut;
      if (m.k === "no") return console.warn(`the room: ${m.why}`);
      if (m.k === "pool") return void (c.pool = m.pool);
      c.front = m.front;
      c.crews = m.crews;
      resolve(campaign);
      ls.tell();
    };
    r.onClose = (why) => {
      c.lost = why ?? "the connection to the room was lost";
      reject(new Error(c.lost));
      ls.tell();
    };
    r.send({ k: "hello", ...hello } satisfies CoopIn);
  });
}

/** A room code: 4 letters and digits, none that look alike (as the server's own). */
export function roomCode(): string {
  const letters = "ACDEFHJKMNPQRTUVWXY3479";
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => letters[b % letters.length]).join("");
}
