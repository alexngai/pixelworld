import { readFileSync } from "node:fs";
import { stylePack } from "@pixelworlds/game/src/styles";
import { openWorld, setRemoved, type WorldEdit } from "pixelworld/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RtsGame, parseCommand } from "../../src/demos/rts/game";
import {
  BUILDINGS,
  DAY,
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
  OBJECTIVE,
  Razed,
  SIGHT,
  SURFACE_PACE,
  WOODS_SPEED,
  buildGrid,
  fogCells,
  holds,
  isNight,
  nextLight,
  razeCells,
  roofEye,
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
import { TRAFFIC, trafficArea } from "../../src/demos/rts/rules";
import { RemoteTraffic, TickClient, type Room } from "../../src/index";
import { loopback } from "../../src/testing";

type Seen = RtsSnap & { t: number; cmd?: number };
/**
 * A Fogfront page on the loopback: its side's views as they come (in its
 * group's shared snapshot, D-127), each marked with the last command its own
 * snapshot of that time says was taken; and the shared snapshots.
 */
const rtsClient = (room: Room, now: () => number, views: Seen[], worlds?: RtsWorldNet[]) =>
  new TickClient<never, object, RtsWorldNet, RtsEvent>(room, {
    tick: TICK,
    now,
    onWorld: (w) => {
      worlds?.push(w);
      if (w.view) views.push({ ...w.view, t: w.t });
    },
    restore: (s) => {
      const v = views.findLast((v) => v.t === s.t);
      if (v && s.cmd !== undefined) v.cmd = s.cmd;
    },
  });

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

  it("keeps a move inside the map", () => {
    const game = field();
    const r = unitsOf(game, "kiln")[0]!;
    game.order("kiln", { t: "move", u: [r.id], x: 1e6, y: -1e6 });
    expect(r.order).toMatchObject({ k: "move", x: game.grid.x0 + game.grid.w - 0.5, y: game.grid.y0 + 0.5 });
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

describe("Fogfront's traffic (D-126)", () => {
  it("a unit waits for a car on the cell ahead to pass; a car on a deck over the cell, or on the unit's own, doesn't stop it", () => {
    const game = new RtsGame(open(40, 16), { hearths: { kiln: [2, 10], tide: [35, 10] }, seeps: [] });
    const u = unitsOf(game, "kiln", "runner")[0]!;
    [u.x, u.y] = [10.5, 3.5];
    expect(game.order("kiln", { t: "move", u: [u.id], x: 30.5, y: 3.5 })).toBeNull();
    game.traffic([{ x: 20.4, y: 3.6, h: 0 }]);
    expect([...game.movers]).toEqual([cellIndex(game.grid, 20, 3)]);
    run(game, 8);
    expect(u.x).toBeLessThan(20); // waiting by the car's cell
    expect(u.x).toBeGreaterThan(19.5);
    game.traffic([{ x: 20.4, y: 3.6, h: MAX_CLIMB + 1 }]); // a deck over it: no car on the ground
    expect(game.movers.size).toBe(0);
    run(game, 1);
    expect(u.x).toBeGreaterThan(20);
    game.traffic([{ x: u.x, y: u.y, h: 0 }]); // a car comes onto its own cell: it walks on, out of it
    run(game, 5);
    expect(u.x).toBeCloseTo(30.5, 1);
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
    // the Tide's order is taken (from across the map it can't know who is inside), and it's turned away at the door
    expect(game.order("tide", { t: "enter", u: [scout.id], obj: 7 })).toBeNull();
    run(game, 5);
    expect(scout.inside).toBeNull();
    expect(scout.order.k).toBe("idle");
    // out, where they went in
    const doors = runners.map((r) => ({ ...r.door! }));
    expect(game.order("kiln", { t: "leave", obj: 7 })).toBeNull();
    expect(game.garrison(7)).toHaveLength(0);
    runners.forEach((r, n) => expect(Math.hypot(r.x - doors[n]!.x, r.y - doors[n]!.y)).toBeLessThan(1));
    expect(game.order("kiln", { t: "leave", obj: 7 })).toBe("none of yours in there");
  });

  it("watches every side from the roof: its own building's cells don't hide anything from it", () => {
    const rows = Array.from({ length: 16 }, (_, y) => [...".".repeat(40)].map((c, x) => (y === 7 && x >= 18 && x <= 23 ? "#" : c)).join(""));
    const g = standing(gridOf(rows), [{ obj: 7, cells: [18, 19, 20, 21, 22, 23].map((x) => [x, 7] as [number, number]) }]);
    for (const o of g.objects.values()) for (const ob of o) ob.top = 3; // three steps tall
    const game = new RtsGame(g, { hearths: { kiln: [2, 2], tide: [35, 12] }, seeps: [] });
    setRemoved(g, () => false);
    const s = game.structures.get(7)!;
    const sight = sideSight(g, [roofEye(g, { ...s, top: 3 }, 8)], null);
    // a cell beyond each end of the building, across its own roof
    expect(seesUnit(g, sight, 16.5, 7.5)).toBe(true);
    expect(seesUnit(g, sight, 25.5, 7.5)).toBe(true);
  });

  it("a building knocked down throws out those inside, hurt, and one too hurt to live falls at once", () => {
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
    // in again with too little left: gone the step it falls
    const g2 = town();
    const [r2] = unitsOf(g2, "kiln", "runner");
    g2.order("kiln", { t: "enter", u: [r2!.id], obj: 7 });
    run(g2, 15);
    r2!.hp = GARRISON.fall - 1;
    g2.structures.get(7)!.hp = 0;
    g2.step(TICK);
    expect(g2.units.has(r2!.id)).toBe(false);
  });
});

describe("Fogfront's landmarks to hold (D-125)", () => {
  const held = () => {
    const g = open(40, 16);
    g.objectives = [{ id: "rock", name: "the Rock", x: 20.5, y: 8.5 }];
    return new RtsGame(g, { hearths: { kiln: [2, 6], tide: [35, 6] }, seeps: [] });
  };
  const send = (game: RtsGame, team: Team, x: number, y: number) =>
    game.order(team, { t: "move", u: unitsOf(game, team).map((u) => u.id), x, y });

  it("a side alone by one long enough takes it: it pays glim and sees from it", () => {
    const game = held();
    send(game, "kiln", 20.5, 8.5);
    const events: RtsEvent[] = [];
    for (let n = 0; n < 40 / TICK && !game.marks[0]!.owner; n++) {
      game.step(TICK);
      events.push(...(game.events as RtsEvent[]));
      game.events = [];
    }
    expect(game.marks[0]!.owner).toBe("kiln");
    expect(events.filter((e) => e.kind === "taken")).toEqual([{ kind: "taken", id: "rock", name: "the Rock", side: "kiln" }]);
    const glim = game.glim.kiln;
    send(game, "kiln", 3.5, 12.5); // walk away: it stays theirs, and pays
    run(game, 20);
    expect(game.marks[0]!.owner).toBe("kiln");
    expect(game.glim.kiln - glim).toBeGreaterThanOrEqual(Math.floor(20 * OBJECTIVE.income) - 1);
    // its eye: the Kiln sees a Tide runner walking up to it with none of its own near
    const scout = unitsOf(game, "tide")[0]!;
    game.order("tide", { t: "move", u: [scout.id], x: 25.5, y: 8.5 });
    run(game, 12);
    expect(game.view("kiln").units.some((u) => u.i === scout.id)).toBe(true);
    expect(game.marksNet()[0]).toMatchObject({ id: "rock", owner: "kiln" });
  });

  it("a rival's taking fades while only the holder stands by", () => {
    const game = held();
    game.marks[0]!.owner = "kiln";
    Object.assign(game.marks[0]!, { taker: "tide", hold: 5 });
    send(game, "kiln", 20.5, 8.5);
    run(game, 25);
    expect(game.marks[0]!.taker).toBeNull();
    expect(game.marks[0]!.owner).toBe("kiln");
  });

  it("contested, it stands still; left, the taking fades", () => {
    const game = held();
    send(game, "kiln", 20.5, 8.5);
    send(game, "tide", 21.5, 8.5);
    run(game, 30);
    // runners both (they don't fight): while both sides stand by it, nobody takes it
    expect(game.marks[0]!.owner).toBeNull();
    const m = held();
    send(m, "kiln", 20.5, 8.5);
    run(m, 9); // most of the way: a few seconds' walk and some holding
    const before = m.marks[0]!.hold;
    send(m, "kiln", 3.5, 3.5);
    run(m, 8);
    expect(m.marks[0]!.owner).toBeNull();
    expect(m.marks[0]!.hold).toBeLessThan(before);
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

  it("night falls on the match's clock, and units see less by it; buildings, lit, see as by day", () => {
    expect([isNight(0), isNight(DAY.day - 1), isNight(DAY.day + 1), isNight(DAY.day + DAY.night + 1)]).toEqual([false, false, true, false]);
    expect([nextLight(10), nextLight(DAY.day + 5)]).toEqual([DAY.day, DAY.day + DAY.night]);
    const game = new RtsGame(open(40, 16), { hearths: { kiln: [2, 2], tide: [35, 12] }, seeps: [] });
    const r = unitsOf(game, "kiln")[0]!;
    const foe = unitsOf(game, "tide")[0]!;
    Object.assign(r, { x: 20.5, y: 8.5 });
    Object.assign(foe, { x: 25.5, y: 8.5 }); // 5 cells: in a runner's sight (6) by day, not by night (3.6)
    run(game, SIGHT.every * TICK);
    expect(game.view("kiln").units.some((u) => u.i === foe.id)).toBe(true);
    game.time = DAY.day + 1;
    expect(game.night).toBe(true);
    Object.assign(foe, { x: 25.5, y: 8.5 });
    Object.assign(r, { x: 20.5, y: 8.5 });
    run(game, SIGHT.every * TICK);
    expect(game.view("kiln").units.some((u) => u.i === foe.id)).toBe(false);
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

  it("takes in the Presidio's landmarks as objectives, each reachable from both hearths (D-125)", () => {
    const g = world.grid;
    expect(g.objectives!.map((o) => o.id).sort()).toEqual(["golden-gate-bridge", "palace-of-fine-arts"]);
    expect(g.objectives!.every((o) => o.name.length > 0 && o.name !== o.id)).toBe(true); // named as the example game names them
    for (const o of g.objectives!) {
      expect(passable(g, Math.floor(o.x), Math.floor(o.y))).toBe(true);
      for (const [hx, hy] of Object.values(LAYOUT.hearths)) expect(findPath(g, { x: hx - 0.5, y: hy + 1.5 }, o).at(-1)).toEqual({ x: o.x, y: o.y });
    }
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
    const snaps: Seen[][] = [[], []];
    const worlds: RtsWorldNet[] = [];
    const events: RtsEvent[][] = [[], []];
    const clients = pages.map((p, n) => rtsClient(p.room, lb.now, snaps[n]!, worlds));
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
  }, 20_000); // a whole match: a few seconds alone, more beside the other suites

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
  }, 30_000); // minutes of play with forty units on the whole map

  it("runs the motorway's cars in each room: the same for two pages, five times a second, on the map's roads, and in the units' way (D-126)", async () => {
    const lb = await opened(60);
    const pages = [lb.join(0.05), lb.join(0.08)];
    const remotes: RemoteTraffic[] = [];
    const sent: { t: number; bytes: number; n: number }[][] = [[], []];
    const clients = pages.map(
      (p, n) =>
        new TickClient<never, RtsSnap, RtsWorldNet, RtsEvent>(p.room, {
          tick: TICK,
          now: lb.now,
          onWorld: (w) => {
            if (!w.cars) return;
            sent[n]!.push({ t: w.t, bytes: JSON.stringify(w.cars).length, n: w.cars.length });
            remotes[n]!.push(w.t, w.cars, lb.now());
          },
        }),
    );
    clients.forEach((c) => remotes.push(new RemoteTraffic({ delay: TRAFFIC.delay, clock: c.clock })));
    clients.forEach((c, n) => c.hello({ name: `P${n}`, vs: "any" }));
    lb.run(3, () => clients.forEach((c) => c.sync()));
    const room = lb.host;
    expect(room.traffic).not.toBeNull();
    // five a second, the same for both pages
    expect(sent[0]!.length).toBeGreaterThanOrEqual(14);
    expect(sent[0]!.length).toBeLessThanOrEqual(16);
    expect(sent[0]!.at(-1)!.t - sent[0]!.at(-2)!.t).toBeCloseTo(TICK * 2 * TRAFFIC.every, 5);
    expect(sent[1]!.slice(0, 10)).toEqual(sent[0]!.slice(0, 10));
    expect(Math.min(...sent[0]!.map((s) => s.n))).toBeGreaterThan(25);
    expect(Math.max(...sent[0]!.map((s) => s.bytes))).toBeLessThan(3000);
    // each page draws them at the server time it shows: the slower page the same cars a little later
    const now = lb.now();
    const shift = clients[0]!.clock.time(now)! - clients[1]!.clock.time(now)!;
    expect(shift).toBeGreaterThan(0.02);
    const [a, b] = [remotes[0]!.poses(now), remotes[1]!.poses(now + shift)];
    expect(a.length).toBeGreaterThan(25);
    expect(b.map((p) => p.id)).toEqual(a.map((p) => p.id));
    b.forEach((p, i) => {
      expect(p.x).toBeCloseTo(a[i]!.x, 6);
      expect(p.y).toBeCloseTo(a[i]!.y, 6);
    });
    // on the map's roads, within the area round it
    const g = world.grid;
    const area = trafficArea();
    const onMap = a.filter((p) => cellIndex(g, Math.floor(p.x), Math.floor(p.y)) >= 0);
    expect(onMap.length).toBeGreaterThan(20);
    const onRoad = onMap.filter((p) => g.flags[cellIndex(g, Math.floor(p.x), Math.floor(p.y))]! & ROAD).length;
    expect(onRoad / onMap.length).toBeGreaterThan(0.9);
    expect(a.every((p) => p.x >= area.x0 && p.y >= area.y0 && p.x < area.x0 + area.w && p.y < area.y0 + area.h)).toBe(true);
    // the cells they stand on are in the units' way
    const movers = [...room.game!.movers];
    expect(movers.length).toBeGreaterThan(15);
    expect(movers.filter((i) => g.flags[i]! & ROAD).length / movers.length).toBeGreaterThan(0.9);
    expect(lb.failed).toBeUndefined();
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

  it("two against two, and spectators: a side's view serialized once for its two players and its watchers, shared orders and glim (D-127)", async () => {
    const teams: { t: number; to: string[] }[] = [];
    const lb = loopback(
      (room) => {
        const sendTo = room.sendTo!;
        room.sendTo = (ids, data) => {
          const m = data as RtsWorldNet & { k: string; t: number };
          if (m.k === "world" && m.view) teams.push({ t: m.t, to: [...ids] });
          sendTo(ids, data);
        };
        return new RtsRoom(room, Promise.resolve(world), false);
      },
      { fps: 20 },
    );
    await new Promise((r) => setTimeout(r, 0));
    const joins = [
      { name: "A", vs: "any", size: 2 },
      { name: "B", vs: "any", side: "tide" },
      { name: "C", vs: "any" },
      { name: "Kw", vs: "any", watch: "kiln" },
      { name: "All", vs: "any", watch: "all" },
      { name: "D", vs: "any" },
    ];
    const pages = joins.map(() => lb.join(0.05));
    const snaps: Seen[][] = pages.map(() => []);
    const events: RtsEvent[][] = pages.map(() => []);
    const clients = pages.map((p, n) => rtsClient(p.room, lb.now, snaps[n]!));
    const frame = () => clients.forEach((c, n) => (c.sync(), events[n]!.push(...c.due())));
    // three players: the room waits for the fourth (two a side, from the first page's size)
    clients.slice(0, 5).forEach((c, n) => c.hello(joins[n]));
    lb.run(1, frame);
    expect(lb.host.size).toBe(2);
    expect(lb.host.match.phase).toBe("waiting");
    clients[5]!.hello(joins[5]);
    lb.run(1, frame);
    expect(lb.host.match.phase).toBe("playing");
    const ids = pages.map((p) => p.room.id);
    expect(ids.slice(0, 4).map((id) => lb.host.sideOf(id))).toEqual(["kiln", "tide", "kiln", null]);
    expect(lb.host.sideOf(ids[5]!)).toBe("tide");
    expect([lb.host.watchOf(ids[3]!), lb.host.watchOf(ids[4]!)]).toEqual(["kiln", "all"]);

    // each snapshot: one serialization a side and one for all, to its players and watchers alone
    const t = teams.at(-1)!.t;
    const now = teams.filter((m) => m.t === t).map((m) => m.to.sort());
    expect(now).toHaveLength(3);
    expect(now).toContainEqual([ids[0]!, ids[2]!, ids[3]!].sort());
    expect(now).toContainEqual([ids[1]!, ids[5]!].sort());
    expect(now).toContainEqual([ids[4]!]);

    // teammates and the side's watcher restore the same view; the other side's runners at home are hidden from it, and not from all
    const last = () => snaps.map((s) => s.at(-1)!);
    expect(last()[0]!.t).toBe(last()[3]!.t);
    expect([last()[2]!.units, last()[3]!.units]).toEqual([last()[0]!.units, last()[0]!.units]);
    expect(last()[3]!.side).toBe("kiln");
    expect(last()[0]!.units.every((u) => u.s === "kiln")).toBe(true);
    expect(new Set(last()[4]!.units.map((u) => u.s))).toEqual(new Set(["kiln", "tide"]));
    expect(last()[4]!.glims).toEqual({ kiln: START.glim, tide: START.glim });

    // shared control: A trains a runner from the side's glim; C sends one of the side's runners off; each acknowledged on its own page
    const kiln = last()[0]!;
    const hearth = kiln.buildings.find((b) => b.s === "kiln" && b.k === "hearth")!;
    const runner = kiln.units[0]!;
    const n1 = clients[0]!.command({ t: "train", b: hearth.i });
    const n2 = clients[2]!.command({ t: "move", u: [runner.i], x: 160, y: 215 });
    lb.run(0.5, frame);
    expect(snaps[0]!.find((s) => (s.cmd ?? 0) >= n1)!.glim).toBe(START.glim - UNITS.runner.cost);
    expect(snaps[2]!.find((s) => (s.cmd ?? 0) >= n2)!.units.find((u) => u.i === runner.i)!.g).toEqual([160, 215]);
    expect(last()[0]!.cmd).toBe(n1); // C's command doesn't acknowledge A's numbers
    expect([last()[0]!.glim, last()[2]!.glim]).toEqual([START.glim - UNITS.runner.cost, START.glim - UNITS.runner.cost]);
    expect(last()[0]!.units.find((u) => u.i === runner.i)!.g).toEqual([160, 215]); // A sees its teammate's order
    // a watcher orders nothing, and the other side's players can't order this side's runner
    clients[3]!.command({ t: "move", u: [runner.i], x: 200, y: 180 });
    clients[1]!.command({ t: "move", u: [runner.i], x: 200, y: 180 });
    lb.run(0.5, frame);
    expect(last()[0]!.units.find((u) => u.i === runner.i)!.g).toEqual([160, 215]);
    expect(events[1]!.filter((e) => e.kind === "refused")).toEqual([{ kind: "refused", why: "no units of yours" }]);

    // one of the Kiln's two leaves: the match goes on; the second: the Tide wins
    pages[0]!.room.close();
    lb.run(0.5, frame);
    expect(lb.host.match.phase).toBe("playing");
    pages[2]!.room.close();
    lb.run(0.5, frame);
    expect(lb.host.match.phase).toBe("ended");
    expect(events[4]!.find((e) => e.kind === "phase" && e.phase === "ended")).toEqual({ kind: "phase", phase: "ended", winner: "tide" });
    expect(lb.failed).toBeUndefined();
  });
});
