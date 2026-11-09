/**
 * The benchmark page (bench.html): bakes a fixed set of tiles in each world
 * and level and times them, then times frames with and without traffic and
 * fog, and reads memory. Each case loads the app in an iframe with `bench=1`
 * (which keeps every tile's bake timings) and drives its debug API
 * (`window.__pixelworld`), as the e2e tests do. Without `bench=1` the app is
 * unchanged.
 *
 * Parameters: cases=sw-drive,sf-walk (default all), w=1280&h=720 (the canvas),
 * draws=20 (redraws per frame timing), sample=1500 (ms of animation frames
 * sampled), auto=1 (start on load; tools/bench.mjs uses it).
 */
import {
  BENCH_CASES,
  BENCH_ZOOMS,
  bakeSummary,
  reportText,
  summarize,
  type BenchCase,
  type BenchReport,
  type CaseResult,
  type FrameSample,
  type MemorySample,
  type TileBake,
  type ZoomResult,
} from "./benchReport";

type Api = NonNullable<Window["__pixelworld"]>;

/** The fields of the app's stats() the bench reads. */
interface AppStats {
  renderer: string;
  bakeMode: string;
  gpuTiles: number;
  gpuMB: number;
  chunksLoaded: number;
  renderMs: number;
  level: string | null;
  traffic: { enabled: boolean; simMs: number; baked: number } | null;
}

interface BenchState {
  status: string;
  report: BenchReport | null;
  error: string | null;
}

declare global {
  interface Window {
    __bench?: BenchState;
  }
}

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number) => {
  const v = Number(params.get(key));
  return params.has(key) && Number.isFinite(v) && v > 0 ? v : fallback;
};
const opt = {
  width: Math.round(num("w", 1280)),
  height: Math.round(num("h", 720)),
  draws: Math.round(num("draws", 20)),
  sampleMs: num("sample", 1500),
  /** Longest wait for a page or a complete frame (software rendering is slow). */
  timeoutMs: num("timeout", 900) * 1000,
};
const wanted = params.get("cases")?.split(",").filter(Boolean);
const cases = wanted ? BENCH_CASES.filter((c) => wanted.includes(c.id)) : BENCH_CASES;

const state: BenchState = { status: "idle", report: null, error: null };
window.__bench = state;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $<HTMLSpanElement>("status");
const textEl = $<HTMLPreElement>("text");
const jsonEl = $<HTMLTextAreaElement>("json");
const stage = $<HTMLDivElement>("stage");
const runButton = $<HTMLButtonElement>("run");

function setStatus(s: string) {
  state.status = s;
  statusEl.textContent = s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}: timed out`)), opt.timeoutMs)),
  ]);
}

/** Wait until the app in the frame is up (its debug API is set) or reports an error. */
async function appIn(frame: HTMLIFrameElement): Promise<Api> {
  const t0 = performance.now();
  while (performance.now() - t0 < opt.timeoutMs) {
    let win: Window | null;
    let hud: string;
    try {
      win = frame.contentWindow;
      if (win?.__pixelworld) return win.__pixelworld;
      hud = win?.document.getElementById("hud")?.textContent ?? "";
    } catch {
      // the browser's error page stands in for the app: it never loaded
      throw new Error("the app's page did not load (is the dev server still running?)");
    }
    if (hud.startsWith("error:") || hud.startsWith("bake error:")) throw new Error(hud);
    await sleep(100);
  }
  throw new Error("the app did not start");
}

/** Animation-frame intervals and main-thread time per frame, over `ms` of play. */
function sampleFrames(win: Window, api: Api, ms: number): Promise<{ intervals: number[]; cpu: number[] }> {
  return new Promise((resolve) => {
    const times: number[] = [];
    const cpu: number[] = [];
    const tick = (t: number) => {
      times.push(t);
      const s = api.stats() as unknown as AppStats;
      cpu.push(s.renderMs + (s.traffic?.enabled ? s.traffic.simMs : 0));
      if (t - times[0]! < ms) win.requestAnimationFrame(tick);
      else resolve({ intervals: times.slice(1).map((v, i) => v - times[i]!), cpu });
    };
    win.requestAnimationFrame(tick);
  });
}

async function frameSamples(win: Window, api: Api): Promise<FrameSample[]> {
  const hasTraffic = api.traffic() !== null;
  const hasFog = api.fog() !== null;
  const configs = [
    { traffic: false, fog: false },
    ...(hasTraffic ? [{ traffic: true, fog: false }] : []),
    ...(hasFog ? [{ traffic: false, fog: true }] : []),
    ...(hasTraffic && hasFog ? [{ traffic: true, fog: true }] : []),
  ];
  const out: FrameSample[] = [];
  for (const c of configs) {
    api.setTraffic({ enabled: c.traffic });
    api.setFog({ enabled: c.fog });
    await withTimeout(api.ready(), "frame");
    api.timeFrames(Math.max(2, Math.round(opt.draws / 4))); // warm up: first draws at a new size are slow
    const drawMs = api.timeFrames(opt.draws);
    const { intervals, cpu } = await sampleFrames(win, api, opt.sampleMs);
    const moving = c.traffic || c.fog; // with nothing moving the frame isn't redrawn
    out.push({
      traffic: c.traffic,
      fog: c.fog,
      drawMs,
      frame: summarize(intervals),
      cpuMs: moving ? (summarize(cpu)?.meanMs ?? NaN) : NaN,
      vehiclesDrawn: c.traffic ? (api.traffic()?.vehicles.length ?? null) : null,
      fogInView: c.fog ? (api.fog()?.drawn ?? null) : null,
    });
  }
  // back to the app's defaults (every layer on) for the next zoom
  api.setTraffic({ enabled: true });
  api.setFog({ enabled: true });
  return out;
}

function memory(win: Window, api: Api): MemorySample {
  const s = api.stats() as unknown as AppStats;
  const heap = (win.performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return {
    tilesMB: s.gpuMB,
    tilesOnGpu: s.gpuTiles,
    chunksLoaded: s.chunksLoaded,
    jsHeapMB: heap ? heap.usedJSHeapSize / (1024 * 1024) : null,
    trafficSprites: s.traffic?.baked ?? null,
  };
}

async function runCase(c: BenchCase, onRenderer: (r: string) => void): Promise<CaseResult> {
  const q = new URLSearchParams({
    world: c.world,
    at: `${c.lon},${c.lat}`,
    rot: String(c.rotation),
    zoom: String(BENCH_ZOOMS[0]),
    w: String(opt.width),
    h: String(opt.height),
    hud: "0",
    marker: "0",
    cache: "0", // every tile is baked, never read from the tile cache
    bench: "1",
    trafficTime: "120", // vehicles spread along their routes
  });
  const frame = document.createElement("iframe");
  frame.width = String(opt.width);
  frame.height = String(opt.height);
  frame.src = `./?${q}`;
  stage.replaceChildren(frame);
  const base: CaseResult = {
    id: c.id,
    label: c.label,
    world: c.world,
    level: null,
    packageHash: null,
    rotation: c.rotation,
    lon: c.lon,
    lat: c.lat,
    loadMs: NaN,
    bakeMode: "",
    zooms: [],
    bake: bakeSummary([]),
  };
  try {
    const t0 = performance.now();
    const api = await appIn(frame);
    const win = frame.contentWindow!;
    await withTimeout(api.ready(), "first frame");
    base.loadMs = performance.now() - t0;
    const s0 = api.stats() as unknown as AppStats;
    base.bakeMode = s0.bakeMode;
    base.level = s0.level;
    onRenderer(s0.renderer);
    const manifest = await (await fetch(new URL(`${c.world}manifest.json`, location.href))).json();
    base.packageHash = manifest.packageHash ?? null;
    let seen = 0;
    for (const zoom of BENCH_ZOOMS) {
      setStatus(`${c.label}: ${zoom}×`);
      const tz = performance.now();
      if (zoom !== BENCH_ZOOMS[0]) {
        api.setZoom(zoom);
        await withTimeout(api.ready(), `zoom ${zoom}`);
      }
      const readyMs = zoom === BENCH_ZOOMS[0] ? base.loadMs : performance.now() - tz;
      const bakes = api.tileBakes();
      const tiles = bakes.slice(seen);
      seen = bakes.length;
      const frames = await frameSamples(win, api);
      const z: ZoomResult = { zoom, readyMs, tiles, bake: bakeSummary(tiles, bakes[0] ?? null), frames, memory: memory(win, api) };
      base.zooms.push(z);
    }
    const all: TileBake[] = base.zooms.flatMap((z) => z.tiles);
    base.bake = bakeSummary(all, all[0] ?? null);
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
  } finally {
    stage.replaceChildren();
    await sleep(500); // let the frame's GPU contexts go before the next case
  }
  return base;
}

function show(report: BenchReport) {
  textEl.textContent = reportText(report);
  jsonEl.value = JSON.stringify(report, null, 1);
}

async function run() {
  runButton.disabled = true;
  state.report = null;
  state.error = null;
  const report: BenchReport = {
    version: 1,
    date: new Date().toISOString(),
    userAgent: navigator.userAgent,
    renderer: "unknown",
    canvas: [opt.width, opt.height],
    devicePixelRatio: window.devicePixelRatio,
    cores: navigator.hardwareConcurrency ?? null,
    cases: [],
  };
  try {
    for (const c of cases) {
      setStatus(`${c.label}: loading`);
      report.cases.push(await runCase(c, (r) => (report.renderer = r)));
      show(report);
    }
    setStatus(`done · ${report.cases.length} cases · ${report.renderer}`);
    state.report = report;
  } catch (e) {
    state.error = String(e);
    setStatus(`failed: ${state.error}`);
  } finally {
    runButton.disabled = false;
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    jsonEl.select();
    document.execCommand("copy");
  }
}

runButton.onclick = () => void run();
$<HTMLButtonElement>("copy-text").onclick = () => void copy(textEl.textContent ?? "");
$<HTMLButtonElement>("copy-json").onclick = () => void copy(jsonEl.value);
$<HTMLSpanElement>("cases").textContent = cases.map((c) => c.id).join(", ");
$<HTMLSpanElement>("canvas").textContent = `${opt.width}×${opt.height}`;
if (params.get("auto") === "1") void run();
