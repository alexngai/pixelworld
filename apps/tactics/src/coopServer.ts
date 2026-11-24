import type { Server } from "node:http";
import { cleanName } from "@pixelworlds/multiplayer";
import { attachRelay, type HostedRoom, type Relay, type RelayOptions, type RoomHost } from "@pixelworlds/multiplayer/server";
import { choosing, frontAct, frontJoined, frontLeft, frontMessage, fromWire, newFront, replayFight, type Action, type Combat, type Front, type FrontSite } from "@pixelworlds/tactics";
import boards from "../survey/boards.json";
import { COOP_PATH, FIGHT_ROUNDS, type CoopOut, type Crew } from "./coop";
import { sitesOf, type Block } from "./sites";

/**
 * Co-op rooms (D-179): squads defending one city together, each fighting its
 * own blocks. A room keeps the city's front (`@pixelworlds/tactics`' front),
 * made from the first page's city; it sends each page the city's boards as it
 * has them, carries out each page's messages, and sends the front to every
 * page after each change. A page that leaves lets
 * go of the block it took and hadn't fought.
 *
 * A squad's fight comes as its start and its rigs' moves, and the room
 * replays them through the rules (D-186): the block is held or not, and so
 * many people lost, as the replay has it, not as the page says.
 *
 * ponytail: the fight's start is the page's own (the room has no world to
 * make it from), so a page could send an easy one; making or checking the
 * start on the server needs the city's world loaded there.
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
    if (!this.front || !this.crews.has(id)) return;
    const msg = m?.k === "fought" ? this.replay(m) : frontMessage(data);
    if (!msg) return this.room.send(id, { k: "no", why: m?.k === "fought" ? "that fight doesn't replay" : "not a message the room takes" } satisfies CoopOut);
    // a page's own word on a fight isn't taken: its moves are
    if (msg.k === "report" && m?.k !== "fought") return this.room.send(id, { k: "no", why: "a fight is reported by its moves" } satisfies CoopOut);
    const why = frontAct(this.front, this.sites, this.ids(), id, msg);
    if (why) this.room.send(id, { k: "no", why } satisfies CoopOut);
    this.tell();
  }

  /** A fought block replayed (D-186): the report as the rules have it, or null when the moves don't replay. */
  private replay(m: Record<string, unknown>) {
    if (!Number.isInteger(m.threat)) return null;
    try {
      const r = replayFight(fromWire<Combat>(m.start), fromWire<Action[][]>(m.turns), FIGHT_ROUNDS);
      const razed = Array.isArray(m.razed) ? m.razed.filter((x): x is number => Number.isInteger(x) && x >= 0).slice(0, 400) : [];
      return r && ({ k: "report", threat: m.threat as number, held: r.held, lost: r.lost, razed } as const);
    } catch {
      return null;
    }
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

/**
 * The co-op rooms on a server, at `COOP_PATH?room=`: a room opens when a page
 * names it, and stays ten minutes after its last page goes. `sameOrigin` and
 * `lag` as the relay takes them (play.pixelworld.site refuses other sites'
 * pages, D-184).
 */
export function attachCoop(server: Server, opts: Pick<RelayOptions, "sameOrigin" | "lag" | "log"> = {}): Relay {
  // a fight's start and moves (D-186) are tens of kilobytes
  return attachRelay(server, { ...opts, path: COOP_PATH, maxPlayers: 6, maxMessage: 256 * 1024, idle: { named: 10 * 60_000 }, host: (room) => new CoopRoom(room) });
}
