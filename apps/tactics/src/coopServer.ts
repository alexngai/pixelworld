import type { Server } from "node:http";
import { cleanName } from "@pixelworlds/multiplayer";
import { attachRelay, type HostedRoom, type Relay, type RoomHost } from "@pixelworlds/multiplayer/server";
import { choosing, frontAct, frontJoined, frontLeft, frontMessage, newFront, type Front, type FrontSite } from "@pixelworlds/tactics";
import boards from "../survey/boards.json";
import { COOP_PATH, type CoopOut, type Crew } from "./coop";
import { sitesOf, type Block } from "./sites";

/**
 * Co-op rooms (D-179): squads defending one city together, each fighting its
 * own blocks. A room keeps the city's front (`@pixelworlds/tactics`' front),
 * made from the first page's city; it sends each page the city's boards as it
 * has them, carries out each page's messages, and sends the front to every
 * page after each change. A page that leaves lets
 * go of the block it took and hadn't fought.
 *
 * ponytail: a page's report of its fight is taken as it says; replaying the
 * fight's moves from its seed on the server would check it, once strangers
 * play together.
 */

const POOLS = boards as unknown as Record<string, Block[]>;
/** Once a squad has chosen its block, how long the others have to choose theirs before they sit the wave out (D-182). */
export const CHOOSE_MS = 90_000;

export class CoopRoom implements RoomHost {
  private front: Front | null = null;
  private sites: FrontSite[] = [];
  private world = "";
  private readonly crews = new Map<string, Crew>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the squads still choosing sit the wave out (ms since the epoch), or 0. */
  private due = 0;

  constructor(private readonly room: HostedRoom) {}

  message(id: string, data: unknown): void {
    const m = data as Record<string, unknown> | null;
    if (m?.k === "hello") {
      const world = String(m.world);
      if (!POOLS[world]?.length) return this.room.kick(id, "no such city");
      if (!this.front) {
        this.world = world;
        this.sites = sitesOf(POOLS[world]!);
        this.front = newFront(this.sites, { seed: (Math.random() * 2 ** 32) >>> 0 });
        this.room.log(`defending ${world}`);
      } else if (world !== this.world) return this.room.kick(id, "this room is defending another city");
      this.crews.set(id, { name: cleanName(m.name) || "A squad", squad: cleanName(m.squad, 40) });
      this.room.send(id, { k: "pool", pool: POOLS[world]! } satisfies CoopOut);
      frontJoined(this.front, this.sites, this.ids());
      return this.tell();
    }
    const msg = frontMessage(data);
    if (!this.front || !this.crews.has(id) || !msg) return;
    const why = frontAct(this.front, this.sites, this.ids(), id, msg);
    if (why) this.room.send(id, { k: "no", why } satisfies CoopOut);
    this.tell();
  }

  leave(id: string): void {
    if (!this.crews.delete(id) || !this.front) return;
    frontLeft(this.front, this.sites, this.ids(), id);
    this.tell();
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  info(): object {
    return { world: this.world, wave: this.front?.wave ?? 0 };
  }

  private ids(): string[] {
    return [...this.crews.keys()];
  }

  /** The choosing clock (D-182): running while some squads have chosen and others haven't; at its end, those sit the wave out. */
  private clock(): void {
    const f = this.front;
    const waiting = f ? choosing(f, this.ids()) : [];
    const chosen = !!f && (f.passed.length > 0 || f.threats.some((t) => t.by));
    if (!waiting.length || !chosen) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.due = 0;
      return;
    }
    if (this.timer) return;
    this.due = Date.now() + CHOOSE_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.due = 0;
      if (!this.front) return;
      for (const id of choosing(this.front, this.ids())) frontAct(this.front, this.sites, this.ids(), id, { k: "pass" });
      this.tell();
    }, CHOOSE_MS);
  }

  private tell(): void {
    if (!this.front) return;
    this.clock();
    this.room.broadcast({ k: "front", front: this.front, crews: Object.fromEntries(this.crews), choose: this.due ? this.due - Date.now() : null } satisfies CoopOut);
  }
}

/** The co-op rooms on a server, at `COOP_PATH?room=`: a room opens when a page names it, and stays ten minutes after its last page goes. */
export function attachCoop(server: Server): Relay {
  return attachRelay(server, { path: COOP_PATH, maxPlayers: 6, idle: { named: 10 * 60_000 }, host: (room) => new CoopRoom(room) });
}
