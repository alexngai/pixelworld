import { readFileSync } from "node:fs";
import { CarPilot } from "@pixelworlds/game/src/pilot";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RaceRoom, openRaceWorld, type RaceWorld } from "../../src/demos/race/server";
import {
  BOTS,
  COURSE,
  Ghosts,
  RACE,
  TICK,
  contacts,
  courseLine,
  gridSlot,
  progress,
  raceTick,
  type CarNet,
  type RaceEvent,
  type RaceInput,
  type RaceSnap,
  type RaceWorldNet,
  type Racer,
} from "../../src/demos/race/rules";
import { Smoothing, TickClient, type TickEvent, type TickShared, type TickSnapshot } from "../../src/index";
import type { HostedRoom } from "../../src/server";
import { loopback } from "../../src/testing";

/**
 * The race demo (D-119) over the real driving level, in Node: the world and
 * its routes from the committed package, a room with a made-up transport
 * and ticks stepped by hand, or the loopback with latency.
 */

const ROOT = new URL("../../../../", import.meta.url);
let world: RaceWorld;

beforeAll(async () => {
  vi.stubGlobal("fetch", async (url: string | URL) => {
    try {
      return new Response(readFileSync(new URL(`fixtures${new URL(String(url)).pathname}`, ROOT)));
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
  world = await openRaceWorld("https://pixelworld.test/southwest/");
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const GO: RaceInput = { throttle: 1, brake: 0, steer: 0, reset: false };
const IDLE: RaceInput = { throttle: 0, brake: 0, steer: 0, reset: false };

type Msg = (TickShared & RaceWorldNet) | (TickSnapshot & RaceSnap) | TickEvent<RaceEvent>;

/** A room over a transport that keeps what it sends, by page. */
function room() {
  const inbox = new Map<string, Msg[]>();
  const all: Msg[] = [];
  const hosted: HostedRoom = {
    name: "test",
    settings: undefined,
    isPublic: false,
    send: (to, data) => inbox.get(to)?.push(data as Msg),
    broadcast: (data, except) => {
      all.push(data as Msg);
      for (const [id, box] of inbox) if (!except?.has(id)) box.push(data as Msg);
    },
    players: () => [...inbox.keys()],
    kick: () => {},
    close: () => {},
    fail: (e) => {
      throw e;
    },
    log: () => {},
  };
  const game = new RaceRoom(hosted, Promise.resolve(world), false);
  const join = async (id: string, name = id, watch = false) => {
    inbox.set(id, []);
    game.join(id);
    game.message(id, { k: "hello", join: { name, watch } });
    await new Promise((r) => setTimeout(r, 0)); // the world arrives
  };
  const worlds = (id: string) => inbox.get(id)!.filter((m): m is TickShared & RaceWorldNet => m.k === "world");
  const events = (kind?: RaceEvent["kind"]) => all.filter((m): m is TickEvent<RaceEvent> => m.k === "ev" && (!kind || m.e.kind === kind)).map((m) => ({ ...m.e, t: m.t }));
  const send = (id: string, seq: number, i: Partial<RaceInput>, seen: number | null = null) => game.message(id, { k: "in", seq, i: { ...IDLE, ...i }, seen });
  /** On to the race: the countdown over. */
  const go = () => {
    while (game.race.phase !== "racing") game.tick();
  };
  return { game, join, worlds, events, send, go };
}

/** A racer let go at a grid slot. */
const racer = (slot = 0): Racer => {
  const r: Racer = { car: { x: 0, y: 0, h: 0, heading: 0, speed: 0, steer: 0 }, steps: 0, cps: 0, laps: [], held: false };
  Object.assign(r.car, gridSlot(world.course, slot));
  r.car.h = world.drive.groundAt(r.car.x, r.car.y, -Infinity)!;
  return r;
};

describe("the race demo's rules (D-119)", () => {
  it("plans the course round the Strip on the roads: a closed loop, its checkpoints evenly round it, the grid behind the line", () => {
    const c = world.course;
    const pts = c.path.points;
    expect(c.length).toBeGreaterThan(110);
    expect(c.length).toBeLessThan(140);
    expect(pts[0]).toEqual(pts[pts.length - 1]); // a loop
    expect(c.checkpoints).toHaveLength(RACE.checkpoints);
    c.checkpoints.forEach((cp, i) => expect(cp.d).toBeCloseTo((c.length * i) / RACE.checkpoints, 6));
    // the line at the first waypoint, on the Strip
    const [sx, sy] = world.query.lonLatToCell(COURSE[0]!.lon, COURSE[0]!.lat)!;
    expect(Math.hypot(c.checkpoints[0]!.x - sx, c.checkpoints[0]!.y - sy)).toBeLessThan(1);
    // every grid slot on the road, behind the line, facing it, and clear of the slot ahead
    for (let slot = 0; slot < 8; slot++) {
      const g = gridSlot(c, slot);
      const h = world.drive.groundAt(g.x, g.y, -Infinity)!;
      expect(world.drive.roadClassAt(g.x, g.y, h)).not.toBeNull();
      const toLine = Math.atan2(c.checkpoints[0]!.y - g.y, c.checkpoints[0]!.x - g.x);
      expect(Math.abs(Math.atan2(Math.sin(toLine - g.heading), Math.cos(toLine - g.heading)))).toBeLessThan(0.3);
    }
    // a bot's line from anywhere, round as often as it takes
    const line = courseLine(c, -2, 2.5 * c.length);
    expect(line.length).toBeGreaterThan(2 * pts.length);
  });

  it("times a race in the car's own steps, counts a lap only when every checkpoint is passed in order, and finishes after the last", () => {
    const c = world.course;
    const r = racer(3); // out of the line's reach (the pole is within it)
    const tp = (i: number) => Object.assign(r.car, { x: c.checkpoints[i]!.x, y: c.checkpoints[i]!.y, speed: 0 });
    // held: nothing moves, the clock doesn't run
    r.held = true;
    raceTick(r, GO, world.drive, c, world.params);
    expect([r.steps, r.car.speed]).toEqual([0, 0]);
    r.held = false;
    for (let n = 0; n < 10; n++) raceTick(r, IDLE, world.drive, c, world.params);
    expect([r.steps, r.cps]).toEqual([10, 0]);
    tp(0);
    raceTick(r, IDLE, world.drive, c, world.params); // over the line: the race begins, not a lap
    expect([r.cps, r.laps]).toEqual([1, []]);
    tp(3); // a short cut past checkpoints 1 and 2: nothing
    raceTick(r, IDLE, world.drive, c, world.params);
    expect(r.cps).toBe(1);
    for (let lap = 1; lap <= RACE.laps; lap++) {
      for (let i = 1; i < RACE.checkpoints; i++) {
        tp(i);
        for (let n = 0; n < 60; n++) raceTick(r, IDLE, world.drive, c, world.params); // a second at each
      }
      tp(0);
      raceTick(r, IDLE, world.drive, c, world.params);
      expect(r.laps).toHaveLength(lap);
    }
    // each lap's time is its steps: a second at each of 7 checkpoints, and the tick at the line; the first from the start
    // (the run-up, the line, the short cut)
    expect(r.laps.map((s, i) => s - (r.laps[i - 1] ?? 0))).toEqual([10 + 1 + 1 + 7 * 60 + 1, 7 * 60 + 1, 7 * 60 + 1]);
    expect(r.steps).toBe(r.laps.at(-1));
    // finished: the clock stops, the car still drives
    for (let n = 0; n < 30; n++) raceTick(r, GO, world.drive, c, world.params);
    expect(r.steps).toBe(r.laps.at(-1));
    expect(r.car.speed).toBeGreaterThan(0);
  });

  it("puts a car back at its last checkpoint on a reset, stopped, facing along the course", () => {
    const c = world.course;
    const r = racer();
    Object.assign(r.car, { x: c.checkpoints[2]!.x, y: c.checkpoints[2]!.y });
    r.cps = 3; // the line, 1 and 2 passed
    Object.assign(r.car, { x: r.car.x + 3, y: r.car.y + 1, heading: 2, speed: 4 });
    raceTick(r, { ...IDLE, reset: true }, world.drive, c, world.params);
    expect(r.car).toMatchObject({ x: c.checkpoints[2]!.x, y: c.checkpoints[2]!.y, heading: c.checkpoints[2]!.heading, speed: 0 });
    expect(r.cps).toBe(3);
  });

  it("bumps a car into another ahead of it, and lets the one ahead pull away from one behind", () => {
    const c = world.course;
    const ahead = racer(0);
    const behind = racer(1);
    Object.assign(behind.car, { x: ahead.car.x - Math.cos(ahead.car.heading) * 0.7, y: ahead.car.y - Math.sin(ahead.car.heading) * 0.7, heading: ahead.car.heading, speed: 3 });
    world.contacts = contacts([ahead.car], world.params);
    const hit = raceTick(behind, GO, world.drive, c, world.params);
    world.contacts = contacts([behind.car], world.params);
    const away = raceTick(ahead, GO, world.drive, c, world.params);
    world.contacts = null;
    expect([hit?.blocked, away?.blocked]).toEqual(["vehicle", null]);
  });
});

describe("the race demo's server (D-119)", () => {
  it("runs a race: waiting, the countdown on the grid with bots making up the field, the race, the results, and the next", async () => {
    const { game, join, worlds, events } = room();
    expect(game.race.phase).toBe("waiting");
    await join("a", "  Alex‮\u0000 ");
    expect(game.joinOf("a")!.name).toBe("Alex");
    expect(game.playerIds()).toEqual(["a", ...BOTS.map((b) => b.id)]);
    game.tick();
    expect(game.race.phase).toBe("countdown");
    // the grid: the driver on the pole, the bots behind, all held
    const a = game.car("a")!;
    expect(a.slot).toBe(0);
    expect(a.r.held).toBe(true);
    for (let t = 0; t < 2 / TICK; t++) game.tick();
    expect(a.r.car).toMatchObject(gridSlot(world.course, 0));
    const shared = worlds("a").at(-1)!;
    // the bots slowest first: the quick ones have to come through
    expect(shared.cars.map((c) => [c.id, c.place, c.lap])).toEqual([
      ["a", 1, 1],
      ["bot1", 4, 1],
      ["bot2", 3, 1],
      ["bot3", 2, 1],
    ]);
    expect(shared.race).toMatchObject({ phase: "countdown", laps: RACE.laps, results: [] });
    // a second driver before the start takes a bot's place; a watcher doesn't count
    await join("w", "Watcher", true);
    await join("b", "Bo");
    expect([game.playerIds(), game.spectatorIds()]).toEqual([["a", "bot1", "bot2", "b"], ["w"]]);
    while (game.race.phase === "countdown") game.tick();
    expect(game.race.phase).toBe("racing");
    expect(events("phase").map((e) => e.kind === "phase" && e.phase)).toEqual(["countdown", "racing"]);
    expect(game.car("a")!.r.held).toBe(false);
    // the drivers send nothing: the race runs out its window after the bots finish, then the results
    for (let t = 0; t < (RACE.laps * 30 + RACE.window) / TICK && game.race.phase === "racing"; t++) game.tick();
    expect(game.race.phase).toBe("results");
    for (let t = 0; t < 3; t++) game.tick(); // a shared snapshot
    const results = worlds("a").at(-1)!.race.results;
    expect(results.map((r) => r.id).slice(0, 2)).toEqual(["bot1", "bot2"]); // the quicker one came through
    expect(results.slice(0, 2).every((r) => r.time !== null && r.best !== null && r.bot)).toBe(true);
    expect(results.slice(2).map((r) => [r.time, r.best])).toEqual([
      [null, null],
      [null, null],
    ]);
    for (let t = 0; t < RACE.results / TICK + 1; t++) game.tick();
    expect(game.race.phase).toBe("countdown");
    expect(game.car("bot1")!.r).toMatchObject({ steps: 0, cps: 0, laps: [], held: true });
    // everyone gone: waiting, and the bots go too
    game.leave("a");
    game.leave("b");
    game.tick();
    expect([game.race.phase, game.playerIds()]).toEqual(["waiting", []]);
  });

  it("has a bot drive a lap of the Strip with the game's CarPilot", async () => {
    const { game, join, events, go } = room();
    await join("a");
    go();
    for (let t = 0; t < 40 / TICK && !events("lap").length; t++) game.tick();
    const lap = events("lap")[0] as Extract<RaceEvent, { kind: "lap" }>;
    expect(lap).toMatchObject({ kind: "lap", lap: 1 });
    expect(BOTS.map((b) => b.id)).toContain(lap.who);
    expect(lap.time).toBeGreaterThan(15);
    expect(lap.time).toBeLessThan(35);
  });

  it("has the bots pass a slower car as ghosts, the quickest first, each solid again once clear ahead of it", async () => {
    const { game, join, worlds, send, go } = room();
    await join("a");
    go();
    // a on the pole, on the course's line at 3 cells/s: the bots come up behind it
    const pilot = new CarPilot(courseLine(world.course, -2, 2 * world.course.length), { stop: false, maxSpeed: 3, lookMin: 1.2, lookTime: 0.3, lookMax: 4 });
    const passing = new Set<string>();
    for (let seq = 1; seq <= 25 / TICK; seq++) {
      const s = game.car("a")!.r.car;
      send("a", seq, { ...pilot.input(s, world.params.pace, world.drive.topSpeedAt(s.x, s.y, s.h)) });
      game.tick();
      for (const c of worlds("a").at(-1)?.cars ?? []) if (c.passing) passing.add(c.id);
    }
    expect([...passing].sort()).toEqual(BOTS.map((b) => b.id));
    const ahead = (id: string) => progress(world.course, game.car(id)!.r) > progress(world.course, game.car("a")!.r);
    expect(BOTS.every((b) => ahead(b.id))).toBe(true);
    expect(BOTS.map((b) => game.car(b.id)!.life)).toEqual([2, 2, 2]); // nobody stuck and reset
    for (let t = 0; t < 3; t++) game.tick();
    expect(worlds("a").at(-1)!.cars.filter((c) => c.passing)).toEqual([]);
  });

  it("judges a bump against where the driver saw the others, never where they moved this tick: the order cars are stepped in doesn't matter", async () => {
    // two cars nose to tail on the straight, both flat out: in either order of joining, the same
    const run = async (first: string, second: string) => {
      const { game, join, send, go } = room();
      await join(first);
      await join(second);
      go();
      const lead = game.car("lead")!.r.car;
      const chase = game.car("chase")!.r.car;
      Object.assign(lead, { ...gridSlot(world.course, 0), speed: 2 });
      Object.assign(chase, { ...gridSlot(world.course, 0), speed: 4 });
      Object.assign(chase, { x: lead.x - Math.cos(lead.heading) * 0.8, y: lead.y - Math.sin(lead.heading) * 0.8 });
      for (let seq = 1; seq <= 30; seq++) {
        send("lead", seq, { throttle: 0.3 });
        send("chase", seq, { throttle: 1 });
        game.tick();
      }
      return [{ ...lead }, { ...chase }];
    };
    const one = await run("lead", "chase");
    const two = await run("chase", "lead");
    expect(two).toEqual(one);
    expect(one[1]!.speed).toBeLessThan(4); // the chaser bumped
  });

  it("lets the others drive through a stalled car (its page went quiet), and flags it", async () => {
    const { game, join, worlds, send, go } = room();
    await join("a");
    await join("b");
    go();
    const a = game.car("a")!.r.car;
    const b = game.car("b")!.r.car;
    for (let seq = 1; seq <= 10; seq++) {
      send("a", seq, {});
      send("b", seq, {});
      game.tick();
    }
    // b goes quiet, stopped across the road ahead of a
    Object.assign(b, { x: a.x + Math.cos(a.heading) * 1.2, y: a.y + Math.sin(a.heading) * 1.2 });
    for (let seq = 11; seq <= 11 + RACE.stall / TICK + 3; seq++) {
      send("a", seq, {});
      game.tick();
    }
    expect(game.idleFor("b")).toBeGreaterThan(RACE.stall);
    expect(worlds("a").at(-1)!.cars.find((c) => c.id === "b")).toMatchObject({ ghost: true });
    const from = { x: a.x, y: a.y };
    for (let seq = 100; seq < 160; seq++) {
      send("a", seq, { throttle: 1 });
      game.tick();
    }
    expect(Math.hypot(a.x - from.x, a.y - from.y)).toBeGreaterThan(2); // through it
  });

  it("clamps a page's pedals and wheel, and keeps a late driver on the grid for the next race", async () => {
    const { game, join, go, worlds } = room();
    await join("a");
    go();
    game.message("a", { k: "in", seq: 1, i: { throttle: 9, brake: Number.NaN, steer: "x", reset: "yes" }, seen: null });
    const before = { ...game.car("a")!.r.car };
    game.tick();
    const after = game.car("a")!.r.car;
    expect(after.speed).toBeGreaterThan(0); // throttle 1, not a reset
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(0.1);
    await join("late");
    for (let t = 0; t < 3; t++) game.tick();
    expect(game.car("late")!.r.held).toBe(true);
    expect(worlds("late").at(-1)!.cars.find((c: CarNet) => c.id === "late")).toMatchObject({ place: 0, ghost: true });
  });
});

describe("the race through the loopback (D-119)", () => {
  it("keeps a page's prediction exact at 50 ms each way, driving the Strip among the bots, and reads its ping", async () => {
    const lb = loopback((r) => new RaceRoom(r, Promise.resolve(world), false));
    const page = lb.join(0.05);
    // the page's own racer, its world's bumps the other cars where its smoothing draws them, as client.ts does
    const me: Racer = { car: { x: 0, y: 0, h: 0, heading: 0, speed: 0, steer: 0 }, steps: 0, cps: 0, laps: [], held: true };
    const saw = new WeakMap<RaceInput, ReturnType<typeof contacts>>();
    let cars: CarNet[] = [];
    const ghosts = new Ghosts();
    let before = { x: 0, y: 0 };
    let worst = 0;
    let started = false;
    let pilot: CarPilot | null = null;
    let bumped = 0;
    const passes = new Set<string>();
    const client: TickClient<RaceInput, RaceSnap, RaceWorldNet, RaceEvent> = new TickClient(page.room, {
      tick: TICK,
      step: (i) => {
        world.contacts = saw.get(i) ?? null;
        if (raceTick(me, i, world.drive, world.course, world.params)?.blocked === "vehicle") bumped++;
        world.contacts = null;
      },
      restore: (snap) => {
        before = { x: me.car.x, y: me.car.y };
        Object.assign(me.car, snap.you.car);
        Object.assign(me, { steps: snap.you.steps, cps: snap.you.cps, laps: snap.you.laps, held: snap.you.held });
      },
      reconciled: () => {
        if (started) worst = Math.max(worst, Math.hypot(me.car.x - before.x, me.car.y - before.y));
      },
      onWorld: (m) => {
        cars = m.cars;
        for (const c of cars) ghosts.record(c.id, m.t, !!c.ghost);
        for (const c of cars) if (c.passing) passes.add(c.id);
        for (const c of cars) if (c.id !== page.room.id) smoothing.push(c.id, m.t, { x: c.x, y: c.y, h: c.h, heading: c.hd, life: c.life }, lb.now());
      },
      now: lb.now,
    });
    const smoothing = new Smoothing(0.1, client.clock);
    client.hello({ name: "Alex", watch: false });
    await new Promise((r) => setTimeout(r, 0)); // the world arrives
    const drive = () => {
      // the others where the page draws them now: this frame's inputs bump into them
      const seen = client.seen(lb.now());
      const solid = cars.filter((c) => c.id !== page.room.id && !(seen === null ? c.ghost : ghosts.at(c.id, seen, c.ghost))).flatMap((c) => smoothing.at(c.id, lb.now()) ?? []);
      const bumps = contacts(solid, world.params);
      client.advance(1 / 60, () => {
        if (!me.held && !pilot) pilot = new CarPilot(courseLine(world.course, -2, 2 * world.course.length), { stop: false, lookMin: 0.8, lookTime: 0.25, lookMax: 3 });
        const top = world.drive.topSpeedAt(me.car.x, me.car.y, me.car.h) * world.params.pace;
        const i: RaceInput = pilot ? { ...pilot.input(me.car, world.params.pace, top), reset: false } : { ...IDLE };
        saw.set(i, bumps);
        return i;
      });
    };
    lb.run(0.5, drive); // the first snapshots: the page takes its car from them
    expect(lb.host.race.phase).toBe("countdown");
    // the page's car to the back of the grid: quicker than the bots, it comes up behind them, and they pass one another
    const mine = lb.host.car(page.room.id)!.r.car;
    const last = lb.host.car(BOTS[0]!.id)!.r.car;
    const [a, b] = [{ ...mine }, { ...last }];
    Object.assign(mine, b);
    Object.assign(last, a);
    lb.run(0.5, drive);
    started = true;
    lb.run(RACE.countdown + 12, drive);
    expect(me.cps).toBeGreaterThanOrEqual(2); // round the first corner
    expect(lb.host.car(page.room.id)!.r.steps).toBeGreaterThan(600);
    expect(worst).toBe(0);
    expect(client.ping).toBeCloseTo(100, 6);
    expect(bumped).toBeGreaterThan(0); // the page met the others on the way
    expect(passes.size).toBeGreaterThan(0); // and bots passed, turning ghost and back
  });
});
