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
};

/**
 * The grid behind the line, staggered single file (the roads are a quarter
 * cell wide, and cars side by side close on the line and lock): the pole
 * this far back (cells), each next one this far behind, this far either side
 * of the line in turn.
 */
export const GRID = { first: 1.5, gap: 0.9, side: 0.1 };

/** Bots: their names, and the share of each road's top speed they keep to (beatable). */
export const BOTS = [
  { id: "bot1", name: "Bot Ace", pace: 0.9 },
  { id: "bot2", name: "Bot Blue", pace: 0.85 },
  { id: "bot3", name: "Bot Cobalt", pace: 0.8 },
];

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

/** The course's line from `from` cells along, for `length` cells, round the loop as often as it takes: a path for a bot. */
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
  /** The others drive through it: stalled, finished, or waiting for the next race. */
  ghost?: boolean;
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
