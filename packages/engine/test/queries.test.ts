import { LANE_DIVIDED, LANE_ONEWAY, TerrainGrid, project, type Rotation } from "@pixelworld/grid";
import { describe, expect, it } from "vitest";
import { createQuery, type PickView, type QuerySource } from "../src/queries";

/**
 * A 16×16 world: ground at 4 steps, a plateau at 10 over x, y in 8..11, a
 * pond at (2, 2) with its water at 6, and a road along y = 5.
 */
function world() {
  const g = new TerrainGrid(16, 16);
  g.base.fill(4);
  for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) g.base[g.index(x, y)] = 10;
  g.surface.fill(1);
  g.surface[g.index(2, 2)] = 5;
  g.water[g.index(2, 2)] = 6;
  for (let x = 0; x < 16; x++) {
    const i = g.index(x, 5);
    g.road[i] = (x > 0 ? 1 << 6 : 0) | (x < 15 ? 1 << 2 : 0); // west and east
    g.roadClass[i] = x < 8 ? 1 : 2;
  }
  g.roadWidth[g.index(10, 5)] = 48; // a real half-width of 1.5 cells
  g.lane[g.index(10, 5)] = 4 | LANE_ONEWAY | LANE_DIVIDED;
  let loaded = true;
  const src: QuerySource = {
    cellsX: 16,
    cellsY: 16,
    cell: (x, y) => (loaded && x >= 0 && y >= 0 && x < 16 && y < 16 ? { terrain: g, i: g.index(Math.floor(x), Math.floor(y)) } : null),
    surfaceHeightAt: (x, y) => (loaded ? g.surfaceHeightAt(x, y) : null),
    realHeightAt: (_x, _y, h) => h / 2, // a vertical caricature of 2×
    metersPerCellAt: () => 100,
    ensureRect: async () => {
      loaded = true;
    },
  };
  const unload = () => (loaded = false);
  return { g, src, unload };
}

const WORLD = {
  manifest: {
    surfaces: { "1": "grass", "5": "water" },
    roadClasses: { "1": "residential", "2": "primary" },
    scale: { metersPerCell: 100, metersPerStep: 10, elevationDatumMeters: 500 },
  },
  style: { roads: { asphalt: "asphalt", marking: "marking", classes: { residential: { halfWidth: 0.2, centerLine: false } } } },
  renderScale: 1,
  heightRange: [4, 10] as [number, number],
};

/** A view with no zoom or offset tricks: canvas px = render px from the origin. */
const view = (rotation: Rotation = 0, zoom = 1, pixelRatio = 1): PickView => ({
  rotation,
  left: -200,
  top: -100,
  fracX: 0.25,
  fracY: 0.5,
  zoom,
  pixelRatio,
});

/** The canvas point (CSS px) showing a world point in a view. */
function canvasPoint(v: PickView, x: number, y: number, h: number): [number, number] {
  const p = project(x, y, h, v.rotation);
  return [((p.sx - v.left - v.fracX) * v.zoom) / v.pixelRatio, ((p.sy - v.top - v.fracY) * v.zoom) / v.pixelRatio];
}

describe("world queries", () => {
  it("reads heights, surfaces and water", () => {
    const { src, unload } = world();
    const q = createQuery(src, WORLD, null, () => view());
    expect(q.heightAt(3.5, 3.5)).toBe(4);
    expect(q.heightAt(9, 9)).toBe(10);
    expect(q.heightAt(-1, 3)).toBeNull();
    expect(q.surfaceAt(3, 3)).toEqual({ id: 1, name: "grass", waterLevel: null });
    expect(q.surfaceAt(2.7, 2.1)).toEqual({ id: 5, name: "water", waterLevel: 6 });
    expect(q.elevationAt(3, 3)).toBe(4 / 2 * 10 + 500);
    expect(q.elevationAt(3, 3, 8)).toBe(8 / 2 * 10 + 500);
    expect(q.metersPerCellAt(3, 3)).toBe(100);
    unload();
    expect(q.heightAt(3.5, 3.5)).toBeNull();
    expect(q.surfaceAt(3, 3)).toBeNull();
  });

  it("describes roads: class, width and connections", () => {
    const { src } = world();
    const q = createQuery(src, WORLD, null, () => view());
    expect(q.roadAt(3, 3)).toBeNull();
    const r = q.roadAt(3.2, 5.9)!;
    expect(r.class).toBe("residential");
    expect(r.connections).toEqual([
      [1, 0],
      [-1, 0],
    ]);
    expect(r.width).toBeCloseTo(0.4, 9); // the style's half-width at render scale 1
    expect(q.roadAt(0, 5)!.connections).toEqual([[1, 0]]); // the west end
    const wide = q.roadAt(10, 5)!;
    expect(wide).toMatchObject({ classId: 2, class: "primary", width: 3, lanes: 4, oneWay: true, divided: true });
    expect(q.roadAt(12, 5)!.width).toBe(0); // no real width, and the style draws primaries at no fixed width
  });

  it("converts lon/lat through the geo grid, where the world has one", () => {
    const { src } = world();
    const geo = {
      cellToLonLat: (x: number, y: number): [number, number] => [-120 + x / 100, 36 - y / 100],
      lonLatToCell: (lon: number, lat: number): [number, number] | null => {
        const c: [number, number] = [(lon + 120) * 100, (36 - lat) * 100];
        return c[0] < 0 || c[1] < 0 || c[0] > 16 || c[1] > 16 ? null : c;
      },
    };
    const q = createQuery(src, WORLD, geo, () => view());
    expect(q.cellToLonLat(4, 8)).toEqual([-119.96, 35.92]);
    const cell = q.lonLatToCell(-119.96, 35.92)!;
    expect(cell[0]).toBeCloseTo(4, 9);
    expect(cell[1]).toBeCloseTo(8, 9);
    expect(q.lonLatToCell(-121, 35)).toBeNull();
    const none = createQuery(src, WORLD, null, () => view());
    expect(none.cellToLonLat(4, 8)).toBeNull();
    expect(none.lonLatToCell(-119.96, 35.92)).toBeNull();
  });

  for (const rotation of [0, 1, 2, 3] as Rotation[])
    it(`picks the ground under a canvas point in rotation ${rotation}`, () => {
      const { src } = world();
      for (const [zoom, ratio] of [
        [1, 1],
        [3, 2],
      ] as const) {
        const v = view(rotation, zoom, ratio);
        const q = createQuery(src, WORLD, null, () => v);
        // open ground
        const [cx, cy] = canvasPoint(v, 4.3, 6.6, 4);
        const p = q.pick(cx, cy)!;
        expect(p.x).toBeCloseTo(4.3, 3);
        expect(p.y).toBeCloseTo(6.6, 3);
        expect(p.h).toBe(4);
        expect([p.cellX, p.cellY]).toEqual([4, 6]);
        // the plateau's top
        const top = q.pick(...canvasPoint(v, 9.5, 10.2, 10))!;
        expect([top.cellX, top.cellY, top.h]).toEqual([9, 10, 10]);
        // the pond: its water, not its bed
        const pond = q.pick(...canvasPoint(v, 2.5, 2.5, 6))!;
        expect([pond.cellX, pond.cellY, pond.h]).toEqual([2, 2, 6]);
      }
    });

  it("picks what is in front: the plateau's face hides the ground behind it", () => {
    const { src } = world();
    const v = view(0);
    const q = createQuery(src, WORLD, null, () => v);
    // ground behind the plateau (north-west of it), seen through where the plateau stands
    const behind = canvasPoint(v, 7, 7, 4);
    const p = q.pick(...behind)!;
    expect(p.cellX >= 8 && p.cellY >= 8).toBe(true); // a plateau cell, in front
    expect(q.pick(-5000, -5000)).toBeNull(); // off the world
  });
});
