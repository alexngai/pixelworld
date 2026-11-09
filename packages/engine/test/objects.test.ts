import type { ObjectInstance } from "@pixelworlds/generators";
import { describe, expect, it } from "vitest";
import { ObjectIndex, inPolygon } from "../src/objects";
import { createQuery, type QuerySource } from "../src/queries";

/**
 * Occupancy queries over placed objects: a square house, an L-shaped block,
 * a tree, a tower drawn from its anchor, a dam with an intake tower (one
 * landmark of two parts), and a group the style doesn't draw. Ground at 2
 * steps, rising 1 step per cell east of x = 20.
 */
const INSTANCES: ObjectInstance[] = [
  { g: "building.house", x: 3, y: 3, s: 1, hm: 10, fp: [[2, 2], [4, 2], [4, 4], [2, 4]] },
  { g: "building.block", x: 10, y: 10, s: 2, hm: 20, m: 50, fp: [[8, 8], [12, 8], [12, 10], [10, 10], [10, 12], [8, 12]] },
  { g: "tree.conifer", x: 5.4, y: 6.6, s: 3 },
  { g: "landmark.tower", x: 14.5, y: 3.5, s: 4, hm: 300, id: "big-tower" },
  { g: "landmark.dam", x: 22, y: 5, s: 5, top: 9, id: "dam", fp: [[21, 4], [23, 4], [23, 6], [21, 6]] },
  { g: "landmark.dam.intake", x: 24, y: 5, s: 6, top: 9.5, id: "dam" },
  { g: "secret.thing", x: 3, y: 3, s: 7 },
];

const ground = (x: number) => (x > 20 ? 2 + (x - 20) : 2);
const world = { cellsX: 32, cellsY: 32, metersPerCell: 100, heightStretch: 1.5 };
const index = (heightAt: (x: number, y: number) => number | null = (x) => ground(x)) =>
  new ObjectIndex(INSTANCES, world, (g) => !g.startsWith("secret"), heightAt);

describe("object occupancy", () => {
  it("finds footprints that contain a point, their edges included", () => {
    const ix = index();
    expect(ix.at(3, 3).map((o) => o.group)).toEqual(["building.house"]);
    expect(ix.at(2, 3).map((o) => o.group)).toEqual(["building.house"]); // on the west wall
    expect(ix.at(4.01, 3)).toEqual([]);
    // the L's notch is open
    expect(ix.at(9, 11).map((o) => o.group)).toEqual(["building.block"]);
    expect(ix.at(11, 11)).toEqual([]);
    expect(ix.at(11, 9).map((o) => o.group)).toEqual(["building.block"]);
  });

  it("puts objects without a footprint in their anchor's cell", () => {
    const ix = index();
    expect(ix.at(5.01, 6.99).map((o) => o.group)).toEqual(["tree.conifer"]);
    expect(ix.at(6, 6.5)).toEqual([]);
    expect(ix.at(14.9, 3.1).map((o) => o.id)).toEqual(["big-tower"]);
  });

  it("leaves out groups the style doesn't draw, and points outside the world", () => {
    const ix = index();
    expect(ix.at(3, 3).some((o) => o.group === "secret.thing")).toBe(false);
    expect(ix.at(-1, 3)).toEqual([]);
    expect(ix.at(40, 3)).toEqual([]);
  });

  it("estimates where objects are built and how tall they are drawn", () => {
    const ix = index();
    const [house] = ix.at(3, 3);
    expect(house).toMatchObject({ id: null, x: 3, y: 3, bounds: [2, 2, 4, 4], footprint: true, base: 2 });
    // 10 m at 100 m per cell, voxels 1/16 cell across and 1/8 step tall, stretched 1.5×
    expect(house!.top).toBeCloseTo(2 + (2 * 10 * 1.5) / 100);
    // an object's own metres per cell (a warped world)
    expect(ix.at(9, 9)[0]!.top).toBeCloseTo(2 + (2 * 20 * 1.5) / 50);
    // a crest height is the top; the base is the lowest footprint corner
    const [dam] = ix.at(22, 5);
    expect(dam).toMatchObject({ group: "landmark.dam", id: "dam", base: 3, top: 9 });
    // trees have no height in the world
    expect(ix.at(5.5, 6.5)[0]!.top).toBeNull();
  });

  it("answers no base or height where the terrain isn't loaded, and caches it once it is", () => {
    let loaded = false;
    const ix = index((x) => (loaded ? ground(x) : null));
    expect(ix.at(3, 3)[0]).toMatchObject({ base: null, top: null });
    loaded = true;
    expect(ix.at(3, 3)[0]!.base).toBe(2);
    loaded = false;
    expect(ix.at(3, 3)[0]!.base).toBe(2);
  });

  it("lists landmarks once per id, at the middle of their parts, named by the largest part", () => {
    const marks = index().landmarks();
    expect(marks).toHaveLength(2);
    expect(marks.find((l) => l.id === "big-tower")).toEqual({ id: "big-tower", group: "landmark.tower", x: 14.5, y: 3.5, parts: 1 });
    expect(marks.find((l) => l.id === "dam")).toEqual({ id: "dam", group: "landmark.dam", x: 23, y: 5, parts: 2 });
  });

  it("tests points in polygons", () => {
    const sq: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    expect(inPolygon(0.5, 0.5, sq)).toBe(true);
    expect(inPolygon(1, 0.5, sq)).toBe(true);
    expect(inPolygon(1.5, 0.5, sq)).toBe(false);
    expect(inPolygon(0, 0, sq)).toBe(true);
  });

  it("is what the view's queries answer", () => {
    const src: QuerySource = {
      cellsX: 32,
      cellsY: 32,
      cell: () => null,
      surfaceHeightAt: (x) => ground(x),
      realHeightAt: (_x, _y, h) => h,
      metersPerCellAt: () => 100,
      ensureRect: async () => {},
    };
    const w = {
      manifest: { surfaces: {}, scale: { metersPerCell: 100, metersPerStep: 10, elevationDatumMeters: 0 } },
      style: {},
      renderScale: 1,
      heightRange: [0, 10] as [number, number],
    };
    const v = () => ({ rotation: 0 as const, left: 0, top: 0, fracX: 0, fracY: 0, zoom: 1, pixelRatio: 1 });
    const none = createQuery(src, w, null, v);
    expect(none.objectsAt(3, 3)).toEqual([]);
    expect(none.landmarks()).toEqual([]);
    const q = createQuery(src, w, null, v, index());
    expect(q.objectsAt(3, 3).map((o) => o.group)).toEqual(["building.house"]);
    expect(q.landmarks().map((l) => l.id).sort()).toEqual(["big-tower", "dam"]);
  });
});
