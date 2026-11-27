import { hasGenerator, listGenerators } from "@pixelworlds/generators";
import { describe, expect, it, vi } from "vitest";
import { BakeService, type FromWorker, type InitMessage, type ToWorker } from "../../src/runtime/index";
import { bakeWorkerLoop, type BakeHandler } from "../../src/runtime/workerLoop";

/**
 * Plugins in the bake worker (D-071), in a worker-like setting: the worker's
 * message loop with a stand-in for the WebGL baker, messages passed
 * asynchronously and structured-cloned as postMessage does, and plugin
 * modules "imported by URL" from the city pack's own worker module.
 */

const CITY_SF = { name: "@pixelworlds/city-sf", url: "https://example.test/assets/worker-sf.js" };
/** `import(url)` in the worker: the city pack's module for its URL (a bundle that keeps no exports). */
const importCityPack = async (url: string): Promise<unknown> => {
  if (url !== CITY_SF.url) throw new Error(`Failed to fetch dynamically imported module: ${url}`);
  await import("../../../city-sf/src/worker");
  return {};
};
const SF_GENERATORS = ["block", "decoTower", "gate", "lanterns", "rowhouse", "sfTower"];

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A stand-in for `new Worker(bake.worker.ts)`: the real loop, a recording host, async messages. */
class FakeWorker {
  onmessage: ((ev: { data: FromWorker }) => void) | null = null;
  readonly handled: ToWorker["type"][] = [];
  terminated = false;
  private readonly handle: (msg: ToWorker) => void;

  constructor(importPlugin: (url: string) => Promise<unknown>) {
    const post = (msg: FromWorker) => setTimeout(() => this.onmessage?.({ data: structuredClone(msg) }), 0);
    const host: BakeHandler = { handle: (msg) => this.handled.push(msg.type) };
    this.handle = bakeWorkerLoop(host, post, { importPlugin });
    post({ type: "ready", renderer: "fake" }); // as BakeHost does when it starts
  }

  postMessage(msg: ToWorker): void {
    setTimeout(() => this.handle(structuredClone(msg)), 0);
  }

  terminate(): void {
    this.terminated = true;
  }
}

const init = { type: "init", tileSize: 32, margin: 8, floor: 0, worldWidth: 64, worldHeight: 64 } as unknown as InitMessage;

describe("the bake worker's plugins", () => {
  it("imports them before anything else is baked", async () => {
    expect(hasGenerator("rowhouse")).toBe(false); // a fresh worker has only the built-ins
    const posted: FromWorker[] = [];
    const handled: string[] = [];
    const handle = bakeWorkerLoop({ handle: (m) => handled.push(m.type) }, (m) => posted.push(m), { importPlugin: importCityPack });
    handle({ type: "loadPlugins", id: 1, plugins: [CITY_SF] });
    handle(init); // arrives while the plugin loads: waits
    handle({ type: "bakeSprite", id: 2, rotation: 0, boxes: [] });
    expect(handled).toEqual([]);
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(posted).toEqual([{ type: "pluginsLoaded", id: 1, plugins: [{ name: "@pixelworlds/city-sf", generators: SF_GENERATORS }] }]);
    expect(handled).toEqual(["init", "bakeSprite"]);
    for (const g of SF_GENERATORS) expect(listGenerators().find((e) => e.name === g)?.source).toBe("@pixelworlds/city-sf");
  });

  it("answers a plugin that fails to load with an error, and goes on", async () => {
    const posted: FromWorker[] = [];
    const handled: string[] = [];
    const handle = bakeWorkerLoop({ handle: (m) => handled.push(m.type) }, (m) => posted.push(m), { importPlugin: importCityPack });
    handle({ type: "loadPlugins", id: 7, plugins: [{ name: "@pixelworlds/city-nyc", url: "https://example.test/nyc.js" }] });
    handle(init);
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(posted).toEqual([
      {
        type: "error",
        id: 7,
        message:
          "plugin @pixelworlds/city-nyc (https://example.test/nyc.js) failed to import: " +
          "Failed to fetch dynamically imported module: https://example.test/nyc.js",
      },
    ]);
    expect(handled).toEqual(["init"]);
  });
});

describe("BakeService with plugins", () => {
  const prepare = () => Promise.resolve({ cached: null });

  it("has the worker load them, then sends init", async () => {
    let worker: FakeWorker | null = null;
    const factory = () => (worker = new FakeWorker(importCityPack)) as unknown as Worker;
    const svc = await BakeService.create(init, prepare, factory, { plugins: [CITY_SF] });
    expect(svc.mode).toBe("worker");
    expect(svc.plugins).toEqual([{ name: "@pixelworlds/city-sf", generators: SF_GENERATORS }]);
    await tick();
    expect(worker!.handled).toEqual(["init"]); // loadPlugins went to the loop, not the baker
    svc.dispose();
  });

  it("fails to start when a plugin doesn't load", async () => {
    let worker: FakeWorker | null = null;
    const factory = () => (worker = new FakeWorker(importCityPack)) as unknown as Worker;
    const bad = { name: "@pixelworlds/city-sf", url: "https://example.test/missing.js" };
    await expect(BakeService.create(init, prepare, factory, { plugins: [bad] })).rejects.toThrow(
      "bake worker: plugin @pixelworlds/city-sf (https://example.test/missing.js) failed to import",
    );
    expect(worker!.terminated).toBe(true);
    expect(worker!.handled).toEqual([]);
  });
});
