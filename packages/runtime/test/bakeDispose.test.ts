import { describe, expect, it } from "vitest";
import { BakeService, type FromWorker, type InitMessage, type ToWorker } from "../src/index";

/**
 * Disposing a bake service with bakes in flight (D-073): what was asked for
 * settles, so a layer counting its sprite bakes isn't left waiting forever
 * after its view is destroyed.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A worker that starts, records what it is sent and answers only when told to. */
class SilentWorker {
  onmessage: ((ev: { data: FromWorker }) => void) | null = null;
  readonly sent: ToWorker[] = [];
  terminated = false;

  constructor() {
    setTimeout(() => this.onmessage?.({ data: { type: "ready", renderer: "fake" } }), 0);
  }

  postMessage(msg: ToWorker): void {
    this.sent.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Answer a bake as the worker would. */
  answer(id: number): void {
    this.onmessage?.({ data: { type: "baked", id, image: { width: 1, height: 1, pixels: new Uint8Array(4) }, stats: null } as unknown as FromWorker });
  }
}

const init = { type: "init", tileSize: 32, margin: 8, floor: 0, worldWidth: 64, worldHeight: 64 } as unknown as InitMessage;

async function service() {
  let worker: SilentWorker | null = null;
  const prepared: string[] = [];
  const svc = await BakeService.create(
    init,
    async (t) => {
      prepared.push(`${t.tx},${t.ty}`);
      return { cached: null };
    },
    () => (worker = new SilentWorker()) as unknown as Worker,
  );
  return { svc, worker: worker!, prepared };
}

describe("disposing the bake service", () => {
  it("resolves sprite and object bakes in flight and queued with null", async () => {
    const { svc, worker } = await service();
    const results: unknown[] = [];
    const a = svc.bakeSprite(0, []).then((img) => results.push(img));
    const b = svc.bakeSprite(1, []).then((img) => results.push(img)); // queued behind a
    const c = svc.bakeObjects(0, [], { x0: 0, y0: 0, width: 0, height: 0 } as never).then((img) => results.push(img));
    expect(svc.spritesPending).toBe(3);
    expect(worker.sent.filter((m) => m.type === "bakeSprite")).toHaveLength(1);
    svc.dispose();
    await Promise.all([a, b, c]);
    expect(results).toEqual([null, null, null]);
    expect(svc.spritesPending).toBe(0);
    expect(worker.terminated).toBe(true);
  });

  it("answers later bakes with null at once, and drops answers that arrive after", async () => {
    const { svc, worker } = await service();
    const first = svc.bakeSprite(0, []);
    const id = (worker.sent.find((m) => m.type === "bakeSprite") as { id: number }).id;
    svc.dispose();
    worker.answer(id); // too late: the service is gone
    expect(await first).toBeNull();
    expect(await svc.bakeSprite(0, [])).toBeNull();
    expect(worker.sent.filter((m) => m.type === "bakeSprite")).toHaveLength(1);
  });

  it("stops handing tiles to its owner after dispose", async () => {
    const { svc, prepared } = await service();
    const tiles: string[] = [];
    svc.onTile = (r) => tiles.push(r.key);
    svc.want([{ rotation: 0, tx: 0, ty: 0 }]); // prepares the tile, which finishes after dispose
    svc.dispose();
    await tick();
    expect(prepared).toEqual(["0,0"]);
    expect(tiles).toEqual([]);
  });

  it("still bakes normally until then", async () => {
    const { svc, worker } = await service();
    const sprite = svc.bakeSprite(0, []);
    const id = (worker.sent.find((m) => m.type === "bakeSprite") as { id: number }).id;
    worker.answer(id);
    expect(await sprite).toMatchObject({ width: 1, height: 1 });
    expect(svc.spritesPending).toBe(0);
    svc.dispose();
  });
});
