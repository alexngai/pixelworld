import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FlyWorld } from "@pixelworlds/game/src/ground";
import { FlightPilot } from "@pixelworlds/game/src/pilot";
import { LEVEL_FLIGHT, axes, drawnPitch, flightParams, flyPlane, spawnPlane, type PlaneParams, type PlaneState } from "@pixelworlds/game/src/plane";
import { stylePack } from "@pixelworlds/game/src/styles";
import { PLANE } from "@pixelworlds/game/src/tuning";
import { openWorld } from "pixelworld/engine";
import { History, TickRoom, attachRelay, type HostedRoom, type Relay, type TickRole } from "../../server";
import {
  BOT,
  CREDIT_S,
  DOGFIGHT_START,
  DOGFIGHT_WORLD,
  GUN,
  HP,
  MAX_REWIND,
  SPAWN_SPREAD,
  TICK,
  fireRound,
  passes,
  type DogfightEvent,
  type DogfightInput,
  type DogfightJoin,
  type PlaneNet,
  type Round,
} from "./rules";

/**
 * The dogfight's server (D-113, D-114, D-116): a `TickRoom` per room on
 * `/dogfight?room=`. It owns every plane: each page's inputs are flown
 * through the example game's flight model over the same world (`openWorld`);
 * it fires the guns, judges hits against where the shooter saw its target
 * (rewound by its lag, `History`), and decides health, kills and respawns.
 * Pages may watch instead of fly; a pilot alone gets a bot to fight, which
 * goes when another pilot arrives.
 */

export interface DogfightWorld {
  fly: FlyWorld;
  params: PlaneParams;
  /** The start (cells). */
  start: [number, number];
}

/** Open the flying level the pages fly, over HTTP, with the style packs the game has; the whole level is loaded (a few dozen chunks). */
export async function openDogfightWorld(worldUrl: string): Promise<DogfightWorld> {
  const { world, query } = await openWorld({ worldUrl, style: stylePack });
  // ponytail: the whole level, as the flying levels are small; a big one would load around each plane
  await query.ensure(0, 0, world.cellsX, world.cellsY);
  const tops = query.landmarks().flatMap((l) => query.objectsAt(l.x, l.y).map((o) => o.top ?? -Infinity));
  const start = query.lonLatToCell(DOGFIGHT_START.lon, DOGFIGHT_START.lat) ?? [world.cellsX / 2, world.cellsY / 2];
  return { fly: new FlyWorld(query, world.cellsX, world.cellsY), params: flightParams(world, tops), start };
}

/**
 * The dogfight on an HTTP server that also serves the page and the world
 * package: `/dogfight?room=`. The world is opened from the server itself when
 * the first room needs it; if it fails, that room closes saying why and the
 * next one tries again. `lag` holds every message back that many ms each way.
 */
export function attachDogfight(server: Server, opts: { lag?: number; maxRooms?: number } = {}): Relay {
  let opened: Promise<DogfightWorld> | null = null;
  const world = () => {
    if (!opened) {
      const { port } = server.address() as AddressInfo;
      opened = openDogfightWorld(`http://localhost:${port}${DOGFIGHT_WORLD}`);
      opened.catch((e: unknown) => {
        console.error("dogfight: the world didn't open:", e);
        opened = null;
      });
    }
    return opened;
  };
  return attachRelay(server, { path: "/dogfight", lag: opts.lag, maxRooms: opts.maxRooms, host: (room) => new DogfightRoom(room, world()) });
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
  /** Its shooter's lag when it fired: targets are tested where the shooter saw them. */
  lag: number;
  life: number;
}

const clamp = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);

/** One room's dogfight. */
export class DogfightRoom extends TickRoom<DogfightInput, DogfightJoin, DogfightWorld> {
  private readonly planes = new Map<string, Plane>();
  private readonly rounds: Flying[] = [];

  /** @param clock Run in real time (default); off for tests, which call `tick`. */
  constructor(room: HostedRoom, world: Promise<DogfightWorld>, clock = true) {
    super(room, { tick: TICK, ready: world, clock });
  }

  // ---------------------------------------------------------------- joining

  protected parseJoin(data: unknown): DogfightJoin | null {
    const j = (data ?? {}) as Partial<DogfightJoin>;
    if (typeof j !== "object") return null;
    const name = typeof j.name === "string" ? j.name.trim().slice(0, 20) : "";
    return { name: name || "Pilot", watch: j.watch === true };
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
    if (this.planes.delete(id)) this.botWhenAlone();
  }

  /** A pilot alone gets a bot to fight; it goes when another pilot arrives, or the pilot leaves. */
  private botWhenAlone(): void {
    const pilots = this.playerIds().filter((id) => !this.isBot(id) && this.planes.has(id));
    const flying = this.planes.has(BOT);
    if (pilots.length === 1 && !flying) this.addBot(BOT, { name: "Bot", watch: false }, () => this.botInput(BOT));
    else if (pilots.length !== 1 && flying) this.removeBot(BOT);
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

  protected step(id: string, input: DogfightInput, seen: number | null): void {
    const w = this.world;
    const p = this.planes.get(id)!;
    const r = flyPlane(p.s, input, w.fly, w.params, TICK);
    p.cooldown = Math.max(0, p.cooldown - TICK);
    if (r.crashed) return this.down(id, p.lastHit && this.time - p.lastHit.at < CREDIT_S ? p.lastHit.by : null);
    if (!input.fire || p.cooldown > 0) return;
    p.cooldown = GUN.interval;
    // the targets where this page saw them, and the round tested against them there as it flies
    const lag = this.lagOf(seen, MAX_REWIND);
    const targets = [...this.planes].filter(([o]) => o !== id).map(([, o]) => o.history.at(this.time - lag, o.s));
    const round = fireRound(p.s, w.params, targets);
    this.rounds.push({ ...round, by: id, lag, life: GUN.life });
    this.event({ k: "fire", t: this.time, by: id, ...round });
  }

  protected override update(): void {
    this.flyRounds();
    for (const p of this.planes.values()) p.history.record(this.time, p.s);
  }

  // ---------------------------------------------------------------- snapshots

  protected override shared(): { planes: PlaneNet[] } {
    return {
      planes: [...this.planes].map(([id, p]) => ({
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
        life: p.deaths,
        ...(this.isBot(id) ? { bot: true } : {}),
      })),
    };
  }

  protected override snapshot(id: string): { you: PlaneState } {
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
          this.hit(id, r.by);
          gone = true;
          break;
        }
      if (gone) this.rounds.splice(i, 1);
    }
  }

  private hit(id: string, by: string): void {
    const p = this.planes.get(id)!;
    p.hp -= GUN.damage;
    p.lastHit = { by, at: this.time };
    this.event({ k: "hit", t: this.time, by, to: id });
    if (p.hp <= 0) this.down(id, by);
  }

  private down(id: string, by: string | null): void {
    const p = this.planes.get(id)!;
    const killer = by === null ? undefined : this.planes.get(by);
    if (killer) killer.kills++;
    p.deaths++;
    this.event({ k: "down", t: this.time, who: id, by: killer ? by : null, x: p.s.x, y: p.s.y, h: p.s.h });
    this.respawn(p);
  }

  private event(e: DogfightEvent): void {
    this.room.broadcast(e);
  }

  /** For tests: a plane's state and score. */
  plane(id: string): Readonly<Plane> | undefined {
    return this.planes.get(id);
  }
}
