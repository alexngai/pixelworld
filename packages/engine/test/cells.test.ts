import { describe, expect, it } from "vitest";
import {
  CELL_ROAD,
  CELL_TREES,
  CELL_WALL,
  CELL_WATER,
  cellIndex,
  cellsOf,
  findPath,
  followEdits,
  lineClear,
  lineOfSight,
  readCells,
  setRemoved,
  viewshed,
  walkable,
  type CellPoint,
  type Cells,
} from "../src/cells";
import type { ObjectHit, WorldEdit } from "../src/types";

/**
 * A map from text: `.` open, `#` a wall (3 steps tall), `~` water, `=` road,
 * `t` trees (2 steps), a digit open ground that high (steps).
 */
function cellsOf_(rows: string[]): Cells {
  const h = rows.length;
  const w = rows[0]!.length;
  const query = {
    heightAt: (x: number, y: number) => {
      const ch = rows[Math.floor(y)]![Math.floor(x)]!;
      return /\d/.test(ch) ? Number(ch) : 0;
    },
    surfaceAt: (x: number, y: number) => ({ id: 1, name: "grass", waterLevel: rows[Math.floor(y)]![Math.floor(x)] === "~" ? 0 : null }),
    roadAt: (x: number, y: number) =>
      rows[Math.floor(y)]![Math.floor(x)] === "=" ? { classId: 3, class: "residential", width: 0.5, connections: [], lanes: 2, oneWay: false, divided: false } : null,
    objectsAt: (x: number, y: number): ObjectHit[] => {
      const ch = rows[Math.floor(y)]![Math.floor(x)];
      const index = Math.floor(y) * w + Math.floor(x);
      const at = { index, id: null, x, y, bounds: [Math.floor(x), Math.floor(y), Math.floor(x) + 1, Math.floor(y) + 1] as [number, number, number, number], base: 0 };
      if (ch === "#") return [{ ...at, group: "building.house", footprint: true, top: 3 }];
      if (ch === "t") return [{ ...at, group: "tree.conifer", footprint: false, top: null }];
      return [];
    },
  };
  return readCells(query, { x0: 0, y0: 0, w, h }, { defaultHeight: 2 });
}

/** The cells a path walks through, from its start, every fifth of a cell. */
function walked(from: CellPoint, path: CellPoint[]): CellPoint[] {
  const out: CellPoint[] = [];
  let a = from;
  for (const b of path) {
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 5);
    for (let k = 0; k <= n; k++) out.push({ x: Math.floor(a.x + ((b.x - a.x) * k) / n), y: Math.floor(a.y + ((b.y - a.y) * k) / n) });
    a = b;
  }
  return out;
}

describe("cells: a world's rectangle for games (D-125)", () => {
  it("reads water, walls, roads, trees and heights, and the highest thing on each cell", () => {
    const c = cellsOf_([
      "~#=t2", //
    ]);
    expect([...c.flags]).toEqual([CELL_WATER, CELL_WALL, CELL_ROAD, CELL_TREES, 0]);
    expect([...c.height]).toEqual([0, 0, 0, 0, 2]);
    expect([...c.top]).toEqual([0, 3, 0, 2, 2]); // a wall's top; a tree's default height over its base
    expect([...c.roadClass]).toEqual([0, 0, 3, 0, 0]);
    expect(cellsOf(c, [1, 3])).toEqual([1, 3]);
  });

  it("opens a cell once what walled it is taken out, and follows a world's edits", () => {
    const c = cellsOf_([".#t."]);
    setRemoved(c, (o) => o === 1, [1]);
    expect(c.flags[1]! & CELL_WALL).toBe(0);
    expect(c.top[1]).toBe(0);
    setRemoved(c, () => false, [1]);
    expect(c.flags[1]! & CELL_WALL).toBe(CELL_WALL);
    // a world's edits: taken out and put back as its ops come
    const removed = new Set<number>();
    let listener: ((e: WorldEdit) => void) | null = null;
    const stop = followEdits(c, { isRemoved: (o) => removed.has(o), onChange: (f) => ((listener = f), () => (listener = null)) });
    removed.add(2);
    listener!({ op: "remove", objects: [2] });
    expect(c.flags[2]! & CELL_TREES).toBe(0);
    stop();
    expect(listener).toBeNull();
  });

  it("finds a way round a wall through its gap, and never onto water or a wall", () => {
    const c = cellsOf_([
      "..........", //
      "..........",
      "#####.####",
      "..........",
      "~~~~~~~~..",
      "..........",
    ]);
    const from = { x: 0.5, y: 0.5 };
    const path = findPath(c, from, { x: 0.5, y: 5.5 });
    expect(path.at(-1)).toEqual({ x: 0.5, y: 5.5 });
    const cells = walked(from, path);
    expect(cells.every((p) => walkable(c, p.x, p.y))).toBe(true);
    expect(cells.some((p) => p.x === 5 && p.y === 2)).toBe(true);
  });

  it("takes each cell at the game's cost, climbs no more than maxClimb, and goes as near as it can", () => {
    const c = cellsOf_([
      "..........", //
      ".========.",
      "..........",
    ]);
    const roads = (i: number) => (c.flags[i]! & CELL_ROAD ? 2 / 3 : 1);
    const p = findPath(c, { x: 0.5, y: 0.5 }, { x: 9.5, y: 0.5 }, { cost: roads, minCost: 2 / 3 });
    expect(walked({ x: 0.5, y: 0.5 }, p).filter((q) => q.y === 1).length).toBeGreaterThan(20);
    const ridge = cellsOf_([
      "0000500000", //
      "0000500000",
      "0000500000",
    ]);
    expect(findPath(ridge, { x: 2.5, y: 1.5 }, { x: 7.5, y: 1.5 }, { maxClimb: 1.5 }).at(-1)).toEqual({ x: 3.5, y: 1.5 });
    expect(findPath(ridge, { x: 2.5, y: 1.5 }, { x: 7.5, y: 1.5 }).at(-1)).toEqual({ x: 7.5, y: 1.5 });
    expect(lineClear(ridge, { x: 2.5, y: 1.5 }, { x: 7.5, y: 1.5 }, { maxClimb: 1.5 })).toBe(false);
  });

  it("sees over low ground but not through a wall or a ridge; an eye up high sees over them", () => {
    const c = cellsOf_([
      "....#....", //
      ".........",
      "....3....",
    ]);
    const eye = (x: number, y: number, up = 1) => ({ x, y, h: c.height[cellIndex(c, Math.floor(x), Math.floor(y))]! + up });
    expect(lineOfSight(c, eye(0.5, 1.5), eye(8.5, 1.5))).toBe(true);
    expect(lineOfSight(c, eye(0.5, 0.5), eye(8.5, 0.5))).toBe(false); // the wall, 3 steps
    expect(lineOfSight(c, eye(0.5, 2.5), eye(8.5, 2.5))).toBe(false); // the ridge
    expect(lineOfSight(c, eye(0.5, 0.5, 4), eye(8.5, 0.5, 4))).toBe(true);
    // into the cell the target stands on, and out of the eye's own
    expect(lineOfSight(c, eye(3.5, 0.5), eye(4.5, 0.5))).toBe(true);
    // cells an eye looks out over (its own roof) don't hide
    expect(lineOfSight(c, eye(0.5, 0.5), eye(8.5, 0.5), (i) => i === cellIndex(c, 4, 0))).toBe(true);
  });

  it("goes to the edge for a goal off the rectangle, not past it", () => {
    const c = cellsOf_(["......", "......"]);
    const end = findPath(c, { x: 0.5, y: 0.5 }, { x: 1000, y: 1.5 }).at(-1)!;
    expect(end).toEqual({ x: 5.5, y: 1.5 });
  });

  it("a viewshed: what an eye sees around it, nearest eye's distance kept, a wall's shadow left out", () => {
    const c = cellsOf_([
      ".........", //
      "...#.....",
      ".........",
    ]);
    const seen = new Float32Array(c.w * c.h).fill(Infinity);
    viewshed(c, { x: 1.5, y: 1.5, h: 1 }, 6, seen);
    expect(seen[cellIndex(c, 2, 1)]).toBeCloseTo(1);
    expect(seen[cellIndex(c, 6, 1)]).toBe(Infinity); // behind the wall
    expect(seen[cellIndex(c, 4, 2)]).toBeLessThan(Infinity); // beside its shadow
    expect(seen[cellIndex(c, 8, 1)]).toBe(Infinity); // too far
    // a second eye fills in, nearer
    viewshed(c, { x: 7.5, y: 1.5, h: 1 }, 2, seen);
    expect(seen[cellIndex(c, 6, 1)]).toBeCloseTo(1);
    // and a game's reach (fog, say) cuts it short
    const fogged = new Float32Array(c.w * c.h).fill(Infinity);
    viewshed(c, { x: 1.5, y: 1.5, h: 1 }, 6, fogged, { reach: (_, d) => d <= 2 });
    expect(fogged[cellIndex(c, 5, 0)]).toBe(Infinity);
  });
});
