import { project } from "@pixelworlds/grid";
import type { TileRequest } from "@pixelworlds/runtime";
import { describe, expect, it } from "vitest";
import { BakedTiles, CameraMotion, MAX_CAMERA_SPEED, Prefetches, TileGrid, bakeOrder, shiftView, type TileInView } from "../src/tiles";

/** A flat world of 128 × 96 cells in 32-cell tiles (4 × 3), at render scale 1. */
const grid = () => new TileGrid(128, 96, 32, 1, 0, false, () => [0, 0]);
const key = (t: TileRequest) => `${t.tx},${t.ty}`;

/** A view of w × h render px centred on a cell. */
function viewOn(x: number, y: number, w = 64, h = 32) {
  const c = project(x, y, 0, 0);
  return { left: Math.floor(c.sx - w / 2), top: Math.floor(c.sy - h / 2), width: w, height: h };
}

describe("the tile grid", () => {
  it("finds the tile under a point, and none outside the world", () => {
    const g = grid();
    expect(g.tileAt(0, 0)).toEqual({ tx: 0, ty: 0 });
    expect(g.tileAt(33.5, 64)).toEqual({ tx: 1, ty: 2 });
    expect(g.tileAt(127.9, 95.9)).toEqual({ tx: 3, ty: 2 });
    expect(g.tileAt(128, 0)).toBeNull();
    expect(g.tileAt(-0.1, 4)).toBeNull();
  });

  it("finds the tiles within a radius of a point, nearest first", () => {
    const g = grid();
    expect(g.around(0, 40, 40, 5).map(key)).toEqual(["1,1"]);
    const ten = g.around(2, 40, 40, 10);
    expect(ten.map(key)[0]).toBe("1,1");
    expect(new Set(ten.map(key))).toEqual(new Set(["1,1", "0,1", "1,0"])); // (0, 0) is 11.3 cells off
    expect(ten.every((t) => t.rotation === 2)).toBe(true);
    expect(g.around(0, 0, 0, 0).map(key)).toEqual(["0,0"]);
  });

  it("lists the tiles a view shows, the one under its centre first", () => {
    const g = grid();
    const seen = g.visibleFrom(0, viewOn(64.5, 48.5));
    expect(key(seen[0]!)).toBe("2,1");
    expect(seen.every((t) => g.inView(0, viewOn(64.5, 48.5)).find((u) => key(u) === key(t))?.visible)).toBe(true);
  });
});

describe("tall objects", () => {
  it("keep their tile in view as far up as they reach", () => {
    // a view well above tile (1, 1)'s ground: only something tall there reaches it
    const view = viewOn(48, 48);
    const high = { ...view, top: view.top - 400 };
    const g = new TileGrid(128, 96, 32, 1, 0, true, () => [0, 0]);
    expect(g.inView(0, high).some((t) => key(t) === "1,1" && t.visible)).toBe(false);
    g.addObject(40, 40, 41, 41, 60); // 60 steps, 480 px
    expect(g.inView(0, high).some((t) => key(t) === "1,1" && t.visible)).toBe(true);
    expect(g.maxTop).toBe(60);
    g.addObject(0, 0, 70, 1, 0, 80); // an absolute top (a bridge deck) over three tiles
    expect(g.maxTop).toBe(80);
  });
});

describe("baked tiles", () => {
  it("are kept per rotation, and found under a point", () => {
    const g = grid();
    const b = new BakedTiles(g);
    b.set(1, 2, 1, true);
    expect(b.has(1, 2, 1)).toBe(true);
    expect(b.has(0, 2, 1)).toBe(false);
    expect(b.at(1, 70, 40)).toBe(true);
    expect(b.at(1, 30, 40)).toBe(false);
    expect(b.at(1, 500, 40)).toBe(false); // outside the world
    b.set(1, 2, 1, false);
    expect(b.at(1, 70, 40)).toBe(false);
    b.set(3, 0, 0, true);
    b.set(3, 9, 9, true); // outside: ignored
    b.clear();
    expect(b.has(3, 0, 0)).toBe(false);
  });
});

describe("the camera's motion", () => {
  it("measures a steady velocity and says where the focus will be", () => {
    const m = new CameraMotion();
    for (let i = 0; i <= 60; i++) m.update(10 + (2 * i) / 60, 20, 1 / 60);
    expect(m.vx).toBeCloseTo(2, 1);
    expect(m.vy).toBeCloseTo(0, 9);
    const [dx, dy] = m.ahead(1.5);
    expect(dx).toBeCloseTo(3, 0);
    expect(dy).toBe(0);
  });

  it("takes a jump for a jump, not a motion, and slows to a stop when the camera does", () => {
    const m = new CameraMotion();
    for (let i = 0; i <= 30; i++) m.update(i / 10, 0, 1 / 60); // 6 cells/s
    expect(m.vx).toBeGreaterThan(4);
    m.update(200, 0, 1 / 60); // a teleport
    expect(Math.hypot(m.vx, m.vy)).toBe(0);
    expect(MAX_CAMERA_SPEED).toBeLessThan(200 * 60);
    for (let i = 0; i <= 30; i++) m.update(200 + i / 10, 0, 1 / 60);
    for (let i = 0; i < 120; i++) m.update(203, 0, 1 / 60);
    expect(m.vx).toBeLessThan(0.01);
  });

  it("moves a view by a screen offset, no further than one view", () => {
    const v = { left: 0, top: 0, width: 100, height: 50 };
    expect(shiftView(v, 30, -10)).toEqual({ left: 30, top: -10, width: 100, height: 50 });
    const far = shiftView(v, 400, 100); // four views right, two down: scaled to one view right
    expect(far.left).toBeCloseTo(100, 9);
    expect(far.top).toBeCloseTo(25, 9);
    expect(shiftView(v, 0, 0)).toEqual(v);
  });
});

describe("prefetches", () => {
  it("work out their tiles once per key, and resolve when every one is baked", async () => {
    const p = new Prefetches();
    const done: string[] = [];
    void p.add({ x: 1, y: 1 }).then(() => done.push("a"));
    void p.add({ x: 2, y: 2, radius: 5 }).then(() => done.push("b"));
    let calls = 0;
    const tilesFor = (area: { x: number }) => {
      calls++;
      return [{ rotation: 0 as const, tx: area.x, ty: 0 }];
    };
    expect(p.wanted("r0", tilesFor).map(key)).toEqual(["1,0", "2,0"]);
    expect(p.wanted("r0", tilesFor).map(key)).toEqual(["1,0", "2,0"]);
    expect(calls).toBe(2);
    p.wanted("r1", tilesFor); // a rotation or a resize: worked out again
    expect(calls).toBe(4);
    p.settle((t) => t.tx === 2);
    await Promise.resolve();
    expect(done).toEqual(["b"]);
    expect(p.size).toBe(1);
    p.clear(); // the view is destroyed
    await Promise.resolve();
    expect(done).toEqual(["b", "a"]);
    expect(p.size).toBe(0);
  });

  it("don't resolve before their tiles are worked out", () => {
    const p = new Prefetches();
    void p.add({ x: 1, y: 1 });
    p.settle(() => true);
    expect(p.size).toBe(1);
  });
});

describe("the bake order", () => {
  it("is the visible tiles, then ahead of the camera, then asked for, then around the view, each once", () => {
    const t = (tx: number, visible = false): TileInView => ({ rotation: 0, tx, ty: 0, visible, dist: tx });
    const near = [t(1, true), t(2, true), t(3), t(4)];
    const ahead = [{ rotation: 0 as const, tx: 4, ty: 0 }, { rotation: 0 as const, tx: 5, ty: 0 }];
    const asked = [{ rotation: 0 as const, tx: 2, ty: 0 }, { rotation: 0 as const, tx: 9, ty: 0 }];
    expect(bakeOrder(near, ahead, asked).map(key)).toEqual(["1,0", "2,0", "4,0", "5,0", "9,0", "3,0"]);
    // without motion or requests: exactly the view's order
    expect(bakeOrder(near, [], []).map(key)).toEqual(near.map(key));
    // a reveal's bare tiles right after the visible ones, beside the same tiles unbare
    const bare = [{ rotation: 0 as const, tx: 2, ty: 0, bare: true }];
    const order = bakeOrder(near, [], [], bare);
    expect(order.map((t) => key(t) + (t.bare ? "b" : ""))).toEqual(["1,0", "2,0", "2,0b", "3,0", "4,0"]);
    // the ground of visible tiles first, beside the same tiles whole
    const ground = [{ rotation: 0 as const, tx: 2, ty: 0, ground: true }];
    const first = bakeOrder(near, [], [], [], ground);
    expect(first.map((t) => key(t) + (t.ground ? "g" : ""))).toEqual(["2,0g", "1,0", "2,0", "3,0", "4,0"]);
  });
});
