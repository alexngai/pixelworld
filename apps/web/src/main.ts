import { project, type Rotation } from "@pixelworld/grid";
import { BAKE_VERSION } from "@pixelworld/bake";
import { roverBoxes } from "@pixelworld/generators";
import {
  BakeService,
  Camera,
  ChunkStore,
  Compositor,
  TileCache,
  cellsScreenRect,
  hashString,
  loadManifest,
  loadObjects,
  tileKey,
  worldDepthRange,
  type GpuImage,
  type PreparedTile,
  type TileKey,
  type HeroPaint,
  type TileRequest,
} from "@pixelworld/runtime";
import { buildPalette, materialTables, validateStyle, type StylePack } from "@pixelworld/style";
import { GeoGrid, decodePng, verticalExaggeration, type WorldManifest } from "@pixelworld/world-format";
import styleJson from "../../../worlds/_styles/desert-southwest/style.json";

const TILE_SIZE = 32; // default bake tile edge (cells); manifest render.tileSize overrides
const MARGIN = 16; // context around a tile, in render units (cells at scale 1)
const MICRO_MARGIN = 8; // micro-terrain: shadows and AO reach a few cells; 16× the cells cost more
const PAN_SPEED = 220; // internal px / s
const DRIVE_SPEED = 3; // cells / s
// Steepest grade the rover can drive, in height steps per cell travelled. Gentle
// slopes (1 step per cell, up to 1.41 across a diagonal fold) are drivable;
// steep slope tiles and cliffs are not.
const MAX_GRADE = 2;
const PREFETCH_PX = 96; // bake tiles this far outside the view
const GPU_BUDGET_BYTES = 192 * 1024 * 1024; // baked tile textures kept on the GPU

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
  const fixedSize = params.has("w") && params.has("h");
  if (params.get("hud") === "0") {
    for (const el of [hud, help, attribution]) el.classList.add("hidden");
  }

  const worldUrl = params.get("world") ?? "/southwest/";
  const manifest = await loadManifest(worldUrl);
  const store = new ChunkStore(manifest, worldUrl);
  const worldBase = new URL(worldUrl, location.href);
  // Lon/lat of cell corners: carries the rover's place between scale levels (D-046).
  const geo = await GeoGrid.load(manifest, worldBase).catch((e: unknown) => {
    console.warn("geo grid:", e);
    return null;
  });
  const sourcesButton = document.createElement("button");
  sourcesButton.textContent = "Sources (I)";
  sourcesButton.onclick = () => sources.classList.toggle("hidden");
  const short = document.createElement("span");
  short.textContent = manifest.attribution.map((a) => a.name.split(" (")[0]).join(" · ") + " ";
  attribution.replaceChildren(short, sourcesButton);
  renderSources(manifest, sources);

  // Render scale: fine worlds draw each cell smaller (render units = cells × RS).
  const RS = manifest.render?.scale ?? 1;
  const tileSize = manifest.render?.tileSize ?? TILE_SIZE;
  const margin = manifest.micro ? MICRO_MARGIN : Math.ceil(MARGIN / RS);

  const objectsFile = params.get("objects") === "0" ? null : await loadObjects(worldUrl, manifest);
  // Micro-terrain: tops steeper than the style's rock slope are bare strata (D-036).
  const steepRockParams = () => {
    const slope = style.terrain?.steepRockSlope;
    const ids = new Map(Object.entries(manifest.surfaces).map(([id, name]) => [name, Number(id)]));
    if (!manifest.micro || !slope || !ids.has("rock")) return undefined;
    // rise over run in micro-steps per micro-cell = slope × metres per cell / metres per step
    const drop = Math.max(1, Math.round((slope * manifest.scale.metersPerCell) / manifest.scale.metersPerStep));
    return { drop, rockSurface: ids.get("rock")!, waterSurface: ids.get("water") ?? -1, snowSurface: ids.get("snow") ?? -1 };
  };
  const baseStyle = validateStyle(styleJson as unknown as StylePack);
  const style =
    objectsFile && baseStyle.objects?.surfaces
      ? validateStyle({ ...baseStyle, surfaces: { ...baseStyle.surfaces, ...baseStyle.objects.surfaces } })
      : baseStyle;
  const palette = buildPalette(style);
  let night = params.get("palette") === "night" && !!style.night;
  const { metersPerStep, elevationDatumMeters } = manifest.scale;
  // Strata are compared with render-unit heights in the shader.
  const tables = materialTables(
    style,
    palette,
    manifest,
    (m) => ((m - elevationDatumMeters) / metersPerStep) * RS,
    RS,
  );
  if (!manifest.heightRange) await store.ensureRect(0, 0, manifest.cellsX, manifest.cellsY);
  const [minH, maxH] =
    manifest.heightRange ?? store.slice(0, 0, manifest.cellsX, manifest.cellsY).grid.heightRange();
  const floor = minH - 2;

  const compositor = new Compositor(canvas);
  const applyPalette = () => compositor.setPalette(night ? buildPalette(style, "night").rgba : palette.rgba);
  applyPalette();

  const styleHash = hashString(JSON.stringify(styleJson));
  const cache = params.get("cache") === "0" ? null : await TileCache.open();
  const cacheKey = (t: TileRequest) =>
    [
      manifest.id,
      manifest.packageHash ?? "nohash",
      styleHash,
      BAKE_VERSION,
      objectsFile ? "objects" : "terrain",
      tileKey(t.rotation, t.tx, t.ty),
    ].join("|");

  const prepare = async (t: TileRequest): Promise<PreparedTile> => {
    if (cache) {
      const hit = await cache.get(cacheKey(t));
      if (hit) return { cached: hit };
    }
    const x0 = Math.max(0, t.tx * tileSize - margin);
    const y0 = Math.max(0, t.ty * tileSize - margin);
    const x1 = Math.min(manifest.cellsX, (t.tx + 1) * tileSize + margin);
    const y1 = Math.min(manifest.cellsY, (t.ty + 1) * tileSize + margin);
    await store.ensureRect(x0, y0, x1, y1);
    const s = store.slice(x0, y0, x1, y1);
    return {
      slice: {
        x0: s.x0,
        y0: s.y0,
        width: s.grid.width,
        height: s.grid.height,
        layers: s.grid.layers(),
        micro: s.grid.micro,
      },
    };
  };

  // Painted-over hero landmarks (M3, D-053): stamped into every tile bake.
  const heroes: HeroPaint[] = [];
  if (manifest.heroes?.length && params.get("paint") !== "0") {
    const png = async (path: string) => decodePng(await (await fetch(new URL(path, worldBase))).arrayBuffer());
    for (const h of manifest.heroes) {
      const [bake, paint] = await Promise.all([png(h.bake), png(h.paint)]);
      heroes.push({ ...h, bake: bake.data, paint: paint.data });
    }
  }

  const service = await BakeService.create(
    {
      type: "init",
      style: {
        tables,
        aoStrength: style.ao.strength,
        outlineThreshold: style.outline.depthThreshold,
        renderScale: RS,
        steepRock: steepRockParams(),
      },
      tileSize,
      margin,
      floor,
      worldWidth: manifest.cellsX,
      worldHeight: manifest.cellsY,
      renderScale: RS,
      heroes,
      objects:
        objectsFile && style.assets
          ? {
              instances: objectsFile.instances,
              catalog: style.assets,
              rampIds: [...palette.rampIds],
              metersPerCell: manifest.scale.metersPerCell,
              // a scale level may draw objects with other proportions (D-047)
              heightStretch: manifest.depiction?.heightStretch ?? style.objects?.heightStretch ?? 1,
              variants: style.objects?.variants ?? 6,
              // decorative vegetation and rocks by surface, where the level asks (M3)
              scatter:
                manifest.depiction?.scatter && params.get("scatter") !== "0"
                  ? {
                      density: manifest.depiction.scatter,
                      bySurface: Object.fromEntries(
                        Object.entries(manifest.surfaces).map(([id, name]) => [Number(id), style.scatter?.[name] ?? []]),
                      ),
                    }
                  : undefined,
            }
          : undefined,
    },
    prepare,
  );

  // Tile height ranges (for screen-rect estimates before baking), from the manifest.
  const tilesX = Math.ceil(manifest.cellsX / tileSize);
  const tilesY = Math.ceil(manifest.cellsY / tileSize);
  const tileHeights: [number, number][] = [];
  for (let ty = 0; ty < tilesY; ty++)
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = tx * tileSize;
      const y0 = ty * tileSize;
      const [lo, hi] = store.heightRangeFor(x0, y0, x0 + tileSize, y0 + tileSize);
      const edge = tx === 0 || ty === 0 || tx === tilesX - 1 || ty === tilesY - 1;
      tileHeights.push([edge ? floor : lo, hi]);
    }

  // Baked tiles on the GPU, evicted least-recently-drawn beyond a memory budget.
  interface TileEntry {
    img: GpuImage | null;
    bytes: number;
    lastDrawn: number;
  }
  const tiles = new Map<TileKey, TileEntry>();
  let gpuBytes = 0;
  let frameNo = 0;
  service.onTile = (res) => {
    if (res.image) {
      const img = compositor.upload(res.image);
      const bytes = res.image.width * res.image.height * 4;
      gpuBytes += bytes;
      tiles.set(res.key, { img, bytes, lastDrawn: frameNo });
      if (!res.fromCache && cache) void cache.put(cacheKey(res), res.image);
    } else {
      tiles.set(res.key, { img: null, bytes: 0, lastDrawn: frameNo });
    }
    dirty = true;
  };
  service.onError = (m) => {
    console.error(m);
    hud.textContent = `bake error: ${m}`;
  };
  function evict() {
    if (gpuBytes <= GPU_BUDGET_BYTES) return;
    const old = [...tiles.entries()]
      .filter(([, e]) => e.img && e.lastDrawn < frameNo)
      .sort((a, b) => a[1].lastDrawn - b[1].lastDrawn);
    for (const [key, e] of old) {
      if (gpuBytes <= GPU_BUDGET_BYTES * 0.8) break;
      compositor.release(e.img!);
      gpuBytes -= e.bytes;
      tiles.delete(key);
      service.forget(key);
    }
  }

  const sprites = new Map<Rotation, GpuImage | null>();
  const roverRamp = palette.rampIds.get("marker")!;
  const cabRamp = palette.rampIds.get("coconino")!;
  const requestSprite = (r: Rotation) => {
    if (sprites.has(r)) return;
    sprites.set(r, null);
    void service.bakeSprite(r, roverBoxes(roverRamp, cabRamp)).then((img) => {
      if (img) sprites.set(r, compositor.upload(img));
      dirty = true;
    });
  };

  // Rover: start from the URL, the manifest's start cell, or the world centre.
  const start = manifest.start ?? {
    x: Math.floor(manifest.cellsX / 2),
    y: Math.floor(manifest.cellsY / 2),
  };
  const rover = { x: start.x + 0.5, y: start.y + 0.5, h: 0 };
  const roverParam = params.get("rover");
  // at=lon,lat: arriving from another scale level; outside this level's area
  // the rover starts at the world's start instead
  let arrival = "";
  const atParam = params.get("at");
  if (roverParam) {
    const [rx, ry] = roverParam.split(",").map(Number);
    rover.x = rx ?? rover.x;
    rover.y = ry ?? rover.y;
  } else if (atParam && geo) {
    const [lon, lat] = atParam.split(",").map(Number);
    const cell = geo.lonLatToCell(lon!, lat!);
    if (cell) [rover.x, rover.y] = cell;
    else arrival = " · that place is outside this level, so starting here";
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
    if (geo) {
      const [lon, lat] = geo.cellToLonLat(rover.x, rover.y);
      next.set("at", `${lon.toFixed(6)},${lat.toFixed(6)}`);
    }
    location.search = next.toString();
  }
  const ensureAt = (x: number, y: number) =>
    store.ensureRect(Math.floor(x), Math.floor(y), Math.floor(x) + 1, Math.floor(y) + 1);
  await ensureAt(rover.x, rover.y);
  rover.h = store.surfaceHeightAt(rover.x, rover.y) ?? 0;

  const camera = new Camera(1, 1);
  camera.rotation = (num("rot", 0) & 3) as Rotation;
  let follow = !(params.has("fx") || params.has("fy"));
  // The camera works in render units; fx/fy in the URL are world cells.
  const focusX = num("fx", rover.x);
  const focusY = num("fy", rover.y);
  if (!follow) await ensureAt(focusX, focusY);
  camera.fx = focusX * RS;
  camera.fy = focusY * RS;
  camera.fh = (follow ? rover.h : (store.surfaceHeightAt(focusX, focusY) ?? rover.h)) * RS;
  let noclip = false;
  let zoomFromParams = params.has("zoom");

  let dirty = true;
  function resize() {
    const dpr = fixedSize ? 1 : window.devicePixelRatio || 1;
    const w = fixedSize ? num("w", 640) : Math.round(window.innerWidth * dpr);
    const h = fixedSize ? num("h", 360) : Math.round(window.innerHeight * dpr);
    canvas.width = w;
    canvas.height = h;
    if (fixedSize) {
      canvas.classList.add("fixed");
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    camera.canvasWidth = w;
    camera.canvasHeight = h;
    if (zoomFromParams) camera.zoom = Math.max(1, Math.round(num("zoom", 3)));
    else camera.zoom = Math.max(1, Math.round(w / 640));
    dirty = true;
  }
  resize();
  window.addEventListener("resize", resize);

  const depthRange = worldDepthRange(manifest.cellsX * RS, manifest.cellsY * RS, floor * RS, maxH * RS);

  // ---- input ----
  const keys = new Set<string>();
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    keys.add(k);
    if (k === "q") camera.rotate(-1);
    else if (k === "e") camera.rotate(1);
    else if (k === "f") follow = !follow;
    else if (k === "n") noclip = !noclip;
    else if (k === "t" && style.night) {
      night = !night;
      applyPalette();
    }
    else if (k === "h") [hud, help].forEach((el) => el.classList.toggle("hidden"));
    else if (k === "i") sources.classList.toggle("hidden");
    else if (k === "l") switchLevel();
    else if (k === "escape") sources.classList.add("hidden");
    else if (k >= "1" && k <= "6") {
      camera.zoom = Number(k);
      zoomFromParams = true;
    }
    if (k.startsWith("arrow")) e.preventDefault();
    dirty = true;
  });
  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener("blur", () => keys.clear());
  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const scale = (fixedSize ? 1 : window.devicePixelRatio || 1) / camera.zoom;
    camera.panPixels(-(e.clientX - drag.x) * scale, -(e.clientY - drag.y) * scale);
    drag = { x: e.clientX, y: e.clientY };
    follow = false;
    dirty = true;
  });
  canvas.addEventListener("pointerup", () => (drag = null));

  function update(dt: number) {
    let px = 0;
    let py = 0;
    if (keys.has("a")) px -= 1;
    if (keys.has("d")) px += 1;
    if (keys.has("w")) py -= 1;
    if (keys.has("s")) py += 1;
    if (px || py) {
      const len = Math.hypot(px, py);
      camera.panPixels((px / len) * PAN_SPEED * dt, (py / len) * PAN_SPEED * dt);
      follow = false;
      dirty = true;
    }
    let mx = 0;
    let my = 0;
    if (keys.has("arrowleft")) mx -= 2;
    if (keys.has("arrowright")) mx += 2;
    if (keys.has("arrowup")) my -= 1;
    if (keys.has("arrowdown")) my += 1;
    if (mx || my) {
      const [gx, gy] = camera.screenDirToGrid(mx, my);
      const step = (DRIVE_SPEED * dt) / RS; // same on-screen speed at any render scale
      const tryMove = (nx: number, ny: number) => {
        if (nx < 0.3 || ny < 0.3 || nx > manifest.cellsX - 0.3 || ny > manifest.cellsY - 0.3)
          return false;
        const nh = store.surfaceHeightAt(nx, ny);
        if (nh === null) return false; // terrain not loaded yet
        const dist = Math.hypot(nx - rover.x, ny - rover.y);
        const tooSteep = Math.abs(nh - rover.h) > MAX_GRADE * dist + 0.01;
        if (!noclip && (store.isWater(nx, ny) || tooSteep)) return false;
        rover.x = nx;
        rover.y = ny;
        rover.h = nh;
        return true;
      };
      // slide along obstacles by trying each axis separately
      if (!tryMove(rover.x + gx * step, rover.y + gy * step)) {
        if (!tryMove(rover.x + gx * step, rover.y)) tryMove(rover.x, rover.y + gy * step);
      }
      if (!follow && !keys.has("w") && !keys.has("a") && !keys.has("s") && !keys.has("d"))
        follow = true;
      dirty = true;
    }
    if (follow) {
      camera.fx = rover.x * RS;
      camera.fy = rover.y * RS;
      camera.fh = rover.h * RS;
    }
  }

  // ---- frame ----
  let frames = 0;
  let fps = 0;
  let fpsT = performance.now();
  let lastT = performance.now();
  let renderedComplete = false;
  const readyResolvers: (() => void)[] = [];

  function tilesInView(snap: ReturnType<Camera["snapped"]>) {
    const r = camera.rotation;
    const viewL = snap.left;
    const viewT = snap.top;
    const viewR = snap.left + camera.internalWidth;
    const viewB = snap.top + camera.internalHeight;
    const cx = (viewL + viewR) / 2;
    const cy = (viewT + viewB) / 2;
    const list: (TileRequest & { visible: boolean; dist: number })[] = [];
    for (let ty = 0; ty < tilesY; ty++)
      for (let tx = 0; tx < tilesX; tx++) {
        const [lo, hi] = tileHeights[ty * tilesX + tx]!;
        const rect = cellsScreenRect(
          tx * tileSize * RS,
          ty * tileSize * RS,
          Math.min(manifest.cellsX, (tx + 1) * tileSize) * RS,
          Math.min(manifest.cellsY, (ty + 1) * tileSize) * RS,
          lo * RS,
          hi * RS + (objectsFile ? 12 : 0), // tall objects rise up to ~96 px above the terrain
          r,
        );
        const near =
          rect.right >= viewL - PREFETCH_PX &&
          rect.left <= viewR + PREFETCH_PX &&
          rect.bottom >= viewT - PREFETCH_PX &&
          rect.top <= viewB + PREFETCH_PX;
        if (!near) continue;
        const visible =
          rect.right >= viewL && rect.left <= viewR && rect.bottom >= viewT && rect.top <= viewB;
        const dist = Math.hypot((rect.left + rect.right) / 2 - cx, (rect.top + rect.bottom) / 2 - cy);
        list.push({ rotation: r, tx, ty, visible, dist });
      }
    list.sort((a, b) => Number(b.visible) - Number(a.visible) || a.dist - b.dist);
    return list;
  }

  function frame(now: number) {
    frameNo++;
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    update(dt);
    requestSprite(camera.rotation);

    const snap = camera.snapped();
    const order = tilesInView(snap);
    service.want(order);

    const r = camera.rotation;
    const drawTiles: GpuImage[] = [];
    let complete = true;
    for (const t of order) {
      const entry = tiles.get(tileKey(r, t.tx, t.ty));
      if (entry) {
        entry.lastDrawn = frameNo;
        if (entry.img) drawTiles.push(entry.img);
      } else if (t.visible) complete = false;
    }
    const sprite = sprites.get(r);
    if (!sprite) complete = false;

    if (dirty) {
      const p = project(rover.x * RS, rover.y * RS, rover.h * RS, r);
      compositor.render(
        {
          left: snap.left,
          top: snap.top,
          fracX: snap.fracX,
          fracY: snap.fracY,
          zoom: camera.zoom,
          internalWidth: camera.internalWidth,
          internalHeight: camera.internalHeight,
          depthRange,
        },
        drawTiles,
        sprite
          ? [{ sprite, sx: Math.round(p.sx), sy: Math.round(p.sy), depth: p.depth, silhouette: true }]
          : [],
      );
      dirty = !complete; // keep redrawing while tiles stream in
      renderedComplete = complete;
      if (complete && service.idle) readyResolvers.splice(0).forEach((f) => f());
    }
    evict();

    frames++;
    if (now - fpsT > 500) {
      fps = (frames * 1000) / (now - fpsT);
      frames = 0;
      fpsT = now;
      updateHud();
    }
    requestAnimationFrame(frame);
  }

  function stats() {
    const t = service.totals;
    return {
      renderer: service.renderer,
      bakeMode: service.mode,
      tilesBaked: t.tiles,
      tilesFromCache: t.fromCache,
      tilesPerRotation: tilesX * tilesY,
      chunksLoaded: store.loadedCount,
      chunksTotal: manifest.chunks.length,
      gpuTiles: [...tiles.values()].filter((e) => e.img).length,
      gpuMB: gpuBytes / (1024 * 1024),
      avgMeshMs: t.tiles ? t.meshMs / t.tiles : 0,
      avgBakeMs: t.tiles ? t.bakeMs / t.tiles : 0,
      maxTileMs: t.maxTileMs,
      fps,
      rotation: camera.rotation,
      rover: { x: rover.x, y: rover.y, h: rover.h },
      cache: cache ? "indexeddb" : "off",
      metersPerCell: store.metersPerCellAt(rover.x, rover.y),
      level: manifest.level ?? null,
      renderScale: RS,
      objects: objectsFile?.instances.length ?? 0,
      palette: night ? "night" : "day",
      cacheWrites: cache?.writes ?? 0,
    };
  }

  function updateHud() {
    const s = stats();
    // real elevation: undo the vertical caricature of warped worlds
    const meters = Math.round(store.realHeightAt(rover.x, rover.y, rover.h) * metersPerStep + elevationDatumMeters);
    const local = manifest.warp ? ` · here ${Math.round(store.metersPerCellAt(rover.x, rover.y))} m/cell (warped)` : "";
    const ve = verticalExaggeration(manifest.scale).toFixed(2);
    const ll = geo ? geo.cellToLonLat(rover.x, rover.y) : null;
    const where = ll ? ` · ${ll[1].toFixed(4)}°, ${ll[0].toFixed(4)}°` : "";
    hud.textContent = [
      `${manifest.name} · ${manifest.scale.metersPerCell} m/cell${RS !== 1 ? ` drawn at ×${RS}` : ""}${local} · vertical ×${ve} (${metersPerStep.toFixed(1)} m/step)`,
      `      ${s.objects} objects · ${s.palette} palette${style.night ? " (T toggles)" : ""}`,
      ...(levels.length > 1
        ? [`level ${levels.map((l) => (l.name === manifest.level ? `[${l.label ?? l.name}]` : (l.label ?? l.name))).join(" · ")} (L switches)${arrival}`]
        : []),
      `view  rot ${camera.rotation} · zoom ${camera.zoom}× · ${camera.internalWidth}×${camera.internalHeight} internal`,
      `rover cell ${Math.floor(rover.x)},${Math.floor(rover.y)}${where} · ${rover.h.toFixed(1)} steps (${meters} m)${noclip ? " · no-clip" : ""}${follow ? " · follow" : ""}`,
      `world ${s.chunksLoaded}/${s.chunksTotal} chunks · ${s.gpuTiles} tiles on GPU (${s.gpuMB.toFixed(0)} MB)`,
      `bake  ${s.tilesBaked} baked + ${s.tilesFromCache} cached · mesh ${s.avgMeshMs.toFixed(0)} ms + bake ${s.avgBakeMs.toFixed(0)} ms avg · max ${s.maxTileMs.toFixed(0)} ms`,
      `      ${s.bakeMode} · ${s.renderer}`,
      `fps   ${fps.toFixed(0)}`,
    ].join("\n");
  }

  window.__pixelworld = {
    ready: () =>
      renderedComplete && service.idle
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            dirty = true;
            readyResolvers.push(resolve);
          }),
    stats,
    pan: (dx, dy) => {
      camera.panPixels(dx, dy);
      follow = false;
      renderedComplete = false;
      dirty = true;
    },
    setRover: (x, y) => {
      rover.x = x;
      rover.y = y;
      rover.h = store.surfaceHeightAt(x, y) ?? rover.h;
      renderedComplete = false;
      dirty = true;
    },
    lonLat: () => (geo ? geo.cellToLonLat(rover.x, rover.y) : null),
    switchLevel,
    bakeHero: async (id) => {
      // the landmark and its parts (a dam's intake towers)
      const insts = objectsFile?.instances.filter((o) => o.id === id) ?? [];
      if (!insts.length) throw new Error(`no landmark ${id} in this world`);
      // a slice around it, so it stands on the same terrain heights as in the world
      const pts = insts.flatMap((o) => o.fp ?? [[o.x, o.y] as [number, number]]);
      const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[0]))) - 2);
      const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1]))) - 2);
      const x1 = Math.min(manifest.cellsX, Math.ceil(Math.max(...pts.map((p) => p[0]))) + 3);
      const y1 = Math.min(manifest.cellsY, Math.ceil(Math.max(...pts.map((p) => p[1]))) + 3);
      await store.ensureRect(x0, y0, x1, y1);
      const s = store.slice(x0, y0, x1, y1);
      const slice = { x0: s.x0, y0: s.y0, width: s.grid.width, height: s.grid.height, layers: s.grid.layers(), micro: s.grid.micro };
      const out = [];
      for (const r of [0, 1, 2, 3] as const) {
        const img = await service.bakeObjects(r, insts, slice);
        out.push(img ? { rotation: r, ...img, pixels: Array.from(img.pixels) } : null);
      }
      return out;
    },
    palette: () => Array.from(palette.rgba),
  };

  requestAnimationFrame(frame);
}

main().catch((e: unknown) => {
  console.error(e);
  const hud = document.getElementById("hud");
  if (hud) hud.textContent = `error: ${String(e)}`;
});
