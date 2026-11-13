import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Bot } from "../../src/demos/rts/bot";
import { RtsGame, parseCommand } from "../../src/demos/rts/game";
import {
  BUILDINGS,
  GATHER,
  LAYOUT,
  MAX_CLIMB,
  OBJECT,
  ROAD,
  START,
  TICK,
  UNITS,
  WATER,
  WOODS,
  cellIndex,
  findPath,
  lineClear,
  passable,
  placementError,
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

/** A map from text: `.` open, `#` a building of the level's, `~` water, `=` road, `t` woods, a digit open ground that high (steps). */
function gridOf(rows: string[]): MapGrid {
  const h = rows.length;
  const w = rows[0]!.length;
  const g: MapGrid = { x0: 0, y0: 0, w, h, flags: new Uint8Array(w * h), height: new Float32Array(w * h), building: new Int32Array(w * h) };
  rows.forEach((r, y) =>
    [...r].forEach((c, x) => {
      const i = y * w + x;
      g.flags[i] = c === "~" ? WATER : c === "#" ? OBJECT : c === "=" ? ROAD : c === "t" ? WOODS : 0;
      if (/\d/.test(c)) g.height[i] = Number(c);
    }),
  );
  return g;
}

const open = (w: number, h: number) => gridOf(Array.from({ length: h }, () => ".".repeat(w)));
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

  it("takes only its own side's units, and checks a page's command's shape", () => {
    const game = field();
    const theirs = unitsOf(game, "tide")[0]!;
    expect(game.order("kiln", { t: "move", u: [theirs.id], x: 5, y: 5 })).toBe("no units of yours");
    expect(parseCommand({ t: "move", u: [1, 2], x: 3, y: 4 })).toEqual({ t: "move", u: [1, 2], x: 3, y: 4, attack: false });
    for (const bad of [null, 7, { t: "move", u: "1", x: 1, y: 1 }, { t: "move", u: [1], x: Infinity, y: 1 }, { t: "build", kind: "tower", x: 1, y: 1 }, { t: "train", b: 1.5 }, { t: "launch" }])
      expect(parseCommand(bad)).toBeNull();
    expect(parseCommand({ t: "stop", u: Array.from({ length: 201 }, (_, i) => i) })).toBeNull();
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

  it("a snapshot stays small with dozens of units a side", () => {
    const game = new RtsGame({ ...world.grid, building: new Int32Array(world.grid.building.length) });
    const bots = (["kiln", "tide"] as const).map((t) => new Bot(game, t));
    for (const t of ["kiln", "tide"] as const) game.glim[t] = 100_000;
    // forty units each, trained in their bases
    for (let n = 0; n < 3000 && unitsOf(game, "kiln").length + unitsOf(game, "tide").length < 80; n++) {
      if (n % 20 === 0) for (const b of bots) for (const c of b.orders()) game.order(b.team, c);
      for (const b of game.buildings.values()) if (b.queue.length < 2 && b.built >= 1) game.order(b.team, { t: "train", b: b.id });
      game.step(TICK);
    }
    const snap = game.view("kiln");
    expect(snap.units.length).toBeGreaterThanOrEqual(25);
    // under 100 bytes a unit as JSON, positions to a hundredth of a cell: a side's forty in about 4 KB, ten a second
    expect(JSON.stringify(snap.units).length / snap.units.length).toBeLessThan(100);
  });
});
