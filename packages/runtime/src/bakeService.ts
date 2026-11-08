import type { Rotation } from "@pixelworld/grid";
import type { BakedImage } from "@pixelworld/bake";
import type { Box, ObjectInstance } from "@pixelworld/generators";
import { BakeHost } from "./bakeHost";
import {
  sliceTransferables,
  type BakeStats,
  type FromWorker,
  type InitMessage,
  type TerrainSlice,
  type ToWorker,
} from "./protocol";

export type TileKey = string;
export const tileKey = (r: Rotation, tx: number, ty: number): TileKey => `${r}:${tx},${ty}`;

export interface TileRequest {
  rotation: Rotation;
  tx: number;
  ty: number;
}

/** What `prepare` hands back: a cached image, or a terrain slice to bake. */
export type PreparedTile = { cached: BakedImage | null } | { slice: TerrainSlice };

export interface TileResult extends TileRequest {
  key: TileKey;
  image: BakedImage | null;
  stats: BakeStats | null;
  fromCache: boolean;
}

export interface BakeTotals {
  tiles: number;
  fromCache: number;
  meshMs: number;
  bakeMs: number;
  maxTileMs: number;
}

interface Transport {
  send(msg: ToWorker, transfer?: Transferable[]): void;
}

/** Literal `new Worker(new URL(...))` so Vite bundles the worker in builds. */
export function defaultWorkerFactory(): Worker {
  return new Worker(new URL("./bake.worker.ts", import.meta.url), { type: "module" });
}

/**
 * Main-thread side of baking. Keeps a priority list of wanted tiles and works
 * through it one at a time: `prepare` either finds a cached image or loads the
 * terrain the tile needs, which is then baked in the worker (or an in-thread
 * fallback). Call `want()` every frame with tiles ordered by priority.
 */
export class BakeService {
  private transport: Transport;
  private nextId = 1;
  private busy = false;
  private wanted: TileRequest[] = [];
  private done = new Set<TileKey>();
  private pendingTile: (TileRequest & { id: number; key: TileKey }) | null = null;
  private spriteJobs = new Map<number, (img: BakedImage | null) => void>();
  private spriteQueue: (
    | { id: number; rotation: Rotation; boxes: Box[] }
    | { id: number; rotation: Rotation; instances: ObjectInstance[]; slice: TerrainSlice }
  )[] = [];
  renderer = "pending";
  mode: "worker" | "inline" = "worker";
  readonly totals: BakeTotals = { tiles: 0, fromCache: 0, meshMs: 0, bakeMs: 0, maxTileMs: 0 };
  onTile: (r: TileResult) => void = () => {};
  onError: (message: string) => void = (m) => console.error(m);

  private constructor(private readonly prepare: (t: TileRequest) => Promise<PreparedTile>) {
    this.transport = { send: () => {} };
  }

  /** Create a service backed by a worker; falls back to baking on the main thread. */
  static async create(
    init: InitMessage,
    prepare: (t: TileRequest) => Promise<PreparedTile>,
    workerFactory: (() => Worker) | null = defaultWorkerFactory,
  ): Promise<BakeService> {
    const svc = new BakeService(prepare);
    const viaWorker = workerFactory ? await svc.tryWorker(workerFactory) : false;
    if (!viaWorker) svc.useInline();
    svc.transport.send(init);
    return svc;
  }

  private tryWorker(factory: () => Worker): Promise<boolean> {
    return new Promise((resolve) => {
      let worker: Worker;
      try {
        worker = factory();
      } catch {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        worker.terminate();
        resolve(false);
      }, 10000);
      worker.onmessage = (ev: MessageEvent<FromWorker>) => {
        const msg = ev.data;
        if (msg.type === "ready") {
          clearTimeout(timer);
          this.renderer = msg.renderer;
          this.mode = "worker";
          this.transport = { send: (m, t = []) => worker.postMessage(m, t) };
          worker.onmessage = (e: MessageEvent<FromWorker>) => this.receive(e.data);
          resolve(true);
        } else if (msg.type === "error") {
          clearTimeout(timer);
          worker.terminate();
          resolve(false);
        }
      };
    });
  }

  private useInline(): void {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { antialias: false, depth: false, alpha: false });
    if (!gl) throw new Error("WebGL2 is required");
    this.mode = "inline";
    const queue: FromWorker[] = [];
    const host = new BakeHost(gl, (msg) => {
      if (msg.type === "ready") this.renderer = msg.renderer;
      else queue.push(msg);
    });
    this.transport = {
      send: (m) => {
        // Defer so callers see the same async behaviour as with a worker.
        setTimeout(() => {
          host.handle(m);
          for (const out of queue.splice(0)) this.receive(out);
        }, 0);
      },
    };
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
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.spriteJobs.set(id, resolve);
      this.spriteQueue.push({ id, rotation, boxes });
      this.pump();
    });
  }

  /** Bake object instances alone (hero landmarks, offline) on a terrain slice. */
  bakeObjects(rotation: Rotation, instances: ObjectInstance[], slice: TerrainSlice): Promise<BakedImage | null> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.spriteJobs.set(id, resolve);
      this.spriteQueue.push({ id, rotation, instances, slice });
      this.pump();
    });
  }

  get idle(): boolean {
    return !this.busy && this.spriteQueue.length === 0 && this.nextWanted() === null;
  }

  private nextWanted(): TileRequest | null {
    for (const t of this.wanted) if (!this.done.has(tileKey(t.rotation, t.tx, t.ty))) return t;
    return null;
  }

  private pump(): void {
    if (this.busy) return;
    const sprite = this.spriteQueue.shift();
    if (sprite) {
      this.busy = true;
      if ("boxes" in sprite) this.transport.send({ type: "bakeSprite", ...sprite });
      else this.transport.send({ type: "bakeObjects", ...sprite });
      return;
    }
    const t = this.nextWanted();
    if (!t) return;
    this.busy = true;
    const id = this.nextId++;
    const key = tileKey(t.rotation, t.tx, t.ty);
    this.pendingTile = { ...t, id, key };
    this.prepare(t).then(
      (prepared) => {
        if ("cached" in prepared) {
          this.finish(id, prepared.cached, null, true);
        } else {
          this.transport.send(
            { type: "bakeTile", id, rotation: t.rotation, tx: t.tx, ty: t.ty, slice: prepared.slice },
            sliceTransferables(prepared.slice),
          );
        }
      },
      (err: unknown) => {
        this.onError(`prepare ${key}: ${String(err)}`);
        this.finish(id, null, null, false);
      },
    );
  }

  private receive(msg: FromWorker): void {
    if (msg.type === "ready") return;
    if (msg.type === "error") {
      this.onError(msg.message);
      if (msg.id !== undefined) this.finish(msg.id, null, null, false);
      return;
    }
    this.finish(msg.id, msg.image, msg.stats, false);
  }

  private finish(id: number, image: BakedImage | null, stats: BakeStats | null, fromCache: boolean): void {
    this.busy = false;
    const sprite = this.spriteJobs.get(id);
    if (sprite) {
      this.spriteJobs.delete(id);
      sprite(image);
    } else if (this.pendingTile && this.pendingTile.id === id) {
      const p = this.pendingTile;
      this.pendingTile = null;
      this.done.add(p.key);
      if (fromCache) this.totals.fromCache++;
      else if (stats) {
        this.totals.tiles++;
        this.totals.meshMs += stats.meshMs;
        this.totals.bakeMs += stats.bakeMs;
        this.totals.maxTileMs = Math.max(this.totals.maxTileMs, stats.meshMs + stats.bakeMs);
      }
      this.onTile({ key: p.key, rotation: p.rotation, tx: p.tx, ty: p.ty, image, stats, fromCache });
    }
    this.pump();
  }
}
