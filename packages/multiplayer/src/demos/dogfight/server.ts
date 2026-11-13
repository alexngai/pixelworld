import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { FlyWorld } from "@pixelworlds/game/src/ground";
import { FlightPilot } from "@pixelworlds/game/src/pilot";
import { LEVEL_FLIGHT, axes, drawnPitch, flightParams, spawnPlane, type PlaneParams, type PlaneState } from "@pixelworlds/game/src/plane";
import { stylePack } from "@pixelworlds/game/src/styles";
import { PLANE } from "@pixelworlds/game/src/tuning";
import { openWorld, type OpenedWorld } from "pixelworld/engine";
import { cleanName, type RoomInfo } from "../../index";
import { Areas, History, Phases, TickRoom, attachRelay, lobbyHandler, type HostedRoom, type Relay, type RelayLog, type TickRole } from "../../server";
import {
  BOT,
  CREDIT_S,
  DOGFIGHT_START,
  DOGFIGHT_WORLD,
  GUN,
  HP,
  MATCH,
  MAX_REWIND,
  SPAWN_SPREAD,
  TICK,
  fireRound,
  flyTick,
  passes,
  type DogfightEvent,
  type DogfightInfo,
  type DogfightInput,
  type DogfightJoin,
  type DogfightSnap,
  type DogfightWorldNet,
  type MatchPhase,
  type PlaneNet,
  type Round,
} from "./rules";

/**
 * The dogfight's server (D-113, D-114, D-116, D-118): a `TickRoom` per room
 * on `/dogfight?room=`. It owns every plane: each page's inputs are flown
 * through the example game's flight model over the same world (`openWorld`);
 * it fires the guns, judges hits against where the shooter saw its target
 * (rewound by its lag, `History`), and decides health, kills and respawns.
 * A match: a countdown with the guns cold, play to `MATCH.kills` or
 * `MATCH.seconds`, the end screen, and the next. Pages may watch instead of
 * fly; a pilot alone gets a bot to fight, which goes when another arrives.
 * The world is loaded around each plane and the start (`Areas`, D-120), so
 * a level too big to load whole flies too.
 */

export interface DogfightWorld {
  fly: FlyWorld;
  params: PlaneParams;
  /** The start (cells). */
  start: [number, number];
  /** The world's queries and what it holds, for loading around the planes. */
  opened: OpenedWorld;
}

/** Cells loaded around the start, which respawns fly out of: their spread, and the clearance a spawn looks for ahead and around. */
const START_AREA = 32;
/** Around each plane, and around where it will be 2 s on (D-120). */
const AREAS = { radius: 16, ahead: 2, reach: 2 };

/**
 * Open the flying level the pages fly, over HTTP, with the style packs the
 * game has: the start's area and the ground under the landmarks (for the
 * ceiling over their tops); the rest loads around the planes as they fly,
 * at most `chunkBudgetMB` of it (D-120).
 */
export async function openDogfightWorld(worldUrl: string, opts: { chunkBudgetMB?: number } = {}): Promise<DogfightWorld> {
  const opened = await openWorld({ worldUrl, style: stylePack, chunkBudgetMB: opts.chunkBudgetMB ?? 64 });
  const { world, query } = opened;
  // each read just after its own load, which a budget can't let go of before then; the objects keep a top once read
  const tops = (
    await Promise.all(
      query.landmarks().map(async (l) => {
        await query.ensure(l.x - 1, l.y - 1, l.x + 1, l.y + 1);
        return query.objectsAt(l.x, l.y).map((o) => o.top ?? -Infinity);
      }),
    )
  ).flat();
  const start = query.lonLatToCell(DOGFIGHT_START.lon, DOGFIGHT_START.lat) ?? [world.cellsX / 2, world.cellsY / 2];
  await query.ensure(start[0] - START_AREA, start[1] - START_AREA, start[0] + START_AREA, start[1] + START_AREA);
  return { fly: new FlyWorld(query, world.cellsX, world.cellsY), params: flightParams(world, tops), start, opened };
}

/** The server's log, a line each. */
export function logLine(l: RelayLog): void {
  const what = l.kind === "error" ? `the game hit an error: ${l.error instanceof Error ? (l.error.stack ?? l.error.message) : String(l.error)}` : [l.kind, l.id, l.message].filter(Boolean).join(" ");
  (l.kind === "error" ? console.error : console.log)(`dogfight room ${l.room}: ${what}`);
}

/**
 * The dogfight on an HTTP server that also serves the page and the world
 * package: `/dogfight?room=`. The world is opened from the server itself when
 * the first room needs it; if it fails, that room closes saying why and the
 * next one tries again. An empty room stays open a minute. `lag` holds every
 * message back that many ms each way.
 */
export function attachDogfight(server: Server, opts: { lag?: number; maxRooms?: number; log?: (l: RelayLog) => void; chunkBudgetMB?: number } = {}): Relay {
  let opened: Promise<DogfightWorld> | null = null;
  const world = () => {
    if (!opened) {
      const { port } = server.address() as AddressInfo;
      opened = openDogfightWorld(`http://localhost:${port}${DOGFIGHT_WORLD}`, { chunkBudgetMB: opts.chunkBudgetMB });
      opened.catch((e: unknown) => {
        console.error("dogfight: the world didn't open:", e);
        opened = null;
      });
    }
    return opened;
  };
  return attachRelay(server, {
    path: "/dogfight",
    lag: opts.lag,
    maxRooms: opts.maxRooms,
    idle: { named: 60_000 },
    log: opts.log ?? logLine,
    host: (room) => new DogfightRoom(room, world()),
  });
}

/** The lobby for the dogfight's rooms: quick play puts a page in a room that isn't nearly over. */
export function dogfightLobby(relay: Relay): (req: IncomingMessage, res: ServerResponse) => boolean {
  return lobbyHandler(relay, {
    fits: (r: RoomInfo) => {
      const i = r.info as Partial<DogfightInfo>;
      return i.phase !== "ended" && (i.left === null || i.left === undefined || i.left > 60);
    },
  });
}

interface Plane {
  s: PlaneState;
  hp: number;
  kills: number;
  deaths: number;
  cooldown: number;
  lastHit: { by: string; at: number } | null;
  history: History;
}

interface Flying extends Round {
  by: string;
  /** The input it was fired on: its name, with `by`. */
  seq: number;
  /** Its shooter's lag when it fired: targets are tested where the shooter saw them. */
  lag: number;
  life: number;
}

const clamp = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);

/** One room's dogfight. */
export class DogfightRoom extends TickRoom<DogfightInput, DogfightJoin, DogfightWorld, DogfightEvent> {
  private readonly planes = new Map<string, Plane>();
  private readonly rounds: Flying[] = [];
  /** The match: waiting for pilots (open-ended staging), the countdown, play, the end screen. */
  readonly match = new Phases<MatchPhase>("staging");
  private winner: string | null = null;
  private areasOf: { planes: Areas; start: Areas } | null = null;

  /** @param clock Run in real time (default); off for tests, which call `tick`. */
  constructor(room: HostedRoom, world: Promise<DogfightWorld>, clock = true) {
    super(room, { tick: TICK, ready: world, clock });
  }

  // ---------------------------------------------------------------- joining

  protected parseJoin(data: unknown): DogfightJoin | null {
    const j = (data ?? {}) as Partial<DogfightJoin>;
    if (typeof j !== "object") return null;
    return { name: cleanName(j.name) || "Pilot", watch: j.watch === true };
  }

  protected added(id: string, join: DogfightJoin): TickRole | null {
    if (join.watch) return "spectator";
    const w = this.world;
    const plane: Plane = { s: spawnPlane(w.fly, w.params, ...w.start, 0), hp: HP, kills: 0, deaths: 0, cooldown: 0, lastHit: null, history: new History(MAX_REWIND + 0.2) };
    this.planes.set(id, plane);
    this.respawn(plane);
    this.botWhenAlone();
    return "player";
  }

  protected removed(id: string): void {
    this.lives.delete(id);
    this.areas.planes.forget(id);
    if (this.planes.delete(id)) this.botWhenAlone();
  }

  /** The world around each plane, and all a respawn reads around the start: this room's (the world is every room's). */
  private get areas(): { planes: Areas; start: Areas } {
    const q = this.world.opened.query;
    return (this.areasOf ??= { planes: new Areas(q, AREAS), start: new Areas(q, { radius: START_AREA, ahead: 0 }) });
  }

  /** A pilot alone gets a bot to fight; it goes when another pilot arrives, or the pilot leaves. */
  private botWhenAlone(): void {
    const pilots = this.pilots();
    const flying = this.planes.has(BOT);
    if (pilots.length === 1 && !flying) this.addBot(BOT, { name: "Bot", watch: false }, () => this.botInput(BOT));
    else if (pilots.length !== 1 && flying) this.removeBot(BOT);
  }

  /** The pilots with planes, bots left out. */
  private pilots(): string[] {
    return this.playerIds().filter((id) => !this.isBot(id) && this.planes.has(id));
  }

  /** The bot: after the nearest plane at its height over the ground (the game's autopilot), firing when it is near the nose. */
  private botInput(id: string): DogfightInput {
    const me = this.planes.get(id)!.s;
    let target: PlaneState | null = null;
    for (const [other, p] of this.planes)
      if (other !== id && (!target || Math.hypot(p.s.x - me.x, p.s.y - me.y) < Math.hypot(target.x - me.x, target.y - me.y))) target = p.s;
    if (!target) return { ...LEVEL_FLIGHT, fire: false };
    const w = this.world;
    const ground = w.fly.groundAt(target.x, target.y) ?? 0;
    const input = new FlightPilot([{ x: target.x, y: target.y, agl: Math.max(2, target.h - ground) }]).input(me, w.fly, w.params);
    const { f } = axes(me.yaw, me.pitch, me.roll);
    const d = [target.x - me.x, target.y - me.y, (target.h - me.h) / PLANE.stepsPerCell];
    const len = Math.hypot(d[0]!, d[1]!, d[2]!);
    const reach = (me.speed + GUN.muzzle * PLANE.cruiseSpeed * w.params.pace) * GUN.life;
    const off = len > 0 ? Math.acos(Math.max(-1, Math.min(1, (d[0]! * f[0] + d[1]! * f[1] + d[2]! * f[2]) / len))) : Math.PI;
    return { ...input, fire: off < GUN.assist && len < reach };
  }

  // ---------------------------------------------------------------- flying

  protected input(data: unknown): DogfightInput | null {
    const i = (data ?? {}) as Partial<DogfightInput>;
    if (typeof i !== "object") return null;
    return { pitch: clamp(i.pitch, -1, 1), roll: clamp(i.roll, -1, 1), throttle: clamp(i.throttle, -1, 1), yaw: clamp(i.yaw, -1, 1), fire: i.fire === true };
  }

  protected step(id: string, input: DogfightInput, seen: number | null, seq: number): boolean | void {
    const w = this.world;
    const p = this.planes.get(id)!;
    if (!this.areas.planes.ready(p.s.x, p.s.y)) return false; // over ground still loading: the input waits (D-120)
    const r = flyTick(p.s, input, w.fly, w.params);
    p.cooldown = Math.max(0, p.cooldown - TICK);
    if (r.crashed) return this.down(id, p.lastHit && this.time - p.lastHit.at < CREDIT_S ? p.lastHit.by : null);
    if (!input.fire || p.cooldown > 0) return;
    p.cooldown = GUN.interval; // the page's guns count the same, to draw its rounds at once
    if (this.match.phase !== "playing") return; // cold
    // the targets where this page saw them, and the round tested against them there as it flies
    const lag = this.lagOf(seen, MAX_REWIND);
    const targets = [...this.planes].filter(([o]) => o !== id).map(([, o]) => o.history.at(this.time - lag, o.s));
    const round = fireRound(p.s, w.params, targets);
    this.rounds.push({ ...round, by: id, seq, lag, life: GUN.life });
    this.emit({ kind: "fire", by: id, seq, ...round });
  }

  protected override update(): void {
    this.flyRounds();
    for (const p of this.planes.values()) p.history.record(this.time, p.s);
    for (const [id, { s }] of this.planes) this.areas.planes.track(id, s.x, s.y, s.speed * Math.cos(s.heading), s.speed * Math.sin(s.heading));
    this.areas.start.track("start", ...this.world.start); // kept in use, so a budget lets go of it last
    this.runMatch();
  }

  // ---------------------------------------------------------------- the match

  /** Waiting (no pilot): staging without end. A pilot: the countdown, play, the end screen, and again. */
  private runMatch(): void {
    const m = this.match;
    const now = this.time;
    if (this.pilots().length === 0) {
      if (m.phase !== "staging" || m.until !== null) m.set("staging", now);
      return;
    }
    if (m.phase === "staging" && m.until === null) return this.phase("staging", MATCH.staging);
    const top = [...this.planes].sort(([, a], [, b]) => b.kills - a.kills)[0];
    if (m.phase === "playing" && top && top[1].kills >= MATCH.kills) return this.phase("ended", MATCH.ended, top[0]);
    if (!m.over(now)) return;
    if (m.phase === "staging") this.phase("playing", MATCH.seconds);
    else if (m.phase === "playing") this.phase("ended", MATCH.ended, top?.[0] ?? null);
    else {
      // the next match: scores back to nothing, everyone respawned
      for (const p of this.planes.values()) {
        Object.assign(p, { kills: 0, deaths: 0 });
        this.respawn(p);
      }
      this.rounds.length = 0;
      this.phase("staging", MATCH.staging);
    }
  }

  private phase(phase: MatchPhase, seconds: number, winner: string | null = null): void {
    this.match.set(phase, this.time, seconds);
    this.winner = phase === "ended" ? winner : null;
    this.emit({ kind: "phase", phase, winner: this.winner });
  }

  protected override describe(): DogfightInfo {
    const m = this.match;
    return { phase: m.phase, left: m.phase === "playing" ? Math.round(m.left(this.time)) : null };
  }

  // ---------------------------------------------------------------- snapshots

  protected override shared(): DogfightWorldNet {
    return {
      planes: [...this.planes].map(([id, p]): PlaneNet => ({
        id,
        name: this.joinOf(id)?.name ?? "Pilot",
        x: p.s.x,
        y: p.s.y,
        h: p.s.h,
        hd: p.s.yaw,
        p: drawnPitch(p.s.pitch),
        r: p.s.roll,
        hp: p.hp,
        kills: p.kills,
        deaths: p.deaths,
        life: this.lives.get(id) ?? 0,
        ...(this.isBot(id) ? { bot: true } : {}),
      })),
      match: { ...this.match.net(), kills: MATCH.kills, winner: this.winner },
    };
  }

  /** Each plane's spawns so far: its `life`, which a page draws a jump on. */
  private readonly lives = new Map<string, number>();

  protected override snapshot(id: string): DogfightSnap {
    return { you: this.planes.get(id)!.s };
  }

  // ---------------------------------------------------------------- the guns, and going down

  private respawn(p: Plane): void {
    const w = this.world;
    const a = Math.random() * 2 * Math.PI;
    const r = Math.random() * SPAWN_SPREAD;
    p.s = spawnPlane(w.fly, w.params, w.start[0] + Math.cos(a) * r, w.start[1] + Math.sin(a) * r, Math.random() * 2 * Math.PI);
    Object.assign(p, { hp: HP, lastHit: null, cooldown: 0 });
    p.history.clear();
    for (const [id, q] of this.planes) if (q === p) this.lives.set(id, (this.lives.get(id) ?? 0) + 1);
  }

  private flyRounds(): void {
    const w = this.world;
    const reach = GUN.reach * w.params.length;
    for (let i = this.rounds.length - 1; i >= 0; i--) {
      const r = this.rounds[i]!;
      const from = { x: r.x, y: r.y, h: r.h };
      r.x += r.vx * TICK;
      r.y += r.vy * TICK;
      r.h += r.vh * TICK;
      r.life -= TICK;
      let gone = r.life <= 0 || r.h < (w.fly.groundAt(r.x, r.y) ?? -Infinity);
      if (!gone)
        for (const [id, o] of this.planes) {
          if (id === r.by || passes(from, r, o.history.at(this.time - r.lag, o.s)) > reach) continue;
          this.hit(id, r.by, r.seq);
          gone = true;
          break;
        }
      if (gone) this.rounds.splice(i, 1);
    }
  }

  private hit(id: string, by: string, seq: number): void {
    const p = this.planes.get(id)!;
    p.hp -= GUN.damage;
    p.lastHit = { by, at: this.time };
    this.emit({ kind: "hit", by, seq, to: id });
    if (p.hp <= 0) this.down(id, by);
  }

  private down(id: string, by: string | null): void {
    const p = this.planes.get(id)!;
    const killer = by === null ? undefined : this.planes.get(by);
    if (killer && this.match.phase === "playing") killer.kills++;
    if (this.match.phase === "playing") p.deaths++;
    this.emit({ kind: "down", who: id, by: killer ? by : null, x: p.s.x, y: p.s.y, h: p.s.h });
    this.respawn(p);
  }

  /** For tests: a plane's state and score. */
  plane(id: string): Readonly<Plane> | undefined {
    return this.planes.get(id);
  }
}
