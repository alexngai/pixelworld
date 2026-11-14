import { TerrainGrid, project } from "@pixelworlds/grid";
import { Camera } from "@pixelworlds/runtime";
import { describe, expect, it } from "vitest";
import { ViewCameraImpl } from "../src/camera";
import { Controllers, listenTo } from "../src/controller";
import { Entities } from "../src/entities";
import { createQuery, type QuerySource } from "../src/queries";
import { roverController } from "../src/rover";
import type { Controller, ControllerView, KeyInput, WorldInfo } from "../src/types";

/**
 * A fake view for controllers: a 32×32 world of flat ground at 0 with a lake
 * east of x = 20 and a cliff (10 steps) south of y = 24; the real camera,
 * entities and queries over it, and no GPU.
 */
function fakeView(opts: { start?: { x: number; y: number } } = {}) {
  const g = new TerrainGrid(32, 32);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      if (x >= 20) g.water[g.index(x, y)] = 0;
      if (y >= 24) g.base[g.index(x, y)] = 10;
    }
  const src: QuerySource = {
    cellsX: 32,
    cellsY: 32,
    cell: (x, y) => (x >= 0 && y >= 0 && x < 32 && y < 32 ? { terrain: g, i: g.index(Math.floor(x), Math.floor(y)) } : null),
    surfaceHeightAt: (x, y) => g.surfaceHeightAt(x, y),
    realHeightAt: (_x, _y, h) => h,
    metersPerCellAt: () => 100,
    ensureRect: async () => {},
    isLoadedRect: () => true,
  };
  const geo = {
    cellToLonLat: (x: number, y: number): [number, number] => [x / 100, -y / 100],
    lonLatToCell: (lon: number, lat: number): [number, number] | null =>
      lon < 0 || lon > 0.32 || lat > 0 || lat < -0.32 ? null : [lon * 100, -lat * 100],
  };
  const manifest = { start: opts.start ?? { x: 10, y: 10 }, cellsX: 32, cellsY: 32, surfaces: { "0": "ground" }, scale: { metersPerCell: 100, metersPerStep: 10, elevationDatumMeters: 0 } };
  const cam = new Camera(1280, 720);
  cam.zoom = 2;
  let changes = 0;
  const query = createQuery(src, { manifest, style: {}, renderScale: 1, heightRange: [0, 10] }, geo, () => ({
    rotation: cam.rotation,
    ...cam.snapped(),
    zoom: cam.zoom,
    pixelRatio: 2,
  }));
  const camera = new ViewCameraImpl(cam, 1, () => changes++, {
    ensure: async () => {},
    heightAt: query.heightAt,
    lonLatToCell: query.lonLatToCell,
    pixelRatio: () => 2,
  });
  camera.autoZoom = false;
  const bakes: string[] = [];
  const entities = new Entities({
    bake: async (r) => {
      bakes.push(`r${r}`);
      return null;
    },
    release: () => {},
    groupBoxes: () => [],
    heightAt: query.heightAt,
    invalidate: () => changes++,
    redraw: () => {},
  });
  const captured: number[] = [];
  const world = {
    manifest,
    palette: { rampIds: new Map([["marker", 3], ["cab", 5]]), rgba: new Uint8Array(1024) },
    renderScale: 1,
    cellsX: 32,
    cellsY: 32,
  } as unknown as WorldInfo;
  const view: ControllerView = {
    canvas: { setPointerCapture: (id: number) => captured.push(id) } as unknown as HTMLCanvasElement,
    world,
    camera,
    entities,
    query,
    pixelRatio: 2,
  };
  return { view, cam, camera, entities, captured, changes: () => changes };
}

const key = (k: string): KeyInput => ({ key: k });

describe("the rover controller", () => {
  it("puts the rover at the world's start and the camera on it", async () => {
    const { view, camera, entities } = fakeView();
    const rover = roverController();
    await rover.attach(view);
    expect([rover.rover.x, rover.rover.y, rover.rover.h]).toEqual([10.5, 10.5, 0]);
    expect(rover.rover.silhouette).toBe(true);
    expect(entities.list()).toEqual([rover.rover]);
    expect([camera.x, camera.y, camera.h]).toEqual([10.5, 10.5, 0]);
  });

  it("starts at a cell or a lon/lat, and at the start when the place is outside", async () => {
    const a = fakeView();
    const r1 = roverController({ start: { x: 4, y: 26.5 } });
    await r1.attach(a.view);
    expect([r1.rover.x, r1.rover.y, r1.rover.h]).toEqual([4, 26.5, 10]);
    const b = fakeView();
    const r2 = roverController({ start: { lon: 0.05, lat: -0.07 } });
    await r2.attach(b.view);
    expect(r2.rover.x).toBeCloseTo(5, 9);
    expect(r2.rover.y).toBeCloseTo(7, 9);
    const c = fakeView();
    const r3 = roverController({ start: { lon: 3, lat: 3 } });
    await r3.attach(c.view);
    expect([r3.rover.x, r3.rover.y]).toEqual([10.5, 10.5]);
  });

  it("drives with the arrows in screen directions, and the camera follows", async () => {
    const { view, camera } = fakeView();
    const rover = roverController();
    await rover.attach(view);
    rover.keyDown(key("ArrowRight"));
    rover.update(0.1);
    // right on the screen at rotation 0 is +x −y in the grid
    const [gx, gy] = camera.screenDirToGrid(2, 0);
    expect(rover.rover.x).toBeCloseTo(10.5 + gx * 0.3, 9);
    expect(rover.rover.y).toBeCloseTo(10.5 + gy * 0.3, 9);
    expect([camera.x, camera.y]).toEqual([rover.rover.x, rover.rover.y]);
    rover.keyUp(key("ArrowRight"));
    const at = rover.rover.x;
    rover.update(0.1);
    expect(rover.rover.x).toBe(at);
  });

  it("stays out of water and off cliffs, unless no-clip", async () => {
    const { view } = fakeView({ start: { x: 19, y: 12 } });
    const rover = roverController();
    await rover.attach(view);
    // east is down-right on the screen at rotation 0
    rover.keyDown(key("ArrowRight"));
    rover.keyDown(key("ArrowDown"));
    for (let i = 0; i < 20; i++) rover.update(0.1);
    expect(rover.rover.x).toBeLessThan(20);
    rover.keyDown(key("n"));
    expect(rover.noclip).toBe(true);
    for (let i = 0; i < 5; i++) rover.update(0.1);
    expect(rover.rover.x).toBeGreaterThan(20);
    rover.keyUp(key("ArrowRight"));
    rover.keyUp(key("ArrowDown"));

    const cliff = fakeView({ start: { x: 10, y: 22 } });
    const r2 = roverController();
    await r2.attach(cliff.view);
    // south is down-left on the screen at rotation 0
    r2.keyDown(key("ArrowLeft"));
    r2.keyDown(key("ArrowDown"));
    for (let i = 0; i < 20; i++) r2.update(0.1);
    expect(r2.rover.y).toBeLessThan(24);
    expect(r2.rover.h).toBe(0);
  });

  it("pans with WASD and drags, leaving the rover; driving follows it again", async () => {
    const { view, camera, captured } = fakeView();
    const rover = roverController();
    await rover.attach(view);
    rover.keyDown(key("d"));
    rover.update(0.5);
    rover.keyUp(key("d"));
    expect(rover.follow).toBe(false);
    const before = project(camera.x, camera.y, camera.h, 0);
    expect(project(10.5, 10.5, 0, 0).sx - before.sx).toBeCloseTo(-110, 6); // 220 px/s for 0.5 s
    // a drag of 10 CSS px left at 2 device px each and 2× zoom pans 10 internal px right
    rover.pointerDown({ clientX: 100, clientY: 50, pointerId: 7 });
    expect(captured).toEqual([7]);
    rover.pointerMove({ clientX: 90, clientY: 50 });
    rover.pointerUp();
    rover.pointerMove({ clientX: 0, clientY: 0 }); // not dragging any more
    expect(project(camera.x, camera.y, camera.h, 0).sx - before.sx).toBeCloseTo(10, 6);
    rover.keyDown(key("ArrowUp"));
    rover.update(0.1);
    expect(rover.follow).toBe(true);
    expect([camera.x, camera.y]).toEqual([rover.rover.x, rover.rover.y]);
  });

  it("rotates, zooms and toggles following from its keys, and lets go of keys on blur", async () => {
    const { view, camera } = fakeView();
    const rover = roverController();
    await rover.attach(view);
    expect(rover.keyDown(key("e"))).toBe(true);
    expect(camera.rotation).toBe(1);
    rover.keyDown(key("q"));
    rover.keyDown(key("q"));
    expect(camera.rotation).toBe(3);
    rover.keyDown(key("4"));
    expect(camera.zoom).toBe(4);
    rover.keyDown(key("f"));
    expect(rover.follow).toBe(false);
    expect(rover.keyDown(key("t"))).toBe(false); // not the rover's
    rover.keyDown(key("ArrowUp"));
    rover.blur();
    const at = rover.rover.y;
    rover.update(0.1);
    expect(rover.rover.y).toBe(at);
  });

  it("keeps its place and switches in a saved state, and puts them back", async () => {
    const { view, camera } = fakeView();
    const rover = roverController();
    await rover.attach(view);
    rover.place(4.5, 26.5);
    rover.keyDown(key("n"));
    const saved = JSON.parse(JSON.stringify(rover.serialize()));
    expect(saved).toEqual({ x: 4.5, y: 26.5, h: 10, follow: true, noclip: true });
    rover.place(12, 12);
    rover.keyDown(key("n"));
    rover.restore(saved);
    expect([rover.rover.x, rover.rover.y, rover.rover.h, rover.noclip]).toEqual([4.5, 26.5, 10, true]);
    expect([camera.x, camera.y, camera.h]).toEqual([4.5, 26.5, 10]); // following: the camera is back on it
  });

  it("listens on targets it is given, and stops when detached", async () => {
    const { view, entities } = fakeView();
    const keys = new EventTarget();
    const pointer = new EventTarget();
    const rover = roverController({ listen: { keys, pointer } });
    await rover.attach(view);
    const ev = (type: string, props: object) => Object.assign(new Event(type), props);
    keys.dispatchEvent(ev("keydown", { key: "ArrowRight" }));
    rover.update(0.1);
    expect(rover.rover.x).not.toBe(10.5);
    keys.dispatchEvent(ev("keyup", { key: "ArrowRight" }));
    keys.dispatchEvent(ev("keydown", { key: "e" }));
    expect(view.camera.rotation).toBe(1);
    rover.detach();
    expect(entities.list()).toEqual([]);
    keys.dispatchEvent(ev("keydown", { key: "e" }));
    expect(view.camera.rotation).toBe(1);
  });
});

describe("controller wiring", () => {
  it("attaches one controller at a time and updates it each frame", async () => {
    const { view } = fakeView();
    const log: string[] = [];
    const make = (id: string): Controller => ({
      id,
      attach: () => void log.push(`attach ${id}`),
      detach: () => void log.push(`detach ${id}`),
      update: (dt) => void log.push(`update ${id} ${dt}`),
    });
    const host = new Controllers(view);
    await host.use(make("a"));
    host.update(0.5);
    await host.use(make("b"));
    host.update(0.25);
    await host.use(null);
    host.update(1);
    expect(log).toEqual(["attach a", "update a 0.5", "detach a", "attach b", "update b 0.25", "detach b"]);
    expect(host.current).toBeNull();
  });

  it("forwards DOM input with listenTo until stopped", () => {
    const got: string[] = [];
    const c: Controller = {
      id: "log",
      attach: () => {},
      keyDown: (e) => {
        got.push(`down ${e.key}`);
        return true;
      },
      keyUp: (e) => void got.push(`up ${e.key}`),
      blur: () => void got.push("blur"),
      pointerDown: (e) => void got.push(`pd ${e.clientX}`),
      pointerMove: (e) => void got.push(`pm ${e.clientX}`),
      pointerUp: () => void got.push("pu"),
    };
    const keys = new EventTarget();
    const pointer = new EventTarget();
    const stop = listenTo(c, { keys, pointer });
    const ev = (type: string, props: object = {}) => Object.assign(new Event(type), props);
    keys.dispatchEvent(ev("keydown", { key: "a" }));
    keys.dispatchEvent(ev("keyup", { key: "a" }));
    keys.dispatchEvent(ev("blur"));
    pointer.dispatchEvent(ev("pointerdown", { clientX: 1 }));
    pointer.dispatchEvent(ev("pointermove", { clientX: 2 }));
    pointer.dispatchEvent(ev("pointerup"));
    stop();
    keys.dispatchEvent(ev("keydown", { key: "b" }));
    expect(got).toEqual(["down a", "up a", "blur", "pd 1", "pm 2", "pu"]);
  });

  it("hands each update the frame's clock", async () => {
    const { view } = fakeView();
    const got: unknown[] = [];
    const host = new Controllers(view);
    await host.use({ id: "c", attach: () => {}, update: (dt, clock) => void got.push([dt, clock]) });
    const clock = { dt: 0, realDt: 0.016, time: 0, started: false, paused: false };
    host.update(0, clock);
    expect(got).toEqual([[0, clock]]);
  });

  it("moves a controller used in another view: detached there first, and left alone when that view goes", async () => {
    const a = fakeView();
    const b = fakeView();
    const log: string[] = [];
    const c: Controller = {
      id: "player",
      attach: (v) => void log.push(`attach ${v === a.view ? "A" : "B"}`),
      detach: () => void log.push("detach"),
      update: () => void log.push("update"),
    };
    const hostA = new Controllers(a.view);
    const hostB = new Controllers(b.view);
    await hostA.use(c);
    await hostB.use(c); // a level switch keeping the player's controller
    expect(log).toEqual(["attach A", "detach", "attach B"]);
    expect(hostA.current).toBeNull();
    expect(hostB.current).toBe(c);
    hostA.update(0.1); // the old view's frames don't step it
    await hostA.use(null); // nor does destroying the old view detach it
    expect(log).toEqual(["attach A", "detach", "attach B"]);
    hostB.update(0.1);
    expect(log.at(-1)).toBe("update");
  });
});

describe("the camera's projection to the canvas", () => {
  it("is the inverse of pick, in CSS pixels", () => {
    const { camera, view } = fakeView();
    camera.setFocus(12.3, 9.7, 0);
    for (const [x, y] of [
      [12.3, 9.7],
      [8.25, 14.5],
      [16, 5.5],
    ] as const) {
      const p = camera.project(x, y, 0);
      expect(p.onScreen).toBe(true);
      const hit = view.query.pick(p.x, p.y)!;
      expect(hit.x).toBeCloseTo(x, 4);
      expect(hit.y).toBeCloseTo(y, 4);
    }
    // the focus is the canvas's middle: 1280 × 720 device px at 2 device px per CSS px
    const mid = camera.project(12.3, 9.7, 0);
    expect(mid.x).toBeCloseTo(320, 6);
    expect(mid.y).toBeCloseTo(180, 6);
  });

  it("follows the rotation and the zoom, and says when a place is off the canvas", () => {
    const { camera, view } = fakeView();
    camera.setFocus(16, 16, 0);
    camera.rotation = 1;
    camera.zoom = 3;
    const p = camera.project(18, 15, 0);
    const hit = view.query.pick(p.x, p.y)!;
    expect(hit.x).toBeCloseTo(18, 4);
    expect(hit.y).toBeCloseTo(15, 4);
    expect(camera.project(30, 30, 0).onScreen).toBe(false);
    // higher up is higher on the canvas, 8 render px per step
    expect(camera.project(16, 16, 0).y - camera.project(16, 16, 1).y).toBeCloseTo((8 * 3) / 2, 6);
  });

  it("stands a place on the ground without a height, and answers null where there is none", () => {
    const { camera } = fakeView();
    camera.setFocus(10, 26, 10);
    expect(camera.project(10, 26)).toEqual(camera.project(10, 26, 10)); // on the cliff top
    expect(camera.project(40, 40)).toBeNull(); // outside the world
  });
});
