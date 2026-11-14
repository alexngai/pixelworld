import type { BakedImage } from "@pixelworlds/bake";
import { footprintBounds, generateModel, modelBoxes, resolveAsset, type Box } from "@pixelworlds/generators";
import { project, type Rotation } from "@pixelworlds/grid";
import {
  BakeService,
  Camera,
  Compositor,
  StartTiles,
  TileCache,
  revealRect,
  tileKey,
  worldDepthRange,
  type FogField,
  type FogFrame,
  type GpuImage,
  type PreparedTile,
  type SpriteInstance,
  type TileKey,
  type TileRequest,
} from "@pixelworlds/runtime";
import { buildPalette } from "@pixelworlds/style";
import { ViewCameraImpl } from "./camera";
import { GameClock } from "./clock";
import { Controllers } from "./controller";
import { EditLog, TileEdits } from "./edits";
import { Entities } from "./entities";
import { Layers } from "./layers";
import { checkGenerators, pluginsKey, registerOnMainThread, viewPlugins } from "./plugins";
import { BakedTiles, CameraMotion, Prefetches, TileGrid, bakeOrder, shiftView, type PrefetchArea, type TileInView } from "./tiles";
import type {
  ControllerHost,
  EntityList,
  FrameEvent,
  FrameInfo,
  LayerContext,
  LayerRegistry,
  TileBake,
  TileStore,
  ViewCamera,
  ViewState,
  ViewStats,
  WorldEdits,
  WorldInfo,
  WorldQuery,
  WorldView,
  WorldViewOptions,
} from "./types";
import {
  bakeInit,
  chunkStats,
  loadHeroes,
  loadWorld,
  objectTiles,
  openTileCache,
  tileCacheKey,
  tileSlice,
  worldInfo,
  worldQuery,
  type LoadedWorld,
} from "./world";

const GPU_BUDGET_BYTES = 192 * 1024 * 1024; // baked tile textures kept on the GPU
/** Object voxel size in render units (objectVoxelScale at render scale 1, D-010). */
const VOXEL = { h: 1 / 16, v: 1 / 8 };

/** Seconds of the camera's motion to bake ahead of, by default (`lookAhead`). */
const LOOK_AHEAD_S = 1.5;
/** Look-ahead horizons, in `lookAhead`s: what the view shows that far on, nearest first (bakeOrder drops repeats). */
const AHEAD_STEPS = [1, 2, 4];
/** Cells around the focus whose tiles are baked while nothing else waits (`idleBake`). */
const IDLE_RADIUS = 96;
/** Slower than this (cells per second) the camera counts as still, for baking while idle. */
const IDLE_SPEED = 0.25;

/** Baked tiles on the GPU, evicted least-recently-drawn beyond a memory budget. */
interface TileEntry {
  img: GpuImage | null;
  bytes: number;
  lastDrawn: number;
  rotation: Rotation;
  tx: number;
  ty: number;
  /** A bare variant (buildings left out), for a reveal. */
  bare?: boolean;
  /** The ground alone, drawn until the whole tile is baked. */
  ground?: boolean;
}

/** Bake workers by default: the cores less one for the page, at most 4 (each keeps its own copy of the world's objects). */
const defaultBakeWorkers = (): number => Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1));

/** Screen px around a reveal whose bare tiles are baked ahead of it moving there. */
const REVEAL_AHEAD_PX = 32;

type ScreenBox = { left: number; top: number; right: number; bottom: number };

const withSlash = (u: URL): URL => (u.pathname.endsWith("/") ? u : new URL(u.pathname + "/" + u.search, u));

const overlaps = (img: BakedImage, b: ScreenBox): boolean =>
  img.left < b.right && img.left + img.width > b.left && img.top < b.bottom && img.top + img.height > b.top;

/**
 * A world view (docs/library.md §3.2): streams a world package around the
 * camera, bakes and caches its tiles, and composites them with layers and
 * entities in a frame loop that redraws only when something changed.
 */
export async function createWorldView(opts: WorldViewOptions): Promise<WorldView> {
  const w = await loadWorld(opts);
  // plugins with generators (D-071): registered here, and in the bake worker before its first bake
  const plugins = viewPlugins(opts.plugins, w.styleJson, w.style.id);
  const mainThread = registerOnMainThread(plugins).then(() => checkGenerators(w.style, w.styleJson, plugins));
  mainThread.catch(() => {}); // awaited below
  const compositor = new Compositor(opts.canvas);
  const cache = await openTileCache(opts.cache);
  // the first view's tiles baked ahead, read before the cache (tools/prebake.mjs)
  const start = !opts.startTiles
    ? Promise.resolve(null)
    : StartTiles.load(opts.startTiles === true ? new URL("start-tiles.bin", withSlash(w.base)) : opts.startTiles);
  const keyed = cache !== null || !!opts.startTiles;
  const heroes = opts.heroes === false ? [] : await loadHeroes(w);
  // keyed by the package, style, bake code and the plugins' code, once they are registered here (D-072)
  const cacheKeyReady = mainThread.then(async () => tileCacheKey(w, keyed ? await pluginsKey(plugins.descriptors) : []));
  cacheKeyReady.catch(() => {}); // awaited below
  // objects taken out at runtime (D-124): each tile's bake leaves out those it reaches, and is kept under them
  const edits = new EditLog(w.objects?.instances.length ?? 0);
  const tileEdits = new TileEdits((i) => objectTiles(w, i));
  const prepare = async (t: TileRequest): Promise<PreparedTile> => {
    const removed = tileEdits.removedFor(t.tx, t.ty);
    if (keyed) {
      // a ground request is answered with the whole tile where that is kept
      const key = (await cacheKeyReady)(t.ground ? { rotation: t.rotation, tx: t.tx, ty: t.ty } : t, removed);
      const hit = (await (await start)?.get(key)) ?? (await cache?.get(key));
      if (hit) return { cached: hit, ...(t.ground ? { whole: true } : {}), removed };
    }
    return { slice: await tileSlice(w, t), removed };
  };
  const { workerUrl } = opts;
  const workerFactory = workerUrl ? () => new Worker(workerUrl, { type: "module" }) : undefined;
  const service = await BakeService.create(bakeInit(w, heroes, opts.scatter !== false), prepare, workerFactory, {
    plugins: plugins.refs,
    workers: opts.bakeWorkers ?? defaultBakeWorkers(),
  });
  service.failures.unloaded = plugins.missing; // named in failures of generators nobody registered (D-072)
  await mainThread.catch((e: unknown) => {
    service.dispose();
    throw e;
  });
  const view = new View(opts, w, compositor, service, cache, await cacheKeyReady, edits, tileEdits);
  await view.start(opts);
  return view;
}

class View implements WorldView {
  readonly canvas: HTMLCanvasElement;
  readonly world: WorldInfo;
  readonly camera: ViewCamera;
  readonly query: WorldQuery;
  readonly entities: EntityList;
  readonly layers: LayerRegistry;
  readonly controllers: ControllerHost;
  readonly edits: WorldEdits;
  private readonly cam = new Camera(1, 1);
  private readonly viewCamera: ViewCameraImpl;
  private readonly entityList: Entities;
  private readonly layerList: Layers;
  private readonly controllerHost: Controllers;
  private readonly rs: number;
  private readonly tiles: TileGrid;
  private readonly gpu = new Map<TileKey, TileEntry>();
  private gpuBytes = 0;
  private readonly depthRange: [number, number];
  private night = false;
  private nightRgba: Uint8Array | null = null;
  private fixedSize: { width: number; height: number } | null;
  private ratio = 1;
  private resizeObserver: ResizeObserver | null = null;
  private readonly onWindowResize = () => this.fitCanvas();

  // the frame loop
  private dirty = true;
  private renderedComplete = false;
  private readonly readyResolvers: (() => void)[] = [];
  private frameNo = 0;
  private lastT = performance.now();
  private frames = 0;
  private fps = 0;
  private fpsT = performance.now();
  private renderMs = 0;
  /** The last frame drawn, again (timeFrames). */
  private redrawLast: (() => void) | null = null;
  private fogField: FogField | null = null;
  private raf = 0;
  private stopped = false;
  private readonly frameListeners = new Set<(e: FrameEvent) => void>();
  private readonly bakes: TileBake[] | null;
  /** A view this one takes over from once its first frame is complete (`replace`). */
  private replacing: WorldView | null;
  /** Game time: from the first complete frame, paused and scaled (D-073). */
  private readonly clock = new GameClock();
  // baking ahead (D-073): the tiles in and around the view last frame, all those wanted, which are baked
  private near: TileInView[] = [];
  private wanted: TileRequest[] = [];
  private readonly baked: BakedTiles;
  private readonly motion = new CameraMotion();
  private readonly lookAhead: number;
  private readonly groundFirst: boolean;
  private readonly idleBake: boolean;
  /** Tiles asked for while nothing else waited, and those since baked or found kept: kept in the cache, not on the GPU. */
  private readonly idleAsked = new Set<TileKey>();
  private readonly idleDone = new Set<TileKey>();
  private readonly prefetches = new Prefetches();
  /** Where a revealing entity cleared the world last frame (absolute screen px), or null. */
  private revealBox: ScreenBox | null = null;
  /** Tile images on the GPU from before an edit that touches them (D-124): drawn until their new bake is ready. */
  private readonly stale = new Set<TileKey>();

  constructor(
    opts: WorldViewOptions,
    private readonly w: LoadedWorld,
    private readonly compositor: Compositor,
    private readonly service: BakeService,
    private readonly cache: TileStore | null,
    private readonly cacheKey: (t: TileRequest, removed?: readonly number[]) => string,
    editLog: EditLog,
    private readonly tileEdits: TileEdits,
  ) {
    this.canvas = opts.canvas;
    this.world = worldInfo(w);
    this.rs = w.renderScale;
    this.fixedSize = opts.size ?? null;
    this.bakes = opts.recordBakes ? [] : null;
    this.replacing = opts.replace ?? null;
    this.lookAhead = Math.max(0, opts.lookAhead ?? LOOK_AHEAD_S);
    this.groundFirst = opts.groundFirst !== false;
    this.idleBake = opts.idleBake !== false && cache !== null; // only worth it where tiles are kept
    const { manifest, store } = w;
    const invalidate = () => this.invalidate();

    this.query = worldQuery(
      w,
      () => {
        const snap = this.cam.snapped();
        return { rotation: this.cam.rotation, ...snap, zoom: this.cam.zoom, pixelRatio: this.ratio };
      },
      editLog,
    );
    this.edits = editLog;
    editLog.onChange((e) => this.edited(this.tileEdits.apply(e)));
    this.viewCamera = new ViewCameraImpl(this.cam, this.rs, invalidate, {
      ensure: (x, y) => store.ensureRect(Math.floor(x), Math.floor(y), Math.floor(x) + 1, Math.floor(y) + 1),
      heightAt: (x, y) => this.query.heightAt(x, y),
      lonLatToCell: (lon, lat) => this.query.lonLatToCell(lon, lat),
      pixelRatio: () => this.ratio,
    });
    this.camera = this.viewCamera;
    const cam = opts.camera;
    if (cam?.rotation !== undefined) this.cam.rotation = (((Math.round(cam.rotation) % 4) + 4) % 4) as Rotation;
    if (typeof cam?.zoom === "number") this.viewCamera.zoom = cam.zoom;

    this.entityList = new Entities({
      bake: (r, boxes) => this.bakeSprite(r, boxes),
      release: (s) => this.compositor.release(s),
      groupBoxes: (m) => this.groupBoxes(m),
      heightAt: (x, y) => this.query.heightAt(x, y),
      invalidate,
      redraw: () => (this.dirty = true),
    });
    this.entities = this.entityList;
    this.layerList = new Layers((layer) => this.layerContext(layer.id), invalidate);
    this.layers = this.layerList;
    this.controllerHost = new Controllers(this);
    this.controllers = this.controllerHost;

    this.tiles = new TileGrid(manifest.cellsX, manifest.cellsY, w.tileSize, this.rs, w.floor, !!w.objects, (x0, y0, x1, y1) =>
      store.heightRangeFor(x0, y0, x1, y1),
    );
    // tall objects: their tiles count as in view as far up as they reach, and the depth range holds their tops
    if (w.objects) {
      const stretch = manifest.depiction?.heightStretch ?? w.style.objects?.heightStretch ?? 1;
      for (const o of w.objects.instances) {
        // object voxels are 1/16 cell across and 1/8 step tall (D-010)
        const rise = o.hm !== undefined ? (2 * o.hm * stretch) / (o.m ?? manifest.scale.metersPerCell) : 0;
        const abs = o.top ?? (o.z0 !== undefined ? o.z0 + rise : undefined);
        if (rise <= 12 && abs === undefined) continue; // within the default allowance
        const [x0, y0, x1, y1] = o.fp?.length ? footprintBounds(o.fp) : [o.x, o.y, o.x, o.y];
        this.tiles.addObject(x0, y0, x1, y1, rise, abs);
      }
    }
    this.baked = new BakedTiles(this.tiles);
    this.depthRange = worldDepthRange(
      manifest.cellsX * this.rs,
      manifest.cellsY * this.rs,
      w.floor * this.rs,
      Math.max(w.heightRange[1], this.tiles.maxTop) * this.rs,
    );
    this.night = opts.palette === "night" && !!w.style.night;
    this.applyPalette();

    this.service.onTile = (res) => {
      if (this.bakes && res.stats) {
        const { meshMs, bakeMs, vertices } = res.stats;
        this.bakes.push({ rotation: res.rotation, tx: res.tx, ty: res.ty, meshMs, bakeMs, vertices });
      }
      const at = { rotation: res.rotation, tx: res.tx, ty: res.ty, ...(res.bare ? { bare: true } : res.ground ? { ground: true } : {}) };
      const whole = !res.bare && !res.ground;
      // the ground came after the whole tile: not needed
      if (res.ground && this.gpu.has(tileKey(res.rotation, res.tx, res.ty))) return void this.service.forget(res.key);
      // made before an edit that touches it (D-124): asked for again, and drawn only where nothing newer is
      // (a tile that failed to prepare or bake made nothing: it isn't asked for again)
      const failed = !res.fromCache && !res.stats;
      const outdated = !res.ground && !failed && (res.removed ?? []).join(",") !== this.tileEdits.removedFor(res.tx, res.ty).join(",");
      if (outdated) this.service.forget(res.key);
      // kept under the objects it was made without, so it is right for the cache whenever it was made
      const put = (img: typeof res.image) => {
        if (img && !res.fromCache && !res.modelsFailed && !res.ground) void this.cache?.put(this.cacheKey(res, res.removed), img);
      };
      // baked while idle, for later (another rotation, around the view): into the cache, not onto the GPU
      if (this.idleAsked.delete(res.key) && !(res.rotation === this.cam.rotation && this.near.some((t) => t.tx === res.tx && t.ty === res.ty))) {
        put(res.image);
        if (!outdated) this.idleDone.add(res.key); // done for the bake service until the view wants it (then from the cache)
        return;
      }
      // a tile with missing-model markers isn't kept: a reload bakes it again and reports why (D-072)
      put(res.image);
      if (outdated && this.gpu.has(res.key)) return;
      // a new image in place of one from before an edit: the old one goes now
      const old = this.gpu.get(res.key);
      if (old?.img) this.compositor.release(old.img);
      this.gpuBytes -= old?.bytes ?? 0;
      if (outdated) this.stale.add(res.key);
      else this.stale.delete(res.key);
      if (res.image) {
        const img = this.compositor.upload(res.image);
        const bytes = res.image.width * res.image.height * 4;
        this.gpuBytes += bytes;
        this.gpu.set(res.key, { img, bytes, lastDrawn: this.frameNo, ...at });
      } else {
        this.gpu.set(res.key, { img: null, bytes: 0, lastDrawn: this.frameNo, ...at });
      }
      if (whole) this.baked.set(res.rotation, res.tx, res.ty, !!res.image);
      this.dirty = true;
    };
    this.service.onError = opts.onError ?? ((m) => console.error(m));
  }

  /** Size the canvas, place the camera, attach the controller and layers, then start the loop. */
  async start(opts: WorldViewOptions): Promise<void> {
    if (this.fixedSize) this.resize(this.fixedSize.width, this.fixedSize.height);
    else {
      this.fitCanvas();
      window.addEventListener("resize", this.onWindowResize);
      if (typeof ResizeObserver !== "undefined") {
        this.resizeObserver = new ResizeObserver(() => this.fitCanvas());
        this.resizeObserver.observe(this.canvas);
      }
    }
    // the world's start, until a controller or the options say otherwise (nothing loaded for it yet)
    const m = this.w.manifest;
    const home = m.start ?? { x: Math.floor(m.cellsX / 2), y: Math.floor(m.cellsY / 2) };
    this.viewCamera.setFocus(home.x + 0.5, home.y + 0.5, 0);
    if (opts.controller) await this.controllerHost.use(opts.controller);
    const c = opts.camera;
    if (c?.x !== undefined || c?.y !== undefined || c?.h !== undefined || !opts.controller) {
      const target = { x: c?.x ?? this.camera.x, y: c?.y ?? this.camera.y };
      await this.camera.lookAt(c?.h !== undefined ? { ...target, h: c.h } : target);
    }
    for (const layer of opts.layers ?? []) await this.layerList.add(layer);
    this.lastT = performance.now();
    this.fpsT = this.lastT;
    this.raf = requestAnimationFrame(this.frame);
  }

  // ---------------------------------------------------------------- state

  get pixelRatio(): number {
    return this.ratio;
  }

  get palette(): "day" | "night" {
    return this.night ? "night" : "day";
  }

  set palette(p: "day" | "night") {
    const night = p === "night" && this.hasNight;
    if (night === this.night) return;
    this.night = night;
    this.applyPalette();
    this.invalidate();
  }

  get hasNight(): boolean {
    return !!this.w.style.night;
  }

  private applyPalette(): void {
    if (this.night) this.nightRgba ??= buildPalette(this.w.style, "night").rgba;
    this.compositor.setPalette(this.night ? this.nightRgba! : this.w.palette.rgba);
  }

  invalidate(): void {
    this.dirty = true;
    this.renderedComplete = false;
  }

  ready(): Promise<void> {
    return this.renderedComplete && this.settled()
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          this.dirty = true;
          this.readyResolvers.push(resolve);
        });
  }

  /**
   * Nothing in or around the view is left to bake: its tiles and every
   * sprite asked for. Tiles baked ahead (prefetch, look-ahead) don't count.
   */
  private settled(): boolean {
    if (this.service.spritesPending - this.entityList.unwaitedBakes > 0) return false;
    for (const t of this.near) if (!this.has(tileKey(t.rotation, t.tx, t.ty))) return false;
    return true;
  }

  /** Whether a tile's image is on the GPU and up to date (not from before an edit). */
  private has(key: TileKey): boolean {
    return this.gpu.has(key) && !this.stale.has(key);
  }

  /**
   * Objects taken out or put back (D-124): the tiles whose bake reaches them
   * bake again. In the rotation shown, each image stays on screen until its
   * new one is ready; in the others, and kept in the cache, they are let go.
   */
  private edited(tiles: [number, number][]): void {
    const r = this.cam.rotation;
    for (const [tx, ty] of tiles)
      for (const rot of [0, 1, 2, 3] as const)
        for (const bare of [false, true]) {
          const key = tileKey(rot, tx, ty, bare);
          this.idleDone.delete(key);
          if (rot === r && this.gpu.has(key)) {
            this.stale.add(key);
            this.service.forget(key);
          } else {
            this.drop(key);
            this.service.forget(key);
            // a ground request answered with the whole tile is done too: its ground shows first again
            if (!bare) {
              this.service.forget(tileKey(rot, tx, ty, false, true));
              this.baked.set(rot, tx, ty, false);
            }
          }
        }
    this.invalidate();
  }

  // ---------------------------------------------------------------- game time, baking ahead

  get started(): boolean {
    return this.clock.started;
  }

  get time(): number {
    return this.clock.time;
  }

  get paused(): boolean {
    return this.clock.paused;
  }

  set paused(on: boolean) {
    this.clock.paused = on;
  }

  get timeScale(): number {
    return this.clock.timeScale;
  }

  set timeScale(s: number) {
    this.clock.timeScale = s;
  }

  isDrawn(x: number, y: number): boolean {
    return this.baked.at(this.cam.rotation, x, y);
  }

  prefetch(x: number, y: number, radius?: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    // the next frame asks for its tiles
    return this.prefetches.add(radius === undefined ? { x, y } : { x, y, radius: Math.max(0, radius) });
  }

  /** A prefetch's tiles in a rotation: within its radius, or those a view centred there would show. */
  private prefetchTiles(r: Rotation, area: PrefetchArea): TileRequest[] {
    if (area.radius !== undefined) return this.tiles.around(r, area.x, area.y, area.radius);
    const rs = this.rs;
    const h = this.query.heightAt(area.x, area.y) ?? this.camera.h;
    const c = project(area.x * rs, area.y * rs, h * rs, r);
    const width = this.cam.internalWidth;
    const height = this.cam.internalHeight;
    return this.tiles.visibleFrom(r, { left: Math.floor(c.sx - width / 2), top: Math.floor(c.sy - height / 2), width, height });
  }

  /** The tiles the view will show `lookAhead` seconds along the camera's motion, if it moves. */
  private aheadTiles(r: Rotation, info: FrameInfo): TileRequest[] {
    if (this.lookAhead <= 0) return [];
    const rs = this.rs;
    const f = info.focus;
    const a = project(f.x * rs, f.y * rs, f.h * rs, r);
    // then twice and four times as far, nearest first: the faster it goes, the further ahead
    const out: TileRequest[] = [];
    for (const k of AHEAD_STEPS) {
      const [dx, dy] = this.motion.ahead(this.lookAhead * k);
      if (Math.hypot(dx, dy) < 0.5) break;
      const b = project((f.x + dx) * rs, (f.y + dy) * rs, f.h * rs, r);
      out.push(...this.tiles.visibleFrom(r, shiftView(info.view, b.sx - a.sx, b.sy - a.sy)));
    }
    return out;
  }

  resize(width: number, height: number): void {
    // setting a canvas's size clears it, even to the size it has: a view replacing another keeps its frame
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.ratio = this.fixedSize ? 1 : window.devicePixelRatio || 1;
    this.viewCamera.setCanvasSize(width, height);
  }

  /** Follow the canvas's size on the page. */
  private fitCanvas(): void {
    if (this.fixedSize) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round((this.canvas.clientWidth || window.innerWidth) * dpr);
    const h = Math.round((this.canvas.clientHeight || window.innerHeight) * dpr);
    if (w === this.canvas.width && h === this.canvas.height && this.cam.canvasWidth === w && this.cam.canvasHeight === h) return;
    this.resize(w, h);
  }

  // ---------------------------------------------------------------- frames

  private frameInfo(snap: { left: number; top: number }): FrameInfo {
    const cam = this.cam;
    const rs = this.rs;
    const r = cam.rotation;
    return {
      rotation: r,
      focus: { x: cam.fx / rs, y: cam.fy / rs, h: cam.fh / rs },
      zoom: cam.zoom,
      view: { left: snap.left, top: snap.top, width: cam.internalWidth, height: cam.internalHeight },
      night: this.night,
      renderScale: rs,
      project: (x, y, h) => project(x * rs, y * rs, h * rs, r),
      isDrawn: (x, y) => this.baked.at(r, x, y),
    };
  }

  private readonly frame = (now: number): void => {
    if (this.stopped) return;
    this.frameNo++;
    // game time: 0 until the first complete frame and while paused (D-073)
    const clock = this.clock.tick(now - this.lastT);
    const dt = clock.dt;
    this.lastT = now;
    this.controllerHost.update(dt, clock);
    const cam = this.cam;
    const r = cam.rotation;
    this.entityList.request(r);
    const snap = cam.snapped();
    const info = this.frameInfo(snap);
    const layers = this.layerList.enabled();
    for (const layer of layers) if (layer.update?.(dt, info, clock)) this.dirty = true;

    // tiles: the visible ones, then ahead of the camera's motion and where asked, then around the view
    const order = this.tiles.inView(r, info.view);
    this.near = order;
    this.motion.update(this.camera.x, this.camera.y, clock.realDt);
    const asked = this.prefetches.size
      ? this.prefetches.wanted(`${r}:${info.view.width}x${info.view.height}`, (area) => this.prefetchTiles(r, area))
      : [];
    // the ground of visible tiles not drawn yet, first: quick, so the view is never blank
    const ground = this.groundFirst
      ? order.filter((t) => t.visible && !this.gpu.has(tileKey(r, t.tx, t.ty))).map((t) => ({ rotation: r, tx: t.tx, ty: t.ty, ground: true }))
      : [];
    this.wanted = bakeOrder(order, this.aheadTiles(r, info), asked, this.bareWanted(r, order), ground);
    // a tile baked while idle and wanted now: asked for again, the cache has it
    if (this.idleDone.size)
      for (const t of this.wanted) {
        const k = tileKey(t.rotation, t.tx, t.ty);
        if (!t.bare && this.idleDone.delete(k)) this.service.forget(k);
      }
    // nothing else waiting and the camera still: one tile at a time for later (another rotation, around
    // the view); while it moves, the look-ahead has the tiles that matter
    const still = Math.hypot(this.motion.vx, this.motion.vy) < IDLE_SPEED;
    const busy = !still || this.wanted.some((t) => !this.has(tileKey(t.rotation, t.tx, t.ty, t.bare, t.ground)));
    const idle = this.idleBake && !busy ? this.nextIdle(r, info) : null;
    if (idle) this.idleAsked.add(tileKey(idle.rotation, idle.tx, idle.ty));
    this.service.want(idle ? [...this.wanted, idle] : this.wanted);
    if (this.prefetches.size) this.prefetches.settle((t) => this.has(tileKey(t.rotation, t.tx, t.ty)));

    const drawTiles: GpuImage[] = [];
    // tiles' ground alone, under everything while they bake (a whole tile leaves holes where its neighbours' buildings stand)
    const grounds: GpuImage[] = [];
    let complete = true;
    let missingTiles = 0;
    for (const t of order) {
      const entry = this.gpu.get(tileKey(r, t.tx, t.ty));
      if (entry) {
        entry.lastDrawn = this.frameNo;
        if (entry.img) drawTiles.push(entry.img);
      } else if (t.visible) {
        complete = false;
        missingTiles++;
      }
      const ground = this.gpu.get(tileKey(r, t.tx, t.ty, false, true));
      if (ground) {
        ground.lastDrawn = this.frameNo;
        if (ground.img) grounds.push(ground.img);
      }
    }
    // every visible tile whole: the grounds have done their part
    if (complete && grounds.length) {
      for (const [key, e] of [...this.gpu]) if (e.ground) this.drop(key);
      grounds.length = 0;
    }

    let drawn = this.dirty;
    if (this.dirty) {
      const sprites: SpriteInstance[] = [];
      for (const layer of layers) {
        const s = layer.sprites?.(info);
        if (!s) continue;
        for (const d of s.list) sprites.push(d);
        if (!s.complete) complete = false;
      }
      const t0 = performance.now();
      let fog: FogFrame | null = null;
      for (const layer of layers) {
        const pass = layer.screenPass?.(info);
        if (!pass || fog) continue;
        if (pass.field !== this.fogField) {
          this.compositor.setFogField(pass.field);
          this.fogField = pass.field;
        }
        fog = pass.frame;
      }
      const ents = this.entityList.draws(r, info.project, info.isDrawn);
      if (!ents.complete) complete = false;
      for (const d of ents.list) sprites.push(d);
      // a revealing entity: the bare tiles under it, once all of them are baked (asked for from the next frame)
      const rv = ents.list.find((s) => s.reveal);
      this.revealBox = rv ? revealRect(rv) : null;
      const bare = this.revealBox ? this.bareTiles(r, order, this.revealBox) : [];
      if (this.replacing && !complete) {
        // hold: the view being replaced keeps the canvas until this one has a whole frame
        drawn = false;
      } else {
        if (this.replacing) {
          const old = this.replacing;
          this.replacing = null;
          old.destroy();
        }
        const frameParams = {
          left: snap.left,
          top: snap.top,
          fracX: snap.fracX,
          fracY: snap.fracY,
          zoom: cam.zoom,
          depthRange: this.depthRange,
        };
        this.redrawLast = () => this.compositor.render(frameParams, drawTiles, sprites, fog, bare, grounds);
        this.redrawLast();
        this.renderMs = performance.now() - t0;
        this.dirty = !complete; // keep redrawing while tiles stream in
        this.renderedComplete = complete;
        // the first complete frame starts game time (from the next frame)
        if (complete) this.clock.start();
        if (complete && this.settled()) this.readyResolvers.splice(0).forEach((f) => f());
      }
    }
    this.evict();

    this.frames++;
    if (now - this.fpsT > 500) {
      this.fps = (this.frames * 1000) / (now - this.fpsT);
      this.frames = 0;
      this.fpsT = now;
    }
    const event: FrameEvent = { ...clock, started: this.clock.started, now, drawn, missingTiles };
    for (const f of this.frameListeners) f(event);
    this.raf = requestAnimationFrame(this.frame);
  };

  /**
   * The next tile to bake while nothing else waits: what the view would show
   * here in each other rotation (so turning it finds them kept), then the
   * tiles around the focus, nearest first.
   */
  private nextIdle(r: Rotation, info: FrameInfo): TileRequest | null {
    const fresh = (t: TileRequest) => {
      const k = tileKey(t.rotation, t.tx, t.ty);
      return !this.idleDone.has(k) && !this.gpu.has(k);
    };
    const at = { x: info.focus.x, y: info.focus.y };
    for (let k = 1; k < 4; k++) for (const q of this.prefetchTiles(((r + k) % 4) as Rotation, at)) if (fresh(q)) return q;
    for (const q of this.tiles.around(r, at.x, at.y, IDLE_RADIUS)) if (fresh(q)) return q;
    return null;
  }

  /** Bare variants of the tiles drawn under last frame's reveal, and a little around it (it moves). */
  private bareWanted(r: Rotation, order: readonly TileInView[]): TileRequest[] {
    const box = this.revealBox;
    if (!box) return [];
    const g = REVEAL_AHEAD_PX;
    const grown = { left: box.left - g, top: box.top - g, right: box.right + g, bottom: box.bottom + g };
    const out: TileRequest[] = [];
    for (const t of order) {
      const img = this.gpu.get(tileKey(r, t.tx, t.ty))?.img;
      if (img && overlaps(img.image, grown)) out.push({ rotation: r, tx: t.tx, ty: t.ty, bare: true });
    }
    return out;
  }

  /** The bare tiles under a reveal, or none until every one of them is baked. */
  private bareTiles(r: Rotation, order: readonly TileInView[], box: ScreenBox): GpuImage[] {
    const out: GpuImage[] = [];
    for (const t of order) {
      const img = this.gpu.get(tileKey(r, t.tx, t.ty))?.img;
      if (!img || !overlaps(img.image, box)) continue;
      const bare = this.gpu.get(tileKey(r, t.tx, t.ty, true));
      if (!bare) return [];
      bare.lastDrawn = this.frameNo;
      if (bare.img) out.push(bare.img);
    }
    return out;
  }

  /** Release a tile image, to be baked again if wanted. */
  private drop(key: TileKey): void {
    const e = this.gpu.get(key);
    if (!e) return;
    if (e.img) this.compositor.release(e.img);
    this.gpuBytes -= e.bytes;
    this.gpu.delete(key);
    this.stale.delete(key);
    this.service.forget(key);
  }

  private evict(): void {
    if (this.gpuBytes <= GPU_BUDGET_BYTES) return;
    const old = [...this.gpu.entries()]
      .filter(([, e]) => e.img && e.lastDrawn < this.frameNo)
      .sort((a, b) => a[1].lastDrawn - b[1].lastDrawn);
    for (const [key, e] of old) {
      if (this.gpuBytes <= GPU_BUDGET_BYTES * 0.8) break;
      this.compositor.release(e.img!);
      this.gpuBytes -= e.bytes;
      this.gpu.delete(key);
      this.stale.delete(key);
      if (!e.bare && !e.ground) {
        this.baked.set(e.rotation, e.tx, e.ty, false);
        this.service.forget(tileKey(e.rotation, e.tx, e.ty, false, true));
      }
      this.service.forget(key);
    }
  }

  onFrame(listener: (e: FrameEvent) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  // ---------------------------------------------------------------- sprites, layers

  private bakeSprite(rotation: Rotation, boxes: Box[]): Promise<GpuImage | null> {
    return this.service.bakeSprite(rotation, boxes).then((img) => {
      this.dirty = true;
      return img ? this.compositor.upload(img) : null;
    });
  }

  private groupBoxes(m: { group: string; seed: number; size?: { length: number; width: number; height: number }; variant?: number; part?: number }): Box[] {
    const assets = this.w.style.assets;
    if (!assets || !resolveAsset(assets, m.group)) throw new Error(`the style pack has no asset for ${m.group}`);
    const model = generateModel(assets, this.w.palette.rampIds, m.group, {
      seed: m.seed,
      size: m.size,
      part: m.part,
      variant: m.variant,
    });
    return modelBoxes(model, VOXEL);
  }

  private layerContext(_id: string): LayerContext {
    return {
      view: this,
      bakeSprite: (rotation, boxes) => this.bakeSprite(rotation, boxes),
      releaseSprite: (s) => this.compositor.release(s),
      frame: () => this.frameInfo(this.cam.snapped()),
      invalidate: () => this.invalidate(),
    };
  }

  // ---------------------------------------------------------------- tools

  stats(): ViewStats {
    const t = this.service.totals;
    return {
      renderer: this.service.renderer,
      bakeMode: this.service.mode,
      bakeWorkers: this.service.workers,
      tilesBaked: t.tiles,
      groundTiles: t.ground,
      tilesFromCache: t.fromCache,
      tilesPerRotation: this.tiles.count,
      tilesPending: this.wanted.filter((t) => !this.has(tileKey(t.rotation, t.tx, t.ty, t.bare, t.ground))).length,
      ...chunkStats(this.w.store),
      gpuTiles: [...this.gpu.values()].filter((e) => e.img).length,
      gpuMB: this.gpuBytes / (1024 * 1024),
      avgMeshMs: t.tiles ? t.meshMs / t.tiles : 0,
      avgBakeMs: t.tiles ? t.bakeMs / t.tiles : 0,
      maxTileMs: t.maxTileMs,
      fps: this.fps,
      renderMs: this.renderMs,
      cache: !this.cache ? "off" : this.cache instanceof TileCache ? "indexeddb" : "custom",
      cacheWrites: this.cache?.writes ?? 0,
      modelsFailed: this.service.failures.count,
    };
  }

  tileBakes(): TileBake[] {
    return this.bakes ? this.bakes.slice() : [];
  }

  timeFrames(n: number): number {
    const redraw = this.redrawLast;
    if (!redraw) return NaN;
    const gl = this.compositor.gl;
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      redraw();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // waits for the GPU
    }
    return (performance.now() - t0) / n;
  }

  async bakeObject(id: string): Promise<((BakedImage & { rotation: Rotation }) | null)[]> {
    const { manifest, store } = this.w;
    // the object and its parts (a dam's intake towers)
    const insts = this.w.objects?.instances.filter((o) => o.id === id) ?? [];
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
    const out: ((BakedImage & { rotation: Rotation }) | null)[] = [];
    for (const r of [0, 1, 2, 3] as const) {
      const img = await this.service.bakeObjects(r, insts, slice);
      out.push(img ? { rotation: r, ...img } : null);
    }
    return out;
  }

  serialize(): ViewState {
    const c = this.camera;
    const state: ViewState = {
      camera: { x: c.x, y: c.y, h: c.h, rotation: c.rotation, zoom: c.zoom },
      layers: this.layerList.serialize(),
    };
    const controller = this.controllerHost.current;
    if (controller?.serialize) state.controller = { id: controller.id, state: controller.serialize() };
    return state;
  }

  restore(state: ViewState): void {
    const c = state.camera;
    this.camera.rotation = c.rotation;
    this.camera.zoom = c.zoom;
    this.camera.setFocus(c.x, c.y, c.h);
    this.layerList.restore(state.layers);
    // the controller's state after the camera's: a controller that follows something puts the camera on it
    const controller = this.controllerHost.current;
    if (state.controller && controller?.restore && controller.id === state.controller.id) controller.restore(state.controller.state);
    this.invalidate();
  }

  destroy(): void {
    if (this.stopped) return;
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    // a view still waiting to take over from another leaves it as it is: its owner keeps it
    this.replacing = null;
    window.removeEventListener("resize", this.onWindowResize);
    this.resizeObserver?.disconnect();
    void this.controllerHost.use(null);
    this.layerList.dispose();
    this.service.dispose();
    for (const e of this.gpu.values()) if (e.img) this.compositor.release(e.img);
    this.gpu.clear();
    this.gpuBytes = 0;
    this.entityList.dispose();
    this.compositor.dispose();
    this.readyResolvers.splice(0);
    this.frameListeners.clear();
    this.baked.clear();
    this.prefetches.clear();
  }
}
