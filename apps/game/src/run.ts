import type { CarInput } from "./car";
import type { Game } from "./game";
import type { CarPilotOptions, Waypoint } from "./pilot";
import type { PlaneInput } from "./plane";
import { RoadGraph } from "./route";

/**
 * The scripted run (M4's exit criterion): Las Vegas → Hoover Dam → the
 * Grand Canyon by car, then a canyon flight, driven through the controllers'
 * public methods. With a fixed `dt` it steps the physics itself, as fast as
 * the machine allows (tests, timing the run); in real time it hands the
 * controllers their autopilots and lets the frame loop drive (`?run=1`, a
 * frame-time check on a real GPU).
 */

/** A sample of the car or the plane along the way. */
export interface Sample {
  t: number;
  x: number;
  y: number;
  h: number;
  /** What the vehicle stands on (car: the ground or a deck) or flies over (plane: ground or water). */
  ground: number | null;
  road: string | null;
  speed: number;
  blocked: string | null;
}

export interface LegReport {
  name: string;
  /** Seconds of play and cells covered. */
  seconds: number;
  cells: number;
  /** Of the cells, off the roads' asphalt (corners cut). */
  offRoadCells?: number;
  /** The planned road route: cells by class. */
  planned?: Record<string, number>;
  reached: boolean;
}

/** One stop of the run, by lon/lat. */
export interface RunStop {
  name: string;
  lon: number;
  lat: number;
}

/** The Southwest run's stops on the driving level, and the canyon flight's waypoints (lon/lat, heights over the ground). */
export const SOUTHWEST_RUN = {
  drive: [
    // over the bypass bridge beside the dam, onto US-93 in Arizona (the crest road isn't on the driving level)
    { name: "Hoover Dam", lon: -114.72938, lat: 36.00988 },
    // AZ-64 on the South Rim, by Mather Point
    { name: "the Grand Canyon (South Rim)", lon: -112.10586, lat: 36.05275 },
  ] as RunStop[],
  /** After the rim: back south down AZ-64's long straight to take off. */
  runway: { name: "AZ-64 south of the rim", lon: -112.12391, lat: 35.98856 },
  flight: [
    { lon: -112.1, lat: 36.12, agl: 2.5 }, // turning back north over the village, across the canyon
    { lon: -112.05, lat: 36.2, agl: 2.5 }, // the North Rim
    { lon: -111.95, lat: 36.16, agl: 2 }, // east along the canyon
    { lon: -111.85, lat: 36.075, agl: 2 }, // by Desert View (its watchtower stands tall enough to hit)
    { lon: -112.0, lat: 36.08, agl: 2 }, // back west down the canyon
    { lon: -112.19, lat: 35.45, agl: 2.5 }, // south to Williams
    { lon: -112.19, lat: 35.28, agl: 1.2, slow: true }, // the approach to I-40
    { lon: -112.19, lat: 35.25, agl: 0.8, slow: true }, // over I-40 at Williams: low and slow lands it
  ] as { lon: number; lat: number; agl: number; slow?: boolean }[],
  /** The flight is over the canyon, heading east along it, once past this waypoint. */
  canyonWaypoint: 2,
};

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Load the terrain around a place, so the queries answer there. */
async function ensureAround(game: Game, x: number, y: number, r: number): Promise<void> {
  await game.view.query.ensure(x - r, y - r, x + r, y + r);
}

/**
 * Step the car with a fixed dt for `seconds` of play (or until `until`), with
 * an input (default its own: the keys', or its path's), loading the terrain
 * ahead as it goes. Samples every `every` seconds.
 */
export async function driveFixed(
  game: Game,
  opts: { seconds: number; dt?: number; input?: Partial<CarInput>; until?: () => boolean; every?: number },
): Promise<Sample[]> {
  const car = game.car;
  if (!car) throw new Error("not driving");
  const dt = opts.dt ?? 1 / 30;
  const samples: Sample[] = [];
  let nextSample = 0;
  let nextEnsure = 0;
  const steps = Math.round(opts.seconds / dt);
  for (let i = 0; i < steps; i++) {
    const s = car.state;
    if (car.time >= nextEnsure) {
      nextEnsure = car.time + 0.25;
      await ensureAround(game, s.x + Math.cos(s.heading) * 6, s.y + Math.sin(s.heading) * 6, 12 + Math.abs(s.speed));
    }
    const input = opts.input ? car.inputFrom(opts.input) : car.input();
    const r = car.step(dt, input);
    if (car.time >= nextSample || r.blocked) {
      nextSample = car.time + (opts.every ?? 0.25);
      samples.push({
        t: car.time,
        x: s.x,
        y: s.y,
        h: s.h,
        ground: car.drive.groundAt(s.x, s.y, s.h),
        road: car.drive.roadClassAt(s.x, s.y, s.h),
        speed: s.speed,
        blocked: r.blocked,
      });
    }
    if (opts.until?.()) break;
    if (i % 60 === 59) await tick();
  }
  return samples;
}

/** Step the plane with a fixed dt (its own input, or a given one), loading the terrain ahead. */
export async function flyFixed(
  game: Game,
  opts: { seconds: number; dt?: number; input?: Partial<PlaneInput>; until?: () => boolean; every?: number },
): Promise<Sample[]> {
  const plane = game.plane;
  if (!plane) throw new Error("not flying");
  const dt = opts.dt ?? 1 / 30;
  const samples: Sample[] = [];
  let nextSample = 0;
  let nextEnsure = 0;
  const steps = Math.round(opts.seconds / dt);
  for (let i = 0; i < steps; i++) {
    if (game.plane !== plane || game.transition) break; // it landed
    const s = plane.state;
    if (plane.time >= nextEnsure) {
      nextEnsure = plane.time + 0.25;
      await ensureAround(game, s.x + Math.cos(s.heading) * 6, s.y + Math.sin(s.heading) * 6, 14 + s.speed);
    }
    const input = opts.input ? { pitch: 0, roll: 0, throttle: 0, ...opts.input } : plane.input();
    const r = plane.step(dt, input);
    if (plane.time >= nextSample || r.crashed) {
      nextSample = plane.time + (opts.every ?? 0.25);
      samples.push({ t: plane.time, x: s.x, y: s.y, h: s.h, ground: plane.fly.groundAt(s.x, s.y), road: null, speed: s.speed, blocked: r.crashed });
    }
    if (opts.until?.()) break;
    if (i % 60 === 59) await tick();
  }
  return samples;
}

/** Plan a road route for the car from where it is to a lon/lat, and set it on its way. */
export function routeTo(
  game: Game,
  to: { lon: number; lat: number },
  opts: CarPilotOptions = {},
): { cells: number; byClass: Record<string, number> } | null {
  const car = game.car;
  const routes = game.routes;
  if (!car || !routes) return null;
  const target = game.view.query.lonLatToCell(to.lon, to.lat);
  if (!target) return null;
  const plan = new RoadGraph(routes).plan({ x: car.state.x, y: car.state.y }, { x: target[0], y: target[1] });
  if (!plan) return null;
  car.drivePath(plan.points, opts);
  return { cells: plan.length, byClass: plan.byClass };
}

/** The flight's waypoints in the flying level's cells. */
export function flightWaypoints(game: Game, stops: typeof SOUTHWEST_RUN.flight): Waypoint[] {
  const out: Waypoint[] = [];
  const k = game.flyPace;
  for (const s of stops) {
    const c = game.view.query.lonLatToCell(s.lon, s.lat);
    if (c) out.push({ x: c[0], y: c[1], agl: s.agl, speed: s.slow ? 3.2 * k : undefined });
  }
  return out;
}

export interface RunReport {
  legs: LegReport[];
  /** Seconds of play: the drive, the take-off run, the flight. */
  driveSeconds: number;
  driveCells: number;
  flightSeconds: number;
  flightCells: number;
  landed: boolean;
  crashes: number;
  /** Wall-clock seconds and frame intervals (ms) seen while it ran. */
  wallSeconds: number;
  frames: ReturnType<Game["frames"]["summary"]>;
  /** Level changes and how long each took to show (ms). */
  changes: Game["changes"];
}

/**
 * Drive the run's legs, take off, fly the canyon and land. `dt` steps the
 * physics with a fixed step (as fast as it runs); without, it runs in real
 * time through the frame loop. `onLeg` hears each leg as it ends (a test
 * waits there for a screenshot).
 */
export async function scriptedRun(
  game: Game,
  opts: { dt?: number; onLeg?: (leg: LegReport) => Promise<void> | void; maxLegSeconds?: number } = {},
): Promise<RunReport> {
  const t0 = performance.now();
  game.frames.reset();
  const fixed = opts.dt !== undefined;
  game.pause(fixed);
  const legs: LegReport[] = [];
  const max = opts.maxLegSeconds ?? 600;

  const driveLeg = async (stop: RunStop, stopAtEnd: boolean, until?: () => boolean): Promise<LegReport> => {
    const car = game.car!;
    // the autopilot doesn't overtake and traffic doesn't yield: it drives through traffic
    car.collideTraffic = false;
    // a leg that leads on into the next one doesn't brake at its end
    const plan = routeTo(game, stop, { stop: stopAtEnd });
    const pilot = car.following;
    if (!plan || !pilot) return { name: stop.name, seconds: 0, cells: 0, reached: false };
    const t = car.time;
    const d = car.distance;
    const off = car.offRoad;
    const done = () => pilot.done || (until?.() ?? false) || car.following !== pilot;
    if (fixed) await driveFixed(game, { seconds: max, dt: opts.dt, until: done, every: 5 });
    else
      for (const t1 = performance.now(); !done() && performance.now() - t1 < max * 1000; ) await frame();
    const leg: LegReport = {
      name: stop.name,
      seconds: car.time - t,
      cells: car.distance - d,
      offRoadCells: car.offRoad - off,
      planned: plan.byClass,
      reached: pilot.done,
    };
    legs.push(leg);
    await opts.onLeg?.(leg);
    return leg;
  };

  const driveStart = game.car!.time;
  const driveCells0 = game.car!.distance;
  for (const stop of SOUTHWEST_RUN.drive) await driveLeg(stop, true);
  const car = game.car!;
  const driveSeconds = car.time - driveStart;
  const driveCells = car.distance - driveCells0;

  // the take-off run: back south down AZ-64's straight until fast enough, then up
  const takeoff = await driveLeg(SOUTHWEST_RUN.runway, false, () => car.canTakeOff);
  takeoff.name = "take-off run";
  if (!car.canTakeOff) throw new Error("the take-off run ended without a take-off");
  await game.takeOff();
  const plane = game.plane!;
  const pilot = plane.flyRoute(flightWaypoints(game, SOUTHWEST_RUN.flight))!;
  const ft = plane.time;
  const fd = plane.distance;
  const landed = () => game.mode === "car";
  const flyUntil = async (until: () => boolean) => {
    if (fixed) await flyFixed(game, { seconds: max, dt: opts.dt, until, every: 5 });
    else for (const t1 = performance.now(); !until() && performance.now() - t1 < max * 1000; ) await frame();
  };
  // over the canyon, past the North Rim, heading east along it
  await flyUntil(() => pilot.i >= SOUTHWEST_RUN.canyonWaypoint || landed() || !!game.transition);
  await opts.onLeg?.({ name: "over the canyon", seconds: plane.time - ft, cells: plane.distance - fd, reached: true });
  // on to Williams, where the last waypoint is over I-40: the pilot circles it low and slow until it lands
  await flyUntil(() => landed() || !!game.transition);
  while (game.transition) await frame();
  const flight: LegReport = { name: "canyon flight", seconds: plane.time - ft, cells: plane.distance - fd, reached: landed() };
  legs.push(flight);
  await opts.onLeg?.(flight);
  return {
    legs,
    driveSeconds,
    driveCells,
    flightSeconds: flight.seconds,
    flightCells: flight.cells,
    landed: landed(),
    crashes: plane.crashes,
    wallSeconds: (performance.now() - t0) / 1000,
    frames: game.frames.summary(),
    changes: game.changes,
  };
}
