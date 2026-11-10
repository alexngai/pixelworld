import { describe, expect, it } from "vitest";
import { Layers } from "../src/layers";
import type { Layer, LayerContext } from "../src/types";

/** A layer with a switch, two sublayers and a counter as its state. */
function fakeLayer(id: string, available = true): Layer & { count: number; shown: Set<string>; disposed: boolean } {
  let on = true;
  return {
    id,
    label: id.toUpperCase(),
    count: 0,
    shown: new Set(["a", "b"]),
    disposed: false,
    get enabled() {
      return on;
    },
    setEnabled(v: boolean) {
      on = v;
    },
    sublayers: [
      { id: "a", label: "part a" },
      { id: "b", label: "part b" },
    ],
    isSublayerEnabled(s: string) {
      return this.shown.has(s);
    },
    setSublayerEnabled(s: string, v: boolean) {
      if (v) this.shown.add(s);
      else this.shown.delete(s);
    },
    async init() {
      return available;
    },
    serialize() {
      return { count: this.count };
    },
    restore(state: unknown) {
      this.count = (state as { count: number }).count;
    },
    dispose() {
      this.disposed = true;
    },
  };
}

function registry() {
  const contexts: string[] = [];
  let invalidations = 0;
  const layers = new Layers(
    (layer) => {
      contexts.push(layer.id);
      return {} as LayerContext;
    },
    () => invalidations++,
  );
  return { layers, contexts, invalidations: () => invalidations };
}

describe("the layer registry", () => {
  it("adds layers in order, leaving out one with nothing in the world", async () => {
    const { layers, contexts } = registry();
    expect(await layers.add(fakeLayer("traffic"))).toBe(true);
    expect(await layers.add(fakeLayer("clouds", false))).toBe(false);
    expect(await layers.add(fakeLayer("fog"))).toBe(true);
    expect(layers.list().map((l) => l.id)).toEqual(["traffic", "fog"]);
    expect(layers.get("clouds")).toBeUndefined();
    expect(contexts).toEqual(["traffic", "clouds", "fog"]);
  });

  it("refuses a second layer with the same id", async () => {
    const { layers } = registry();
    await layers.add(fakeLayer("fog"));
    await expect(layers.add(fakeLayer("fog"))).rejects.toThrow(/already has a layer "fog"/);
  });

  it("switches layers and sublayers, redrawing each time", async () => {
    const { layers, invalidations } = registry();
    await layers.add(fakeLayer("traffic"));
    await layers.add(fakeLayer("fog"));
    const before = invalidations();
    layers.enable("fog", false);
    expect(layers.get("fog")!.enabled).toBe(false);
    expect(layers.enabled().map((l) => l.id)).toEqual(["traffic"]);
    layers.enable("traffic", false, "a");
    expect(layers.get("traffic")!.isSublayerEnabled!("a")).toBe(false);
    expect(layers.get("traffic")!.enabled).toBe(true);
    layers.enable("fog");
    expect(layers.enabled().map((l) => l.id)).toEqual(["traffic", "fog"]);
    expect(invalidations() - before).toBe(3);
    layers.enable("nothing", false); // unknown ids are ignored
  });

  it("serializes and restores every layer's state by id", async () => {
    const { layers } = registry();
    const a = fakeLayer("traffic");
    const b = fakeLayer("fog");
    await layers.add(a);
    await layers.add(b);
    a.count = 3;
    b.count = 5;
    const state = layers.serialize();
    expect(state).toEqual({ traffic: { count: 3 }, fog: { count: 5 } });
    a.count = 0;
    b.count = 0;
    layers.restore(JSON.parse(JSON.stringify(state)));
    expect([a.count, b.count]).toEqual([3, 5]);
  });

  it("removes and disposes layers", async () => {
    const { layers } = registry();
    const a = fakeLayer("traffic");
    await layers.add(a);
    layers.remove("traffic");
    expect(layers.list()).toEqual([]);
    expect(a.disposed).toBe(true);
  });

  it("moves a layer added to another view: it leaves the first, and the first's teardown leaves it alone", async () => {
    const log: string[] = [];
    const layer = fakeLayer("traffic");
    layer.init = async (ctx: LayerContext) => {
      log.push(`init ${(ctx as unknown as { name: string }).name}`);
      return true;
    };
    layer.dispose = () => void log.push("dispose");
    const view = (name: string) => new Layers(() => ({ name }) as unknown as LayerContext, () => {});
    const a = view("A");
    const b = view("B");
    await a.add(layer);
    await b.add(layer); // a level switch reusing the layer, while A still draws
    expect(log).toEqual(["init A", "dispose", "init B"]);
    expect(a.list()).toEqual([]);
    expect(b.list()).toEqual([layer]);
    a.dispose(); // A destroyed when B takes over
    expect(log).toEqual(["init A", "dispose", "init B"]);
    await a.add(layer); // and back
    expect(log).toEqual(["init A", "dispose", "init B", "dispose", "init A"]);
    expect(b.list()).toEqual([]);
  });
});
