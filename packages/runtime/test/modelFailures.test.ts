import type { ModelFailure } from "@pixelworlds/generators";
import { describe, expect, it, vi } from "vitest";
import { BakeService, ModelFailures, modelFailureMessage, type FromWorker, type InitMessage, type ToWorker } from "../src/index";

/**
 * Models that fail to generate (D-072): drawn as markers by the bake, counted
 * once per model however many tiles bake them, and reported once per
 * generator and cause, with what's needed to find them.
 */

const threw = (over: Partial<ModelFailure> = {}): ModelFailure => ({
  group: "building.residential",
  generator: "adobe",
  seed: 1234,
  x: 812,
  y: 431,
  footprint: { cells: [11, 12], voxels: [176, 192] },
  heightVox: 96,
  source: "@pixelworlds/city-demo",
  plugin: null,
  error: "Error: adobe: lot too big (176x192)",
  ...over,
});
const missing = (over: Partial<ModelFailure> = {}): ModelFailure =>
  threw({
    generator: "rowhouse",
    source: null,
    plugin: "@pixelworlds/city-sf",
    error: "MissingGeneratorError: no generator named 'rowhouse' (asked for by building.residential). 'rowhouse' comes with the plugin @pixelworlds/city-sf, which isn't loaded here: …",
    ...over,
  });

describe("a failed model's error", () => {
  it("names the group, place, seed, footprint, generator and its source, and the cause", () => {
    expect(modelFailureMessage(threw())).toBe(
      "model failed: building.residential at cell 812,431, seed 1234, footprint 11×12 cells (176×192 voxels), 96 voxels tall: " +
        "generator 'adobe' (@pixelworlds/city-demo) failed: Error: adobe: lot too big (176x192) " +
        "It is drawn as a missing-model marker; other models of 'adobe' that fail alike are only counted (stats().modelsFailed).",
    );
  });

  it("names the plugin a missing generator comes with", () => {
    const m = modelFailureMessage(missing());
    expect(m).toContain("generator 'rowhouse' isn't registered: MissingGeneratorError: no generator named 'rowhouse'");
    expect(m).toContain("comes with the plugin @pixelworlds/city-sf, which isn't loaded here");
  });

  it("names the plugins the style asks for but the view didn't load, for a generator nobody knows", () => {
    const f = missing({ generator: "adobe", plugin: null, error: "MissingGeneratorError: no generator named 'adobe' …" });
    expect(modelFailureMessage(f, ["@pixelworlds/city-demo"])).toContain(
      "The style pack names the plugin @pixelworlds/city-demo, which this view didn't load: 'adobe' likely comes with it.",
    );
    expect(modelFailureMessage(f, [])).not.toContain("The style pack names");
  });

  it("says where a repeated object's variant was first placed", () => {
    const f = threw({ group: "tree.conifer", generator: "conifer", repeated: true, footprint: undefined, heightVox: undefined, seed: 8919 });
    expect(modelFailureMessage(f)).toMatch(/^model failed: a repeated tree\.conifer model \(first placed at cell 812,431, seed 8919\): /);
  });
});

describe("counting and reporting failed models", () => {
  it("reports each generator and cause once, and counts each model once", () => {
    const report = vi.fn();
    const failures = new ModelFailures(report);
    // the same model in two tiles' bakes, and its neighbour that fails alike
    failures.add([threw(), threw({ x: 820, seed: 99, error: "Error: adobe: lot too big (12x9)" })]);
    failures.add([threw()]);
    expect(report).toHaveBeenCalledTimes(1);
    expect(failures.count).toBe(2);
    // another cause of the same generator, and another generator
    failures.add([threw({ x: 1, error: "TypeError: ctx.mask is undefined" }), missing({ x: 2 }), missing({ x: 3 })]);
    expect(report).toHaveBeenCalledTimes(3);
    expect(failures.count).toBe(5);
    // a repeated object's variant counts once wherever it is placed
    const tree = { group: "tree.conifer", generator: "conifer", repeated: true, seed: 8919 };
    failures.add([threw({ ...tree, x: 5 }), threw({ ...tree, x: 50 })]);
    expect(failures.count).toBe(6);
    expect(report.mock.calls.map((c) => (c[1] as ModelFailure).generator)).toEqual(["adobe", "adobe", "rowhouse", "conifer"]);
  });
});

describe("BakeService with failed models", () => {
  /** A worker whose bakes report failed models, as BakeHost does. */
  class FakeWorker {
    onmessage: ((ev: { data: FromWorker }) => void) | null = null;
    constructor(private readonly failures: (tx: number) => ModelFailure[]) {
      setTimeout(() => this.post({ type: "ready", renderer: "fake" }), 0);
    }
    private post(msg: FromWorker) {
      setTimeout(() => this.onmessage?.({ data: structuredClone(msg) }), 0);
    }
    postMessage(msg: ToWorker): void {
      if (msg.type !== "bakeTile") return;
      const stats = { meshMs: 1, bakeMs: 1, vertices: 1, shadowMapSize: [0, 0] as [number, number] };
      const failures = this.failures(msg.tx);
      this.post({ type: "baked", id: msg.id, image: null, stats, ...(failures.length ? { failures } : {}) });
    }
    terminate(): void {}
  }
  const init = { type: "init", tileSize: 32, margin: 8, floor: 0, worldWidth: 96, worldHeight: 32 } as unknown as InitMessage;
  const prepare = () => Promise.resolve({ slice: { x0: 0, y0: 0, width: 1, height: 1, layers: {} } } as never);

  it("bakes every tile, counts the failed models and reports once per generator and cause", async () => {
    const factory = () => new FakeWorker((tx) => (tx < 2 ? [missing({ x: 10 + tx }), threw()] : [])) as unknown as Worker;
    const svc = await BakeService.create(init, prepare, factory);
    const errors: string[] = [];
    svc.onError = (m) => errors.push(m);
    svc.failures.unloaded = [];
    const tiles: string[] = [];
    svc.onTile = (t) => tiles.push(t.key);
    svc.want([0, 1, 2].map((tx) => ({ rotation: 0, tx, ty: 0 })));
    await vi.waitFor(() => expect(tiles).toHaveLength(3));
    expect(svc.failures.count).toBe(3); // two rowhouses and one adobe (in both tiles' margins)
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/^model failed: building\.residential at cell 10,431, seed 1234, .*'rowhouse' comes with the plugin @pixelworlds\/city-sf/);
    expect(errors[1]).toMatch(/generator 'adobe' \(@pixelworlds\/city-demo\) failed/);
    svc.dispose();
  });
});
