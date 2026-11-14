import type { FrameInfo, LayerContext, Rotation, Sprite, WorldView } from "@pixelworlds/engine";
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

/**
 * A layer context over no GPU: bakes finish when told to; the camera sits at
 * (15, 15); the ground is drawn where `ground` says (everywhere by default).
 */
function context(rotation: Rotation = 0) {
  const bakes: { rotation: Rotation; done: (s: Sprite | null) => void }[] = [];
  let invalidations = 0;
  const ground = { drawn: (_x: number, _y: number) => true };
  const frame = (): FrameInfo => ({
    rotation,
    focus: { x: 15, y: 15, h: 0 },
    zoom: 2,
    view: { left: -320, top: -180, width: 640, height: 360 },
    night: false,
    renderScale: 1,
    project: (x, y, h) => project(x, y, h, rotation),
    isDrawn: (x, y) => ground.drawn(x, y),
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
  return { ctx, bakes, frame, ground, invalidations: () => invalidations };
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
    expect(drawn.list[0]!.sx).toBe(project(v.x, v.y, v.h + 0.2, 1).sx); // not rounded: it glides
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

  it("tells a game which vehicles are near a place, with their size, while they are shown", async () => {
    const layer = trafficLayer({ routes: streets(), seed: 3, time: 2, density: 4, paused: true });
    const { ctx } = context();
    await layer.init(ctx);
    const all = layer.sim.poses(1);
    const v = all.find((p) => p.kind === "car")!;
    const near = layer.vehiclesNear(v.x, v.y, 0.01);
    expect(near.map((n) => n.id)).toContain(v.id);
    const me = near.find((n) => n.id === v.id)!;
    expect(me).toMatchObject({ x: v.x, y: v.y, heading: v.heading, kind: "car" });
    // a car at 25 m per cell is drawn at least 0.55 cells long, narrower than long
    expect(me.length).toBeGreaterThanOrEqual(0.55);
    expect(me.width).toBeLessThan(me.length);
    expect(layer.vehiclesNear(v.x, v.y, 100).length).toBe(all.length);
    layer.setSublayerEnabled("road", false);
    expect(layer.vehiclesNear(v.x, v.y, 100).every((n) => n.kind === "cablecar")).toBe(true);
    layer.setEnabled(false);
    expect(layer.vehiclesNear(v.x, v.y, 100)).toEqual([]);
  });

  it("draws a server's vehicles from its feed, loading no routes, and tells a game which are near (D-126)", async () => {
    let poses = [
      { id: 7, kind: "car" as const, variant: 2, part: 0, x: 14, y: 15, h: 0, heading: 0 },
      { id: 8, kind: "bus" as const, variant: 1, part: 0, x: 16, y: 15, h: 0, heading: Math.PI },
    ];
    const layer = trafficLayer({ feed: () => poses });
    const { ctx, bakes, frame } = context();
    (ctx.view.world.manifest as { routes?: unknown }).routes = undefined; // nothing to load
    expect(await layer.init(ctx)).toBe(true);
    expect(layer.sim.vehicles).toEqual([]); // none of its own
    expect(layer.update(1 / 60, frame())).toBe(true); // they move every frame
    layer.sprites(frame());
    for (const b of bakes) b.done({ texture: {}, image: {} } as unknown as Sprite);
    await flush();
    expect(layer.sprites(frame()).list).toHaveLength(2);
    expect(layer.drawn.map((d) => [d.id, d.x])).toEqual([
      [7, 14],
      [8, 16],
    ]);
    expect(layer.vehiclesNear(14, 15, 0.5).map((n) => n.id)).toEqual([7]);
    poses = [];
    expect(layer.update(1 / 60, frame())).toBe(false);
    expect(layer.sprites(frame()).list).toEqual([]);
  });

  it("releases its sprites when it leaves a view", async () => {
    const layer = trafficLayer({ routes: streets(), seed: 3, time: 2, density: 4, paused: true });
    const { ctx, bakes, frame } = context();
    const released: Sprite[] = [];
    ctx.releaseSprite = (s) => released.push(s);
    await layer.init(ctx);
    layer.sprites(frame());
    for (const b of bakes) b.done({ texture: {}, image: {} } as unknown as Sprite);
    await flush();
    layer.dispose();
    expect(released.length).toBe(bakes.length);
    expect(layer.spriteCount).toBe(0);
  });

  it("joins another view after its first was destroyed with bakes in flight, and completes there", async () => {
    const layer = trafficLayer({ routes: streets(), seed: 3, time: 2, density: 4, paused: true });
    const a = context();
    await layer.init(a.ctx);
    layer.sprites(a.frame());
    expect(a.bakes.length).toBeGreaterThan(0);
    // view A is destroyed: the layer leaves it with A's bakes unanswered
    layer.dispose();
    const b = context();
    expect(await layer.init(b.ctx)).toBe(true);
    expect(layer.sprites(b.frame()).complete).toBe(false); // B bakes its own sprites
    expect(b.bakes.length).toBeGreaterThan(0);
    for (const x of b.bakes) x.done({ texture: {}, image: {} } as unknown as Sprite);
    await flush();
    let drawn = layer.sprites(b.frame());
    expect(drawn.complete).toBe(true);
    expect(drawn.list.length).toBe(layer.drawn.length);
    // A's bake service settles them with null on dispose, late: nothing changes in B
    for (const x of a.bakes) x.done(null);
    await flush();
    drawn = layer.sprites(b.frame());
    expect(drawn.complete).toBe(true);
    expect(drawn.list.length).toBe(layer.drawn.length);
  });

  it("gives sprites from a view it left back to that view, and counts them for nothing in the new one", async () => {
    const layer = trafficLayer({ routes: streets(), seed: 3, time: 2, density: 4, paused: true });
    const a = context();
    const releasedA: Sprite[] = [];
    a.ctx.releaseSprite = (s) => releasedA.push(s);
    await layer.init(a.ctx);
    layer.sprites(a.frame());
    const b = context();
    await layer.init(b.ctx); // straight into B (no dispose): A's bakes are still in flight
    layer.sprites(b.frame());
    for (const x of a.bakes) x.done({ texture: {}, image: {}, from: "A" } as unknown as Sprite);
    await flush();
    expect(releasedA.length).toBe(a.bakes.length);
    expect(layer.sprites(b.frame()).complete).toBe(false); // still waiting for B's own
    for (const x of b.bakes) x.done({ texture: {}, image: {}, from: "B" } as unknown as Sprite);
    await flush();
    const drawn = layer.sprites(b.frame());
    expect(drawn.complete).toBe(true);
    expect(drawn.list.every((d) => (d.sprite as unknown as { from: string }).from === "B")).toBe(true);
  });

  it("doesn't wait forever for a sprite whose bake failed", async () => {
    const layer = trafficLayer({ routes: streets(), seed: 3, time: 2, density: 4, paused: true });
    const { ctx, bakes, frame } = context();
    await layer.init(ctx);
    layer.sprites(frame());
    const asked = bakes.length;
    bakes[0]!.done(null);
    for (const b of bakes.slice(1)) b.done({ texture: {}, image: {} } as unknown as Sprite);
    await flush();
    const drawn = layer.sprites(frame());
    expect(drawn.complete).toBe(true);
    expect(bakes.length).toBe(asked); // not asked for again
    expect(drawn.list.length).toBeLessThan(layer.sim.poses(1).length);
  });

  it("leaves out vehicles where the ground isn't drawn yet, still baking their sprites", async () => {
    const layer = trafficLayer({ routes: streets(), seed: 3, time: 2, density: 4, paused: true });
    const { ctx, bakes, frame, ground } = context();
    await layer.init(ctx);
    ground.drawn = (x) => x >= 15.5; // the west half is a tile still baking
    layer.sprites(frame());
    for (const b of bakes) b.done({ texture: {}, image: {} } as unknown as Sprite);
    await flush();
    const drawn = layer.sprites(frame());
    expect(drawn.complete).toBe(true);
    expect(layer.drawn.length).toBeGreaterThan(0);
    expect(layer.drawn.every((v) => v.x >= 15.5)).toBe(true);
    expect(layer.sim.poses(1).some((v) => v.x < 15.5)).toBe(true);
    // the tile arrives: they show at once, their sprites were baked meanwhile
    ground.drawn = () => true;
    const asked = bakes.length;
    expect(layer.sprites(frame()).list.length).toBe(layer.sim.poses(1).length);
    expect(bakes.length).toBe(asked);
  });

  it("keeps its simulation when it leaves a view, for a save", async () => {
    const layer = trafficLayer({ routes: streets(), seed: 3, time: 2, density: 4, paused: true });
    const { ctx } = context();
    await layer.init(ctx);
    const ticks = layer.sim.ticks;
    layer.dispose();
    expect(layer.drawn).toEqual([]);
    expect(layer.serialize().sim.ticks).toBe(ticks);
  });
});
