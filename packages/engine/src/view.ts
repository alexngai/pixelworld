import type { BakedImage } from "@pixelworld/bake";
import { generateModel, modelBoxes, resolveAsset, type Box } from "@pixelworld/generators";
import { project, type Rotation } from "@pixelworld/grid";
import {
  BakeService,
  Camera,
  Compositor,
  TileCache,
  tileKey,
  worldDepthRange,
  type FogField,
  type FogFrame,
  type GpuImage,
  type PreparedTile,
  type SpriteInstance,
  type TileKey,
  type TileRequest,
} from "@pixelworld/runtime";
import { buildPalette } from "@pixelworld/style";
import { ViewCameraImpl } from "./camera";
import { Controllers } from "./controller";
import { Entities } from "./entities";
import { Layers } from "./layers";
import { registerOnMainThread, viewPlugins } from "./plugins";
import { createQuery } from "./queries";
import { TileGrid } from "./tiles";
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
  WorldInfo,
  WorldQuery,
  WorldView,
  WorldViewOptions,
} from "./types";
import { bakeInit, loadHeroes, loadWorld, tileCacheKey, worldInfo, type LoadedWorld } from "./world";

const GPU_BUDGET_BYTES = 192 * 1024 * 1024; // baked tile textures kept on the GPU
/** Object voxel size in render units (objectVoxelScale at render scale 1, D-010). */
const VOXEL = { h: 1 / 16, v: 1 / 8 };

/** Baked tiles on the GPU, evicted least-recently-drawn beyond a memory budget. */
interface TileEntry {
  img: GpuImage | null;
  bytes: number;
  lastDrawn: number;
}

/**
 * A world view (docs/library.md §3.2): streams a world package around the
 * camera, bakes and caches its tiles, and composites them with layers and
 * entities in a frame loop that redraws only when something changed.
 */
export async function createWorldView(opts: WorldViewOptions): Promise<WorldView> {
  const w = await loadWorld(opts);
  // plugins with generators (D-071): registered here, and in the bake worker before its first bake
  const plugins = viewPlugins(opts.plugins, w.styleJson, w.style.id);
  const mainThread = registerOnMainThread(plugins);
  mainThread.catch(() => {}); // awaited below
  const compositor = new Compositor(opts.canvas);
  const cache: TileStore | null =
    opts.cache === false ? null : opts.cache === true || opts.cache === undefined ? await TileCache.open() : opts.cache;
  const heroes = opts.heroes === false ? [] : await loadHeroes(w);
  const cacheKey = tileCacheKey(w, plugins.descriptors);
  const { store, manifest } = w;
  const prepare = async (t: TileRequest): Promise<PreparedTile> => {
    if (cache) {
      const hit = await cache.get(cacheKey(t));
      if (hit) return { cached: hit };
    }
    const ts = w.tileSize;
    const x0 = Math.max(0, t.tx * ts - w.margin);
    const y0 = Math.max(0, t.ty * ts - w.margin);
    const x1 = Math.min(manifest.cellsX, (t.tx + 1) * ts + w.margin);
    const y1 = Math.min(manifest.cellsY, (t.ty + 1) * ts + w.margin);
    await store.ensureRect(x0, y0, x1, y1);
    const s = store.slice(x0, y0, x1, y1);
    return {
      slice: { x0: s.x0, y0: s.y0, width: s.grid.width, height: s.grid.height, layers: s.grid.layers(), micro: s.grid.micro },
    };
  };
  const { workerUrl } = opts;
  const workerFactory = workerUrl ? () => new Worker(workerUrl, { type: "module" }) : undefined;
  const service = await BakeService.create(bakeInit(w, heroes, opts.scatter !== false), prepare, workerFactory, {
    plugins: plugins.refs,
  });
  await mainThread.catch((e: unknown) => {
    service.dispose();
    throw e;
  });
  const view = new View(opts, w, compositor, service, cache, cacheKey);
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

  constructor(
    opts: WorldViewOptions,
    private readonly w: LoadedWorld,
    private readonly compositor: Compositor,
    private readonly service: BakeService,
    private readonly cache: TileStore | null,
    private readonly cacheKey: (t: TileRequest) => string,
  ) {
    this.canvas = opts.canvas;
    this.world = worldInfo(w);
    this.rs = w.renderScale;
    this.fixedSize = opts.size ?? null;
    this.bakes = opts.recordBakes ? [] : null;
    const { manifest, store } = w;
    const invalidate = () => this.invalidate();

    this.query = createQuery(store, w, w.geo, () => {
      const snap = this.cam.snapped();
      return { rotation: this.cam.rotation, ...snap, zoom: this.cam.zoom, pixelRatio: this.ratio };
    });
    this.viewCamera = new ViewCameraImpl(this.cam, this.rs, invalidate, {
      ensure: (x, y) => store.ensureRect(Math.floor(x), Math.floor(y), Math.floor(x) + 1, Math.floor(y) + 1),
      heightAt: (x, y) => this.query.heightAt(x, y),
      lonLatToCell: (lon, lat) => this.query.lonLatToCell(lon, lat),
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
    this.depthRange = worldDepthRange(
      manifest.cellsX * this.rs,
      manifest.cellsY * this.rs,
      w.floor * this.rs,
      w.heightRange[1] * this.rs,
    );
    this.night = opts.palette === "night" && !!w.style.night;
    this.applyPalette();

    this.service.onTile = (res) => {
      if (this.bakes && res.stats) {
        const { meshMs, bakeMs, vertices } = res.stats;
        this.bakes.push({ rotation: res.rotation, tx: res.tx, ty: res.ty, meshMs, bakeMs, vertices });
      }
      if (res.image) {
        const img = this.compositor.upload(res.image);
        const bytes = res.image.width * res.image.height * 4;
        this.gpuBytes += bytes;
        this.gpu.set(res.key, { img, bytes, lastDrawn: this.frameNo });
        if (!res.fromCache && this.cache) void this.cache.put(this.cacheKey(res), res.image);
      } else {
        this.gpu.set(res.key, { img: null, bytes: 0, lastDrawn: this.frameNo });
      }
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
    return this.renderedComplete && this.service.idle
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          this.dirty = true;
          this.readyResolvers.push(resolve);
        });
  }

  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
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
    };
  }

  private readonly frame = (now: number): void => {
    if (this.stopped) return;
    this.frameNo++;
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    this.controllerHost.update(dt);
    const cam = this.cam;
    const r = cam.rotation;
    this.entityList.request(r);
    const snap = cam.snapped();
    const info = this.frameInfo(snap);
    const layers = this.layerList.enabled();
    for (const layer of layers) if (layer.update?.(dt, info)) this.dirty = true;

    const order = this.tiles.inView(r, info.view);
    this.service.want(order);

    const drawTiles: GpuImage[] = [];
    let complete = true;
    for (const t of order) {
      const entry = this.gpu.get(tileKey(r, t.tx, t.ty));
      if (entry) {
        entry.lastDrawn = this.frameNo;
        if (entry.img) drawTiles.push(entry.img);
      } else if (t.visible) complete = false;
    }

    const drawn = this.dirty;
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
      const ents = this.entityList.draws(r, info.project);
      if (!ents.complete) complete = false;
      for (const d of ents.list) sprites.push(d);
      const frameParams = {
        left: snap.left,
        top: snap.top,
        fracX: snap.fracX,
        fracY: snap.fracY,
        zoom: cam.zoom,
        internalWidth: cam.internalWidth,
        internalHeight: cam.internalHeight,
        depthRange: this.depthRange,
      };
      this.redrawLast = () => this.compositor.render(frameParams, drawTiles, sprites, fog);
      this.redrawLast();
      this.renderMs = performance.now() - t0;
      this.dirty = !complete; // keep redrawing while tiles stream in
      this.renderedComplete = complete;
      if (complete && this.service.idle) this.readyResolvers.splice(0).forEach((f) => f());
    }
    this.evict();

    this.frames++;
    if (now - this.fpsT > 500) {
      this.fps = (this.frames * 1000) / (now - this.fpsT);
      this.frames = 0;
      this.fpsT = now;
    }
    for (const f of this.frameListeners) f({ now, dt, drawn });
    this.raf = requestAnimationFrame(this.frame);
  };

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
      tilesBaked: t.tiles,
      tilesFromCache: t.fromCache,
      tilesPerRotation: this.tiles.count,
      chunksLoaded: this.w.store.loadedCount,
      chunksTotal: this.w.manifest.chunks.length,
      gpuTiles: [...this.gpu.values()].filter((e) => e.img).length,
      gpuMB: this.gpuBytes / (1024 * 1024),
      avgMeshMs: t.tiles ? t.meshMs / t.tiles : 0,
      avgBakeMs: t.tiles ? t.bakeMs / t.tiles : 0,
      maxTileMs: t.maxTileMs,
      fps: this.fps,
      renderMs: this.renderMs,
      cache: !this.cache ? "off" : this.cache instanceof TileCache ? "indexeddb" : "custom",
      cacheWrites: this.cache?.writes ?? 0,
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
    return {
      camera: { x: c.x, y: c.y, h: c.h, rotation: c.rotation, zoom: c.zoom },
      layers: this.layerList.serialize(),
    };
  }

  restore(state: ViewState): void {
    const c = state.camera;
    this.camera.rotation = c.rotation;
    this.camera.zoom = c.zoom;
    this.camera.setFocus(c.x, c.y, c.h);
    this.layerList.restore(state.layers);
    this.invalidate();
  }

  destroy(): void {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.onWindowResize);
    this.resizeObserver?.disconnect();
    void this.controllerHost.use(null);
    this.layerList.dispose();
    this.service.dispose();
    for (const e of this.gpu.values()) if (e.img) this.compositor.release(e.img);
    this.gpu.clear();
    this.gpuBytes = 0;
    this.readyResolvers.splice(0);
    this.frameListeners.clear();
  }
}
