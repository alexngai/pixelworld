import { readFileSync } from "node:fs";
import { stylePack } from "@pixelworlds/game/src/styles";
import { openWorld, setRemoved, type WorldEdit } from "pixelworld/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RtsGame, parseCommand } from "../../src/demos/rts/game";
import {
  BUILDINGS,
  GATHER,
  LAYOUT,
  MAP,
  MATCH,
  MAX_CLIMB,
  OBJECT,
  ROAD,
  START,
  TICK,
  UNITS,
  WATER,
  WOODS,
  GARRISON,
  HIGH_GROUND_DAMAGE,
  Razed,
  SIGHT,
  SURFACE_PACE,
  WOODS_SPEED,
  buildGrid,
  fogCells,
  holds,
  razeCells,
  seesUnit,
  sideSight,
  cellIndex,
  findPath,
  lineClear,
  passable,
  placementError,
  structureHp,
  type MapGrid,
  type Point,
  type RtsEvent,
  type RtsSnap,
  type RtsWorldNet,
  type Team,
} from "../../src/demos/rts/rules";
import { BOT, RtsRoom, openRtsWorld, type RtsWorld } from "../../src/demos/rts/server";
import { TickClient } from "../../src/index";
import { loopback } from "../../src/testing";

/**
 * Fogfront (D-121): its paths, placing, fights and gathering on small maps
 * drawn in text; its server over San Francisco's driving level in Node, two
 * pages ordering through the loopback, and the bot playing a match to a win.
 */

/** A map from text: `.` open, `#` a building of the level's (an object of its own, 1000 + its cell), `~` water, `=` road, `t` woods, a digit open ground that high (steps). */
function gridOf(rows: string[]): MapGrid {
  const h = rows.length;
  const w = rows[0]!.length;
  const n = w * h;
  const g: MapGrid = {
    x0: 0,
    y0: 0,
    w,
    h,
    flags: new Uint8Array(n),
    height: new Float32Array(n),
    top: new Float32Array(n),
    surface: new Uint8Array(n),
    roadClass: new Uint8Array(n),
    objects: new Map(),
    building: new Int32Array(n),
  };
  rows.forEach((r, y) =>
    [...r].forEach((c, x) => {
      const i = y * w + x;
      g.flags[i] = c === "~" ? WATER : c === "#" ? OBJECT : c === "=" ? ROAD : c === "t" ? WOODS : 0;
      if (/\d/.test(c)) g.height[i] = g.top[i] = Number(c);
      if (c === "#") g.objects.set(i, [{ index: 1000 + i, wall: true, trees: false, top: 1 }]);
      if (c === "t") g.objects.set(i, [{ index: 1000 + i, wall: false, trees: true, top: 3 }]);
    }),
  );
  return g;
}

const open = (w: number, h: number) => gridOf(Array.from({ length: h }, () => ".".repeat(w)));

/** Level buildings on a text map's `#` cells: each its object and cells, the cells' walls every one standing there. */
function standing(g: MapGrid, list: { obj: number; cells: [number, number][] }[]): MapGrid {
  g.structures = new Map();
  const walled = new Set<number>();
  for (const { obj, cells } of list) {
    const ids = cells.map(([x, y]) => cellIndex(g, x, y));
    for (const i of ids) {
      if (!walled.has(i)) g.objects.set(i, []); // the cell's own stand-in goes: these wall it
      walled.add(i);
      g.objects.get(i)!.push({ index: obj, wall: true, trees: false, top: 1 });
    }
    const mid = (k: 0 | 1) => cells.reduce((sum, c) => sum + c[k] + 0.5, 0) / cells.length;
    g.structures.set(obj, { obj, x: mid(0), y: mid(1), top: 1, cells: ids, hp: structureHp(cells.length, 1) });
  }
  return g;
}
/** The cells a path walks through, from its start, every fifth of a cell. */
function cellsOf(from: Point, path: Point[]): Point[] {
  const out: Point[] = [];
  let a = from;
  for (const b of path) {
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 5);
    for (let k = 0; k <= n; k++) out.push({ x: Math.floor(a.x + ((b.x - a.x) * k) / n), y: Math.floor(a.y + ((b.y - a.y) * k) / n) });
    a = b;
  }
  return out;
}
const run = (game: RtsGame, seconds: number) => {
  for (let n = Math.round(seconds / TICK); n > 0 && !game.winner; n--) game.step(TICK);
};
const unitsOf = (game: RtsGame, team: Team, kind?: string) => [...game.units.values()].filter((u) => u.team === team && (!kind || u.kind === kind));

describe("Fogfront's paths (D-121)", () => {
  it("goes round a wall through its gap, and never onto water or a building", () => {
    const g = gridOf([
      "..........", //
      "..........",
      "#####.####",
      "..........",
      "~~~~~~~~..",
      "..........",
    ]);
    const path = findPath(g, { x: 0.5, y: 0.5 }, { x: 0.5, y: 5.5 });
    expect(path.at(-1)).toEqual({ x: 0.5, y: 5.5 });
    const cells = cellsOf({ x: 0.5, y: 0.5 }, path);
    expect(cells.every((c) => passable(g, c.x, c.y))).toBe(true);
    expect(cells.some((c) => c.x === 5 && c.y === 2)).toBe(true); // the gap
    expect(cells.some((c) => c.x >= 8 && c.y === 4)).toBe(true); // round the water
  });

  it("takes a road when it is quicker, and goes round woods when that is", () => {
    const road = gridOf([
      "..........", //
      ".========.",
      "..........",
    ]);
    // along the row of road, not the straight line beside it
    const p = findPath(road, { x: 0.5, y: 0.5 }, { x: 9.5, y: 0.5 });
    expect(cellsOf({ x: 0.5, y: 0.5 }, p).filter((c) => c.y === 1).length).toBeGreaterThan(20);
    const woods = gridOf([
      "..........", //
      ".tttttttt.",
      "..........",
    ]);
    const q = findPath(woods, { x: 0.5, y: 1.5 }, { x: 9.5, y: 1.5 });
    expect(cellsOf({ x: 0.5, y: 1.5 }, q).some((c) => c.y !== 1)).toBe(true);
  });

  it("climbs no more than MAX_CLIMB a step", () => {
    expect(MAX_CLIMB).toBeLessThan(2);
    const g = gridOf([
      "0000000000", //
      "0000500000",
      "0000500000",
      "0000500000",
      "0000000000",
    ]);
    const path = findPath(g, { x: 2.5, y: 2.5 }, { x: 7.5, y: 2.5 });
    const cells = cellsOf({ x: 2.5, y: 2.5 }, path);
    expect(cells.some((c) => c.x === 4 && c.y >= 1 && c.y <= 3)).toBe(false); // over the ridge
    expect(path.at(-1)).toEqual({ x: 7.5, y: 2.5 });
  });

  it("goes as near as it can to a goal it can't reach", () => {
    const g = gridOf([
      ".....~~~~~", //
      ".....~~~~~",
      ".....~~~~~",
    ]);
    const path = findPath(g, { x: 0.5, y: 1.5 }, { x: 8.5, y: 1.5 });
    expect(path.at(-1)).toEqual({ x: 4.5, y: 1.5 });
  });
});

describe("Fogfront's building places (D-121)", () => {
  const g = gridOf([
    "....~.....", //
    "....t.....",
    "....#.....",
    "....3.....",
    "..........",
    "..........",
  ]);
  const own = [{ x: 0, y: 4, size: 2 }];
  const at = (units: Point[] = [], seeps: Point[] = []) => ({ own, units, seeps });
  it("needs dry, clear, level ground near one's own buildings, away from units and seeps", () => {
    expect(placementError(g, "lodge", 1, 1, at())).toBeNull();
    expect(placementError(g, "lodge", 3, -1, at())).toBe("outside the field");
    expect(placementError(g, "lodge", 3, 0, at())).toBe("water");
    expect(placementError(g, "lodge", 4, 1, at())).toBe("woods");
    expect(placementError(g, "lodge", 3, 2, at())).toBe("something stands there");
    expect(placementError(g, "lodge", 3, 3, at())).toBe("the ground isn't level");
    expect(placementError(g, "lodge", 1, 1, at([{ x: 2.5, y: 2.5 }]))).toBe("units stand there");
    expect(placementError(g, "lodge", 1, 1, at([], [{ x: 3.5, y: 1.5 }]))).toBe("too near a seep");
    expect(placementError(g, "lodge", 1, 1, { own: [{ x: 30, y: 30, size: 2 }], units: [], seeps: [] })).toBe("too far from your buildings");
  });

  it("can't go up on another building, and the game refuses a bad place and one it can't pay for", () => {
    const game = new RtsGame(open(40, 20), { hearths: { kiln: [2, 2], tide: [34, 14] }, seeps: [[8, 3]] });
    expect(game.order("kiln", { t: "build", kind: "lodge", x: 3, y: 3 })).toBe("a building stands there");
    expect(game.order("kiln", { t: "build", kind: "lodge", x: 30, y: 10 })).toBe("too far from your buildings");
    expect(game.order("kiln", { t: "build", kind: "lodge", x: 2, y: 9 })).toBeNull();
    expect(game.glim.kiln).toBe(START.glim - BUILDINGS.lodge.cost);
    expect(game.order("kiln", { t: "build", kind: "lodge", x: 6, y: 9 })).toBe(`a lodge takes ${BUILDINGS.lodge.cost} glim`);
    // it stands in the way of paths now
    expect(passable(game.grid, 2, 9)).toBe(false);
  });
});

describe("Fogfront's match (D-121)", () => {
  /** An open field: the Kiln's hearth at the left, the Tide's at the right, a seep by each. */
  const field = () => new RtsGame(open(40, 16), { hearths: { kiln: [2, 6], tide: [35, 6] }, seeps: [[7, 7], [32, 7]] });

  it("runners carry glim from a seep to their hearth", () => {
    const game = field();
    expect(unitsOf(game, "kiln", "runner")).toHaveLength(START.runners);
    run(game, 30);
    // three runners, each a trip of a few seconds there and back and two of mining
    expect(game.glim.kiln).toBeGreaterThanOrEqual(START.glim + 6 * GATHER.carry);
    expect([...game.seeps.values()][0]!.left).toBeLessThan(800);
  });

  it("trains a unit for its price and its time, beside the building", () => {
    const game = field();
    const hearth = [...game.buildings.values()].find((b) => b.team === "kiln")!;
    expect(game.order("kiln", { t: "train", b: hearth.id })).toBeNull();
    expect(game.glim.kiln).toBe(START.glim - UNITS.runner.cost);
    run(game, UNITS.runner.time - 0.2);
    expect(unitsOf(game, "kiln", "runner")).toHaveLength(START.runners);
    run(game, 0.4);
    expect(unitsOf(game, "kiln", "runner")).toHaveLength(START.runners + 1);
    expect(game.order("tide", { t: "train", b: hearth.id })).toBe("not your building");
  });

  it("a lodge rises over its time, and trains wardens only once it stands", () => {
    const game = field();
    expect(game.order("kiln", { t: "build", kind: "lodge", x: 3, y: 11 })).toBeNull();
    const lodge = [...game.buildings.values()].find((b) => b.kind === "lodge")!;
    expect(game.order("kiln", { t: "train", b: lodge.id })).toBe("it isn't finished");
    run(game, BUILDINGS.lodge.time + TICK);
    expect(lodge.built).toBe(1);
    expect(lodge.hp).toBeCloseTo(BUILDINGS.lodge.hp, 0);
  });

  it("wardens fight: one against a runner wins in five blows; one against one, the first to strike", () => {
    const game = field();
    const hearth = (t: Team) => [...game.buildings.values()].find((b) => b.team === t)!;
    game.glim.kiln = game.glim.tide = 1000;
    for (const t of ["kiln", "tide"] as const) {
      game.order(t, { t: "build", kind: "lodge", x: hearth(t).x, y: hearth(t).y + 5 });
    }
    run(game, BUILDINGS.lodge.time + TICK);
    const lodge = (t: Team) => [...game.buildings.values()].find((b) => b.team === t && b.kind === "lodge")!;
    game.order("kiln", { t: "train", b: lodge("kiln").id });
    run(game, UNITS.warden.time + TICK);
    const [w] = unitsOf(game, "kiln", "warden");
    const runner = unitsOf(game, "tide", "runner")[0]!;
    // the Kiln's warden is told to attack a Tide runner it can't see: refused
    expect(game.order("kiln", { t: "attack", u: [w!.id], target: runner.id })).toBe("nothing of theirs you can see there");
    // walk it over: it takes on the first foe it sees, and keeps on
    game.order("kiln", { t: "move", u: [w!.id], x: 33, y: 9, attack: true });
    const events: RtsEvent[] = [];
    for (let n = 0; n < 60 / TICK && unitsOf(game, "tide", "runner").length === START.runners; n++) {
      game.step(TICK);
      events.push(...(game.events as RtsEvent[]));
      game.events = [];
    }
    expect(unitsOf(game, "tide", "runner")).toHaveLength(START.runners - 1);
    const killed = events.find((e) => e.kind === "die")!;
    const blows = events.filter((e) => e.kind === "hit" && e.to === (killed as { id: number }).id);
    expect(blows).toHaveLength(Math.ceil(UNITS.runner.hp / UNITS.warden.damage));
  });

  it("a side whose hearth falls loses", () => {
    const game = field();
    const tide = [...game.buildings.values()].find((b) => b.team === "tide")!;
    tide.hp = 5;
    game.glim.kiln = 1000;
    game.order("kiln", { t: "build", kind: "lodge", x: 6, y: 2 });
    run(game, BUILDINGS.lodge.time + TICK);
    const lodge = [...game.buildings.values()].find((b) => b.kind === "lodge")!;
    game.order("kiln", { t: "train", b: lodge.id });
    run(game, UNITS.warden.time + TICK);
    const w = unitsOf(game, "kiln", "warden")[0]!;
    // the hearths are known from the start: an attack on it is taken
    expect(game.order("kiln", { t: "attack", u: [w.id], target: tide.id })).toBeNull();
    run(game, 60);
    expect(game.winner).toBe("kiln");
    expect(game.buildings.has(tide.id)).toBe(false);
    expect(game.order("kiln", { t: "stop", u: [w.id] })).toBe("the match is over");
  });

  it("each side sees its own, and the other's units only within sight (the fog of war)", () => {
    const game = field();
    run(game, 0.5);
    const kiln = game.view("kiln");
    expect(kiln.units.every((u) => u.s === "kiln")).toBe(true);
    expect(kiln.units.every((u) => u.g)).toBe(true); // its own runners' goals
    // the other's hearth is known; nothing else of theirs
    expect(kiln.buildings.map((b) => b.s).sort()).toEqual(["kiln", "tide"]);
    expect(kiln.buildings.find((b) => b.s === "tide")!.q).toBeUndefined();
    // a runner walked over sees theirs
    const r = unitsOf(game, "kiln", "runner")[0]!;
    game.order("kiln", { t: "move", u: [r.id], x: 31, y: 9 });
    run(game, 20);
    const seen = game.view("kiln");
    expect(seen.units.some((u) => u.s === "tide")).toBe(true);
    expect(seen.units.filter((u) => u.s === "tide").every((u) => u.g === undefined)).toBe(true);
  });

  it("units on one spot step apart", () => {
    const game = field();
    const [a, b] = unitsOf(game, "kiln");
    for (const u of [a!, b!]) Object.assign(u, { x: 12.5, y: 3.5, order: { k: "idle" } });
    run(game, 1);
    expect(Math.hypot(a!.x - b!.x, a!.y - b!.y)).toBeGreaterThan(0.3);
  });

  it("a seep or a foe it can't get to doesn't hold a unit for good", () => {
    // the Tide's seep is on an island; the Kiln's runners are sent to it
    const g = gridOf([
      "........................................",
      "..............................~~~~~.....",
      "..............................~...~.....",
      "..............................~~~~~.....",
      "........................................",
      "........................................",
    ]);
    const game = new RtsGame(g, { hearths: { kiln: [2, 2], tide: [36, 2] }, seeps: [[32, 2]] });
    const runners = unitsOf(game, "kiln", "runner");
    expect(game.order("kiln", { t: "gather", u: runners.map((u) => u.id), seep: [...game.seeps.keys()][0]! })).toBeNull();
    run(game, 25);
    expect(runners.every((u) => u.order.k === "idle")).toBe(true);
  });

  it("finds at most so many paths a tick, however many units are ordered", () => {
    const game = new RtsGame(open(60, 40), { hearths: { kiln: [2, 2], tide: [55, 35] }, seeps: [] });
    game.glim.kiln = 100_000;
    const hearth = [...game.buildings.values()].find((b) => b.team === "kiln")!;
    // forty runners, five queued at a time
    for (let n = 0; n < 40; n++) {
      game.order("kiln", { t: "train", b: hearth.id });
      if (hearth.queue.length >= 5) run(game, 6.2);
    }
    run(game, 40);
    const all = unitsOf(game, "kiln");
    expect(all.length).toBeGreaterThan(30);
    game.order("kiln", { t: "move", u: all.map((u) => u.id), x: 40, y: 30 });
    game.step(TICK);
    expect(all.filter((u) => u.pathTo !== null).length).toBe(16);
    run(game, 40);
    expect(all.every((u) => Math.hypot(u.x - 40, u.y - 30) < 6)).toBe(true);
  });

  it("wardens knock down one of the level's buildings: its cells open where nothing else stands, and a new match puts it back (D-124)", () => {
    const g = standing(
      gridOf([
        "....................",
        "....................",
        "......##............",
        "......###...........",
        "....................",
        "....................",
        "....................",
        "....................",
        "....................",
        "....................",
      ]),
      [
        { obj: 7, cells: [[6, 2], [7, 2], [6, 3], [7, 3]] },
        { obj: 8, cells: [[7, 3], [8, 3]] },
      ],
    );
    const game = new RtsGame(g, { hearths: { kiln: [1, 6], tide: [16, 6] }, seeps: [] });
    game.glim.kiln = 1000;
    expect(game.order("kiln", { t: "build", kind: "lodge", x: 5, y: 7 })).toBeNull();
    run(game, BUILDINGS.lodge.time + TICK);
    const lodge = [...game.buildings.values()].find((b) => b.kind === "lodge")!;
    game.order("kiln", { t: "train", b: lodge.id });
    run(game, UNITS.warden.time + TICK);
    const w = unitsOf(game, "kiln", "warden")[0]!;
    const runner = unitsOf(game, "kiln", "runner")[0]!;
    expect(game.order("kiln", { t: "raze", u: [runner.id], obj: 7 })).toBe("runners don't knock buildings down");
    expect(game.order("kiln", { t: "raze", u: [w.id], obj: 99 })).toBe("nothing there to knock down");
    expect(game.order("kiln", { t: "raze", u: [w.id], obj: 7 })).toBeNull();
    const hp = game.structures.get(7)!.hp;
    const blows: RtsEvent[] = [];
    for (let n = 0; n < 60 / TICK && game.structures.has(7); n++) {
      game.step(TICK);
      blows.push(...(game.events as RtsEvent[]).filter((e) => e.kind === "hit" && e.obj));
      game.events = [];
      // the side sees it knocked about
      if (blows.length === 1) expect(game.view("kiln").hurt).toEqual([[7, hp - UNITS.warden.damage]]);
    }
    expect(blows).toHaveLength(Math.ceil(hp / UNITS.warden.damage));
    expect(game.razed).toEqual([7]);
    game.step(TICK); // the warden finds it gone
    expect(w.order.k).toBe("idle");
    expect([passable(g, 6, 2), passable(g, 7, 2), passable(g, 6, 3)]).toEqual([true, true, true]);
    expect([passable(g, 7, 3), passable(g, 8, 3)]).toEqual([false, false]); // the other still walls them
    expect(game.order("kiln", { t: "raze", u: [w.id], obj: 7 })).toBe("nothing there to knock down");
    game.order("kiln", { t: "raze", u: [w.id], obj: 8 });
    run(game, 40);
    expect(game.razed).toEqual([7, 8]);
    expect(passable(g, 7, 3)).toBe(true);
    // a new match: every building stands again
    game.reset();
    expect(game.razed).toEqual([]);
    expect([passable(g, 6, 2), passable(g, 7, 3)]).toEqual([false, false]);
    expect(game.structures.get(7)!.hp).toBe(hp);
  });

  it("a warden goes for the wall nearest it, not a U-shaped building's open middle (D-124)", () => {
    const rows = [
      "................",
      "................",
      "..#########.....",
      "..#.......#.....",
      "..#.......#.....",
      "..#.......#.....",
      "..#.......#.....",
      "..#.......#.....",
      "..#.......#.....",
      "................",
      "................",
      "................",
      "................",
      "................",
    ];
    const cells: [number, number][] = [];
    rows.forEach((r, y) => [...r].forEach((c, x) => c === "#" && cells.push([x, y])));
    const game = new RtsGame(standing(gridOf(rows), [{ obj: 1, cells }]), { hearths: { kiln: [12, 10], tide: [12, 3] }, seeps: [] });
    // its middle is open ground 1.5 cells from the nearest wall, out of a warden's reach
    const s = game.structures.get(1)!;
    expect([s.x, s.y]).toEqual([6.5, 4.5]);
    const w = Object.assign(unitsOf(game, "kiln")[0]!, { kind: "warden" as const, hp: UNITS.warden.hp, x: 6.5, y: 11.5, order: { k: "idle" as const } });
    expect(game.order("kiln", { t: "raze", u: [w.id], obj: 1 })).toBeNull();
    run(game, 120);
    expect(game.razed).toEqual([1]);
  });

  it("a page puts the match's fallen buildings into its world's edits and its cells, and puts them back for a new match (D-124)", () => {
    const g = standing(gridOf(["##..", "#..."]), [
      { obj: 3, cells: [[0, 0], [1, 0]] },
      { obj: 5, cells: [[0, 0], [0, 1]] },
    ]);
    const ops: WorldEdit[] = [];
    const edits = {
      remove: (o: Iterable<number>) => (ops.push({ op: "remove", objects: [...o] }), null),
      restore: () => (ops.push({ op: "restore", objects: [] }), null),
    };
    const razed = new Razed(edits, g);
    expect(razed.sync([])).toEqual([]);
    expect(razed.sync([3])).toEqual([3]);
    expect([passable(g, 1, 0), passable(g, 0, 0)]).toEqual([true, false]);
    expect(razed.sync([3])).toEqual([]);
    expect(razed.sync([3, 5])).toEqual([5]);
    expect([passable(g, 0, 0), passable(g, 0, 1)]).toEqual([true, true]);
    // a new match's list starts over
    expect(razed.sync([5])).toEqual([5]);
    expect([passable(g, 1, 0), passable(g, 0, 0), passable(g, 0, 1)]).toEqual([false, false, true]);
    expect(ops).toEqual([
      { op: "remove", objects: [3] },
      { op: "remove", objects: [5] },
      { op: "restore", objects: [] },
      { op: "remove", objects: [5] },
    ]);
  });

  it("takes only its own side's units, and checks a page's command's shape", () => {
    const game = field();
    const theirs = unitsOf(game, "tide")[0]!;
    expect(game.order("kiln", { t: "move", u: [theirs.id], x: 5, y: 5 })).toBe("no units of yours");
    expect(parseCommand({ t: "move", u: [1, 2], x: 3, y: 4 })).toEqual({ t: "move", u: [1, 2], x: 3, y: 4, attack: false });
    expect(parseCommand({ t: "raze", u: [1], obj: 40 })).toEqual({ t: "raze", u: [1], obj: 40 });
    for (const bad of [null, 7, { t: "move", u: "1", x: 1, y: 1 }, { t: "move", u: [1], x: Infinity, y: 1 }, { t: "build", kind: "tower", x: 1, y: 1 }, { t: "train", b: 1.5 }, { t: "launch" }, { t: "raze", u: [1], obj: "7" }])
      expect(parseCommand(bad)).toBeNull();
    expect(parseCommand({ t: "stop", u: Array.from({ length: 201 }, (_, i) => i) })).toBeNull();
  });
});

describe("Fogfront's garrisons in the level's buildings (D-125)", () => {
  /** An open field with a two-cell building of the level's in the middle (object 7). */
  const town = () => {
    const rows = Array.from({ length: 16 }, (_, y) => [...".".repeat(40)].map((c, x) => (y === 7 && (x === 20 || x === 21) ? "#" : c)).join(""));
    const g = standing(gridOf(rows), [{ obj: 7, cells: [[20, 7], [21, 7]] }]);
    return new RtsGame(g, { hearths: { kiln: [2, 6], tide: [35, 6] }, seeps: [] });
  };

  it("units go in, hidden from the other side and watching from its roof; it holds so many, of one side; they come out beside it", () => {
    const game = town();
    const runners = unitsOf(game, "kiln", "runner");
    expect(game.order("kiln", { t: "enter", u: runners.map((u) => u.id), obj: 7 })).toBeNull();
    run(game, 15);
    expect(game.garrison(7)).toHaveLength(START.runners);
    // the other side walks right up: it sees nobody
    const scout = unitsOf(game, "tide", "runner")[0]!;
    game.order("tide", { t: "move", u: [scout.id], x: 22.5, y: 8.5 });
    run(game, 12);
    expect(game.view("tide").units.some((u) => u.s === "kiln" && runners.some((r) => r.id === u.i))).toBe(false);
    expect(game.view("kiln").units.filter((u) => u.in === 7)).toHaveLength(START.runners);
    // its roof: the Kiln sees the scout from inside
    expect(game.view("kiln").units.some((u) => u.i === scout.id)).toBe(true);
    // full (2 a cell: 4), and the other side's for the Tide
    game.glim.kiln = 1000;
    const hearth = [...game.buildings.values()].find((b) => b.team === "kiln")!;
    game.order("kiln", { t: "train", b: hearth.id });
    game.order("kiln", { t: "train", b: hearth.id });
    run(game, 2 * UNITS.runner.time + 0.5);
    const more = unitsOf(game, "kiln", "runner").filter((u) => u.inside === null).map((u) => u.id);
    expect(game.order("kiln", { t: "enter", u: more, obj: 7 })).toBe(`it holds ${holds({ cells: [0, 1] })}`);
    expect(game.order("tide", { t: "enter", u: [scout.id], obj: 7 })).toBe("the other side holds it");
    // out, beside it
    expect(game.order("kiln", { t: "leave", obj: 7 })).toBeNull();
    expect(game.garrison(7)).toHaveLength(0);
    for (const r of runners) expect(Math.hypot(r.x - 20.5, r.y - 7.5)).toBeLessThan(3);
    expect(game.order("kiln", { t: "leave", obj: 7 })).toBe("none of yours in there");
  });

  it("a building knocked down throws out those inside, hurt", () => {
    const game = town();
    const [r] = unitsOf(game, "kiln", "runner");
    game.order("kiln", { t: "enter", u: [r!.id], obj: 7 });
    run(game, 15);
    expect(r!.inside).toBe(7);
    game.structures.get(7)!.hp = 0;
    game.step(TICK);
    expect(r!.inside).toBeNull();
    expect(r!.hp).toBe(UNITS.runner.hp - GARRISON.fall);
    expect(game.razed).toEqual([7]);
  });
});

describe("Fogfront's sight from the level (D-125)", () => {
  const eye = (x: number, y: number, radius = 6) => ({ x, y, up: SIGHT.eye, radius });

  it("a level's building hides what stands behind it, until it falls", () => {
    const g = standing(
      gridOf([
        "..........", //
        "....#.....",
        "..........",
      ]),
      [{ obj: 7, cells: [[4, 1]] }],
    );
    setRemoved(g, () => false);
    const sight = sideSight(g, [eye(1.5, 1.5)], null);
    expect(seesUnit(g, sight, 6.5, 1.5)).toBe(false);
    expect(seesUnit(g, sight, 6.5, 0.2)).toBe(true); // beside its shadow
    razeCells(g, 7, new Set([7]));
    expect(seesUnit(g, sideSight(g, [eye(1.5, 1.5)], null), 6.5, 1.5)).toBe(true);
  });

  it("sees further from high ground, and a unit in woods only from near", () => {
    const flat = open(20, 3);
    const hill = gridOf(["00000000000000000000", "00330000000000000000", "00000000000000000000"]);
    const far = { x: 10.5, y: 1.5 };
    expect(seesUnit(flat, sideSight(flat, [eye(2.5, 1.5)], null), far.x, far.y)).toBe(false); // 8 cells off, 6 of sight
    expect(seesUnit(hill, sideSight(hill, [eye(2.5, 1.5)], null), far.x, far.y)).toBe(true); // 3 steps up: further
    const woods = gridOf(["..........", "....ttt...", ".........."]);
    setRemoved(woods, () => false);
    const sight = sideSight(woods, [eye(1.5, 1.5)], null);
    expect(seesUnit(woods, sight, 4.5, 0.5)).toBe(true); // in the open beside them
    expect(seesUnit(woods, sight, 3.5, 1.5)).toBe(true); // into the woods' edge, two cells off
    expect(seesUnit(woods, sight, 5.5, 1.5)).toBe(false); // deeper in
  });

  it("fog shortens sight, where the eye or what it looks at stands in it", () => {
    const g = open(20, 3);
    const clear = sideSight(g, [eye(1.5, 1.5)], null);
    const thick = sideSight(g, [eye(1.5, 1.5)], fogCells(g, () => 1));
    expect(seesUnit(g, clear, 6.5, 1.5)).toBe(true);
    expect(seesUnit(g, thick, 6.5, 1.5)).toBe(false);
    expect(seesUnit(g, thick, 3.5, 1.5)).toBe(true); // 6 × 0.4 cells still
  });

  it("a blow from a step or more above lands harder", () => {
    const game = new RtsGame(gridOf(["2222200000000000", "2222200000000000", "2222200000000000", "0000000000000000"]), { hearths: { kiln: [0, 0], tide: [12, 0] }, seeps: [] });
    const [a, b] = [...game.units.values()].filter((u) => u.team === "kiln");
    const foe = [...game.units.values()].find((u) => u.team === "tide")!;
    Object.assign(a!, { kind: "warden", x: 4.5, y: 2.5, order: { k: "idle" } });
    Object.assign(foe, { x: 5.6, y: 2.5, hp: 100 });
    Object.assign(b!, { x: 0.5, y: 0.5 });
    game.step(TICK);
    game.step(TICK);
    expect(foe.hp).toBeCloseTo(100 - UNITS.warden.damage * HIGH_GROUND_DAMAGE, 5);
  });
});

// ---------------------------------------------------------------- over the real level

const ROOT = new URL("../../../../", import.meta.url);
let world: RtsWorld;

describe("Fogfront's server over the Presidio (D-121)", () => {
  beforeAll(async () => {
    vi.stubGlobal("fetch", async (url: string | URL) => {
      try {
        return new Response(readFileSync(new URL(`fixtures${new URL(String(url)).pathname}`, ROOT)));
      } catch {
        return new Response("not found", { status: 404 });
      }
    });
    world = await openRtsWorld("https://pixelworld.test/sf/");
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("goes by the level's ground: quicker on bigger roads, slow on the beach and in woods (D-125)", () => {
    const g = world.grid;
    const pace = g.pace!;
    const by = new Map<number, number>();
    for (const v of pace) by.set(Math.round(v * 100) / 100, (by.get(Math.round(v * 100) / 100) ?? 0) + 1);
    expect(by.get(SURFACE_PACE.desert!)).toBeGreaterThan(100); // Baker Beach (the level calls its sand desert)
    expect(by.get(WOODS_SPEED)).toBeGreaterThan(1000); // the woods
    expect([...by.keys()].filter((v) => v >= 1.2).length).toBeGreaterThanOrEqual(4); // roads of several classes
    // the Kiln's runners walk the beach at its pace
    const [kx, ky] = LAYOUT.hearths.kiln;
    expect(pace[cellIndex(g, kx - 1, ky + 1)]).toBeCloseTo(SURFACE_PACE.desert!, 5);
  });

  it("the Golden Gate's fog comes over the Presidio and goes, and hides what stands in it (D-125)", () => {
    const fog = world.fog!;
    expect(fog).not.toBeNull();
    const cover = (t: number) => fogCells(world.grid, (x, y, h) => fog.at(x, y, h, t));
    const shares = [0, 120, 240, 360, 480].map((t) => cover(t).filter((v) => v > 0.3).length / world.grid.flags.length);
    expect(Math.max(...shares)).toBeGreaterThan(0.05); // part of the map lies in it
    expect(Math.max(...shares)).toBeLessThan(0.9); // not all of it
    expect(new Set(shares.map((v) => v.toFixed(3))).size).toBeGreaterThan(1); // it drifts
  });

  it("reads the play area: water, woods, roads and the level's buildings, and a way from one hearth to the other", () => {
    const g = world.grid;
    const count = (f: number) => g.flags.filter((v) => (v & f) !== 0).length;
    expect(count(WATER)).toBeGreaterThan(500); // the Golden Gate and the bay
    expect(count(WOODS)).toBeGreaterThan(2000); // the Presidio's woods
    expect(count(ROAD)).toBeGreaterThan(500);
    expect(count(OBJECT)).toBeGreaterThan(50);
    const [kx, ky] = LAYOUT.hearths.kiln;
    const [tx, ty] = LAYOUT.hearths.tide;
    for (const [x, y] of [...Object.values(LAYOUT.hearths), ...LAYOUT.seeps]) expect(g.flags[cellIndex(g, x, y)]! & (WATER | OBJECT)).toBe(0);
    const from = { x: kx - 0.5, y: ky + 1.5 };
    const path = findPath(g, from, { x: tx - 0.5, y: ty + 1.5 });
    expect(path.at(-1)).toEqual({ x: tx - 0.5, y: ty + 1.5 });
    let a = from;
    for (const b of path) {
      expect(lineClear(g, a, b)).toBe(true);
      a = b;
    }
  });

  /** A room on the loopback, its world in place. */
  const opened = async (fps: number) => {
    const lb = loopback((room) => new RtsRoom(room, Promise.resolve(world), false), { fps });
    await new Promise((r) => setTimeout(r, 0)); // the world arrives
    return lb;
  };

  it("two pages in a room: a side each, orders taken and acknowledged, what each sees its own", async () => {
    const lb = await opened(60);
    const pages = [lb.join(0.05), lb.join(0.08)];
    const snaps: (RtsSnap & { t: number; cmd?: number })[][] = [[], []];
    const worlds: RtsWorldNet[] = [];
    const events: RtsEvent[][] = [[], []];
    const clients = pages.map(
      (p, n) =>
        new TickClient<never, RtsSnap, RtsWorldNet, RtsEvent>(p.room, {
          tick: TICK,
          now: lb.now,
          restore: (s) => void snaps[n]!.push(s),
          onWorld: (w) => void worlds.push(w),
        }),
    );
    clients.forEach((c, n) => c.hello({ name: `P${n}`, vs: "any" }));
    const frame = () => clients.forEach((c, n) => (c.sync(), events[n]!.push(...c.due())));
    lb.run(1, frame);
    expect(lb.host.match.phase).toBe("playing");
    const sides = snaps.map((s) => s.at(-1)!.side);
    expect(new Set(sides)).toEqual(new Set(["kiln", "tide"]));
    expect(worlds.at(-1)!.players.map((p) => p.name).sort()).toEqual(["P0", "P1"]);
    // the fog of war: neither sees the other's runners at home
    for (const s of snaps) expect(s.at(-1)!.units.every((u) => u.s === s.at(-1)!.side)).toBe(true);

    // page 0 trains a runner and sends a runner off: both acknowledged in its next snapshots
    const mine = snaps[0]!.at(-1)!;
    const hearth = mine.buildings.find((b) => b.s === mine.side && b.k === "hearth")!;
    const runner = mine.units[0]!;
    const n1 = clients[0]!.command({ t: "train", b: hearth.i });
    const n2 = clients[0]!.command({ t: "move", u: [runner.i], x: 165, y: 215 });
    expect(n2).toBe(n1 + 1);
    const before = snaps[0]!.length;
    lb.run(0.4, frame);
    const acked = snaps[0]!.slice(before).find((s) => (s.cmd ?? 0) >= n2)!;
    expect(acked).toBeDefined();
    expect(acked.glim).toBe(mine.glim - UNITS.runner.cost);
    expect(acked.units.find((u) => u.i === runner.i)!.g).toEqual([165, 215]);
    expect(clients[0]!.ping).toBeGreaterThan(100); // 50 ms each way, and a tick or two
    expect(clients[0]!.ping).toBeLessThan(300);
    // another page's order to these units isn't taken; a bad one is refused, to that page alone
    clients[1]!.command({ t: "move", u: [runner.i], x: 200, y: 180 });
    clients[1]!.command({ t: "build", kind: "lodge", x: 0, y: 0 });
    lb.run(1, frame);
    expect(events[1]!.filter((e) => e.kind === "refused").map((e) => (e as { why: string }).why)).toEqual(["no units of yours", "outside the field"]);
    expect(events[0]!.some((e) => e.kind === "refused")).toBe(false);
    expect(snaps[0]!.at(-1)!.units.find((u) => u.i === runner.i)!.g).toEqual([165, 215]);
    // a third page is turned away, saying why
    const third = lb.join();
    third.room.send({ k: "hello", join: { name: "late" } });
    lb.run(0.5);
    expect(third.why).toBe("this match has both its sides: open another room");
    // one leaves mid-match: the other wins
    pages[1]!.room.close();
    lb.run(0.5, frame);
    expect(lb.host.match.phase).toBe("ended");
    expect(worlds.at(-1)!.match.winner).toBe(sides[0]);
  });

  it("the bot plays a match against a page that does nothing, and takes its hearth", async () => {
    const lb = await opened(20);
    const page = lb.join(0.05);
    const worlds: RtsWorldNet[] = [];
    const events: RtsEvent[] = [];
    const client = new TickClient<never, RtsSnap, RtsWorldNet, RtsEvent>(page.room, { tick: TICK, now: lb.now, onWorld: (w) => void worlds.push(w) });
    client.hello({ name: "Idle", vs: "bot" });
    const frame = () => {
      client.sync();
      events.push(...client.due());
    };
    lb.run(1, frame);
    expect(lb.host.match.phase).toBe("playing");
    const botSide = lb.host.sideOf(BOT)!;
    expect(worlds.at(-1)!.players.find((p) => p.bot)!.side).toBe(botSide);
    let seconds = 0;
    while (lb.host.match.phase === "playing" && seconds < 600) {
      lb.run(10, frame);
      seconds += 10;
    }
    expect(lb.host.match.phase).toBe("ended");
    expect(worlds.at(-1)!.match.winner).toBe(botSide);
    expect(events.find((e) => e.kind === "phase" && e.phase === "ended")).toEqual({ kind: "phase", phase: "ended", winner: botSide });
    expect(seconds).toBeLessThan(300);
    // after the result, the next match: the bot again for the page still alone
    lb.run(20, frame);
    expect(lb.host.match.phase).toBe("playing");
    expect(lb.failed).toBeUndefined();
  });

  it("a snapshot stays small with forty units", () => {
    const game = new RtsGame({ ...world.grid, building: new Int32Array(world.grid.building.length) });
    game.glim.kiln = 100_000;
    const hearth = [...game.buildings.values()].find((b) => b.team === "kiln")!;
    // forty runners, trained one after another, each off to a seep
    for (let n = 0; n < 6000 && unitsOf(game, "kiln").length < 40; n++) {
      if (hearth.queue.length < 2) game.order("kiln", { t: "train", b: hearth.id });
      game.step(TICK);
    }
    const snap = game.view("kiln");
    expect(snap.units).toHaveLength(40);
    // under 100 bytes a unit as JSON, positions to a hundredth of a cell: about 3.5 KB, ten a second
    expect(JSON.stringify(snap.units).length / snap.units.length).toBeLessThan(100);
  });

  it("reads the level's buildings in the play area, with hit points from their size and height (D-124)", () => {
    const list = [...world.grid.structures!.values()];
    expect(list.length).toBeGreaterThan(100);
    for (const s of list) {
      expect(s.cells.every((i) => (world.grid.flags[i]! & OBJECT) !== 0)).toBe(true);
      expect(s.hp).toBeGreaterThanOrEqual(structureHp(s.cells.length, 0));
      expect(s.hp).toBeLessThanOrEqual(1000);
    }
  });

  it("a building that falls reaches both pages' worlds, and a page that comes late; a new match puts it back (D-124)", async () => {
    /** A page's world: the level's queries and edits, its own cells, and the match's fallen buildings put into them. */
    const pageWorld = async () => {
      const { query, edits } = await openWorld({ worldUrl: "https://pixelworld.test/sf/", style: stylePack });
      await query.ensure(MAP.x0, MAP.y0, MAP.x0 + MAP.w, MAP.y0 + MAP.h);
      const grid = buildGrid(query);
      return { query, edits, grid, razed: new Razed(edits, grid) };
    };
    const worlds = await Promise.all([pageWorld(), pageWorld(), pageWorld()]);
    // the building nearest the Tide's hearth, and a cell it alone walls
    const [hx, hy] = LAYOUT.hearths.tide;
    const target = [...world.grid.structures!.values()].sort((a, b) => Math.hypot(a.x - hx, a.y - hy) - Math.hypot(b.x - hx, b.y - hy))[0]!;
    const cell = target.cells.find((i) => world.grid.objects.get(i)!.filter((o) => o.wall).length === 1)!;
    const [cx, cy] = [(cell % MAP.w) + MAP.x0, Math.floor(cell / MAP.w) + MAP.y0];
    const standsIn = (n: number) => worlds[n]!.query.objectsAt(cx + 0.5, cy + 0.5).some((o) => o.index === target.obj);
    expect([standsIn(0), standsIn(1), standsIn(2)]).toEqual([true, true, true]);

    const lb = loopback((room) => new RtsRoom(room, Promise.resolve(world), false), { fps: 20 });
    await new Promise((r) => setTimeout(r, 0));
    const pages = [lb.join(0.05), lb.join(0.08)];
    const fell: number[][] = [[], [], []];
    const client = (n: number, p: (typeof pages)[number]) =>
      new TickClient<never, RtsSnap, RtsWorldNet, RtsEvent>(p.room, { tick: TICK, now: lb.now, onWorld: (w) => void fell[n]!.push(...worlds[n]!.razed.sync(w.razed)) });
    const clients = pages.map((p, n) => client(n, p));
    clients.forEach((c, n) => c.hello({ name: `P${n}`, vs: "any" }));
    const frame = () => clients.forEach((c) => c.sync());
    lb.run(1, frame);
    expect(lb.host.match.phase).toBe("playing");
    // it falls (knocked down: game.test shows the wardens doing it)
    lb.host.game!.structures.get(target.obj)!.hp = 0;
    lb.run(0.5, frame);
    expect(lb.host.game!.razed).toEqual([target.obj]);
    expect(fell.slice(0, 2)).toEqual([[target.obj], [target.obj]]);
    expect([standsIn(0), standsIn(1), standsIn(2)]).toEqual([false, false, true]);
    expect(worlds[0]!.edits.removed()).toEqual([target.obj]);
    expect(passable(worlds[0]!.grid, cx, cy)).toBe(true);
    // the room's cells are its own: the level's stay as they were
    expect(passable(world.grid, cx, cy)).toBe(false);
    expect(passable(lb.host.game!.grid, cx, cy)).toBe(true);

    // one leaves (the match ends); a page that comes now takes it out of its world from its first shared snapshot
    pages[1]!.room.close();
    lb.run(0.5, frame);
    expect(lb.host.match.phase).toBe("ended");
    const late = lb.join(0.05);
    clients.push(client(2, late));
    clients[2]!.hello({ name: "Late", vs: "any" });
    lb.run(0.5, frame);
    expect(fell[2]).toEqual([target.obj]);
    expect(standsIn(2)).toBe(false);

    // the next match: it stands again everywhere
    lb.run(MATCH.ended + 1, frame);
    expect(lb.host.match.phase).toBe("playing");
    expect(lb.host.game!.razed).toEqual([]);
    expect([standsIn(0), standsIn(2)]).toEqual([true, true]);
    expect(passable(worlds[0]!.grid, cx, cy)).toBe(false);
    expect(lb.failed).toBeUndefined();
  });
});
