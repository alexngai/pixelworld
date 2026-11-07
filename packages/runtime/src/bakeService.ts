import type { Rotation } from "@pixelworld/grid";
import type { BakedImage } from "@pixelworld/bake";
import type { Box } from "@pixelworld/generators";
import { BakeHost } from "./bakeHost";
import type { BakeStats, FromWorker, InitMessage, ToWorker } from "./protocol";

export type TileKey = string;
export const tileKey = (r: Rotation, tx: number, ty: number): TileKey => `${r}:${tx},${ty}`;

export interface TileResult {
  key: TileKey;
  rotation: Rotation;
  tx: number;
  ty: number;
  image: BakedImage | null;
  stats: BakeStats;
}

export interface BakeTotals {
  tiles: number;
  meshMs: number;
  bakeMs: number;
  maxTileMs: number;
}

/** Literal `new Worker(new URL(...))` so Vite bundles the worker in builds. */
export function defaultWorkerFactory(): Worker {
  return new Worker(new URL("./bake.worker.ts", import.meta.url), { type: "module" });
}

interface Transport {
  send(msg: ToWorker, transfer?: Transferable[]): void;
}

/**
 * Main-thread side of baking. Keeps a priority list of wanted tiles, sends
 * one job at a time to the worker (or an in-thread fallback) and reports
 * results. Call `want()` every frame with tiles ordered by priority.
 */
export class BakeService {
  private transport: Transport;
  private nextId = 1;
  private busy = false;
  private wanted: { rotation: Rotation; tx: number; ty: number }[] = [];
  private done = new Set<TileKey>();
  private pendingTile: { id: number; key: TileKey; rotation: Rotation; tx: number; ty: number } | null =
    null;
  private spriteJobs = new Map<number, (img: BakedImage | null) => void>();
  private spriteQueue: { id: number; rotation: Rotation; boxes: Box[] }[] = [];
  renderer = "pending";
  mode: "worker" | "inline" = "worker";
  readonly totals: BakeTotals = { tiles: 0, meshMs: 0, bakeMs: 0, maxTileMs: 0 };
  onTile: (r: TileResult) => void = () => {};
  onError: (message: string) => void = (m) => console.error(m);

  private constructor(transport: Transport | null) {
    this.transport = transport ?? { send: () => {} };
  }

  /** Create a service backed by a worker; falls back to baking on the main thread. */
  static async create(
    init: InitMessage,
    workerFactory: (() => Worker) | null = defaultWorkerFactory,
  ): Promise<BakeService> {
    const svc = new BakeService(null);
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
    let host: BakeHost | null = null;
    const queue: FromWorker[] = [];
    host = new BakeHost(gl, (msg) => {
      if (msg.type === "ready") this.renderer = msg.renderer;
      else queue.push(msg);
    });
    this.transport = {
      send: (m) => {
        // Defer so callers see the same async behaviour as with a worker.
        setTimeout(() => {
          host!.handle(m);
          for (const out of queue.splice(0)) this.receive(out);
        }, 0);
      },
    };
  }

  /** Replace the wanted list (highest priority first). */
  want(tiles: { rotation: Rotation; tx: number; ty: number }[]): void {
    this.wanted = tiles;
    this.pump();
  }

  isDone(key: TileKey): boolean {
    return this.done.has(key);
  }

  bakeSprite(rotation: Rotation, boxes: Box[]): Promise<BakedImage | null> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.spriteJobs.set(id, resolve);
      this.spriteQueue.push({ id, rotation, boxes });
      this.pump();
    });
  }

  get idle(): boolean {
    return !this.busy && this.spriteQueue.length === 0 && this.nextWanted() === null;
  }

  private nextWanted() {
    for (const t of this.wanted) if (!this.done.has(tileKey(t.rotation, t.tx, t.ty))) return t;
    return null;
  }

  private pump(): void {
    if (this.busy) return;
    const sprite = this.spriteQueue.shift();
    if (sprite) {
      this.busy = true;
      this.transport.send({ type: "bakeSprite", ...sprite });
      return;
    }
    const t = this.nextWanted();
    if (!t) return;
    const id = this.nextId++;
    this.busy = true;
    this.pendingTile = { id, key: tileKey(t.rotation, t.tx, t.ty), ...t };
    this.transport.send({ type: "bakeTile", id, ...t });
  }

  private receive(msg: FromWorker): void {
    if (msg.type === "ready") return;
    if (msg.type === "error") {
      this.onError(msg.message);
      if (msg.id !== undefined) this.finish(msg.id, null, null);
      return;
    }
    this.finish(msg.id, msg.image, msg.stats);
  }

  private finish(id: number, image: BakedImage | null, stats: BakeStats | null): void {
    this.busy = false;
    const sprite = this.spriteJobs.get(id);
    if (sprite) {
      this.spriteJobs.delete(id);
      sprite(image);
    } else if (this.pendingTile && this.pendingTile.id === id) {
      const p = this.pendingTile;
      this.pendingTile = null;
      this.done.add(p.key);
      const s = stats ?? { meshMs: 0, bakeMs: 0, vertices: 0, shadowMapSize: [0, 0] as [number, number] };
      this.totals.tiles++;
      this.totals.meshMs += s.meshMs;
      this.totals.bakeMs += s.bakeMs;
      this.totals.maxTileMs = Math.max(this.totals.maxTileMs, s.meshMs + s.bakeMs);
      this.onTile({ key: p.key, rotation: p.rotation, tx: p.tx, ty: p.ty, image, stats: s });
    }
    this.pump();
  }
}
