import {
  createWorldView,
  fogLayer,
  roverController,
  type RoverOptions,
  type TileBake,
} from "@pixelworlds/engine";
import { TRAFFIC_SUBLAYERS, trafficLayer, type DrawnVehicle, type TrafficSublayer } from "@pixelworlds/sim";
import { stylePack } from "./styles";
import { verticalExaggeration, type WorldManifest } from "@pixelworlds/world-format";
import { inspectOnAltClick, inspector, type Inspection } from "./inspect";
import { viewerPlugins } from "./plugins";

/**
 * The reference viewer (`@pixelworlds/viewer`), a client of the engine: the
 * URL parameters, the HUD, the layer panel, the sources screen and help,
 * level switching, and the `__pixelworld` debug API the e2e tests, the bench
 * page and the hero tool drive. The world view, its layers and the rover
 * controller come from `@pixelworlds/engine` and `@pixelworlds/sim`.
 */

// Every style pack in the repo, by id (styles.ts); a world names its pack in the manifest (`style`).

/** Test/debug hooks (used by the Playwright suite in e2e/). */
interface PixelworldDebug {
  ready: () => Promise<void>;
  stats: () => Record<string, unknown>;
  pan: (dx: number, dy: number) => void;
  setRover: (x: number, y: number) => void;
  /** Lon/lat under the rover (worlds with a geo grid), else null. */
  lonLat: () => [number, number] | null;
  /** Reload at the same place in another scale level (the next one if no name). */
  switchLevel: (name?: string) => void;
  /** Bake a landmark alone in all four rotations (the offline hero tool, D-053). */
  bakeHero: (
    id: string,
  ) => Promise<({ rotation: number; left: number; top: number; width: number; height: number; depthBase: number; pixels: number[] } | null)[]>;
  /** The day palette, RGBA per index. */
  palette: () => number[];
  /** Ambient traffic (D-060): what is drawn now, null without routes. */
  traffic: () => {
    enabled: boolean;
    paused: boolean;
    ticks: number;
    time: number;
    counts: Record<string, number>;
    layers: TrafficSublayer[];
    vehicles: DrawnVehicle[];
  } | null;
  /** Run the traffic simulation forward by whole ticks (seconds of play). */
  trafficStep: (seconds: number) => void;
  setTraffic: (opts: { enabled?: boolean; paused?: boolean; layers?: TrafficSublayer[] }) => void;
  /** Centre the camera on a cell at a height (steps; default the surface there). */
  lookAt: (x: number, y: number, h?: number) => Promise<void>;
  /** Fog (an atmosphere layer): its state, null where the world has none. */
  fog: () => { enabled: boolean; paused: boolean; time: number; drawn: boolean } | null;
  /** Switch fog, pause its drift or set its clock (seconds of play). */
  setFog: (opts: { enabled?: boolean; paused?: boolean; time?: number }) => void;
  /** Draw the current frame n times, waiting for the GPU each time: mean milliseconds per frame. */
  timeFrames: (n: number) => number;
  /** Set the zoom (integer upscale of the baked tiles), as the 1–6 keys do. */
  setZoom: (zoom: number) => void;
  /** Every tile baked so far, with its timings: only with bench=1 (apps/web/bench.html), else empty. */
  tileBakes: () => TileBake[];
  /** What is under a canvas point (CSS px): ramp and shade, ground, placed object, generator, landmark (Alt+click logs it). */
  inspect: (x: number, y: number) => Inspection;
}
declare global {
  interface Window {
    __pixelworld?: PixelworldDebug;
  }
}

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number) => {
  const v = params.get(key);
  return v === null || v === "" || Number.isNaN(Number(v)) ? fallback : Number(v);
};
/** A number parameter, or undefined when it is absent or not a number. */
const maybeNum = (key: string) => {
  const v = num(key, NaN);
  return Number.isNaN(v) ? undefined : v;
};

/** The key that toggles each layer (the help line and the layer panel name it). */
const LAYER_KEYS: Record<string, string> = { traffic: "V", fog: "G" };

function renderSources(manifest: WorldManifest, el: HTMLElement): void {
  el.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = `Data sources · ${manifest.name}`;
  el.append(h);
  const list = document.createElement("ul");
  for (const a of manifest.attribution) {
    const li = document.createElement("li");
    const name = document.createElement(a.url ? "a" : "span");
    name.textContent = a.name;
    if (a.url && name instanceof HTMLAnchorElement) {
      name.href = a.url;
      name.target = "_blank";
      name.rel = "noopener";
    }
    const lic = document.createElement("span");
    lic.className = "license";
    lic.textContent = ` — ${a.license}`;
    li.append(name, lic);
    list.append(li);
  }
  el.append(list);
  const note = document.createElement("p");
  note.className = "muted";
  note.textContent =
    "World data derived from OpenStreetMap is available under the ODbL. " +
    `Package ${manifest.packageHash?.slice(0, 12) ?? "(unhashed)"} · press I or Esc to close.`;
  el.append(note);
}

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const hud = document.getElementById("hud")!;
  const help = document.getElementById("help")!;
  const attribution = document.getElementById("attribution")!;
  const sources = document.getElementById("sources")!;
  const layersEl = document.getElementById("layers")!;
  const showHud = params.get("hud") !== "0";
  if (!showHud) for (const el of [hud, help, attribution]) el.classList.add("hidden");

  // w and h: a fixed canvas (tests, the bench), one canvas pixel per CSS pixel
  let size: { width: number; height: number } | undefined;
  if (params.has("w") && params.has("h")) {
    size = { width: num("w", 640), height: num("h", 360) };
    canvas.classList.add("fixed");
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
  }

  // The rover: from the URL (rover=x,y), a place arriving from another scale level
  // (at=lon,lat; outside this level the rover starts at the world's start), or the start.
  const roverParam = params.get("rover");
  const atParam = params.get("at");
  let start: RoverOptions["start"];
  let at: [number, number] | null = null;
  if (roverParam) {
    const [x, y] = roverParam.split(",").map(Number);
    start = { x, y };
  } else if (atParam) {
    const [lon, lat] = atParam.split(",").map(Number);
    at = [lon!, lat!];
    start = { lon: lon!, lat: lat! };
  }
  // fx/fy: the camera looks there instead of following the rover
  const follow = !(params.has("fx") || params.has("fy"));
  const rover = roverController({ start, follow, visible: params.get("marker") !== "0" }); // marker=0: clean screenshots

  // Ambient traffic (D-060): on where the package has routes, unless traffic=0;
  // trafficTime, trafficPause, trafficSeed and trafficDensity fix a scene for tests.
  const only = params.get("trafficLayers"); // the sublayers shown, e.g. road,rail (default all)
  const traffic =
    params.get("traffic") === "0"
      ? null
      : trafficLayer({
          seed: num("trafficSeed", 1),
          density: num("trafficDensity", 1),
          paused: params.get("trafficPause") === "1",
          time: num("trafficTime", 0),
          sublayers: only === null ? undefined : (only.split(",").filter((l) => (TRAFFIC_SUBLAYERS as string[]).includes(l)) as TrafficSublayer[]),
        });
  // Fog (an atmosphere layer): where the style has fog over this world and level; fog=0 starts it off
  const fog = fogLayer({ enabled: params.get("fog") !== "0", time: num("fogTime", 0), paused: params.get("fogPause") === "1" });

  const worldUrl = params.get("world") ?? "/southwest/";
  const worldBase = new URL(worldUrl, location.href);
  const view = await createWorldView({
    canvas,
    worldUrl,
    // ?style=<id> draws the world with another pack, merged with its parents first
    style: params.has("style") ? await stylePack(params.get("style")!) : stylePack,
    size,
    cache: params.get("cache") !== "0",
    groundFirst: params.get("ground") !== "0", // ground=0: no ground-only bake before a tile's own
    startTiles: params.get("startTiles") !== "0", // the world's start-tiles.bin, where prebake.mjs built one
    objects: params.get("objects") !== "0",
    scatter: params.get("scatter") !== "0",
    heroes: params.get("paint") !== "0",
    palette: params.get("palette") === "night" ? "night" : "day",
    camera: {
      rotation: num("rot", 0) & 3,
      zoom: params.has("zoom") ? num("zoom", 3) : "auto",
      x: maybeNum("fx"),
      y: maybeNum("fy"),
    },
    layers: [...(traffic ? [traffic] : []), fog],
    controller: rover,
    // the city packs the world's style pack names, from the viewer's list (src/plugins.ts);
    // plugins=0 loads none, to see a style's models fail as markers (e2e, D-072)
    plugins: (names) => (params.get("plugins") === "0" ? [] : viewerPlugins(names)),
    // bench=1 (the benchmark page, apps/web/bench.html): every baked tile's timings, for its report
    recordBakes: params.get("bench") === "1",
    onError: (m) => {
      console.error(m);
      hud.textContent = `bake error: ${m}`;
    },
  });
  const manifest = view.world.manifest;
  const trafficOn = traffic && view.layers.get(traffic.id) ? traffic : null;
  const fogOn = view.layers.get(fog.id) ? fog : null;
  const arrival =
    at && view.world.hasGeo && !view.query.lonLatToCell(at[0], at[1]) ? " · that place is outside this level, so starting here" : "";

  // attribution, and the sources screen (I)
  const sourcesButton = document.createElement("button");
  sourcesButton.textContent = "Sources (I)";
  sourcesButton.onclick = () => sources.classList.toggle("hidden");
  const short = document.createElement("span");
  short.textContent = manifest.attribution.map((a) => a.name.split(" (")[0]).join(" · ") + " ";
  attribution.replaceChildren(short, sourcesButton);
  renderSources(manifest, sources);

  // the layer panel (top right): every layer of the view and its sublayers
  const boxes = new Map<string, HTMLInputElement>();
  const syncLayers = () => {
    for (const layer of view.layers.list()) {
      boxes.get(layer.id)!.checked = layer.enabled;
      for (const s of layer.sublayers ?? []) {
        const box = boxes.get(`${layer.id}/${s.id}`)!;
        box.checked = layer.isSublayerEnabled?.(s.id) ?? true;
        box.disabled = !layer.enabled;
      }
    }
  };
  const toggle = (key: string, label: string, sub: boolean, onChange: (on: boolean) => void) => {
    const row = document.createElement("label");
    if (sub) row.className = "sub";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.onchange = () => {
      onChange(box.checked);
      syncLayers();
    };
    row.append(box, ` ${label}`);
    layersEl.append(row);
    boxes.set(key, box);
  };
  for (const layer of view.layers.list()) {
    const k = LAYER_KEYS[layer.id];
    toggle(layer.id, k ? `${layer.label} (${k})` : layer.label, false, (on) => view.layers.enable(layer.id, on));
    for (const s of layer.sublayers ?? [])
      toggle(`${layer.id}/${s.id}`, s.label, true, (on) => view.layers.enable(layer.id, on, s.id));
  }
  const hasLayers = view.layers.list().length > 0;
  if (hasLayers) {
    syncLayers();
    if (showHud) layersEl.classList.remove("hidden");
  }

  const levels = manifest.levels ?? [];
  function switchLevel(name?: string) {
    if (levels.length < 2) return;
    const here = levels.findIndex((l) => l.name === manifest.level);
    const target = name ? levels.find((l) => l.name === name) : levels[(here + 1) % levels.length];
    if (!target || target.name === manifest.level) return;
    const next = new URLSearchParams(location.search);
    next.set("world", new URL(`../${target.world}/`, worldBase).pathname);
    for (const key of ["rover", "fx", "fy", "at"]) next.delete(key);
    const ll = view.query.cellToLonLat(rover.rover.x, rover.rover.y);
    if (ll) next.set("at", `${ll[0].toFixed(6)},${ll[1].toFixed(6)}`);
    location.search = next.toString();
  }

  // ---- input: the viewer's keys here, the rest to the rover controller ----
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === "t" && view.hasNight) view.palette = view.palette === "night" ? "day" : "night";
    else if (k === "h") [hud, help, ...(hasLayers ? [layersEl] : [])].forEach((el) => el.classList.toggle("hidden"));
    else if (k === "i") sources.classList.toggle("hidden");
    else if (k === "l") switchLevel();
    else if (k === "escape") sources.classList.add("hidden");
    else {
      const layer = view.layers.list().find((l) => LAYER_KEYS[l.id]?.toLowerCase() === k);
      if (layer) {
        view.layers.enable(layer.id, !layer.enabled);
        syncLayers();
      }
    }
    rover.keyDown(e);
  });
  window.addEventListener("keyup", (e) => rover.keyUp(e));
  window.addEventListener("blur", () => rover.blur());
  canvas.addEventListener("pointerdown", (e) => rover.pointerDown(e));
  canvas.addEventListener("pointermove", (e) => rover.pointerMove(e));
  canvas.addEventListener("pointerup", () => rover.pointerUp());

  function stats() {
    const s = view.stats();
    const r = rover.rover;
    return {
      renderer: s.renderer,
      bakeMode: s.bakeMode,
      tilesBaked: s.tilesBaked,
      tilesFromCache: s.tilesFromCache,
      tilesPerRotation: s.tilesPerRotation,
      chunksLoaded: s.chunksLoaded,
      chunksTotal: s.chunksTotal,
      gpuTiles: s.gpuTiles,
      gpuMB: s.gpuMB,
      avgMeshMs: s.avgMeshMs,
      avgBakeMs: s.avgBakeMs,
      maxTileMs: s.maxTileMs,
      fps: s.fps,
      rotation: view.camera.rotation,
      rover: { x: r.x, y: r.y, h: r.h },
      cache: s.cache,
      metersPerCell: view.query.metersPerCellAt(r.x, r.y),
      level: manifest.level ?? null,
      renderScale: view.world.renderScale,
      objects: view.world.objectCount,
      palette: view.palette,
      cacheWrites: s.cacheWrites,
      modelsFailed: s.modelsFailed,
      // CPU time of the last drawn frame: compositor submission and screen passes (traffic's are below)
      renderMs: s.renderMs,
      traffic: trafficOn
        ? {
            enabled: trafficOn.enabled,
            vehicles: trafficOn.sim.vehicles.length,
            sprites: trafficOn.drawn.length,
            simMs: trafficOn.simMs,
            drawMs: trafficOn.drawMs,
            baked: trafficOn.spriteCount,
          }
        : null,
      fog: fogOn ? { enabled: fogOn.enabled, drawn: fogOn.drawn, time: fogOn.time } : null,
    };
  }

  const RS = view.world.renderScale;
  const { metersPerStep } = manifest.scale;
  const style = view.world.style;
  function updateHud() {
    const s = stats();
    const r = rover.rover;
    // real elevation: undo the vertical caricature of warped worlds
    const meters = Math.round(view.query.elevationAt(r.x, r.y, r.h) ?? 0);
    const local = manifest.warp ? ` · here ${Math.round(view.query.metersPerCellAt(r.x, r.y))} m/cell (warped)` : "";
    const ve = verticalExaggeration(manifest.scale).toFixed(2);
    const ll = view.query.cellToLonLat(r.x, r.y);
    const where = ll ? ` · ${ll[1].toFixed(4)}°, ${ll[0].toFixed(4)}°` : "";
    hud.textContent = [
      `${manifest.name} · ${manifest.scale.metersPerCell} m/cell${RS !== 1 ? ` drawn at ×${RS}` : ""}${local} · vertical ×${ve} (${metersPerStep.toFixed(1)} m/step)`,
      `      ${s.objects} objects · ${s.palette} palette${style.night ? " (T toggles)" : ""}`,
      ...(levels.length > 1
        ? [`level ${levels.map((l) => (l.name === manifest.level ? `[${l.label ?? l.name}]` : (l.label ?? l.name))).join(" · ")} (L switches)${arrival}`]
        : []),
      `view  rot ${view.camera.rotation} · zoom ${view.camera.zoom}× · ${view.camera.internalWidth}×${view.camera.internalHeight} internal`,
      `rover cell ${Math.floor(r.x)},${Math.floor(r.y)}${where} · ${r.h.toFixed(1)} steps (${meters} m)${rover.noclip ? " · no-clip" : ""}${rover.follow ? " · follow" : ""}`,
      `world ${s.chunksLoaded}/${s.chunksTotal} chunks · ${s.gpuTiles} tiles on GPU (${s.gpuMB.toFixed(0)} MB)`,
      `bake  ${s.tilesBaked} baked + ${s.tilesFromCache} cached · mesh ${s.avgMeshMs.toFixed(0)} ms + bake ${s.avgBakeMs.toFixed(0)} ms avg · max ${s.maxTileMs.toFixed(0)} ms${s.modelsFailed ? ` · ${s.modelsFailed} models failed (markers; see the console)` : ""}`,
      `      ${s.bakeMode} · ${s.renderer}`,
      ...(s.traffic
        ? [
            `traffic ${s.traffic.enabled ? `${s.traffic.vehicles} vehicles` : "off"} (V toggles) · sim ${s.traffic.simMs.toFixed(1)} ms · draw ${(s.traffic.drawMs + s.renderMs).toFixed(1)} ms`,
          ]
        : []),
      ...(s.fog
        ? [`fog   ${s.fog.enabled ? (s.fog.drawn ? "on" : "on, none in view") : "off"} (G toggles) · frame ${s.renderMs.toFixed(1)} ms`]
        : []),
      `fps   ${s.fps.toFixed(0)}`,
    ].join("\n");
  }
  let hudT = performance.now();
  view.onFrame(({ now }) => {
    if (now - hudT <= 500) return;
    hudT = now;
    updateHud();
  });

  const inspect = inspector(view);
  inspectOnAltClick(canvas, inspect);
  window.__pixelworld = {
    ready: () => view.ready(),
    stats,
    pan: (dx, dy) => {
      rover.follow = false;
      view.camera.pan(dx, dy);
    },
    setRover: (x, y) => {
      rover.place(x, y);
      view.invalidate();
    },
    lonLat: () => view.query.cellToLonLat(rover.rover.x, rover.rover.y),
    switchLevel,
    bakeHero: async (id) =>
      (await view.bakeObject(id)).map((img) => (img ? { ...img, pixels: Array.from(img.pixels) } : null)),
    palette: () => Array.from(view.world.palette.rgba),
    traffic: () =>
      trafficOn
        ? {
            enabled: trafficOn.enabled,
            paused: trafficOn.paused,
            ticks: trafficOn.sim.ticks,
            time: trafficOn.sim.time,
            counts: trafficOn.sim.counts(),
            layers: [...trafficOn.shown],
            vehicles: trafficOn.drawn,
          }
        : null,
    trafficStep: (seconds) => trafficOn?.step(seconds),
    setTraffic: ({ enabled, paused, layers }) => {
      if (!trafficOn) return;
      if (enabled !== undefined) view.layers.enable(trafficOn.id, enabled);
      if (paused !== undefined) trafficOn.setPaused(paused);
      if (layers) trafficOn.setSublayers(layers);
      syncLayers();
      view.invalidate();
    },
    lookAt: async (x, y, h) => {
      rover.follow = false;
      await view.camera.lookAt(h === undefined ? { x, y } : { x, y, h });
    },
    fog: () => (fogOn ? { enabled: fogOn.enabled, paused: fogOn.paused, time: fogOn.time, drawn: fogOn.drawn } : null),
    setFog: ({ enabled, paused, time }) => {
      if (!fogOn) return;
      if (enabled !== undefined) view.layers.enable(fogOn.id, enabled);
      fogOn.set({ paused, time });
      syncLayers();
      view.invalidate();
    },
    timeFrames: (n) => view.timeFrames(n),
    setZoom: (zoom) => {
      view.camera.zoom = zoom;
      view.invalidate();
    },
    tileBakes: () => view.tileBakes(),
    inspect,
  };
}

main().catch((e: unknown) => {
  console.error(e);
  const hud = document.getElementById("hud");
  if (hud) hud.textContent = `error: ${String(e)}`;
  hud?.classList.add("error"); // wrapped: a style pack's problems run to several long lines
});
