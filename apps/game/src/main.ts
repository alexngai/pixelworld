import type { PluginDescriptor } from "@pixelworlds/engine";
import { cityPlugin as newYork } from "@pixelworlds/city-nyc";
import { cityPlugin as paris } from "@pixelworlds/city-paris";
import { cityPlugin } from "@pixelworlds/city-sf";
import { StyleError, parseStyleJson, resolveStyleExtends, suggest } from "@pixelworlds/style";
import type { CarInput } from "./car";
import { Game } from "./game";
import { blocksCar } from "./ground";
import type { PlaneInput } from "./plane";
import { nearestRoad, roadUnder } from "./roads";
import { driveFixed, flyFixed, routeTo, scriptedRun, type RunReport, type Sample } from "./run";

/**
 * pixelworld's example game (M4): drive and fly a world package, built only
 * on the public API of `@pixelworlds/engine` and `@pixelworlds/sim`, the
 * style packs and the city packs (San Francisco's, New York's, Paris's).
 *
 * URL parameters: `world` (a package, default the Southwest's driving level),
 * `start=lon,lat`, `fly=1` (start in the air), `traffic=0`, `trafficSeed`, `trafficPause=1`, `fog=0`,
 * `cache=0`, `startTiles=0` (bake the first view too), `workers` (bake workers), `ground=0` (no ground while tiles bake), `w`/`h` (a fixed canvas), `zoom`, `rot`, `hud=0`, `run=1` (the
 * scripted run in real time, then its frame times).
 */

// Every style pack in the repo, by id; a world names its pack in the manifest. Read as
// text only when a world needs it and parsed here (D-075), so a broken pack fails only
// the worlds that use it, with its file, line and column.
const STYLE_FILES = import.meta.glob<string>("../../../worlds/_styles/*/style.json", { query: "?raw", import: "default" });
const STYLE_IDS = Object.keys(STYLE_FILES).map((path) => path.split("/").at(-2)!);
async function stylePack(id: string): Promise<object> {
  const file = STYLE_FILES[`../../../worlds/_styles/${id}/style.json`];
  if (!file) throw new StyleError(`no style pack "${id}"${suggest(id, STYLE_IDS)}; there are ${STYLE_IDS.join(", ")} (worlds/_styles/)`, { pack: id });
  return parseStyleJson(await file(), `worlds/_styles/${id}/style.json`) as object;
}

// The city packs the game can load, by name (D-071); a world's style pack names the ones it needs.
const PLUGINS: Record<string, PluginDescriptor> = { [cityPlugin.name]: cityPlugin, [newYork.name]: newYork, [paris.name]: paris };

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number) => {
  const v = params.get(key);
  return v === null || v === "" || Number.isNaN(Number(v)) ? fallback : Number(v);
};

/** The debug and test API (e2e/game.spec.ts drives the game through it). */
export interface GameDebug {
  game: Game;
  ready(): Promise<void>;
  state(): ReturnType<Game["info"]>;
  /** Scripts step the controllers (`drive`, `fly`) instead of the frame loop. */
  pause(on: boolean): void;
  drive(input: Partial<CarInput> | null, seconds: number, dt?: number): Promise<Sample[]>;
  fly(input: Partial<PlaneInput> | null, seconds: number, dt?: number): Promise<Sample[]>;
  /** Plan a road route to a lon/lat and drive it with a fixed dt; returns its samples. */
  driveTo(lon: number, lat: number, opts?: { dt?: number; maxSeconds?: number; stop?: boolean }): Promise<{ planned: number; byClass: Record<string, number>; samples: Sample[]; reached: boolean }>;
  takeOff(force?: boolean): Promise<boolean>;
  /** Another map ("drive", "walk", "fly") here, in the same vehicle (Tab, the map buttons). */
  switchMap(name: string): Promise<boolean>;
  /** The other vehicle (or this one) here, on the same map (C, the vehicle buttons). */
  switchVehicle(mode?: "car" | "plane"): Promise<boolean>;
  /** Back to safety (R). */
  reset(): void;
  land(force?: boolean): Promise<boolean>;
  /** Fly a landing approach to the nearest road within a radius (cells) of the plane: the cell, or null without one. */
  approachRoad(radius: number): { x: number; y: number } | null;
  /**
   * Put the vehicle at a place (cells) facing `heading`: the car stopped on the
   * ground (or a deck near `h`), the plane at height `h` (default 2 steps up), level, at cruise.
   */
  place(x: number, y: number, heading?: number, h?: number): Promise<void>;
  /** A building near a place whose footprint isn't over a road: its anchor and bounds. */
  findBuilding(x: number, y: number, radius: number): { x: number; y: number; bounds: [number, number, number, number]; group: string } | null;
  heightAt(x: number, y: number): number | null;
  roadAt(x: number, y: number): string | null;
  /** The groups of the placed objects standing at a point. */
  objectsAt(x: number, y: number): string[];
  run(dt?: number): Promise<RunReport>;
  frames(): ReturnType<Game["frames"]["summary"]>;
  resetFrames(): void;
  timeFrames(n: number): number;
  stats(): ReturnType<Game["view"]["stats"]>;
}

declare global {
  interface Window {
    __game?: GameDebug;
  }
}

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const ui = document.getElementById("ui")!;
  let size: { width: number; height: number } | undefined;
  if (params.has("w") && params.has("h")) {
    size = { width: num("w", 640), height: num("h", 360) };
    canvas.classList.add("fixed");
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
  }
  const startParam = params.get("start");
  const [slon, slat] = startParam ? startParam.split(",").map(Number) : [NaN, NaN];
  const game = await Game.create({
    canvas,
    worldUrl: params.get("world") ?? "/southwest/",
    start: Number.isFinite(slon) && Number.isFinite(slat) ? { lon: slon!, lat: slat! } : null,
    // ?style= replaces the world's pack, with its own `extends` merged in here
    style: params.has("style") ? ((await resolveStyleExtends(await stylePack(params.get("style")!), stylePack)) as object) : stylePack,
    plugins: (names) => names.flatMap((name) => PLUGINS[name] ?? []),
    traffic: {
      enabled: params.get("traffic") !== "0",
      seed: num("trafficSeed", 1),
      paused: params.get("trafficPause") === "1",
      density: num("trafficDensity", 1),
    },
    fog: params.get("fog") !== "0",
    cache: params.get("cache") !== "0",
    startTiles: params.get("startTiles") !== "0",
    bakeWorkers: params.has("workers") ? num("workers", 0) : undefined,
    groundFirst: params.get("ground") !== "0",
    size,
    zoom: params.has("zoom") ? num("zoom", 2) : "auto",
    rotation: num("rot", 0) & 3,
    hud: params.get("hud") === "0" ? null : ui,
    fly: params.get("fly") === "1",
  });

  window.addEventListener("keydown", (e) => game.keyDown(e));
  window.addEventListener("keyup", (e) => game.keyUp(e));
  window.addEventListener("blur", () => game.blur());

  window.__game = {
    game,
    ready: async () => {
      await game.view.ready();
      game.refreshHud();
    },
    state: () => game.info(),
    pause: (on) => game.pause(on),
    drive: (input, seconds, dt) => driveFixed(game, { seconds, dt, input: input ?? undefined }),
    fly: (input, seconds, dt) => flyFixed(game, { seconds, dt, input: input ?? undefined }),
    driveTo: async (lon, lat, opts = {}) => {
      const plan = routeTo(game, { lon, lat }, { stop: opts.stop });
      if (!plan) return { planned: 0, byClass: {}, samples: [], reached: false };
      const car = game.car!;
      const pilot = car.following!;
      const samples = await driveFixed(game, { seconds: opts.maxSeconds ?? 300, dt: opts.dt, until: () => pilot.done || car.following !== pilot });
      return { planned: plan.cells, byClass: plan.byClass, samples, reached: pilot.done };
    },
    takeOff: (force) => game.takeOff(force),
    switchMap: (name) => game.switchMap(name),
    switchVehicle: (mode) => game.switchVehicle(mode),
    reset: () => game.reset(),
    land: (force) => game.land(force),
    approachRoad: (radius) => {
      const p = game.plane?.state;
      const road = p ? nearestRoad(game.view.query, p.x, p.y, radius) : null;
      if (!road || !game.approach(road.x, road.y)) return null;
      return { x: road.x, y: road.y };
    },
    place: async (x, y, heading, h) => {
      await game.view.query.ensure(x - 4, y - 4, x + 4, y + 4); // the terrain there, for its heights
      if (game.mode === "car") game.car?.place(x, y, heading, h);
      else game.plane?.place(x, y, heading, h);
    },
    findBuilding: (x, y, radius) => {
      const q = game.view.query;
      let best: ReturnType<GameDebug["findBuilding"]> = null;
      let bestD = Infinity;
      for (let j = -radius; j <= radius; j += 0.5)
        for (let i = -radius; i <= radius; i += 0.5) {
          const px = x + i;
          const py = y + j;
          const d = Math.hypot(i, j);
          if (d >= bestD) continue;
          const hit = q.objectsAt(px, py).find((o) => blocksCar(o) && o.footprint);
          if (!hit || roadUnder(q, px, py, 0.3)) continue;
          best = { x: px, y: py, bounds: hit.bounds, group: hit.group };
          bestD = d;
        }
      return best;
    },
    heightAt: (x, y) => game.view.query.heightAt(x, y),
    objectsAt: (x, y) => game.view.query.objectsAt(x, y).map((o) => o.group),
    roadAt: (x, y) => game.view.query.roadAt(x, y)?.class ?? null,
    run: (dt) =>
      scriptedRun(game, {
        dt,
        // a test or a screenshot script may listen for each leg's end: the view is ready by then
        onLeg: async (leg) => {
          const hook = (window as unknown as { __onLeg?: (name: string) => Promise<void> }).__onLeg;
          if (!hook) return;
          await game.view.ready();
          game.refreshHud();
          await hook(leg.name);
        },
      }),
    frames: () => game.frames.summary(),
    resetFrames: () => game.frames.reset(),
    timeFrames: (n) => game.view.timeFrames(n),
    stats: () => game.view.stats(),
  };

  // paused=1: the vehicles wait for a script (tests, screenshots)
  if (params.get("paused") === "1") game.pause(true);
  game.hud?.say(`${game.mode === "car" ? "Drive" : "Fly"} · H for keys`, 4);
  if (params.get("run") === "1" && game.manifest.id.startsWith("southwest")) {
    const report = await scriptedRun(game);
    const f = report.frames;
    const text =
      `Run: drive ${report.driveSeconds.toFixed(0)} s (${report.driveCells.toFixed(0)} cells), ` +
      `flight ${report.flightSeconds.toFixed(0)} s · frames p50 ${f.p50.toFixed(1)} ms, p95 ${f.p95.toFixed(1)} ms, max ${f.max.toFixed(0)} ms, ${f.over20} over 20 ms of ${f.frames}`;
    console.log(text, report);
    game.hud?.say(text, 3600);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  const ui = document.getElementById("ui");
  if (ui) ui.textContent = `error: ${String(e)}`;
});
