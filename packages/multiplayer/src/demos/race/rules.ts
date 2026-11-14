import { stepCar, type CarInput, type CarParams, type CarState, type CarStep, type CarWorld } from "@pixelworlds/game/src/car";
import type { TrafficSource } from "@pixelworlds/game/src/ground";
import { Path } from "@pixelworlds/game/src/pilot";
import type { Point } from "@pixelworlds/game/src/roads";
import { RoadGraph } from "@pixelworlds/game/src/route";
import type { RouteNetwork } from "pixelworld/traffic";

/**
 * The race's rules and messages, the same on the server (server.ts, a
 * `TickRoom`) and in the page (client.ts, a `TickClient`): D-119. The cars
 * drive the example game's car physics (apps/game's car.ts) on the
 * Southwest's driving level, round a loop of the Las Vegas Strip.
 */

/** The driving level the race is on (100 m cells at the Strip). */
export const RACE_WORLD = "/southwest/";
/** The fixed step both sides drive at (s): one input each, and a race's clock counts them. */
export const TICK = 1 / 60;

/**
 * The course, clockwise: north up the Strip past Flamingo Road to Sahara,
 * east and south down Paradise Road, west along Tropicana, and north up the
 * Strip again. The roads between these are planned on the level's routes;
 * the first is the start and finish line, on the Strip's straight between
 * Tropicana and Flamingo, with the grid behind it. About 127 cells (a lap
 * ~25 s).
 */
export const COURSE = [
  { lon: -115.17329, lat: 36.11127 }, // the Strip south of Flamingo Road: the start and finish
  { lon: -115.1718, lat: 36.1227 }, // the Strip by Caesars, before it bends north-east
  { lon: -115.1575, lat: 36.1433 }, // the Strip at Sahara
  { lon: -115.154, lat: 36.1015 }, // Paradise Road at Tropicana
  { lon: -115.1729, lat: 36.1021 }, // the Strip at Tropicana
];
/**
 * Junctions closer than this (cells) are joined when the course is planned:
 * less than the game's planner (2.5), so the course keeps to the drawn roads
 * through the Strip's divided junctions rather than across a corner of the
 * buildings beside them.
 */
export const COURSE_GAP = 1.5;

export const RACE = {
  laps: 3,
  /** Checkpoints round a lap, evenly spaced; the first is the line. */
  checkpoints: 8,
  /** A checkpoint is passed within this many cells of it (roads are a cell or so wide; corners get cut). */
  reach: 2.5,
  /** A race has at least this many cars: bots make up the field. */
  field: 4,
  /** Seconds: the countdown on the grid, the longest a race runs, how long after the winner the others have, the results. */
  countdown: 8,
  seconds: 300,
  window: 30,
  results: 12,
  /** A driver's bumps are judged against where it saw the others, rewound by its lag at most this much (s). */
  maxRewind: 0.3,
  /** A player whose inputs stopped this long ago (s) is stalled: the others drive through its car. */
  stall: 0.5,
  /**
   * Cars bump at this share of their drawn width (`raceCar`): at this level a
   * car is drawn 0.31 cells wide on roads a quarter cell wide, and at its
   * drawn width no car could pass another. Nose to tail, they bump at their
   * whole length.
   */
  width: 0.5,
};

/** The car's parameters in the race: the game's (`carParams`), bumping at `RACE.width` of its width. The server and the page step with the same. */
export const raceCar = (p: CarParams): CarParams => ({ ...p, width: p.width * RACE.width });

/**
 * The grid behind the line, staggered single file (the roads are a quarter
 * cell wide, and cars side by side close on the line and lock): the pole
 * this far back (cells), each next one this far behind, this far either side
 * of the line in turn.
 */
export const GRID = { first: 1.5, gap: 0.9, side: 0.1 };

/** Bots: their names, and the share of each road's top speed they keep to (beatable). The grid puts the slowest first: the others come through. */
export const BOTS = [
  { id: "bot1", name: "Bot Ace", pace: 1 },
  { id: "bot2", name: "Bot Blue", pace: 0.8 },
  { id: "bot3", name: "Bot Cobalt", pace: 0.62 },
];

/**
 * Overtaking, for the bots. The roads are about a car wide, so a bot held up
 * behind a slower car (within `follow` cells ahead, within `width` across:
 * in its way) passes it as a ghost: nothing bumps it and it bumps nothing,
 * until it is `clear` cells ahead of that car (its length and a little), or
 * gives up (`drop` cells behind it, or `give` seconds). So that it reads as a
 * pass, its path eases `lane` cells to the side away from the other over
 * `ramp` cells, where the course runs straight (strays at most `stray` from
 * its chord, so the roads' one-cell jogs count) and that side has room
 * (`passingRoom`, `room` cells off the line), and eases back. A bot that
 * can't pass keeps back rather than ram.
 */
export const PASS = { lane: 0.15, follow: 1.3, width: 0.17, clear: 0.9, drop: 1.5, give: 4, ramp: 1.5, hold: [2, 14] as const, stray: 0.6, room: 0.3 };

// ---------------------------------------------------------------- the course

/** A checkpoint: where it is on the course's line, which way the course runs there, and how far along it is (cells). */
export interface Checkpoint {
  x: number;
  y: number;
  heading: number;
  d: number;
}

export interface Course {
  /** The loop's line through the road cells: its last point is its first. */
  path: Path;
  length: number;
  /** Evenly round the lap; the first is the start and finish line. */
  checkpoints: Checkpoint[];
}

/** The course's line, from the waypoints: each leg planned on the roads, joined into a loop. */
export function planCourse(routes: RouteNetwork, geo: { lonLatToCell(lon: number, lat: number): [number, number] | null }): Course {
  const graph = new RoadGraph(routes, COURSE_GAP);
  const at = COURSE.map((w, i) => {
    const c = geo.lonLatToCell(w.lon, w.lat);
    if (!c) throw new Error(`the course's waypoint ${i} is outside the world`);
    return { x: c[0], y: c[1] };
  });
  // each leg runs from the road beside its waypoint (its first point is the waypoint itself, off the line) to the road beside the next
  const line: Point[] = [];
  at.forEach((from, i) => {
    const leg = graph.plan(from, at[(i + 1) % at.length]!);
    if (!leg) throw new Error(`no road from the course's waypoint ${i} to the next`);
    for (const p of leg.points.slice(1)) {
      const last = line[line.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) line.push(p);
    }
  });
  const path = new Path(line);
  const course: Course = { path, length: path.length, checkpoints: [] };
  for (let i = 0; i < RACE.checkpoints; i++) {
    const d = (path.length * i) / RACE.checkpoints;
    course.checkpoints.push({ ...courseAt(course, d), heading: courseHeading(course, d), d });
  }
  return course;
}

/** The point `d` cells along the course, round the loop either way. */
export function courseAt(c: Course, d: number): Point {
  return c.path.at(((d % c.length) + c.length) % c.length);
}

/** Which way the course runs `d` cells along (over a couple of cells, past the roads' octilinear stairs). */
export function courseHeading(c: Course, d: number): number {
  const a = courseAt(c, d - 1);
  const b = courseAt(c, d + 1);
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/**
 * The course's line from `from` cells along, for `length` cells, round the
 * loop as often as it takes, `offset` cells to its right (a passing lane): a
 * path for a bot.
 */
export function courseLine(c: Course, from: number, length: number): Point[] {
  const pts = c.path.points;
  const out: Point[] = [courseAt(c, from)];
  const end = from + length;
  for (let base = Math.floor(from / c.length) * c.length; base < end; base += c.length)
    for (let i = 1; i < pts.length; i++) {
      const d = base + c.path.cum[i]!;
      if (d > from && d < end) out.push(pts[i]!);
    }
  out.push(courseAt(c, end));
  return out;
}

/** A point `across` cells to the right of the course's line, `d` cells along. */
export function courseOffset(c: Course, d: number, across: number): Point {
  const p = courseAt(c, d);
  const h = courseHeading(c, d);
  return { x: p.x - Math.sin(h) * across, y: p.y + Math.cos(h) * across };
}

/** How far the course runs straight from `d` (cells, up to `max`): nowhere more than `PASS.stray` off the chord. */
export function straightFor(c: Course, d: number, max: number): number {
  const a = courseAt(c, d);
  let run = 0;
  for (let n = 1; n <= max; n++) {
    const b = courseAt(c, d + n);
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    if (chord < n * 0.9) break; // it turns back on itself
    let ok = true;
    for (let k = 1; k < n && ok; k++) {
      const p = courseAt(c, d + k);
      ok = Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / chord <= PASS.stray;
    }
    if (!ok) break;
    run = n;
  }
  return run;
}

/**
 * Where each side of the course (left, right) has room to pass, every half
 * cell round it: `PASS.room` off the line, on the road's top speed and clear
 * of buildings. Worked out once, from the world.
 */
export function passingRoom(c: Course, world: CarWorld, p: CarParams): boolean[][] {
  return [-PASS.room, PASS.room].map((off) =>
    Array.from({ length: Math.ceil(c.length * 2) }, (_, k) => {
      const at = courseAt(c, k / 2);
      const heading = courseHeading(c, k / 2);
      const { x, y } = courseOffset(c, k / 2, off);
      const [h, h0] = [groundOn(world, x, y), groundOn(world, at.x, at.y)];
      return h !== null && h0 !== null && world.topSpeedAt(x, y, h) >= world.topSpeedAt(at.x, at.y, h0) && !world.obstacle({ x, y, heading, length: p.length, width: p.width, dir: 1 });
    }),
  );
}

/** How far from `d` (cells, up to `max`) a side of the course (`passingRoom`'s) has room to pass. */
export function roomFor(room: readonly boolean[], c: Course, d: number, max: number): number {
  for (let k = 0; k <= max * 2; k++) if (!room[Math.floor(((((d + k / 2) % c.length) + c.length) % c.length) * 2) % room.length]) return k / 2;
  return max;
}

/**
 * A bot's path to the side of the course's line, from `from` cells along:
 * from `start` cells across, eased to `lane` over `PASS.ramp` cells, along it
 * for `hold`, eased back to the line over `PASS.ramp`, then the line for
 * `rest` cells.
 */
export function sideLine(c: Course, from: number, lane: number, hold: number, rest: number, start = 0): Point[] {
  const ease = (u: number) => u * u * (3 - 2 * u);
  const back = from + PASS.ramp + hold;
  const end = back + PASS.ramp;
  const across = (d: number) => (d < from + PASS.ramp ? start + (lane - start) * ease((d - from) / PASS.ramp) : d < back ? lane : lane * (1 - ease((d - back) / PASS.ramp)));
  const out: Point[] = [];
  for (let d = from; d < end; d += 0.5) out.push(courseOffset(c, d, across(d)));
  return [...out, ...courseLine(c, end, rest)];
}

/** How far along the course a point is, near `near` cells along (a few cells either way, unwrapped round the loop as `near` is). */
export function courseDistance(c: Course, x: number, y: number, near: number): number {
  const base = Math.floor(near / c.length) * c.length;
  const m = near - base;
  let best = near;
  let bestGap = Infinity;
  // the window round `near`, and where it runs over either end of the loop
  for (const off of [-c.length, 0, c.length]) {
    const [s0, s1] = [Math.max(0, m + off - 4), Math.min(c.length, m + off + 4)];
    if (s0 >= s1) continue;
    const s = c.path.project(x, y, s0, s1);
    const p = c.path.at(s);
    const gap = Math.hypot(p.x - x, p.y - y);
    if (gap < bestGap) [best, bestGap] = [base + s - off, gap];
  }
  return best;
}

/** Where a point is from the course `d` cells along: how far ahead along it, and how far to its right (cells). */
export function courseRelative(c: Course, d: number, x: number, y: number): { along: number; across: number } {
  const p = courseAt(c, d);
  const h = courseHeading(c, d);
  const [dx, dy] = [x - p.x, y - p.y];
  return { along: dx * Math.cos(h) + dy * Math.sin(h), across: -dx * Math.sin(h) + dy * Math.cos(h) };
}

/** How far along the course a grid slot is (cells; behind the line, so negative). */
export const gridDistance = (slot: number) => -(GRID.first + slot * GRID.gap);

/** A grid slot (0 the pole): behind the line, facing along the course. */
export function gridSlot(c: Course, slot: number): { x: number; y: number; heading: number } {
  const d = gridDistance(slot);
  const p = courseAt(c, d);
  const heading = courseHeading(c, d);
  const side = (slot % 2 ? 1 : -1) * GRID.side;
  return { x: p.x - Math.sin(heading) * side, y: p.y + Math.cos(heading) * side, heading };
}

// ---------------------------------------------------------------- a racer

/** A page's input for a tick: the pedals and the wheel, and back to the last checkpoint (R). */
export interface RaceInput extends CarInput {
  reset: boolean;
}

/**
 * A car in the race, everything the page predicts of its own. Its clock is
 * its own steps (D-119): a tick each, counted from the start, the same on
 * the page as on the server however late its inputs arrive or however many
 * a tick the server steps after a stall.
 */
export interface Racer {
  car: CarState;
  /** Its own steps since the start (its race time is `steps × TICK`). */
  steps: number;
  /** Checkpoints passed, in order: the line first, then each round the lap. */
  cps: number;
  /** Its steps when it finished each lap. */
  laps: number[];
  /** On the grid until the start (or for the next race): inputs move nothing, the clock doesn't run. */
  held: boolean;
}

export const lapsDone = (r: Racer) => r.laps.length;
export const finished = (r: Racer) => r.laps.length >= RACE.laps;
/** The lap it is on (1 to `RACE.laps`). */
export const lapOf = (r: Racer) => Math.min(RACE.laps, r.laps.length + 1);
/** The next checkpoint it has to pass. */
export const nextCheckpoint = (c: Course, r: Racer) => c.checkpoints[r.cps % RACE.checkpoints]!;

/** The height to stand on at a place: the road's surface there, else the ground; null where nothing is loaded. */
export function groundOn(world: CarWorld, x: number, y: number): number | null {
  const ground = world.groundAt(x, y, -Infinity); // the drawn ground: no road surface or deck is that low
  return ground === null ? null : world.groundAt(x, y, ground);
}

/** Put a car at a place, stopped, facing `heading`, on the road there. */
export function placeCar(car: CarState, world: CarWorld, at: { x: number; y: number; heading: number }): void {
  Object.assign(car, { x: at.x, y: at.y, heading: at.heading, speed: 0, steer: 0 });
  car.h = groundOn(world, at.x, at.y) ?? car.h;
}

/** A racer on a grid slot, held for the start. */
export function gridRacer(c: Course, world: CarWorld, slot: number): Racer {
  const car: CarState = { x: 0, y: 0, h: 0, heading: 0, speed: 0, steer: 0 };
  placeCar(car, world, gridSlot(c, slot));
  return { car, steps: 0, cps: 0, laps: [], held: true };
}

/** Where a reset puts a car: the last checkpoint it passed (the line's run-up before any). */
export function resetPoint(c: Course, r: Racer): { x: number; y: number; heading: number; d: number } {
  const d = r.cps === 0 ? -GRID.first : c.checkpoints[(r.cps - 1) % RACE.checkpoints]!.d;
  return { ...courseAt(c, d), heading: courseHeading(c, d), d };
}

/**
 * One tick of a racer, the same on both sides: held, nothing; else its clock
 * runs (until it finishes), a reset puts it back at its last checkpoint, or
 * the car physics step it; then the next checkpoint, and a lap at the line.
 * Any −0 in the car's state is made 0 (JSON writes −0 as 0, as the dogfight
 * found). Returns the car's step (null when held or reset).
 */
export function raceTick(r: Racer, input: RaceInput, world: CarWorld, c: Course, p: CarParams): CarStep | null {
  if (r.held) return null;
  const done = finished(r);
  if (!done) r.steps++;
  let step: CarStep | null = null;
  if (input.reset) placeCar(r.car, world, resetPoint(c, r));
  else step = stepCar(r.car, input, world, p, TICK);
  for (const k in r.car) (r.car as unknown as Record<string, number>)[k]! += 0;
  if (done) return step;
  const next = nextCheckpoint(c, r);
  if (Math.hypot(r.car.x - next.x, r.car.y - next.y) <= RACE.reach) {
    r.cps++;
    // back at the line after a whole lap
    if (r.cps > 1 && (r.cps - 1) % RACE.checkpoints === 0) r.laps.push(r.steps);
  }
  return step;
}

/** How far a racer has got, to rank them: checkpoints passed, then nearness to the next. */
export function progress(c: Course, r: Racer): number {
  const next = nextCheckpoint(c, r);
  return r.cps * 1000 - Math.hypot(r.car.x - next.x, r.car.y - next.y);
}

/** The other cars as the car physics' traffic: oriented boxes it bumps into (`DriveWorld.obstacle`). */
export function contacts(cars: readonly { x: number; y: number; h: number; heading: number }[], p: CarParams): TrafficSource {
  const list = cars.map((o) => ({ id: 0, kind: "car" as const, variant: 0, part: 0, x: o.x, y: o.y, h: o.h, heading: o.heading, length: p.length, width: p.width }));
  return { vehiclesNear: (x, y, radius) => list.filter((v) => Math.hypot(v.x - x, v.y - y) <= radius + p.length) };
}

/**
 * Which cars were ghosts when (`CarNet.ghost`), recorded at each shared
 * snapshot's time on both sides: a bump is judged with the flags as of the
 * time the driver saw, as the page's own prediction used them, so a car
 * turning ghost (a bot passing, a page stalling, a finish) doesn't make the
 * page and the server disagree.
 */
export class Ghosts {
  private readonly flags = new Map<string, { t: number; ghost: boolean }[]>();

  /** @param keep Seconds kept. */
  constructor(private readonly keep = 2) {}

  record(id: string, t: number, ghost: boolean): void {
    let list = this.flags.get(id);
    if (!list) this.flags.set(id, (list = []));
    if (list.length && t <= list[list.length - 1]!.t) return; // late or repeated
    list.push({ t, ghost });
    while (list.length > 1 && t - list[0]!.t > this.keep) list.shift();
  }

  /** Whether a car was a ghost at `t`: the newest record at or before it (the oldest kept, before them all); `now` without any. */
  at(id: string, t: number, now = false): boolean {
    const list = this.flags.get(id);
    if (!list?.length) return now;
    let i = list.length - 1;
    while (i > 0 && list[i]!.t > t) i--;
    return list[i]!.ghost;
  }

  delete(id: string): void {
    this.flags.delete(id);
  }
}

/** Seconds as m:ss.s. */
export const raceClock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

// ---------------------------------------------------------------- messages (the page's are `TickMessage<RaceInput>`)

/** Who a page is: its name, and whether it only watches. */
export interface RaceJoin {
  name: string;
  watch: boolean;
}

/** waiting: no drivers; the countdown on the grid; the race; the results, then the next countdown. */
export type RacePhase = "waiting" | "countdown" | "racing" | "results";

/** A car in the shared snapshot: where it is, which life (a reset or the grid: drawn there at once), and how its race goes. */
export interface CarNet {
  id: string;
  name: string;
  x: number;
  y: number;
  h: number;
  hd: number;
  life: number;
  lap: number;
  /** Its race time so far, or its finishing time (s, its own steps). */
  time: number;
  /** Its place (1 first), or 0 when it isn't in this race (it joined during it). */
  place: number;
  done: boolean;
  /** The others drive through it: stalled, finished, waiting for the next race, or passing (a bot). */
  ghost?: boolean;
  passing?: boolean;
  bot?: boolean;
}

/** One line of the results: its time and best lap (s; null if it didn't finish). */
export interface Result {
  id: string;
  name: string;
  time: number | null;
  best: number | null;
  bot?: boolean;
}

/** The race in the shared snapshot: its phase and when that ends (server time; null: open-ended), the laps, and the last results. */
export interface RaceNet {
  phase: RacePhase;
  until: number | null;
  laps: number;
  results: Result[];
}

/** The shared snapshot: every car, and the race. */
export interface RaceWorldNet {
  cars: CarNet[];
  race: RaceNet;
}

/** A player's own snapshot: its racer after its last input stepped. */
export interface RaceSnap {
  you: Racer;
}

/** An event, at its server time: a page shows it when it shows that time of the others. */
export type RaceEvent = { kind: "phase"; phase: RacePhase } | { kind: "lap"; who: string; lap: number; time: number } | { kind: "finish"; who: string; place: number; time: number };

/** What the lobby lists of a room: the race's phase and the seconds it has left. */
export interface RaceInfo {
  phase: RacePhase;
  left: number | null;
}
