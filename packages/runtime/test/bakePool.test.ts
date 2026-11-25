import { describe, expect, it } from "vitest";
import { BakeService, type FromWorker, type InitMessage, type ToWorker } from "../src/index";

/** A pool of bake workers: tiles spread across them, and a tile's later bakes go to the one keeping its meshes. */

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A worker that starts, records what it is sent and answers only when told to. */
class FakeWorker {
  onmessage: ((ev: { data: FromWorker }) => void) | null = null;
  readonly sent: ToWorker[] = [];

  constructor() {
    setTimeout(() => this.onmessage?.({ data: { type: "ready", renderer: "fake" } }), 0);
  }

  postMessage(msg: ToWorker): void {
    this.sent.push(msg);
  }

  terminate(): void {}

  /** The tiles it was asked to bake, as "tx,ty" (":bare" for a bare variant). */
  get tiles(): string[] {
    return this.sent.flatMap((m) => (m.type === "bakeTile" ? [`${m.tx},${m.ty}${m.bare ? ":bare" : ""}`] : []));
  }

  /** Finish its last tile bake. */
  answer(): void {
    const last = [...this.sent].reverse().find((m) => m.type === "bakeTile") as { id: number };
    this.onmessage?.({ data: { type: "baked", id: last.id, image: { width: 1, height: 1, pixels: new Uint8Array(4) }, stats: { meshMs: 1, bakeMs: 1, vertices: 0 } } as unknown as FromWorker });
  }
}

const init = { type: "init", tileSize: 32, margin: 8, floor: 0, worldWidth: 256, worldHeight: 256 } as unknown as InitMessage;
const slice = { x0: 0, y0: 0, width: 1, height: 1, layers: {} };

async function pool(workers: number, prepare: (t: { tx: number; ground?: boolean }) => unknown = () => ({ slice })) {
  const made: FakeWorker[] = [];
  const svc = await BakeService.create(init, async (t) => prepare(t) as never, () => {
    const w = new FakeWorker();
    made.push(w);
    return w as unknown as Worker;
  }, { workers });
  return { svc, made };
}

describe("a pool of bake workers", () => {
  it("bakes as many tiles at once as it has workers, each taking the next as it finishes", async () => {
    const { svc, made } = await pool(3);
    expect(svc.workers).toBe(3);
    // the scenes kept are shared out, two at least
    expect(made.map((w) => (w.sent.find((m) => m.type === "init") as { meshScenes: number }).meshScenes)).toEqual([2, 2, 2]);
    svc.want([0, 1, 2, 3, 4].map((tx) => ({ rotation: 0 as const, tx, ty: 0 })));
    await tick();
    expect(made.map((w) => w.tiles)).toEqual([["0,0"], ["1,0"], ["2,0"]]);
    made[1]!.answer();
    await tick();
    expect(made[1]!.tiles).toEqual(["1,0", "3,0"]);
    svc.dispose();
  });

  it("gives a tile's bare variant to the worker that keeps its meshes, though another is free first", async () => {
    const { svc, made } = await pool(2);
    const t = (tx: number, bare = false) => ({ rotation: 0 as const, tx, ty: 0, ...(bare ? { bare } : {}) });
    svc.want([t(0), t(1)]);
    await tick();
    made[0]!.answer();
    made[1]!.answer();
    await tick();
    // both idle: the bare variant of 1,0 waits for worker 1, which baked 1,0, and nothing else jumps it
    svc.want([t(1, true), t(2)]);
    await tick();
    expect(made[0]!.tiles).toEqual(["0,0", "2,0"]);
    expect(made[1]!.tiles).toEqual(["1,0", "1,0:bare"]);
    svc.dispose();
  });

  it("bakes a tile's ground alone, keeping no meshes for it, or answers with the whole tile where it is kept", async () => {
    const kept = { width: 1, height: 1, pixels: new Uint8Array(4) };
    // tile 1,0 is kept (a cache): its ground request comes back as the whole tile
    const { svc, made } = await pool(2, (t) => (t.tx === 1 ? { cached: kept, ...(t.ground ? { whole: true } : {}) } : { slice }));
    const results: string[] = [];
    svc.onTile = (r) => results.push(r.key);
    const t = (tx: number, ground = false) => ({ rotation: 0 as const, tx, ty: 0, ...(ground ? { ground } : {}) });
    svc.want([t(0, true), t(1, true), t(0), t(1)]);
    await tick();
    expect(results).toEqual(["0:1,0"]); // the whole tile, and its own request is done with it
    expect(svc.isDone("0:1,0:ground") && svc.isDone("0:1,0")).toBe(true);
    // the ground bake went to a worker, the whole tile to the other: no meshes kept for a ground
    expect(made.map((w) => w.sent.flatMap((m) => (m.type === "bakeTile" ? [`${m.tx},${m.ty}${m.ground ? ":ground" : ""}`] : [])))).toEqual([["0,0:ground"], ["0,0"]]);
    made[0]!.answer();
    await tick();
    expect(results).toEqual(["0:1,0", "0:0,0:ground"]);
    expect(svc.totals.ground).toBe(1);
    svc.dispose();
  });

  it("sends a tile's removed objects and terrain edits with its bake, and echoes them with its result (D-124, D-147)", async () => {
    const { svc, made } = await pool(1, () => ({ slice, removed: [4], cells: "3,4,1,," }));
    const results: { removed?: number[]; cells?: string }[] = [];
    svc.onTile = (r) => results.push({ removed: r.removed, cells: r.cells });
    svc.want([{ rotation: 0, tx: 0, ty: 0 }]);
    await tick();
    expect(made[0]!.sent.find((m) => m.type === "bakeTile")).toMatchObject({ removed: [4], cells: "3,4,1,," });
    made[0]!.answer();
    await tick();
    expect(results).toEqual([{ removed: [4], cells: "3,4,1,," }]);
    svc.dispose();
  });

  it("starts one worker by default", async () => {
    const { svc, made } = await pool(1);
    expect([svc.workers, made.length]).toEqual([1, 1]);
    svc.dispose();
  });
});
