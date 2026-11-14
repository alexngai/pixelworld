import { buildBoxesMesh, type Box } from "@pixelworlds/generators";
import { project, type Rotation } from "@pixelworlds/grid";
import { Camera, type GpuImage } from "@pixelworlds/runtime";
import { describe, expect, it } from "vitest";
import { ViewCameraImpl } from "../src/camera";
import { Entities, headingIndex, turnBoxes } from "../src/entities";
import { TileGrid } from "../src/tiles";

const BOX: Box = { x0: -0.5, y0: -0.25, z0: 0, x1: 0.5, y1: 0.25, z1: 1, ramp: 2 };

/** Entities over a fake baker that finishes bakes when told to. */
function entities() {
  const jobs: { rotation: Rotation; boxes: Box[]; done: (s: GpuImage | null) => void }[] = [];
  const released: GpuImage[] = [];
  let invalidations = 0;
  let redraws = 0;
  const list = new Entities({
    bake: (rotation, boxes) => new Promise((done) => jobs.push({ rotation, boxes, done })),
    release: (s) => released.push(s),
    groupBoxes: (m) => [{ ...BOX, ramp: m.seed }],
    heightAt: (x) => (x < 100 ? x / 10 : null),
    invalidate: () => invalidations++,
    redraw: () => redraws++,
  });
  const sprite = (n: number) => ({ texture: {}, image: { left: n } }) as unknown as GpuImage;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { list, jobs, released, sprite, flush, invalidations: () => invalidations, redraws: () => redraws };
}

const proj = (x: number, y: number, h: number) => project(x, y, h, 0);

describe("entities", () => {
  it("rounds headings to the nearest of n and turns boxes to them", () => {
    expect(headingIndex(0, 16)).toBe(0);
    expect(headingIndex(Math.PI / 2, 16)).toBe(4);
    expect(headingIndex(-Math.PI / 8, 16)).toBe(15);
    expect(headingIndex(2 * Math.PI + 0.01, 16)).toBe(0);
    expect(turnBoxes([BOX], 0, 16)[0]).toBe(BOX); // heading 0 is the model as given
    expect(turnBoxes([BOX], 4, 16)[0]!.rot).toBeCloseTo(Math.PI / 2, 12);
    expect(turnBoxes([{ ...BOX, rot: 0.1 }], 8, 16)[0]!.rot).toBeCloseTo(Math.PI + 0.1, 12);
  });

  it("draws a silhouette in the entity's own ramp, at its lightest shade, where it has one", async () => {
    const t = entities();
    t.list.add({ model: { boxes: [BOX], key: "a" }, x: 5, y: 6, silhouette: true });
    t.list.add({ model: { boxes: [BOX], key: "a" }, x: 7, y: 6, silhouette: true, silhouetteRamp: 3 });
    t.list.request(0);
    t.jobs[0]!.done(t.sprite(1));
    await t.flush();
    const [a, b] = t.list.draws(0, proj).list;
    expect(a!.silhouetteIndex).toBeUndefined(); // the style's silhouette colour
    expect(b!.silhouetteIndex).toBe(1 + 3 * 6 + 5);
  });

  it("bakes each model once per rotation and heading, and draws it when baked", async () => {
    const t = entities();
    const a = t.list.add({ model: { boxes: [BOX] }, x: 5, y: 6, silhouette: true });
    expect(a.h).toBe(0.5); // the ground there
    t.list.request(0);
    t.list.request(0);
    expect(t.jobs.length).toBe(1);
    expect(t.jobs[0]!.boxes[0]).toBe(BOX);
    let frame = t.list.draws(0, proj);
    expect(frame).toEqual({ list: [], complete: false });
    t.jobs[0]!.done(t.sprite(1));
    await t.flush();
    expect(t.redraws()).toBe(1);
    frame = t.list.draws(0, proj);
    const p = project(5, 6, 0.5, 0);
    expect(frame.complete).toBe(true);
    expect(frame.list).toEqual([{ sprite: t.sprite(1), sx: p.sx, sy: p.sy, depth: p.depth, silhouette: true, reveal: null }]);
    // another heading and another rotation are baked on demand
    a.heading = Math.PI / 2;
    t.list.request(0);
    t.list.request(1);
    expect(t.jobs.map((j) => [j.rotation, j.boxes[0]!.rot ?? 0])).toEqual([
      [0, 0],
      [0, (4 * 2 * Math.PI) / 16],
      [1, (4 * 2 * Math.PI) / 16],
    ]);
  });

  it("reveals with defaults when asked, and passes it to its sprite", async () => {
    const t = entities();
    const a = t.list.add({ model: { boxes: [BOX] }, x: 5, y: 6, reveal: {} });
    expect(a.reveal).toEqual({ margin: 24, density: 0.75 });
    a.reveal = { margin: 24, density: 2 }; // clamped
    expect(a.reveal).toEqual({ margin: 24, density: 1 });
    t.list.request(0);
    t.jobs[0]!.done(t.sprite(1));
    await t.flush();
    expect(t.list.draws(0, proj).list[0]!.reveal).toEqual({ margin: 24, density: 1 });
    a.reveal = null;
    expect(t.list.draws(0, proj).list[0]!.reveal).toBeNull();
  });

  it("shares a group model's sprites between entities and asks for hidden ones too", async () => {
    const t = entities();
    t.list.add({ model: { group: "vehicle.car", seed: 7 }, x: 1, y: 1, h: 2 });
    const b = t.list.add({ model: { group: "vehicle.car", seed: 7 }, x: 2, y: 2, h: 2, visible: false, lift: 0.5 });
    t.list.add({ model: { group: "vehicle.car", seed: 8 }, x: 3, y: 3, h: 2 });
    t.list.request(0);
    expect(t.jobs.map((j) => j.boxes[0]!.ramp)).toEqual([7, 8]);
    t.jobs[0]!.done(t.sprite(7));
    t.jobs[1]!.done(t.sprite(8));
    await t.flush();
    expect(t.list.draws(0, proj).list.length).toBe(2); // the hidden one isn't drawn
    b.visible = true;
    const drawn = t.list.draws(0, proj).list;
    expect(drawn.length).toBe(3);
    expect(drawn[1]!.depth).toBeCloseTo(project(2, 2, 2.5, 0).depth, 12); // lifted
  });

  it("moves entities to the ground, redrawing only on change", () => {
    const t = entities();
    const e = t.list.add({ model: { boxes: [BOX] }, x: 5, y: 6 });
    const n = t.invalidations();
    e.moveTo(5, 6);
    expect(t.invalidations()).toBe(n);
    e.moveTo(20, 6);
    expect([e.x, e.y, e.h]).toEqual([20, 6, 2]);
    e.moveTo(200, 6); // nothing loaded there: the height stays
    expect(e.h).toBe(2);
    e.moveTo(200, 6, 7);
    expect(e.h).toBe(7);
    expect(t.invalidations()).toBe(n + 3);
  });

  it("lets go of a model's sprites when its last entity goes", async () => {
    const t = entities();
    const a = t.list.add({ model: { boxes: [BOX], key: "rover" }, x: 1, y: 1 });
    t.list.request(0);
    t.jobs[0]!.done(t.sprite(1));
    await t.flush();
    a.remove();
    expect(t.released).toEqual([t.sprite(1)]);
    expect(t.list.list()).toEqual([]);
    // a bake that finishes after its model went is let go of too
    const b = t.list.add({ model: { boxes: [BOX], key: "rover" }, x: 1, y: 1 });
    t.list.request(2);
    b.remove();
    t.jobs[1]!.done(t.sprite(2));
    await t.flush();
    expect(t.released.length).toBe(2);
  });
});

describe("the camera", () => {
  function camera() {
    const cam = new Camera(1, 1);
    let changes = 0;
    const view = new ViewCameraImpl(cam, 0.25, () => changes++, {
      ensure: async () => {},
      heightAt: (x) => (x < 100 ? 8 : null),
      lonLatToCell: (lon, lat) => (lon > 0 ? [lon * 10, lat * 10] : null),
    });
    return { cam, view, changes: () => changes };
  }

  it("works in cells outside and render units inside", async () => {
    const { cam, view } = camera();
    view.setFocus(12, 20, 4);
    expect([cam.fx, cam.fy, cam.fh]).toEqual([3, 5, 1]);
    expect([view.x, view.y, view.h]).toEqual([12, 20, 4]);
    expect(await view.lookAt({ x: 40, y: 8 })).toBe(true);
    expect([view.x, view.y, view.h]).toEqual([40, 8, 8]);
    expect(await view.lookAt({ x: 400, y: 8 })).toBe(true); // nothing there: the height stays
    expect(view.h).toBe(8);
    expect(await view.lookAt({ lon: 2, lat: 3, h: 1 })).toBe(true);
    expect([view.x, view.y, view.h]).toEqual([20, 30, 1]);
    expect(await view.lookAt({ lon: -2, lat: 3 })).toBe(false);
  });

  it("redraws on change only, and zooms automatically until told a zoom", () => {
    const { cam, view, changes } = camera();
    view.setCanvasSize(1920, 1080);
    expect(view.zoom).toBe(3);
    expect(view.autoZoom).toBe(true);
    view.setFocus(1, 2, 3);
    const n = changes();
    view.setFocus(1, 2, 3);
    view.rotation = 0;
    expect(changes()).toBe(n);
    view.rotation = 5 as Rotation;
    expect(view.rotation).toBe(1);
    view.zoom = 2.4;
    expect(view.zoom).toBe(2);
    view.setCanvasSize(640, 360);
    expect(view.zoom).toBe(2);
    expect([view.internalWidth, view.internalHeight]).toEqual([cam.internalWidth, 180]);
  });
});

describe("posed entities", () => {
  it("bakes pitch and roll to 10° steps, tilted about the model's middle height, and shows the last pose while the next bakes", async () => {
    const t = entities();
    const e = t.list.add({ model: { boxes: [BOX] }, x: 5, y: 6 });
    const level = t.sprite(1);
    t.list.request(0);
    t.jobs[0]!.done(level);
    await t.flush();
    expect(t.list.draws(0, proj).list[0]!.sprite).toBe(level);
    e.roll = 0.52; // 30°
    e.pitch = 0.04; // rounds to level
    t.list.request(0);
    expect(t.jobs.length).toBe(2);
    expect(t.jobs[1]!.boxes[0]).toMatchObject({ roll: Math.PI / 6, pitch: 0, pivot: 0.5 });
    const frame = t.list.draws(0, proj);
    expect(frame.complete).toBe(false);
    expect(frame.list[0]!.sprite).toBe(level); // no blink
    e.roll = 0.5; // the same step: nothing new to bake
    t.list.request(0);
    expect(t.jobs.length).toBe(2);
    t.jobs[1]!.done(t.sprite(2));
    await t.flush();
    const rolled = t.list.draws(0, proj).list[0]!.sprite;
    // a pose not drawn for a while is let go; the one shown stays
    e.roll = 0;
    for (let i = 0; i < 800; i++) t.list.draws(0, proj);
    expect(t.released).toContain(rolled);
    expect(t.released).not.toContain(level);
  });

  it("tilts a box's mesh: a right roll puts its right side down, a nose-up pitch its front up", () => {
    const wing: Box = { x0: -0.5, y0: -2, z0: 0, x1: 0.5, y1: 2, z1: 0.5, ramp: 1 };
    const lowest = (b: Box, side: (x: number, y: number) => boolean) => {
      const m = buildBoxesMesh([b]);
      let z = Infinity;
      for (let i = 0; i < m.vertexCount; i++) if (side(m.position[i * 3]!, m.position[i * 3 + 1]!)) z = Math.min(z, m.position[i * 3 + 2]!);
      return z;
    };
    const rolled = { ...wing, roll: 0.3, pivot: 0.25 };
    expect(lowest(rolled, (_x, y) => y > 1)).toBeLessThan(lowest(rolled, (_x, y) => y < -1));
    const nose = { ...wing, x0: -2, x1: 2, y0: -0.5, y1: 0.5, pitch: 0.3, pivot: 0.25 };
    expect(lowest(nose, (x) => x > 1)).toBeGreaterThan(lowest(nose, (x) => x < -1));
  });
});

describe("entities and the baked ground", () => {
  it("leave out an entity where the ground isn't drawn yet, without holding up the frame", async () => {
    const t = entities();
    t.list.add({ model: { boxes: [BOX], key: "a" }, x: 5, y: 6 });
    const b = t.list.add({ model: { boxes: [BOX], key: "b" }, x: 50, y: 6 });
    t.list.request(0);
    t.jobs[0]!.done(t.sprite(1));
    t.jobs[1]!.done(t.sprite(2));
    await t.flush();
    const drawn = (x: number) => x < 20; // the tile under b is still baking
    let frame = t.list.draws(0, proj, drawn);
    expect(frame.complete).toBe(true);
    expect(frame.list.map((d) => d.sprite)).toEqual([t.sprite(1)]);
    b.moveTo(10, 6);
    frame = t.list.draws(0, proj, drawn);
    expect(frame.list.map((d) => d.sprite)).toEqual([t.sprite(1), t.sprite(2)]);
  });

  it("don't wait for a sprite whose bake failed, nor ask for it again", async () => {
    const t = entities();
    t.list.add({ model: { boxes: [BOX] }, x: 5, y: 6 });
    t.list.request(0);
    t.jobs[0]!.done(null);
    await t.flush();
    t.list.request(0);
    expect(t.jobs.length).toBe(1);
    expect(t.list.draws(0, proj)).toEqual({ list: [], complete: true });
  });
});

describe("disposing entities", () => {
  it("releases every sprite, and drops ones that arrive afterwards", async () => {
    const t = entities();
    t.list.add({ model: { boxes: [BOX], key: "a" }, x: 1, y: 1 });
    t.list.add({ model: { boxes: [BOX], key: "b" }, x: 2, y: 2 });
    t.list.request(0);
    t.jobs[0]!.done(t.sprite(1));
    await t.flush();
    t.list.dispose();
    expect(t.released).toEqual([t.sprite(1)]);
    expect(t.list.list()).toEqual([]);
    expect(t.list.spriteCount).toBe(0);
    t.jobs[1]!.done(t.sprite(2)); // still baking when the view went away
    await t.flush();
    expect(t.released).toEqual([t.sprite(1), t.sprite(2)]);
  });
});

describe("the tile grid", () => {
  it("lists the tiles around a view, visible first and nearest first", () => {
    // 32×32 tiles of 4 cells, flat at 0
    const grid = new TileGrid(128, 128, 4, 1, -2, false, () => [0, 0]);
    expect(grid.count).toBe(1024);
    const c = project(22, 22, 0, 0); // the middle of tile (5, 5)
    const view = { left: Math.floor(c.sx - 100), top: Math.floor(c.sy - 60), width: 200, height: 120 };
    const tiles = grid.inView(0, view);
    expect(tiles[0]).toMatchObject({ tx: 5, ty: 5, visible: true, rotation: 0 });
    const firstHidden = tiles.findIndex((t) => !t.visible);
    expect(firstHidden).toBeGreaterThan(0);
    expect(tiles.slice(firstHidden).every((t) => !t.visible)).toBe(true);
    for (let i = 1; i < firstHidden; i++) expect(tiles[i]!.dist).toBeGreaterThanOrEqual(tiles[i - 1]!.dist);
    // far tiles are neither visible nor near
    expect(tiles.some((t) => t.tx === 31 && t.ty === 31)).toBe(false);
    expect(tiles.length).toBeLessThan(100);
  });
});

describe("entities that don't wait (D-111)", () => {
  it("leave the frame complete while their sprites bake, and count those bakes apart", async () => {
    const t = entities();
    t.list.add({ model: { boxes: [BOX] }, x: 5, y: 6, wait: false });
    t.list.request(0);
    expect(t.list.unwaitedBakes).toBe(1);
    expect(t.list.draws(0, proj)).toEqual({ list: [], complete: true }); // not drawn yet, but nothing to wait for
    t.jobs[0]!.done(t.sprite(1));
    await t.flush();
    expect(t.list.unwaitedBakes).toBe(0);
    expect(t.list.draws(0, proj).list.length).toBe(1);
    // one that waits, beside it: the frame is incomplete until its sprite is baked
    t.list.add({ model: { boxes: [{ ...BOX, ramp: 3 }] }, x: 7, y: 6 });
    t.list.request(0);
    expect(t.list.unwaitedBakes).toBe(0);
    expect(t.list.draws(0, proj).complete).toBe(false);
  });
});
