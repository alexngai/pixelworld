import { CELL_WALL, type Board, type WorldQuery } from "@pixelworlds/engine";
import { describe, expect, it } from "vitest";
import { BoardOverlay, FX_KINDS, UNIT_KINDS, entityModel, fxBoxes, objectInfo, rampsFor, unitBoxes } from "../src/index";

/** The tactics kit (D-149): building facts, models and the overlay's boxes. */

describe("objectInfo: occupants and materials", () => {
  const opts = { metersPerCell: 10 };
  const square = (n: number): [number, number][] => [[0, 0], [n, 0], [n, n], [0, n]];

  it("reads storeys, area, use and material from what the objects file says", () => {
    // a 49-storey office tower on 1,056 m², built 1987
    const tower = objectInfo({ g: "building.tower.postmodern", x: 0, y: 0, s: 1, fp: square(Math.sqrt(10.56)), hm: 196, fl: 49, yr: 1987 }, opts);
    expect(tower).toMatchObject({ building: true, material: "steel", use: "office", storeys: 49, year: 1987 });
    expect(tower.footprintM2).toBeCloseTo(1056, 0);
    expect(tower.occupants).toBe(Math.round((49 * 1056 * 0.8) / 15));
    // a brownstone burns more readily than a glass tower, and a machiya more than either
    const brownstone = objectInfo({ g: "building.brownstone", x: 0, y: 0, s: 1, fp: square(0.6), hm: 14 }, opts);
    const glass = objectInfo({ g: "building.tower.glass", x: 0, y: 0, s: 1, fp: square(4), hm: 200 }, opts);
    const machiya = objectInfo({ g: "building.machiya", x: 0, y: 0, s: 1, fp: square(0.6), hm: 7, fl: 2 }, opts);
    expect(machiya.flammability).toBeGreaterThan(brownstone.flammability);
    expect(brownstone.flammability).toBeGreaterThan(glass.flammability);
    expect(brownstone.storeys).toBe(4); // 14 m at 3.3 m a storey
    // a kura is plastered against fire
    expect(objectInfo({ g: "building.kura", x: 0, y: 0, s: 1, fp: square(0.5), hm: 6 }, opts).material).toBe("earth");
  });

  it("leaves courtyards out, takes a facade material over the group's, and guesses from height and age", () => {
    const fp = square(4);
    const court: [number, number][] = [[1, 1], [3, 1], [3, 3], [1, 3]];
    expect(objectInfo({ g: "building.haussmann", x: 0, y: 0, s: 1, fp, fh: [court], hm: 20 }, opts).footprintM2).toBeCloseTo(1200);
    expect(objectInfo({ g: "building.residential", x: 0, y: 0, s: 1, fp, hm: 20, fm: "glass" }, opts).material).toBe("glass");
    expect(objectInfo({ g: "building.residential", x: 0, y: 0, s: 1, fp, hm: 80 }, opts).material).toBe("steel");
    expect(objectInfo({ g: "building.residential", x: 0, y: 0, s: 1, fp, hm: 15, yr: 1890 }, opts).material).toBe("brick");
    expect(objectInfo({ g: "building.residential", x: 0, y: 0, s: 1, fp, hm: 15, yr: 1970 }, opts).material).toBe("concrete");
  });

  it("gives trees and props no one inside", () => {
    expect(objectInfo({ g: "tree.street", x: 0, y: 0, s: 1 }, opts)).toMatchObject({ building: false, material: "vegetation", occupants: 0, flammability: 1 });
    expect(objectInfo({ g: "prop.streetlight", x: 0, y: 0, s: 1 }, opts)).toMatchObject({ building: false, occupants: 0, flammability: 0 });
  });
});

describe("unit and effect models", () => {
  const ramps = rampsFor(new Map([["sign-red", 3], ["taxi", 4], ["water", 5], ["verdigris", 6], ["marker", 7]]));

  it("takes each role's first ramp the palette has, else ramp 0", () => {
    expect([ramps.red, ramps.yellow, ramps.water, ramps.alien, ramps.fire, ramps.glass]).toEqual([3, 4, 5, 6, 7, 0]);
  });

  it("builds every unit and effect as boxes about a cell across, scaled to a board's cells and the render scale", () => {
    for (const kind of UNIT_KINDS) {
      const boxes = unitBoxes(kind, ramps);
      expect(boxes.length, kind).toBeGreaterThan(5);
      for (const b of boxes) expect(b.x1 > b.x0 && b.y1 > b.y0 && b.z1 > b.z0, kind).toBe(true);
      const span = Math.max(...boxes.map((b) => b.x1)) - Math.min(...boxes.map((b) => b.x0));
      expect(span, kind).toBeGreaterThan(0.5);
      expect(span, kind).toBeLessThan(1.6);
      const half = unitBoxes(kind, ramps, { scale: 0.5, renderScale: 2 });
      expect(half[0]!.x0).toBeCloseTo(boxes[0]!.x0, 9);
    }
    for (const kind of FX_KINDS) expect(fxBoxes(kind, ramps, { frame: 1 }).length, kind).toBeGreaterThan(3);
    // fire flickers from frame to frame; rubble is the same pile for the same seed
    expect(fxBoxes("fire", ramps, { frame: 0 })).not.toEqual(fxBoxes("fire", ramps, { frame: 1 }));
    expect(fxBoxes("rubble", ramps, { seed: 4 })).toEqual(fxBoxes("rubble", ramps, { seed: 4 }));
    const a = entityModel("pumper", ramps);
    const b = entityModel("pumper", ramps);
    expect("key" in a && "key" in b && a.key === b.key).toBe(true);
  });
});

describe("the board overlay's boxes", () => {
  /** A flat 4 × 3 board at height 2, with a roof at 6 on cell 1,1. */
  function board(): Board {
    const n = 12;
    const top = new Float32Array(n).fill(2);
    top[5] = 6;
    const flags = new Uint8Array(n);
    flags[5] = CELL_WALL;
    return { x0: 0, y0: 0, w: 4, h: 3, origin: [10, 20], cell: 2, height: new Float32Array(n).fill(2), top, flags } as unknown as Board;
  }
  const query = { heightAt: () => 2 } as unknown as WorldQuery;
  const ids = new Map([["paint-white", 1], ["sign-red", 2], ["glass", 3]]);

  it("puts marks on the cell's roof or ground, in board-relative render units", () => {
    const o = new BoardOverlay(board(), { grid: false });
    o.setMarks([{ i: 1, j: 1, kind: "attack" }, { i: 0, j: 0, kind: "move" }, { i: 9, j: 9, kind: "move" }]);
    const boxes = o.boxes(query, ids, 2);
    expect(boxes).toHaveLength(2); // the one off the board is dropped
    const [roof, ground] = boxes;
    expect(roof!.ramp).toBe(2);
    expect(roof!.z0).toBeGreaterThan(6 * 2); // on the roof, ×2 render scale
    expect(roof!.x0).toBeGreaterThan(2 * 2); // cell 1 starts 2 world cells in
    expect(roof!.x1).toBeLessThan(4 * 2);
    expect(ground!.z0).toBeGreaterThan(2 * 2);
    expect(ground!.z0).toBeLessThan(3 * 2);
  });

  it("draws the grid and arrows that arc over what lies between", () => {
    const o = new BoardOverlay(board());
    const grid = o.boxes(query, ids, 1).length;
    expect(grid).toBe(4 * 3 * 2 + 3 + 4); // two edges a cell, and the far edges
    o.setArrows([{ from: [0, 0], to: [3, 2], kind: "attack" }]);
    const arrow = o.boxes(query, ids, 1).slice(grid);
    expect(arrow.length).toBeGreaterThan(4);
    const mid = arrow[Math.floor(arrow.length / 2)]!;
    expect(mid.z0).toBeGreaterThan(arrow[0]!.z1); // it rises in the middle
  });
});
