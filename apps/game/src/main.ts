import type { CarInput } from "./car";
import { Game } from "./game";
import { blocksCar } from "./ground";
import type { PlaneInput } from "./plane";
import { roadUnder } from "./roads";
import { driveFixed, flyFixed, routeTo, scriptedRun, type RunReport, type Sample } from "./run";

/**
 * pixelworld's example game (M4): drive and fly a world package, built only
 * on the public API of `@pixelworld/engine` and `@pixelworld/sim` and the
 * style packs.
 *
 * URL parameters: `world` (a package, default the Southwest's driving level),
 * `start=lon,lat`, `traffic=0`, `trafficSeed`, `trafficPause=1`, `fog=0`,
 * `cache=0`, `w`/`h` (a fixed canvas), `zoom`, `rot`, `hud=0`, `run=1` (the
 * scripted run in real time, then its frame times).
 */

// Every style pack in the repo, by id; a world names its pack in the manifest.
const STYLE_PACKS = import.meta.glob("../../../worlds/_styles/*/style.json", { eager: true, import: "default" }) as Record<string, object>;
function stylePack(id: string): object {
  const json = STYLE_PACKS[`../../../worlds/_styles/${id}/style.json`];
  if (!json) throw new Error(`no style pack ${id}`);
  return json;
}

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
  land(force?: boolean): Promise<boolean>;
  place(x: number, y: number, heading?: number): void;
  /** A building near a place whose footprint isn't over a road: its anchor and bounds. */
  findBuilding(x: number, y: number, radius: number): { x: number; y: number; bounds: [number, number, number, number]; group: string } | null;
  heightAt(x: number, y: number): number | null;
  roadAt(x: number, y: number): string | null;
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
    style: (id) => stylePack(params.get("style") ?? id),
    traffic: {
      enabled: params.get("traffic") !== "0",
      seed: num("trafficSeed", 1),
      paused: params.get("trafficPause") === "1",
      density: num("trafficDensity", 1),
    },
    fog: params.get("fog") !== "0",
    cache: params.get("cache") !== "0",
    size,
    zoom: params.has("zoom") ? num("zoom", 2) : "auto",
    rotation: num("rot", 0) & 3,
    hud: params.get("hud") === "0" ? null : ui,
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
    land: (force) => game.land(force),
    place: (x, y, heading) => {
      if (game.mode === "car") game.car?.place(x, y, heading);
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
