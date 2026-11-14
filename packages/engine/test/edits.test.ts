import type { ObjectInstance } from "@pixelworlds/generators";
import { project } from "@pixelworlds/grid";
import { describe, expect, it, vi } from "vitest";
import { EditLog, TileEdits } from "../src/edits";
import { ObjectIndex } from "../src/objects";
import { createQuery, type QuerySource } from "../src/queries";
import { objectTiles, tileCacheKey, type LoadedWorld } from "../src/world";

/**
 * Runtime world edits (D-124): the op log, the queries leaving out removed
 * objects, the object under a canvas point, and which tiles an edit bakes
 * again (and keys apart in the cache).
 */

const INSTANCES: ObjectInstance[] = [
  { g: "building.house", x: 3, y: 3, s: 1, hm: 10, fp: [[2, 2], [4, 2], [4, 4], [2, 4]] },
  { g: "tree.conifer", x: 5.4, y: 6.6, s: 3 },
  { g: "landmark.tower", x: 14.5, y: 3.5, s: 4, hm: 300, id: "big-tower" },
  { g: "landmark.dam", x: 22, y: 5, s: 5, top: 9, id: "dam", fp: [[21, 4], [23, 4], [23, 6], [21, 6]] },
  { g: "landmark.dam.intake", x: 24, y: 5, s: 6, top: 9.5, id: "dam" },
];
const world = { cellsX: 32, cellsY: 32, metersPerCell: 100, heightStretch: 1.5 };
const indexOf = (edits: EditLog) => new ObjectIndex(INSTANCES, world, () => true, () => 2, () => null, edits);

describe("the edit log (D-124)", () => {
  it("logs the ops that changed something, with only what they changed", () => {
    const log = new EditLog(5);
    const seen = vi.fn();
    log.onChange(seen);
    expect(log.remove([1, 3, 3])).toEqual({ op: "remove", objects: [1, 3] });
    expect(log.remove([3])).toBeNull(); // already out
    expect(log.remove([7, -1, 1.5])).toBeNull(); // not objects of this world
    expect(log.restore([0, 3])).toEqual({ op: "restore", objects: [3] });
    expect(log.removed()).toEqual([1]);
    expect(log.isRemoved(1)).toBe(true);
    expect(log.version).toBe(2);
    expect(seen.mock.calls.map(([e]) => e)).toEqual(log.list());
    // with nothing named, everything comes back
    log.remove([0, 4]);
    expect(log.restore()).toEqual({ op: "restore", objects: [1, 0, 4] });
    expect(log.removed()).toEqual([]);
  });

  it("replays onto another world to the same objects, and a bad op from the network changes nothing", () => {
    const a = new EditLog(5);
    a.remove([4, 2]);
    a.restore([4]);
    a.remove([0]);
    const b = new EditLog(5);
    for (const op of a.list()) b.apply(op);
    expect(b.removed().sort()).toEqual(a.removed().sort());
    expect(b.list()).toEqual(a.list());
    expect(b.apply({ op: "burn", objects: [1] } as never)).toBeNull();
    expect(b.apply({ op: "remove", objects: "1" } as never)).toBeNull();
    expect(b.apply(null as never)).toBeNull();
    expect(b.version).toBe(3);
  });
});

describe("queries over an edited world (D-124)", () => {
  it("objectsAt leaves out removed objects until they are put back, naming each by its index", () => {
    const edits = new EditLog(INSTANCES.length);
    const ix = indexOf(edits);
    expect(ix.at(3, 3).map((o) => o.index)).toEqual([0]);
    edits.remove([0, 1]);
    expect(ix.at(3, 3)).toEqual([]);
    expect(ix.at(5.5, 6.5)).toEqual([]);
    edits.restore([0]);
    expect(ix.at(3, 3).map((o) => o.group)).toEqual(["building.house"]);
    expect(ix.at(5.5, 6.5)).toEqual([]);
  });

  it("landmarks lose a removed part, and a landmark with none left", () => {
    const edits = new EditLog(INSTANCES.length);
    const ix = indexOf(edits);
    expect(ix.landmarks().find((l) => l.id === "dam")!.parts).toBe(2);
    edits.remove([4]);
    expect(ix.landmarks().find((l) => l.id === "dam")).toMatchObject({ parts: 1, x: 22 });
    edits.remove([3, 2]);
    expect(ix.landmarks()).toEqual([]);
    edits.restore();
    expect(ix.landmarks().map((l) => l.id).sort()).toEqual(["big-tower", "dam"]);
  });

  it("pickObject finds a tall object in front of the ground behind it, and nothing once it is removed", () => {
    const src: QuerySource = {
      cellsX: 32,
      cellsY: 32,
      cell: () => null,
      surfaceHeightAt: () => 2,
      realHeightAt: (_x, _y, h) => h,
      metersPerCellAt: () => 100,
      ensureRect: async () => {},
      isLoadedRect: () => true,
    };
    const w = {
      manifest: { surfaces: {}, scale: { metersPerCell: 100, metersPerStep: 10, elevationDatumMeters: 0 } },
      style: {},
      renderScale: 1,
      heightRange: [0, 10] as [number, number],
    };
    const edits = new EditLog(INSTANCES.length);
    for (const rotation of [0, 1, 2, 3] as const) {
      const q = createQuery(src, w, null, () => ({ rotation, left: 0, top: 0, fracX: 0, fracY: 0, zoom: 1, pixelRatio: 1 }), indexOf(edits));
      // the tower's side, high up: 300 m at 100 m a cell, stretched 1.5×, is 9 steps over the ground at 2
      const side = project(14.5, 3.5, 8, rotation);
      const ground = q.pick(side.sx, side.sy)!;
      expect(Math.hypot(ground.x - 14.5, ground.y - 3.5)).toBeGreaterThan(3); // the ground pick goes through it
      expect(q.pickObject(side.sx, side.sy)).toMatchObject({ index: 2, id: "big-tower", base: 2, top: 11 });
      // a point over open ground, and the tree (3 steps tall, drawn from its cell)
      const open = project(10.5, 20.5, 2, rotation);
      expect(q.pickObject(open.sx, open.sy)).toBeNull();
      const tree = project(5.5, 6.5, 4, rotation);
      expect(q.pickObject(tree.sx, tree.sy)?.group).toBe("tree.conifer");
      edits.remove([2]);
      expect(q.pickObject(side.sx, side.sy)).toBeNull();
      edits.restore();
    }
  });
});

describe("the tiles an edit bakes again (D-124)", () => {
  // tiles 32 cells, a 16-cell context margin, a 128-cell world
  const instances: ObjectInstance[] = [
    { g: "tree", x: 40, y: 10, s: 1 },
    { g: "building", x: 63.5, y: 70, s: 2, fp: [[62, 69], [65, 69], [65, 71], [62, 71]] },
    // a bridge: a big footprint reaches into slices far from its anchor
    { g: "landmark.bridge", x: 55, y: 101, s: 3, fp: [[10, 100], [100, 100], [100, 102], [10, 102]] },
    // a small footprint whose anchor lies outside it: the anchor's tiles build it
    { g: "building", x: 50, y: 10, s: 4, fp: [[28, 9], [30, 9], [30, 11], [28, 11]] },
  ];
  const w = { tileSize: 32, margin: 16, manifest: { cellsX: 128, cellsY: 128 }, objects: { instances } } as unknown as LoadedWorld;
  const sorted = (t: [number, number][]) => t.map(([x, y]) => `${x},${y}`).sort();

  it("are those whose bake builds the object: its anchor in their slice, or its big footprint reaching into it", () => {
    expect(sorted(objectTiles(w, 0))).toEqual(["0,0", "1,0"]);
    expect(sorted(objectTiles(w, 1))).toEqual(["1,1", "1,2", "2,1", "2,2"]);
    expect(sorted(objectTiles(w, 2))).toEqual(["0,2", "0,3", "1,2", "1,3", "2,2", "2,3", "3,2", "3,3"]);
    expect(sorted(objectTiles(w, 3))).toEqual(["1,0", "2,0"]);
    expect(objectTiles(w, 9)).toEqual([]);
  });

  it("each tile knows the removed objects its bake reaches", () => {
    const tiles = new TileEdits((i) => objectTiles(w, i));
    expect(sorted(tiles.apply({ op: "remove", objects: [2, 1] }))).toEqual(["0,2", "0,3", "1,1", "1,2", "1,3", "2,1", "2,2", "2,3", "3,2", "3,3"]);
    expect(tiles.removedFor(1, 2)).toEqual([1, 2]);
    expect(tiles.removedFor(1, 1)).toEqual([1]);
    expect(tiles.removedFor(0, 0)).toEqual([]);
    tiles.apply({ op: "restore", objects: [1] });
    expect(tiles.removedFor(1, 2)).toEqual([2]);
    expect(tiles.removedFor(1, 1)).toEqual([]);
  });

  it("an edited tile is cached under its removed objects themselves, never under the plain key", () => {
    const key = tileCacheKey({ ...w, manifest: { id: "sf", packageHash: "p1" }, styleJson: {}, renderScale: 1 } as unknown as LoadedWorld, [], "c0de");
    const t = { rotation: 0, tx: 1, ty: 2 } as const;
    expect(key(t, [])).toBe(key(t));
    expect(key(t, [1, 2])).toMatch(/\|0:1,2\|edits:1,2$/);
    expect(key(t, [1, 2])).toBe(key(t, [1, 2]));
    expect(key(t, [1, 2])).not.toBe(key(t, [2]));
  });
});
