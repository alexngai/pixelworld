import type { Rotation } from "@pixelworlds/grid";
import type { BakedImage } from "@pixelworlds/bake";
import { loadPlugin, type Box, type ObjectInstance, type PluginReport } from "@pixelworlds/generators";
import { BakeHost } from "./bakeHost";
import { ModelFailures } from "./modelFailures";
import {
  sliceTransferables,
  type BakeStats,
  type FromWorker,
  type InitMessage,
  type PluginRef,
  type BakeAreaMessage,
  type TerrainSlice,
  type ToWorker,
} from "./protocol";

export type TileKey = string;
export const tileKey = (r: Rotation, tx: number, ty: number, bare?: boolean, ground?: boolean): TileKey =>
  `${r}:${tx},${ty}${bare ? ":bare" : ""}${ground ? ":ground" : ""}`;

export interface TileRequest {
  rotation: Rotation;
  tx: number;
  ty: number;
  /**
   * The tile without its buildings and landmarks (they still cast their
   * shadows): what lies behind them, for revealing a player they hide.
   */
  bare?: boolean;
  /**
   * The ground alone, without buildings or trees: quick to bake, so it shows
   * while the whole tile bakes. Where the whole tile is kept, `prepare`
   * answers with it instead (`whole`).
   */
  ground?: boolean;
}

const requestKey = (t: TileRequest): TileKey => tileKey(t.rotation, t.tx, t.ty, t.bare, t.ground);

/**
 * What `prepare` hands back: a cached image, or a terrain slice to bake.
 * `whole`: a ground request answered with the whole tile, kept. `removed`:
 * the placed objects taken out of the world that the tile's bake leaves out
 * (D-124), echoed in its result.
 */
export type PreparedTile = ({ cached: BakedImage | null; whole?: boolean } | { slice: TerrainSlice }) & { removed?: number[]; cells?: string; cut?: string };

export interface TileResult extends TileRequest {
  key: TileKey;
  image: BakedImage | null;
  stats: BakeStats | null;
  fromCache: boolean;
  /** Models of the tile that failed to generate and are drawn as markers (D-072): such a tile isn't worth keeping. */
  modelsFailed: number;
  /** The removed objects its image was made without (`PreparedTile.removed`), if any. */
  removed?: number[];
  /** The terrain edits its image was made with (`PreparedTile.cells`, D-147), if any. */
  cells?: string;
  /** The buildings cut down in its image (`PreparedTile.cut`, D-159), if any. */
  cut?: string;
}

export interface BakeTotals {
  tiles: number;
  /** Ground-only bakes (`TileRequest.ground`), not counted in `tiles`. */
  ground: number;
  fromCache: number;
  meshMs: number;
  bakeMs: number;
  maxTileMs: number;
}

interface Transport {
  send(msg: ToWorker, transfer?: Transferable[]): void;
}

export interface BakeServiceOptions {
  /**
   * Plugins the baker needs (D-071): imported in the worker before its first
   * bake, or on this thread when baking inline. A plugin that fails to load
   * fails `create`.
   */
  plugins?: PluginRef[];
  /** Bake workers to start (default 1): each takes the next wanted tile as it finishes one. */
  workers?: number;
}

/**
 * Literal `new Worker(new URL(...))` so Vite bundles the worker in builds.
 * The npm build (packages/pixelworld/build.mjs) rewrites the URL to the
 * prebuilt `./bake.worker.js` beside the engine and keeps it literal, so
 * consumers' bundlers (Vite, webpack 5) and plain ESM find it too.
 */
export function defaultWorkerFactory(): Worker {
  return new Worker(new URL("./bake.worker.ts", import.meta.url), { type: "module" });
}

/** One baker: a worker, or the in-thread fallback. */
interface Baker {
  transport: Transport;
  worker: Worker | null;
  /** A sprite or object bake, or a tile being prepared or baked; null while idle. */
  job: { id: number; tile: (TileRequest & { key: TileKey; removed?: number[]; cells?: string; cut?: string }) | null } | null;
  /** Tiles (tx,ty) whose meshes its BakeHost keeps, oldest first, as the host evicts them. */
  meshes: string[];
}

/** Tile scenes (meshes) the bakers keep between them, for a tile's other rotations and its bare variant. */
const MESH_SCENES = 6;

/**
 * Main-thread side of baking. Keeps a priority list of wanted tiles and hands
 * them to a pool of bakers (workers, or one in-thread fallback), each taking
 * the next as it finishes: `prepare` either finds a cached image or loads the
 * terrain the tile needs, which a worker then bakes. A tile goes back to the
 * worker that keeps its meshes, so another rotation or its bare variant isn't
 * meshed again. Call `want()` every frame with tiles ordered by priority.
 */
export class BakeService {
  private bakers: Baker[] = [];
  private nextId = 1;
  private wanted: TileRequest[] = [];
  private done = new Set<TileKey>();
  /** Tiles being prepared or baked. */
  private inFlight = new Set<TileKey>();
  /** The baker that keeps a tile's meshes (tx,ty). */
  private owners = new Map<string, Baker>();
  /** Scenes each baker keeps (its share of MESH_SCENES). */
  private meshScenes = MESH_SCENES;
  private spriteJobs = new Map<number, (img: BakedImage | null) => void>();
  /** Disposed: nothing more is baked, and late answers are dropped. */
  private disposed = false;
  private pluginJobs = new Map<number, { resolve: (p: PluginReport[]) => void; reject: (e: Error) => void }>();
  private spriteQueue: (
    | { id: number; rotation: Rotation; boxes: Box[] }
    | { id: number; rotation: Rotation; instances: ObjectInstance[]; slice: TerrainSlice }
    | Omit<BakeAreaMessage, "type">
  )[] = [];
  renderer = "pending";
  mode: "worker" | "inline" = "worker";
  /** The plugins the baker registered, and the generators each added. */
  plugins: PluginReport[] = [];
  readonly totals: BakeTotals = { tiles: 0, ground: 0, fromCache: 0, meshMs: 0, bakeMs: 0, maxTileMs: 0 };
  onTile: (r: TileResult) => void = () => {};
  onError: (message: string) => void = (m) => console.error(m);
  /** Models that failed to generate (drawn as markers): counted, and reported through onError once per generator and cause (D-072). */
  readonly failures = new ModelFailures((m) => this.onError(m));

  private constructor(private readonly prepare: (t: TileRequest) => Promise<PreparedTile>) {}

  /**
   * Create a service backed by `options.workers` workers (default 1); falls
   * back to baking on the main thread when none can start.
   */
  static async create(
    init: InitMessage,
    prepare: (t: TileRequest) => Promise<PreparedTile>,
    workerFactory: (() => Worker) | null = defaultWorkerFactory,
    options: BakeServiceOptions = {},
  ): Promise<BakeService> {
    const svc = new BakeService(prepare);
    const plugins = options.plugins ?? [];
    const first = workerFactory ? await svc.tryWorker(workerFactory) : null;
    if (first) {
      // the rest start together; one that can't (no WebGL2 there) is left out
      const more = await Promise.all(Array.from({ length: Math.max(1, options.workers ?? 1) - 1 }, () => svc.tryWorker(workerFactory!)));
      svc.bakers = [first, ...more.filter((b): b is Baker => b !== null)];
      if (plugins.length) {
        const reports = await Promise.all(svc.bakers.map((b) => svc.loadWorkerPlugins(b, plugins))).catch((e: unknown) => {
          svc.dispose();
          throw e;
        });
        svc.plugins = reports[0]!;
      }
    } else {
      // the inline baker uses this thread's registry
      for (const ref of plugins) svc.plugins.push(await loadPlugin(ref));
      svc.bakers = [svc.inlineBaker()];
    }
    // each keeps its share of the scenes, and at least two: a tile's bare variant follows it
    svc.meshScenes = Math.max(2, Math.ceil(MESH_SCENES / svc.bakers.length));
    for (const b of svc.bakers) b.transport.send({ ...init, meshScenes: svc.meshScenes });
    return svc;
  }

  /** How many bakers there are. */
  get workers(): number {
    return this.bakers.length;
  }

  /** Have a worker import and register plugins; resolves once it has. */
  private loadWorkerPlugins(b: Baker, plugins: PluginRef[]): Promise<PluginReport[]> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pluginJobs.set(id, { resolve, reject });
      b.transport.send({ type: "loadPlugins", id, plugins });
    });
  }

  private tryWorker(factory: () => Worker): Promise<Baker | null> {
    return new Promise((resolve) => {
      let worker: Worker;
      try {
        worker = factory();
      } catch {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => {
        worker.terminate();
        resolve(null);
      }, 10000);
      worker.onmessage = (ev: MessageEvent<FromWorker>) => {
        const msg = ev.data;
        if (msg.type === "ready") {
          clearTimeout(timer);
          this.renderer = msg.renderer;
          this.mode = "worker";
          const b: Baker = { transport: { send: (m, t = []) => worker.postMessage(m, t) }, worker, job: null, meshes: [] };
          worker.onmessage = (e: MessageEvent<FromWorker>) => this.receive(b, e.data);
          resolve(b);
        } else if (msg.type === "error") {
          clearTimeout(timer);
          worker.terminate();
          resolve(null);
        }
      };
    });
  }

  private inlineBaker(): Baker {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { antialias: false, depth: false, alpha: false });
    if (!gl) throw new Error("WebGL2 is required");
    this.mode = "inline";
    const queue: FromWorker[] = [];
    const host = new BakeHost(gl, (msg) => {
      if (msg.type === "ready") this.renderer = msg.renderer;
      else queue.push(msg);
    });
    const b: Baker = { transport: { send: () => {} }, worker: null, job: null, meshes: [] };
    b.transport = {
      send: (m) => {
        // Defer so callers see the same async behaviour as with a worker.
        setTimeout(() => {
          host.handle(m);
          for (const out of queue.splice(0)) this.receive(b, out);
        }, 0);
      },
    };
    return b;
  }

  /**
   * Stop baking: the workers end, and nothing more is sent or received.
   * Everything still asked for settles: sprite and object bakes resolve null
   * (so a layer counting them isn't left waiting), plugin loads reject, and
   * later bakes resolve null at once.
   */
  dispose(): void {
    this.disposed = true;
    for (const b of this.bakers) {
      b.worker?.terminate();
      b.worker = null;
      b.transport = { send: () => {} };
    }
    this.wanted = [];
    this.spriteQueue = [];
    const sprites = [...this.spriteJobs.values()];
    this.spriteJobs.clear();
    for (const done of sprites) done(null);
    const plugins = [...this.pluginJobs.values()];
    this.pluginJobs.clear();
    for (const job of plugins) job.reject(new Error("the bake service was disposed"));
  }

  /** Sprite and object bakes asked for and not finished yet (queued or baking). */
  get spritesPending(): number {
    return this.spriteJobs.size;
  }

  /** Replace the wanted list (highest priority first). */
  want(tiles: TileRequest[]): void {
    this.wanted = tiles;
    this.pump();
  }

  isDone(key: TileKey): boolean {
    return this.done.has(key);
  }

  /** Forget a finished tile so it can be requested again (e.g. after eviction). */
  forget(key: TileKey): void {
    this.done.delete(key);
  }

  bakeSprite(rotation: Rotation, boxes: Box[]): Promise<BakedImage | null> {
    if (this.disposed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.spriteJobs.set(id, resolve);
      this.spriteQueue.push({ id, rotation, boxes });
      this.pump();
    });
  }

  /** Bake object instances alone (hero landmarks, offline) on a terrain slice. */
  bakeObjects(rotation: Rotation, instances: ObjectInstance[], slice: TerrainSlice): Promise<BakedImage | null> {
    if (this.disposed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.spriteJobs.set(id, resolve);
      this.spriteQueue.push({ id, rotation, instances, slice });
      this.pump();
    });
  }

  /** Bake a rectangle of the world in another projection (D-155), once. */
  bakeArea(area: Omit<BakeAreaMessage, "type" | "id">): Promise<BakedImage | null> {
    if (this.disposed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.spriteJobs.set(id, resolve);
      this.spriteQueue.push({ id, ...area });
      this.pump();
    });
  }

  get idle(): boolean {
    return this.bakers.every((b) => !b.job) && this.spriteQueue.length === 0 && this.wanted.every((t) => this.done.has(requestKey(t)));
  }

  /** The first wanted tile not done or under way whose meshes no other baker keeps. */
  private nextWanted(b: Baker): TileRequest | null {
    for (const t of this.wanted) {
      const key = requestKey(t);
      if (this.done.has(key) || this.inFlight.has(key)) continue;
      const owner = this.owners.get(`${t.tx},${t.ty}`);
      if (owner === undefined || owner === b) return t;
    }
    return null;
  }

  /** Give each idle baker work: sprites first, then the wanted tiles in order. */
  private pump(): void {
    if (this.disposed) return;
    for (const b of this.bakers) {
      if (b.job) continue;
      const sprite = this.spriteQueue.shift();
      if (sprite) {
        b.job = { id: sprite.id, tile: null };
        if ("boxes" in sprite) b.transport.send({ type: "bakeSprite", ...sprite });
        else if ("owned" in sprite) b.transport.send({ type: "bakeArea", ...sprite });
        else b.transport.send({ type: "bakeObjects", ...sprite });
        continue;
      }
      const t = this.nextWanted(b);
      if (t) this.startTile(b, t);
    }
  }

  private startTile(b: Baker, t: TileRequest): void {
    const id = this.nextId++;
    const key = requestKey(t);
    const tile = { ...t, key, removed: undefined as number[] | undefined, cells: undefined as string | undefined, cut: undefined as string | undefined };
    b.job = { id, tile };
    this.inFlight.add(key);
    this.prepare(t).then(
      (prepared) => {
        tile.removed = prepared.removed?.length ? prepared.removed : undefined;
        tile.cells = prepared.cells || undefined;
        tile.cut = prepared.cut || undefined;
        if ("cached" in prepared) {
          this.finish(b, id, prepared.cached, null, true, 0, prepared.whole);
        } else {
          if (!t.ground) this.keepMeshes(b, t); // a ground bake keeps no meshes
          const variant = t.bare ? { bare: true } : t.ground ? { ground: true } : {};
          const removed = tile.removed ? { removed: tile.removed } : {};
          const cells = tile.cells ? { cells: tile.cells } : {};
          const cut = tile.cut ? { cut: tile.cut } : {};
          b.transport.send(
            { type: "bakeTile", id, rotation: t.rotation, tx: t.tx, ty: t.ty, ...variant, slice: prepared.slice, ...removed, ...cells, ...cut },
            sliceTransferables(prepared.slice),
          );
        }
      },
      (err: unknown) => {
        this.onError(`prepare ${key}: ${String(err)}`);
        this.finish(b, id, null, null, false);
      },
    );
  }

  /** As its BakeHost does: a baked tile's meshes are kept, first in first out, up to the baker's share. */
  private keepMeshes(b: Baker, t: TileRequest): void {
    const at = `${t.tx},${t.ty}`;
    this.owners.set(at, b);
    if (b.meshes.includes(at)) return;
    b.meshes.push(at);
    if (b.meshes.length > this.meshScenes) {
      const old = b.meshes.shift()!;
      if (this.owners.get(old) === b) this.owners.delete(old);
    }
  }

  private receive(b: Baker, msg: FromWorker): void {
    if (this.disposed || msg.type === "ready") return;
    const job = msg.id !== undefined ? this.pluginJobs.get(msg.id) : undefined;
    if (job) {
      this.pluginJobs.delete(msg.id!);
      if (msg.type === "pluginsLoaded") job.resolve(msg.plugins);
      else if (msg.type === "error") job.reject(new Error(`bake worker: ${msg.message}`));
      return;
    }
    if (msg.type === "pluginsLoaded") return;
    if (msg.type === "error") {
      this.onError(msg.message);
      if (msg.id !== undefined) this.finish(b, msg.id, null, null, false);
      return;
    }
    if (msg.failures) this.failures.add(msg.failures);
    this.finish(b, msg.id, msg.image, msg.stats, false, msg.failures?.length ?? 0);
  }

  private finish(b: Baker, id: number, image: BakedImage | null, stats: BakeStats | null, fromCache: boolean, modelsFailed = 0, whole = false): void {
    if (this.disposed) return; // a tile prepared, or an answer in flight, after dispose
    const job = b.job?.id === id ? b.job : null;
    if (job) b.job = null;
    const sprite = this.spriteJobs.get(id);
    if (sprite) {
      this.spriteJobs.delete(id);
      sprite(image);
    } else if (job?.tile) {
      const p = job.tile;
      this.inFlight.delete(p.key);
      this.done.add(p.key);
      // a ground request answered with the whole tile: the tile is done
      const t: TileRequest = whole ? { rotation: p.rotation, tx: p.tx, ty: p.ty } : p;
      const key = requestKey(t);
      this.done.add(key);
      if (fromCache) this.totals.fromCache++;
      else if (stats && t.ground) this.totals.ground++;
      else if (stats) {
        this.totals.tiles++;
        this.totals.meshMs += stats.meshMs;
        this.totals.bakeMs += stats.bakeMs;
        this.totals.maxTileMs = Math.max(this.totals.maxTileMs, stats.meshMs + stats.bakeMs);
      }
      const variant = t.bare ? { bare: true } : t.ground ? { ground: true } : {};
      const removed = p.removed ? { removed: p.removed } : {};
      const cells = p.cells ? { cells: p.cells } : {};
      const cut = p.cut ? { cut: p.cut } : {};
      this.onTile({ key, rotation: t.rotation, tx: t.tx, ty: t.ty, ...variant, image, stats, fromCache, modelsFailed, ...removed, ...cells, ...cut });
    }
    this.pump();
  }
}
