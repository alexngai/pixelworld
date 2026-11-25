import type { Server } from "node:http";
import { cleanName } from "@pixelworlds/multiplayer";
import { attachRelay, type HostedRoom, type Relay, type RelayOptions, type RoomHost } from "@pixelworlds/multiplayer/server";
import {
  FIGHTERS,
  FightRun,
  SQUAD,
  WEAPONS,
  choosing,
  cloneCombat,
  frontAct,
  frontJoined,
  frontLeft,
  frontMessage,
  fromWire,
  joinSquad,
  reinforce,
  loadoutOf,
  newFront,
  replayFight,
  teamOf,
  toWire,
  type Action,
  type Armed,
  type Combat,
  type FighterKind,
  type Front,
  type FrontSite,
  type Loadout,
  type WeaponId,
} from "@pixelworlds/tactics";
import boards from "../survey/boards.json";
import { COOP_PATH, FIGHT_ROUNDS, type CoopOut, type Crew, type JointOut } from "./coop";
import { sitesOf, type Block } from "./sites";

/**
 * Co-op rooms (D-179): squads defending one city together, each fighting its
 * own blocks. A room keeps the city's front (`@pixelworlds/tactics`' front),
 * made from the first page's city; it sends each page the city's boards as it
 * has them, carries out each page's messages, and sends the front to every
 * page after each change. A page that leaves lets go of the block it took and
 * hadn't fought.
 *
 * A squad's fight comes as its start and its rigs' moves, and the room
 * replays them through the rules (D-186): the block is held or not, and so
 * many people lost, as the replay has it, not as the page says.
 *
 * ponytail: the fight's start is the page's own (the room has no world to
 * make it from), so a page could send an easy one; making or checking the
 * start on the server needs the city's world loaded there.
 *
 * A joint finale (D-187) is fought in the room: the lead's page sends its
 * fight's start, the second squad's page its rigs; the room sets the second
 * squad down on the board (`joinSquad`), brings two more invaders
 * (`reinforce`), and sends both pages the fight. The
 * rigs act one at a time (a baton: asked for, then the action or handed
 * back), each action carried out in the room (`FightRun`) and sent on to the
 * other page; once both squads end the turn, the invaders' turn runs in the
 * room and on both pages. The room's result moves the front.
 */

/** A joint finale being fought (D-187). */
class JointFight {
  start: Combat | null = null;
  rigs: Loadout[] | null = null;
  run: FightRun | null = null;
  /** Each squad's rigs. */
  units: Record<string, number[]> = {};
  baton: string | null = null;
  readonly ended = new Set<string>();
  constructor(
    readonly lead: string,
    readonly partner: string,
  ) {}
}

/** A page's rigs, checked: up to three squad kinds, each with two slots of weapons it could have bought and upgrades it could have powered. */
function rigsOf(raw: unknown): Loadout[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > 3) return null;
  const out: Loadout[] = [];
  for (const r of raw as { kind?: unknown; slots?: unknown }[]) {
    const kind = r?.kind as FighterKind;
    if (typeof kind !== "string" || !(kind in FIGHTERS) || FIGHTERS[kind].team !== SQUAD || !Array.isArray(r.slots) || r.slots.length > 2) return null;
    const slots: (Armed | null)[] = [];
    for (const s of r.slots as ({ id?: unknown; ups?: unknown } | null)[]) {
      if (s === null) {
        slots.push(null);
        continue;
      }
      const def = WEAPONS[s?.id as WeaponId];
      const ups = s?.ups;
      if (!def || !Array.isArray(ups) || ups.some((i) => !Number.isInteger(i) || i < 0 || i >= def.upgrades.length) || new Set(ups).size !== ups.length) return null;
      slots.push({ id: s!.id as WeaponId, ups: ups as number[] });
    }
    out.push(loadoutOf(kind, slots));
  }
  return out;
}

const POOLS = boards as unknown as Record<string, Block[]>;
/** Once a squad has chosen its block, how long the others have to choose theirs before they sit the wave out (D-182; long enough for a visit to the depot, D-188). */
export const CHOOSE_MS = 150_000;

export class CoopRoom implements RoomHost {
  private front: Front | null = null;
  private sites: FrontSite[] = [];
  private world = "";
  private readonly crews = new Map<string, Crew>();
  private readonly joints = new Map<number, JointFight>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the squads still choosing sit the wave out (ms since the epoch), or 0. */
  private due = 0;

  constructor(
    private readonly room: HostedRoom,
    /** Waves an operation lasts (tests: fewer). */
    private readonly waves?: number,
  ) {}

  message(id: string, data: unknown): void {
    const m = data as Record<string, unknown> | null;
    if (m?.k === "hello") {
      const world = String(m.world);
      if (!POOLS[world]?.length) return this.room.kick(id, "no such city");
      if (!this.front) {
        this.world = world;
        this.sites = sitesOf(POOLS[world]!);
        this.front = newFront(this.sites, { seed: (Math.random() * 2 ** 32) >>> 0, ...(this.waves ? { waves: this.waves } : {}) });
        this.room.log(`defending ${world}`);
      } else if (world !== this.world) return this.room.kick(id, "this room is defending another city");
      this.crews.set(id, { name: cleanName(m.name) || "A squad", squad: cleanName(m.squad, 40) });
      this.room.send(id, { k: "pool", pool: POOLS[world]! } satisfies CoopOut);
      frontJoined(this.front, this.sites, this.ids());
      return this.tell();
    }
    if (!this.front || !this.crews.has(id)) return;
    if (typeof m?.k === "string" && m.k.startsWith("j-")) return this.joint(id, m);
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

  /** A joint finale's message (D-187), from one of its two squads. */
  private joint(id: string, m: Record<string, unknown>): void {
    const no = (why: string) => this.room.send(id, { k: "no", why } satisfies CoopOut);
    const t = this.front!.threats.find((x) => x.id === m.threat);
    if (!t || !t.joint || !t.by || !t.with || t.result || (id !== t.by && id !== t.with)) return no("that isn't your finale");
    let j = this.joints.get(t.id);
    if (!j) this.joints.set(t.id, (j = new JointFight(t.by, t.with)));
    const to = (out: JointOut) => {
      for (const p of [j!.lead, j!.partner]) if (this.crews.has(p)) this.room.send(p, out);
    };
    if (m.k === "j-start" || m.k === "j-squad") {
      if (j.run) return;
      try {
        if (m.k === "j-start" && id === j.lead) j.start = fromWire<Combat>(m.start);
        if (m.k === "j-squad" && id === j.partner) j.rigs = rigsOf(m.rigs);
      } catch {
        return no("that fight doesn't load");
      }
      if (!j.start || !j.rigs) return;
      // both in: the second squad set down on the lead's board
      const c = cloneCombat(j.start);
      j.units[j.lead] = c.roster.flatMap((_, u) => (teamOf(c, u) === SQUAD && c.hp[u]! > 0 ? [u] : []));
      j.units[j.partner] = joinSquad(c, j.rigs);
      // two squads: two more invaders
      reinforce(c, 2);
      j.run = new FightRun(c, FIGHT_ROUNDS);
      return to({ k: "j-begin", threat: t.id, start: toWire(c), units: j.units });
    }
    const run = j.run;
    if (!run || run.result) return no("the finale hasn't begun");
    if (m.k === "j-take") {
      const u = m.unit as number;
      const free = (j.baton === null || j.baton === id) && !j.ended.has(id);
      if (!free || !j.units[id]?.includes(u) || run.acted.has(u) || run.c.hp[u]! <= 0) return this.room.send(id, { k: "j-baton", threat: t.id, by: j.baton } satisfies CoopOut);
      j.baton = id;
      return to({ k: "j-baton", threat: t.id, by: id });
    }
    if (m.k === "j-cancel") {
      if (j.baton === id) j.baton = null;
      return to({ k: "j-baton", threat: t.id, by: j.baton });
    }
    if (m.k === "j-act") {
      const a = m.action as Action;
      if (j.baton !== id) return no("another squad is acting");
      j.baton = null;
      if (!a || !j.units[id]!.includes(a.unit) || !run.act(a)) {
        to({ k: "j-baton", threat: t.id, by: null });
        return no("that action isn't one the rules allow now");
      }
      return to({ k: "j-act", threat: t.id, by: id, action: a });
    }
    if (m.k === "j-end") {
      j.ended.add(id);
      this.jointTurn(t.id, j);
    }
  }

  /** Both squads (those still here) have ended the turn: the invaders' turn, and the front moved once the fight is over. */
  private jointTurn(threat: number, j: JointFight): void {
    const here = [j.lead, j.partner].filter((p) => this.crews.has(p));
    if (!j.run || !here.every((p) => j.ended.has(p))) return;
    j.ended.clear();
    j.baton = null;
    const r = j.run.endTurn();
    for (const p of here) this.room.send(p, { k: "j-turn", threat } satisfies CoopOut);
    if (!r) return;
    this.joints.delete(threat);
    const { start, c } = j.run;
    const razed = c.arena.structures.flatMap((s, i) => (start.structHp[i]! > 0 && c.structHp[i]! <= 0 && s.object >= 0 ? [s.object] : []));
    const t = this.front!.threats.find((x) => x.id === threat);
    if (t?.by) frontAct(this.front!, this.sites, this.ids(), t.by, { k: "report", threat, held: r.held, lost: r.lost, razed });
    this.tell();
  }

  leave(id: string): void {
    if (!this.crews.delete(id) || !this.front) return;
    for (const [threat, j] of this.joints) {
      if (id !== j.lead && id !== j.partner) continue;
      // not begun: it won't (the other squad fights alone); begun: it goes on with the other squad
      if (!j.run) this.joints.delete(threat);
      else {
        if (j.baton === id) j.baton = null;
        this.jointTurn(threat, j);
      }
    }
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
  // COOP_WAVES=n: operations of n waves, to reach the finale (D-187) sooner
  const waves = Number(process.env.COOP_WAVES) || undefined;
  // a fight's start and moves (D-186) are tens of kilobytes
  return attachRelay(server, { ...opts, path: COOP_PATH, maxPlayers: 6, maxMessage: 256 * 1024, idle: { named: 10 * 60_000 }, host: (room) => new CoopRoom(room, waves) });
}
