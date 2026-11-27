import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openWorld, type OpenedWorld } from "../src/index";
import {
  Boards,
  CELL_WALL,
  CELL_WATER,
  boardCellAt,
  cutBoard,
  findPath,
  followEdits,
  lineOfSight,
  readCells,
  toBoard,
  toWorld,
  type Board,
} from "../src/boardsIndex";

/**
 * Terrain edits (D-147) and boards at any resolution (D-148) on Manhattan's
 * walking level, in Node as a game server opens it: cell edits change what
 * the queries answer, boards and `readCells` grids follow every edit, paths
 * and sight work on a board, and replaying the log gives the same boards.
 */

const ROOT = new URL("../../../", import.meta.url);
const style = (id: string) => JSON.parse(readFileSync(new URL(`worlds/_styles/${id}/style.json`, ROOT), "utf8")) as object;

function serveFixtures(): void {
  vi.stubGlobal("fetch", async (url: string | URL) => {
    try {
      return new Response(readFileSync(new URL(`fixtures${new URL(String(url)).pathname}`, ROOT)));
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const open = () => openWorld({ worldUrl: "nyc-walk/", base: "https://pixelworld.test/", style });

/** A board over Battery Park and the Financial District's edge: water, lawn, trees and towers. */
function battery(w: OpenedWorld) {
  const [x, y] = w.query.lonLatToCell(-74.0155, 40.7045)!;
  return { x0: Math.floor(x) - 12, y0: Math.floor(y) - 12, w: 24, h: 24 };
}

const roofs = (b: Board) => [...b.top.keys()].filter((i) => b.flags[i]! & CELL_WALL && b.top[i]! > b.height[i]! + 2);

describe("boards at any resolution (D-148)", () => {
  it("cuts boards from what the queries answer, at world cells and finer and coarser", async () => {
    serveFixtures();
    const w = await open();
    const spec = battery(w);
    await w.query.ensure(spec.x0 - 1, spec.y0 - 1, spec.x0 + 26, spec.y0 + 26);
    const b = cutBoard(w.query, w.world, spec);
    expect([b.w, b.h, b.cell, b.samples, b.metersPerCell, b.x0, b.y0]).toEqual([24, 24, 1, 2, 10, 0, 0]);
    expect(roofs(b).length).toBeGreaterThan(10);
    expect([...b.object].filter((o) => o >= 0).length).toBeGreaterThan(50);
    // at one sample a cell it is readCells's grid, in board coordinates
    const one = cutBoard(w.query, w.world, { ...spec, samples: 1 });
    const cells = readCells(w.query, { x0: spec.x0, y0: spec.y0, w: 24, h: 24 });
    expect(Array.from(one.flags)).toEqual(Array.from(cells.flags));
    expect(Array.from(one.top)).toEqual(Array.from(cells.top));
    // a board cell's middle and the world point there
    const i = 7 * 24 + 5;
    const mid = toWorld(b, { x: 5.5, y: 7.5 });
    expect(boardCellAt(b, mid.x, mid.y)).toBe(i);
    expect(toBoard(b, mid.x, mid.y)).toEqual({ x: 5.5, y: 7.5 });
    // the same ground at four times the cells, and at a sixteenth
    const fine = cutBoard(w.query, w.world, { ...spec, w: 48, h: 48, cell: 0.5 });
    const coarse = cutBoard(w.query, w.world, { ...spec, w: 6, h: 6, cell: 4 });
    expect([coarse.samples, coarse.metersPerCell]).toEqual([8, 40]);
    const mean = (a: Float32Array) => a.reduce((s, v) => s + v, 0) / a.length;
    expect(mean(fine.height)).toBeCloseTo(mean(b.height), 0);
    expect(mean(coarse.height)).toBeCloseTo(mean(b.height), 0);
  });

  it("walks and sees on a board as on world cells", async () => {
    serveFixtures();
    const w = await open();
    const boards = new Boards(w);
    const b = await boards.add({ ...battery(w), cell: 2, w: 12, h: 12 });
    const open_ = [...b.flags.keys()].filter((i) => !(b.flags[i]! & (CELL_WALL | CELL_WATER)));
    const [a, z] = [open_[0]!, open_[open_.length - 1]!];
    const path = findPath(b, { x: (a % 12) + 0.5, y: Math.floor(a / 12) + 0.5 }, { x: (z % 12) + 0.5, y: Math.floor(z / 12) + 0.5 });
    expect(path.length).toBeGreaterThan(0);
    for (const p of path) expect(b.flags[boardCellAt(b, toWorld(b, p).x, toWorld(b, p).y)]! & CELL_WALL).toBe(0);
    // over a tower's roof nothing is seen from the ground beyond it
    const roof = roofs(b)[0]!;
    const [ri, rj] = [roof % 12, Math.floor(roof / 12)];
    const eye = { x: ri - 1.5, y: rj + 0.5, h: b.height[roof]! + 1 };
    if (ri >= 2 && ri <= 9) expect(lineOfSight(b, eye, { x: ri + 2.5, y: rj + 0.5, h: b.height[roof]! + 1 })).toBe(false);
    boards.dispose();
  });
});

describe("terrain edits (D-147), and the boards over them", () => {
  it("edits cells' surface, water and height, leaves out what isn't in the world, and every board and grid follows", async () => {
    serveFixtures();
    const w = await open();
    const spec = battery(w);
    const boards = new Boards(w);
    const board = await boards.add(spec);
    const half = await boards.add({ ...spec, x0: spec.x0 + 6, w: 36, h: 36, cell: 0.5 }); // overlapping, finer
    const grid = readCells(w.query, { x0: spec.x0, y0: spec.y0, w: 24, h: 24 });
    const stop = followEdits(grid, w.edits, w.query);
    const changed: [number, number][] = [];
    boards.onChange((b, cells) => changed.push([boards.boards.indexOf(b), cells.length]));

    // an open cell of the board: scorch it, flood the next, raise the one after
    const k = [...board.flags.keys()].find((i) => i % 24 < 20 && [0, 1, 2].every((d) => !(board.flags[i + d]! & (CELL_WALL | CELL_WATER))))!;
    const [cx, cy] = [spec.x0 + (k % 24), spec.y0 + Math.floor(k / 24)];
    const before = w.query.heightAt(cx + 2.5, cy + 0.5)!;
    const level = Math.ceil(w.query.heightAt(cx + 1.5, cy + 0.5)!) + 1;
    const op = w.edits.cells([
      { x: cx, y: cy, surface: "rock" },
      { x: cx + 1, y: cy, water: level, surface: "water" },
      { x: cx + 2, y: cy, height: before + 4 },
      { x: -1, y: 0, water: 3 }, // outside the world
      { x: cx, y: cy, surface: "lava" }, // no such surface
    ]);
    expect(op).toMatchObject({ op: "cells" });
    expect(op?.op === "cells" && op.cells.length).toBe(3);
    expect(w.query.surfaceAt(cx + 0.5, cy + 0.5)!.name).toBe("rock");
    expect(w.query.surfaceAt(cx + 1.5, cy + 0.5)!.waterLevel).toBe(level);
    expect(w.query.heightAt(cx + 2.5, cy + 0.5)).toBeCloseTo(before + 4, 0);
    expect(board.surface[k]).toBe(1); // rock's id
    expect(board.flags[k + 1]! & CELL_WATER).toBe(CELL_WATER);
    expect(board.water[k + 1]).toBe(level);
    expect(board.height[k + 2]).toBeCloseTo(before + 4, 0);
    expect(grid.flags[k + 1]! & CELL_WATER).toBe(CELL_WATER);
    expect(grid.height[k + 2]).toBeCloseTo(before + 4, 0);
    expect(changed.some(([b]) => b === 0)).toBe(true);
    const wet = boardCellAt(half, cx + 1.25, cy + 0.25);
    if (wet >= 0) expect(half.water[wet]).toBe(level);
    expect(w.edits.cells([{ x: 1e9, y: 0, surface: "rock" }])).toBeNull(); // nothing applied: no op

    // a building: fell it, and every board over it opens; put it back, and it stands again
    const r = roofs(board).find((i) => board.object[i]! >= 0)!;
    const victim = board.object[r]!;
    const standing = [...board.objects.get(r)!].map((o) => o.index);
    w.edits.remove(standing);
    expect(board.object[r]).not.toBe(victim);
    expect(board.flags[r]! & CELL_WALL).toBe(0);
    expect(grid.flags[r]! & CELL_WALL).toBe(0);
    w.edits.restore(standing);
    expect(board.object[r]).toBe(victim);
    expect(board.flags[r]! & CELL_WALL).toBe(CELL_WALL);
    expect(grid.flags[r]! & CELL_WALL).toBe(CELL_WALL);

    // a late joiner replays the log and cuts the same boards
    const late = await open();
    for (const e of w.edits.list()) late.edits.apply(e);
    const again = await new Boards(late).add(spec);
    for (const name of ["height", "top", "surface", "flags", "water", "object", "cover"] as const)
      expect(Array.from(again[name]), name).toEqual(Array.from(board[name]));
    stop();
    boards.dispose();
  });
});
