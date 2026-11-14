import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { carParams, type CarParams } from "@pixelworlds/game/src/car";
import { Decks, DriveWorld, type TrafficSource } from "@pixelworlds/game/src/ground";
import { CarPilot } from "@pixelworlds/game/src/pilot";
import { stylePack } from "@pixelworlds/game/src/styles";
import { openWorld, type WorldQuery } from "pixelworld/engine";
import { loadRoutes } from "pixelworld/traffic";
import { cleanName, type RoomInfo } from "../../index";
import { History, Phases, TickRoom, attachRelay, lobbyHandler, type HostedRoom, type Place, type Relay, type RelayLog, type TickRole } from "../../server";
import {
  BOTS,
  RACE,
  RACE_WORLD,
  TICK,
  contacts,
  courseLine,
  finished,
  gridDistance,
  gridRacer,
  lapOf,
  planCourse,
  progress,
  raceTick,
  resetPoint,
  type CarNet,
  type Course,
  type RaceEvent,
  type RaceInfo,
  type RaceInput,
  type RaceJoin,
  type RacePhase,
  type RaceSnap,
  type RaceWorldNet,
  type Racer,
  type Result,
} from "./rules";

/**
 * The race's server (D-119): a `TickRoom` per room on `/race?room=`. It owns
 * every car: each page's inputs are driven through the example game's car
 * physics over the same world (`openWorld`, its routes for the road decks),
 * round a loop of the Strip. A race: the countdown on the grid, three laps
 * timed in each car's own steps, a window for the rest once the winner is
 * in, the results, and the next. Bots (the game's `CarPilot`) make up the
 * field. A car bumps into the others where its driver saw them (rewound by
 * its lag, `History` with headings), never where they moved this tick, so
 * the order cars are stepped in doesn't matter and a page's prediction holds
 * through a bump. A car whose page went quiet is stalled: the others drive
 * through it, as through a finished car.
 */

export interface RaceWorld {
  drive: DriveWorld;
  params: CarParams;
  course: Course;
  query: WorldQuery;
  /** The cars the one being stepped bumps into: set before each step (the world is shared by every room, stepped one at a time). */
  contacts: TrafficSource | null;
}

/** Open the driving level the pages drive, over HTTP, with its routes (the road decks) and the course; the course and around it are loaded. */
export async function openRaceWorld(worldUrl: string): Promise<RaceWorld> {
  const { world, query } = await openWorld({ worldUrl, style: stylePack });
  const routes = await loadRoutes(worldUrl, world.manifest);
  if (!routes) throw new Error(`${worldUrl} has no routes to race on`);
  const course = planCourse(routes, query);
  const xs = course.path.points.map((p) => p.x);
  const ys = course.path.points.map((p) => p.y);
  // the course, once; off it, the ground ahead of each car as it drives (`RaceRoom.ensureAhead`)
  await query.ensure(Math.min(...xs) - 12, Math.min(...ys) - 12, Math.max(...xs) + 12, Math.max(...ys) + 12);
  const w: RaceWorld = { course, query, params: carParams(world), contacts: null, drive: null! };
  w.drive = new DriveWorld(query, world.cellsX, world.cellsY, new Decks(routes), () => w.contacts);
  return w;
}

/** The server's log, a line each. */
export function logLine(l: RelayLog): void {
  const what = l.kind === "error" ? `the game hit an error: ${l.error instanceof Error ? (l.error.stack ?? l.error.message) : String(l.error)}` : [l.kind, l.id, l.message].filter(Boolean).join(" ");
  (l.kind === "error" ? console.error : console.log)(`race room ${l.room}: ${what}`);
}

/**
 * The race on an HTTP server that also serves the page and the world
 * package: `/race?room=`. The world is opened from the server itself when
 * the first room needs it; if it fails, that room closes saying why and the
 * next one tries again. An empty room stays open a minute. `lag` holds every
 * message back that many ms each way.
 */
export function attachRace(server: Server, opts: { lag?: number; maxRooms?: number; log?: (l: RelayLog) => void } = {}): Relay {
  let opened: Promise<RaceWorld> | null = null;
  const world = () => {
    if (!opened) {
      const { port } = server.address() as AddressInfo;
      opened = openRaceWorld(`http://localhost:${port}${RACE_WORLD}`);
      opened.catch((e: unknown) => {
        console.error("race: the world didn't open:", e);
        opened = null;
      });
    }
    return opened;
  };
  return attachRelay(server, {
    path: "/race",
    lag: opts.lag,
    maxRooms: opts.maxRooms,
    maxPlayers: 12,
    idle: { named: 60_000 },
    log: opts.log ?? logLine,
    host: (room) => new RaceRoom(room, world()),
  });
}

/** The lobby for the race's rooms: quick play puts a page in a room that isn't mid-race. */
export function raceLobby(relay: Relay): (req: IncomingMessage, res: ServerResponse) => boolean {
  return lobbyHandler(relay, { fits: (r: RoomInfo) => (r.info as Partial<RaceInfo>).phase !== "racing" });
}

interface Car {
  r: Racer;
  /** Its grid slot this race. */
  slot: number;
  /** In this race (else it joined during it, and waits on the grid). */
  racing: boolean;
  /** Grid placings and resets so far: a page draws a jump on a new one. */
  life: number;
  /** Where it was at each shared snapshot (what the pages draw between), and where it was at the start of this tick. */
  history: History;
  last: Place;
  /** A bot's driver, its share of the top speed, and how long it has been stuck. */
  pilot?: CarPilot | null;
  pace?: number;
  stuck?: number;
  ensured: { x: number; y: number };
}

/**
 * The bots' pilot: a shorter look-ahead than the game's scripted run, so it
 * keeps to the line through the Strip's one-cell jogs, where buildings stand
 * over the quarter-cell roads' inside corners.
 */
const BOT_PILOT = { stop: false, lookMin: 0.8, lookTime: 0.25, lookMax: 3 };

const clamp = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);
const placeOf = (r: Racer): Place => ({ x: r.car.x, y: r.car.y, h: r.car.h, heading: r.car.heading });

/** One room's race. */
export class RaceRoom extends TickRoom<RaceInput, RaceJoin, RaceWorld, RaceEvent> {
  private readonly cars = new Map<string, Car>();
  readonly race = new Phases<RacePhase>("waiting");
  /** The finishers this race, in order. */
  private readonly order: string[] = [];
  private results: Result[] = [];

  /** @param clock Run in real time (default); off for tests, which call `tick`. */
  constructor(room: HostedRoom, world: Promise<RaceWorld>, clock = true) {
    super(room, { tick: TICK, ready: world, clock });
  }

  // ---------------------------------------------------------------- joining

  protected parseJoin(data: unknown): RaceJoin | null {
    const j = (data ?? {}) as Partial<RaceJoin>;
    if (typeof j !== "object") return null;
    return { name: cleanName(j.name) || "Driver", watch: j.watch === true };
  }

  protected added(id: string, join: RaceJoin): TickRole | null {
    if (join.watch) return "spectator";
    const slot = this.freeSlot();
    const car: Car = {
      r: gridRacer(this.world.course, this.world.drive, slot),
      slot,
      racing: this.race.phase !== "racing",
      life: 1,
      history: new History(RACE.maxRewind + 0.3),
      last: { x: 0, y: 0, h: 0 },
      ensured: { x: NaN, y: NaN },
    };
    car.last = placeOf(car.r);
    this.cars.set(id, car);
    const bot = BOTS.find((b) => b.id === id);
    if (bot) car.pace = bot.pace;
    else this.fillBots();
    return "player";
  }

  protected removed(id: string): void {
    if (this.cars.delete(id) && !this.isBot(id)) this.fillBots();
  }

  /** The lowest grid slot no car has. */
  private freeSlot(): number {
    const taken = new Set([...this.cars.values()].map((c) => c.slot));
    let slot = 0;
    while (taken.has(slot)) slot++;
    return slot;
  }

  /** The drivers, bots left out. */
  private drivers(): string[] {
    return this.playerIds().filter((id) => !this.isBot(id) && this.cars.has(id));
  }

  /** Bots make up the field to `RACE.field` between races (none with no driver); mid-race they stay as they are. */
  private fillBots(): void {
    if (this.race.phase === "racing") return;
    const drivers = this.drivers().length;
    const want = drivers === 0 ? 0 : Math.max(0, Math.min(BOTS.length, RACE.field - drivers));
    BOTS.forEach((b, i) => {
      const has = this.cars.has(b.id);
      if (i < want && !has) this.addBot(b.id, { name: b.name, watch: false }, () => this.botInput(b.id));
      else if (i >= want && has) this.removeBot(b.id);
    });
  }

  // ---------------------------------------------------------------- driving

  protected input(data: unknown): RaceInput | null {
    const i = (data ?? {}) as Partial<RaceInput>;
    if (typeof i !== "object") return null;
    return { throttle: clamp(i.throttle, 0, 1), brake: clamp(i.brake, 0, 1), steer: clamp(i.steer, -1, 1), reset: i.reset === true };
  }

  protected step(id: string, input: RaceInput, seen: number | null): void {
    const w = this.world;
    const car = this.cars.get(id)!;
    const r = car.r;
    // the others where this driver saw them (a bot: where they were as this tick began), never where they moved this
    // tick, so the order cars are stepped in doesn't matter; at `seen` itself, the very time the page's smoothing drew
    const t = seen === null ? this.time : Math.max(this.time - RACE.maxRewind, Math.min(this.time, seen));
    w.contacts = contacts(
      [...this.cars].filter(([o, c]) => o !== id && !this.isGhost(o, c)).map(([, c]) => c.history.at(t, c.last) as Required<Place>),
      w.params,
    );
    const laps = r.laps.length;
    raceTick(r, input, w.drive, w.course, w.params);
    w.contacts = null;
    if (input.reset) {
      car.life++;
      car.history.clear();
    }
    if (r.laps.length > laps) this.lapDone(id, car);
    this.ensureAhead(car);
  }

  /** A bot: the course's line from where it is, at its share of the road's top speed; stuck a second and a half, back to its last checkpoint. Past the flag it stops. */
  private botInput(id: string): RaceInput {
    const w = this.world;
    const car = this.cars.get(id)!;
    const s = car.r.car;
    // the brake reverses a stopped car: only while it rolls
    if (car.r.held || finished(car.r)) return { throttle: 0, brake: s.speed > 0.1 ? 1 : 0, steer: 0, reset: false };
    car.stuck = Math.abs(s.speed) < 0.3 ? (car.stuck ?? 0) + TICK : 0;
    if (car.stuck > 1.5) {
      car.stuck = 0;
      car.pilot = null;
      return { throttle: 0, brake: 0, steer: 0, reset: true };
    }
    if (!car.pilot) {
      const from = car.r.cps === 0 && car.r.steps === 0 ? gridDistance(car.slot) : resetPoint(w.course, car.r).d;
      car.pilot = new CarPilot(courseLine(w.course, from, (RACE.laps + 1) * w.course.length), BOT_PILOT);
    }
    const top = w.drive.topSpeedAt(s.x, s.y, s.h) * w.params.pace * (car.pace ?? 1);
    return { ...car.pilot.input(s, w.params.pace, top), reset: false };
  }

  /** The others drive through a car that isn't racing: finished, stalled (its page went quiet), or waiting for the next race. */
  private isGhost(id: string, c: Car): boolean {
    return !c.racing || finished(c.r) || this.idleFor(id) > RACE.stall;
  }

  /** Load the ground around and ahead of a car off the course (the course is loaded): the car stands still on ground still loading. */
  private ensureAhead(car: Car): void {
    const s = car.r.car;
    const ahead = 6 + Math.abs(s.speed) * 1.5;
    const cx = s.x + Math.cos(s.heading) * ahead * 0.5;
    const cy = s.y + Math.sin(s.heading) * ahead * 0.5;
    if (Math.hypot(cx - car.ensured.x, cy - car.ensured.y) < 4) return;
    car.ensured = { x: cx, y: cy };
    void this.world.query.ensure(cx - ahead, cy - ahead, cx + ahead, cy + ahead);
  }

  private lapDone(id: string, car: Car): void {
    const r = car.r;
    const n = r.laps.length;
    if (!finished(r)) return this.emit({ kind: "lap", who: id, lap: n, time: (r.laps[n - 1]! - (r.laps[n - 2] ?? 0)) * TICK });
    this.order.push(id);
    this.emit({ kind: "finish", who: id, place: this.order.length, time: r.steps * TICK });
    // the winner is in: the rest have a while
    if (this.order.length === 1) this.race.until = Math.min(this.race.until ?? Infinity, this.time + RACE.window);
  }

  protected override update(): void {
    for (const c of this.cars.values()) c.last = placeOf(c.r);
    this.runRace();
  }

  // ---------------------------------------------------------------- the race

  /** No driver: waiting, without end. Drivers: the countdown on the grid, the race, the results, and again. */
  private runRace(): void {
    const m = this.race;
    const now = this.time;
    if (this.drivers().length === 0) {
      if (m.phase === "waiting") return;
      this.phase("waiting");
      this.fillBots(); // the bots go too
      return;
    }
    if (m.phase === "waiting") return this.grid();
    if (m.phase === "racing") {
      const racing = [...this.cars.values()].filter((c) => c.racing);
      if (m.over(now) || racing.every((c) => finished(c.r))) return this.finish();
      return;
    }
    if (!m.over(now)) return;
    if (m.phase === "countdown") {
      this.phase("racing", RACE.seconds);
      for (const c of this.cars.values()) if (c.racing) c.r.held = false;
    } else this.grid();
  }

  private phase(phase: RacePhase, seconds?: number): void {
    this.race.set(phase, this.time, seconds);
    this.emit({ kind: "phase", phase });
  }

  /** Everyone back on the grid, in the order they came (bots at the back), held for the countdown. */
  private grid(): void {
    this.fillBots();
    const ids = [...this.cars.keys()].sort((a, b) => Number(this.isBot(a)) - Number(this.isBot(b)));
    ids.forEach((id, slot) => {
      const c = this.cars.get(id)!;
      Object.assign(c, { r: gridRacer(this.world.course, this.world.drive, slot), slot, racing: true, pilot: null, stuck: 0 });
      c.life++;
      c.history.clear();
      c.last = placeOf(c.r);
    });
    this.order.length = 0;
    this.phase("countdown", RACE.countdown);
  }

  /** The race is over: the results, finishers first by time, then the rest by how far they got. */
  private finish(): void {
    const racing = [...this.cars].filter(([, c]) => c.racing);
    const ranked = this.ranked(racing);
    this.results = ranked.map(([id, c]): Result => {
      const lapTimes = c.r.laps.map((s, i) => (s - (c.r.laps[i - 1] ?? 0)) * TICK);
      return {
        id,
        name: this.joinOf(id)?.name ?? "Driver",
        time: finished(c.r) ? c.r.steps * TICK : null,
        best: lapTimes.length ? Math.min(...lapTimes) : null,
        ...(this.isBot(id) ? { bot: true } : {}),
      };
    });
    for (const [, c] of racing) c.r.held = true;
    this.phase("results", RACE.results);
  }

  /** Cars in race order: finishers by their own time, then by how far they got. */
  private ranked(cars: [string, Car][]): [string, Car][] {
    const course = this.world.course;
    return [...cars].sort(([, a], [, b]) => {
      const fa = finished(a.r);
      const fb = finished(b.r);
      if (fa !== fb) return fa ? -1 : 1;
      if (fa) return a.r.steps - b.r.steps;
      return progress(course, b.r) - progress(course, a.r);
    });
  }

  protected override describe(): RaceInfo {
    const m = this.race;
    return { phase: m.phase, left: m.phase === "racing" ? Math.round(m.left(this.time)) : null };
  }

  // ---------------------------------------------------------------- snapshots

  protected override shared(): RaceWorldNet {
    // where each car is in what the pages get: what a driver's bumps are judged against
    for (const c of this.cars.values()) c.history.record(this.time, c.last);
    const places = new Map(this.ranked([...this.cars].filter(([, c]) => c.racing)).map(([id], i) => [id, i + 1]));
    return {
      cars: [...this.cars].map(([id, c]): CarNet => ({
        id,
        name: this.joinOf(id)?.name ?? "Driver",
        x: c.r.car.x,
        y: c.r.car.y,
        h: c.r.car.h,
        hd: c.r.car.heading,
        life: c.life,
        lap: lapOf(c.r),
        time: c.r.steps * TICK,
        place: places.get(id) ?? 0,
        done: finished(c.r),
        ...(this.isGhost(id, c) ? { ghost: true } : {}),
        ...(this.isBot(id) ? { bot: true } : {}),
      })),
      race: { ...this.race.net(), laps: RACE.laps, results: this.results },
    };
  }

  protected override snapshot(id: string): RaceSnap {
    return { you: this.cars.get(id)!.r };
  }

  /** For tests: a car's racer and how its race goes. */
  car(id: string): Readonly<Car> | undefined {
    return this.cars.get(id);
  }
}
