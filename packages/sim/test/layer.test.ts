import type { FrameInfo, LayerContext, Rotation, Sprite, WorldView } from "@pixelworld/engine";
import { describe, expect, it } from "vitest";
import { RouteNetwork, parseRoutes, trafficLayer, type RoutesFile } from "../src";

/** The isometric projection (architecture §3.4) in rotations 0 and 1, as the engine's frame gives it. */
function project(x: number, y: number, h: number, r: Rotation) {
  const [u, v] = r === 0 ? [x, y] : [-y, x];
  return { sx: 16 * (u - v), sy: 8 * (u + v) - 8 * h, depth: u + v + h / 3 };
}

/** Two crossing streets 30 cells long and a cable car line beside them. */
function streets(): RouteNetwork {
  const nodes: [number, number, number][] = [
    [0.5, 15.5, 0],
    [15.5, 15.5, 0],
    [30.5, 15.5, 0],
    [15.5, 0.5, 0],
    [15.5, 30.5, 0],
    [20.5, 0.5, 0],
    [20.5, 30.5, 0],
  ];
  const line = (a: number, b: number) => {
    const [ax, ay] = nodes[a]!;
    const [bx, by] = nodes[b]!;
    const pts: number[] = [];
    for (let i = 0; i <= 15; i++) pts.push(ax + ((bx - ax) * i) / 15, ay + ((by - ay) * i) / 15, 0);
    return pts;
  };
  const file: RoutesFile = {
    version: 1,
    nodes,
    routes: [
      { net: "road", cls: "primary", a: 0, b: 1, pts: line(0, 1), w: 0.4 },
      { net: "road", cls: "primary", a: 1, b: 2, pts: line(1, 2), w: 0.4 },
      { net: "road", cls: "primary", a: 3, b: 1, pts: line(3, 1), w: 0.4 },
      { net: "road", cls: "primary", a: 1, b: 4, pts: line(1, 4), w: 0.4 },
      { net: "rail", kind: "cablecar", a: 5, b: 6, pts: line(5, 6) },
    ],
  };
  return new RouteNetwork(parseRoutes(file));
}

/** A layer context over no GPU: bakes finish when told to; the camera sits at (15, 15). */
function context(rotation: Rotation = 0) {
  const bakes: { rotation: Rotation; done: (s: Sprite | null) => void }[] = [];
  let invalidations = 0;
  const frame = (): FrameInfo => ({
    rotation,
    focus: { x: 15, y: 15, h: 0 },
    zoom: 2,
    view: { left: -320, top: -180, width: 640, height: 360 },
    night: false,
    renderScale: 1,
    project: (x, y, h) => project(x, y, h, rotation),
  });
  const view = {
    world: {
      url: "/nowhere/",
      manifest: { scale: { metersPerCell: 25 }, level: "drive" },
      renderScale: 1,
      palette: { rampIds: new Map([["marker", 1], ["concrete", 2]]) },
      style: {},
    },
  } as unknown as WorldView;
  const ctx: LayerContext = {
    view,
    bakeSprite: (r) => new Promise((done) => bakes.push({ rotation: r, done })),
    releaseSprite: () => {},
    frame,
    invalidate: () => invalidations++,
  };
  return { ctx, bakes, frame, invalidations: () => invalidations };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the traffic layer", () => {
  it("joins a view around its camera and runs as far along as asked", async () => {
    const layer = trafficLayer({ routes: streets(), seed: 3, time: 2, density: 4 });
    const { ctx } = context();
    expect(await layer.init(ctx)).toBe(true);
    expect(layer.sim.ticks).toBe(60);
    expect(layer.sim.vehicles.length).toBeGreaterThan(0);
    expect(layer.sim.serialize().focus).toMatchObject({ x: 15, y: 15 });
  });

  it("is left out of a world without routes", async () => {
    const layer = trafficLayer();
    const { ctx } = context();
    (ctx.view.world.manifest as { routes?: unknown }).routes = undefined;
    expect(await layer.init(ctx)).toBe(false);
  });

  it("bakes vehicle sprites in rotation 0, one per model and heading, and draws them once baked", async () => {
    const layer = trafficLayer({ routes: streets(), seed: 3, time: 2, density: 4, paused: true });
    const { ctx, bakes, frame } = context(1);
    await layer.init(ctx);
    let drawn = layer.sprites(frame());
    expect(drawn.complete).toBe(false);
    expect(bakes.length).toBeGreaterThan(0);
    expect(bakes.every((b) => b.rotation === 0)).toBe(true);
    expect(layer.drawn.length).toBe(layer.sim.poses(1).length);
    const asked = bakes.length;
    layer.sprites(frame());
    expect(bakes.length).toBe(asked); // no second request while baking
    for (const b of bakes) b.done({ texture: {}, image: {} } as unknown as Sprite);
    await flush();
    drawn = layer.sprites(frame());
    expect(drawn.complete).toBe(true);
    expect(drawn.list.length).toBe(layer.drawn.length);
    const v = layer.drawn[0]!;
    expect(drawn.list[0]!.sx).toBe(Math.round(project(v.x, v.y, v.h + 0.2, 1).sx));
    expect(drawn.list[0]!.silhouette).toBe(false);
  });

  it("switches sublayers without changing the simulation, and draws nothing while off", async () => {
    const layer = trafficLayer({ routes: streets(), seed: 3, time: 2, density: 4, paused: true });
    const { ctx, frame, invalidations } = context();
    await layer.init(ctx);
    const kinds = () => new Set(layer.drawn.map((v) => v.kind));
    layer.sprites(frame());
    expect(kinds().has("car")).toBe(true);
    expect(kinds().has("cablecar")).toBe(true);
    layer.setSublayerEnabled("road", false);
    layer.sprites(frame());
    expect([...kinds()]).toEqual(["cablecar"]);
    expect(layer.isSublayerEnabled("road")).toBe(false);
    layer.setSublayers(["road"]);
    layer.sprites(frame());
    expect([...kinds()]).toEqual(["car"]);
    const n = invalidations();
    layer.setEnabled(false);
    expect(layer.drawn).toEqual([]);
    expect(invalidations()).toBe(n + 1);
    expect(() => layer.setSublayerEnabled("boats", true)).toThrow();
  });

  it("holds still while paused, and steps by whole ticks", async () => {
    const layer = trafficLayer({ routes: streets(), seed: 3, density: 4, paused: true });
    const { ctx, frame } = context();
    await layer.init(ctx);
    expect(layer.update(0.5, frame())).toBe(false);
    expect(layer.sim.ticks).toBe(0);
    layer.step(1);
    expect(layer.sim.ticks).toBe(30);
    layer.setPaused(false);
    layer.update(0.1, frame());
    expect(layer.sim.ticks).toBe(33);
  });

  it("serializes and restores its whole state: the same state runs the same way", async () => {
    const a = trafficLayer({ routes: streets(), seed: 5, time: 3, density: 4 });
    const ctxA = context();
    await a.init(ctxA.ctx);
    a.setSublayers(["rail"]);
    const state = JSON.parse(JSON.stringify(a.serialize()));
    const b = trafficLayer({ routes: streets(), seed: 99, density: 4 });
    const ctxB = context();
    await b.init(ctxB.ctx);
    b.restore(state);
    expect([...b.shown]).toEqual(["rail"]);
    for (let i = 0; i < 40; i++) {
      a.update(1 / 30, ctxA.frame());
      b.update(1 / 30, ctxB.frame());
    }
    expect(b.sim.serialize()).toEqual(a.sim.serialize());
  });
});
