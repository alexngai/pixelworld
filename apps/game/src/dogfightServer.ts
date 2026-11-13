import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openWorld } from "@pixelworlds/engine";
import { attachRelay, type HostedRoom, type Relay, type RoomHost } from "@pixelworlds/multiplayer/server";
import { parseStyleJson } from "@pixelworlds/style";
import {
  CREDIT_S,
  DOGFIGHT_START,
  GUN,
  HP,
  MAX_REWIND,
  SNAPSHOT_TICKS,
  SPAWN_SPREAD,
  TICK,
  fireRound,
  passes,
  type ClientMsg,
  type PlaneNet,
  type Point,
  type Round,
  type ServerMsg,
} from "./dogfightRules";
import { FlyWorld } from "./ground";
import { drawnPitch, flightParams, flyPlane, spawnPlane, type PlaneInput, type PlaneParams, type PlaneState } from "./plane";

/**
 * The dogfight's server (D-113): a game per room on `/dogfight?room=`, run on
 * the game's dev and preview servers (vite.config.ts). It owns every plane:
 * each page sends its inputs, numbered, at a fixed 60 a second, and the server
 * flies them through the same flight model over the same world (`openWorld`),
 * fires the guns, judges hits against where the shooter saw its target
 * (rewound by its lag), and decides health, kills and respawns. Twenty times a
 * second each page gets a snapshot: every plane, and its own after the last
 * input stepped, for its prediction.
 */

export interface DogfightWorld {
  fly: FlyWorld;
  params: PlaneParams;
  /** The start (cells). */
  start: [number, number];
}

/** Open the flying level the pages fly, over HTTP, with its style pack from disk; the whole level is loaded (a few dozen chunks). */
export async function openDogfightWorld(worldUrl: string, styles: URL): Promise<DogfightWorld> {
  const style = (id: string) => parseStyleJson(readFileSync(new URL(`${id}/style.json`, styles), "utf8"), `worlds/_styles/${id}/style.json`) as object;
  const { world, query } = await openWorld({ worldUrl, style });
  // ponytail: the whole level, as the flying levels are small; a big one would load around each plane
  await query.ensure(0, 0, world.cellsX, world.cellsY);
  const tops = query.landmarks().flatMap((l) => query.objectsAt(l.x, l.y).map((o) => o.top ?? -Infinity));
  const start = query.lonLatToCell(DOGFIGHT_START.lon, DOGFIGHT_START.lat) ?? [world.cellsX / 2, world.cellsY / 2];
  return { fly: new FlyWorld(query, world.cellsX, world.cellsY), params: flightParams(world, tops), start };
}

/**
 * The dogfight on an HTTP server: `/dogfight?room=`. The world is opened from
 * the server itself (`world`, a path on it) when the first player arrives.
 * `lag` holds every message back that many ms each way, to try the game under lag.
 */
export function attachDogfight(server: Server, opts: { styles: URL; world?: string; lag?: number }): Relay {
  let opened: Promise<DogfightWorld> | null = null;
  const world = () => {
    if (!opened) {
      const { port } = server.address() as AddressInfo;
      opened = openDogfightWorld(`http://localhost:${port}${opts.world ?? "/southwest-fly/"}`, opts.styles);
      opened.catch((e: unknown) => {
        console.error("dogfight: the world didn't open:", e);
        opened = null; // the next room tries again
      });
    }
    return opened;
  };
  return attachRelay(server, { path: "/dogfight", lag: opts.lag, host: (room) => new DogfightRoom(room, world()) });
}

/** Inputs a page may have waiting, and the steps it may catch up in one tick after a stall. */
const MAX_QUEUE = 120;
const MAX_BUDGET = 8;

interface Input {
  seq: number;
  i: PlaneInput;
  f: boolean;
  seen: number | null;
}

interface Player {
  id: string;
  name: string;
  s: PlaneState;
  queue: Input[];
  /** The last input stepped. */
  ack: number;
  /** Steps it may take this tick: one a tick, saved up to MAX_BUDGET (a page can't fly faster than the clock). */
  budget: number;
  hp: number;
  kills: number;
  deaths: number;
  cooldown: number;
  lastHit: { by: string; at: number } | null;
  jump: boolean;
  /** Where it was, by server time, for rewinding a shooter's view. */
  history: (Point & { t: number })[];
}

interface Flying extends Round {
  by: string;
  /** Its shooter's lag when it fired: targets are tested where the shooter saw them. */
  lag: number;
  life: number;
}

const clamp = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);

/** One room's game. */
export class DogfightRoom implements RoomHost {
  private readonly players = new Map<string, Player>();
  private readonly names = new Map<string, string>();
  private readonly waiting = new Set<string>();
  private readonly rounds: Flying[] = [];
  private world: DogfightWorld | null = null;
  /** Server time (s): whole ticks. */
  time = 0;
  private ticks = 0;
  private last = performance.now();
  private acc = 0;
  private readonly timer: ReturnType<typeof setInterval> | null;

  /** @param clock Run in real time (default); off for tests, which call `tick`. */
  constructor(
    private readonly room: HostedRoom,
    world: Promise<DogfightWorld>,
    clock = true,
  ) {
    void world.then(
      (w) => {
        this.world = w;
        for (const id of this.waiting) this.add(id);
        this.waiting.clear();
      },
      () => {}, // attachDogfight says why
    );
    this.timer = clock ? setInterval(() => this.run(), 1000 / 120) : null;
  }

  join(id: string): void {
    if (this.world) this.add(id);
    else this.waiting.add(id);
  }

  leave(id: string): void {
    this.players.delete(id);
    this.waiting.delete(id);
    this.names.delete(id);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }

  message(id: string, data: unknown): void {
    const m = data as Partial<ClientMsg> | null;
    if (!m || typeof m !== "object") return;
    if (m.k === "hello" && typeof m.name === "string") {
      const name = m.name.trim().slice(0, 20) || `Pilot ${id}`;
      this.names.set(id, name);
      const p = this.players.get(id);
      if (p) p.name = name;
      return;
    }
    const p = this.players.get(id);
    if (m.k !== "in" || !p || !Number.isInteger(m.seq) || m.seq! <= (p.queue.at(-1)?.seq ?? p.ack) || p.queue.length >= MAX_QUEUE) return;
    const i = (m.i ?? {}) as Partial<PlaneInput>;
    p.queue.push({
      seq: m.seq!,
      i: { pitch: clamp(i.pitch, -1, 1), roll: clamp(i.roll, -1, 1), throttle: clamp(i.throttle, -1, 1), yaw: clamp(i.yaw, -1, 1) },
      f: m.f === true,
      seen: typeof m.seen === "number" && Number.isFinite(m.seen) ? m.seen : null,
    });
  }

  /** Whole ticks for the time gone by. */
  private run(): void {
    const now = performance.now();
    this.acc += Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    while (this.acc >= TICK) {
      this.acc -= TICK;
      this.tick();
    }
  }

  tick(): void {
    this.time = ++this.ticks * TICK;
    if (!this.world) return;
    for (const p of this.players.values()) {
      p.budget = Math.min(MAX_BUDGET, p.budget + 1);
      while (p.budget >= 1 && p.queue.length) {
        p.budget--;
        this.step(p, p.queue.shift()!);
      }
    }
    this.flyRounds();
    for (const p of this.players.values()) {
      p.history.push({ t: this.time, x: p.s.x, y: p.s.y, h: p.s.h });
      while (p.history.length && this.time - p.history[0]!.t > MAX_REWIND + 0.2) p.history.shift();
    }
    if (this.ticks % SNAPSHOT_TICKS === 0) this.snapshot();
  }

  private add(id: string): void {
    const p: Player = {
      id,
      name: this.names.get(id) ?? `Pilot ${id}`,
      s: spawnPlane(this.world!.fly, this.world!.params, ...this.world!.start, 0), // respawn puts it somewhere
      queue: [],
      ack: 0,
      budget: 0,
      hp: HP,
      kills: 0,
      deaths: 0,
      cooldown: 0,
      lastHit: null,
      jump: true,
      history: [],
    };
    this.players.set(id, p);
    this.respawn(p);
  }

  private respawn(p: Player): void {
    const w = this.world!;
    const a = Math.random() * 2 * Math.PI;
    const r = Math.random() * SPAWN_SPREAD;
    p.s = spawnPlane(w.fly, w.params, w.start[0] + Math.cos(a) * r, w.start[1] + Math.sin(a) * r, Math.random() * 2 * Math.PI);
    Object.assign(p, { hp: HP, lastHit: null, jump: true, cooldown: 0, history: [] });
  }

  private step(p: Player, input: Input): void {
    const w = this.world!;
    p.ack = input.seq;
    const r = flyPlane(p.s, input.i, w.fly, w.params, TICK);
    p.cooldown = Math.max(0, p.cooldown - TICK);
    if (r.crashed) return this.down(p, p.lastHit && this.time - p.lastHit.at < CREDIT_S ? p.lastHit.by : null);
    if (!input.f || p.cooldown > 0) return;
    p.cooldown = GUN.interval;
    // the targets where this page saw them, and the round tested against them there as it flies
    const lag = input.seen === null ? 0 : Math.max(0, Math.min(MAX_REWIND, this.time - input.seen));
    const targets = [...this.players.values()].filter((o) => o !== p).map((o) => this.at(o, this.time - lag));
    const round = fireRound(p.s, w.params, targets);
    this.rounds.push({ ...round, by: p.id, lag, life: GUN.life });
    this.broadcast({ k: "fire", by: p.id, ...round });
  }

  /** Where a plane was at server time t: between the two ticks around it, else its oldest or where it is now. */
  private at(p: Player, t: number): Point {
    const hs = p.history;
    if (!hs.length || t >= hs[hs.length - 1]!.t) return { x: p.s.x, y: p.s.y, h: p.s.h };
    if (t <= hs[0]!.t) return hs[0]!;
    let i = hs.length - 1;
    while (hs[i - 1]!.t > t) i--;
    const [a, b] = [hs[i - 1]!, hs[i]!];
    const f = (t - a.t) / (b.t - a.t);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, h: a.h + (b.h - a.h) * f };
  }

  private flyRounds(): void {
    const w = this.world!;
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
        for (const o of this.players.values()) {
          if (o.id === r.by || passes(from, r, this.at(o, this.time - r.lag)) > reach) continue;
          this.hit(o, r.by);
          gone = true;
          break;
        }
      if (gone) this.rounds.splice(i, 1);
    }
  }

  private hit(p: Player, by: string): void {
    p.hp -= GUN.damage;
    p.lastHit = { by, at: this.time };
    this.broadcast({ k: "hit", by, to: p.id });
    if (p.hp <= 0) this.down(p, by);
  }

  private down(p: Player, by: string | null): void {
    const killer = by === null ? undefined : this.players.get(by);
    if (killer) killer.kills++;
    p.deaths++;
    this.broadcast({ k: "down", who: p.id, by: killer ? by : null, x: p.s.x, y: p.s.y, h: p.s.h });
    this.respawn(p);
  }

  private snapshot(): void {
    const planes: PlaneNet[] = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      x: p.s.x,
      y: p.s.y,
      h: p.s.h,
      hd: p.s.yaw,
      p: drawnPitch(p.s.pitch),
      r: p.s.roll,
      hp: p.hp,
      kills: p.kills,
      deaths: p.deaths,
      ...(p.jump ? { jump: true } : {}),
    }));
    for (const p of this.players.values()) this.room.send(p.id, { k: "snap", t: this.time, ack: p.ack, you: p.s, planes } satisfies ServerMsg);
    for (const p of this.players.values()) p.jump = false;
  }

  private broadcast(m: ServerMsg): void {
    this.room.broadcast(m);
  }

  /** For tests: a player's state. */
  player(id: string): Readonly<Player> | undefined {
    return this.players.get(id);
  }
}
