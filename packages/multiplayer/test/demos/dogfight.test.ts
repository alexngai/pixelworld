import { readFileSync } from "node:fs";
import { LEVEL_FLIGHT, flyPlane, type PlaneState } from "@pixelworlds/game/src/plane";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DogfightRoom, openDogfightWorld, type DogfightWorld } from "../../src/demos/dogfight/server";
import {
  BOT,
  GUN,
  HP,
  MATCH,
  PLANE_STATE,
  PLANE_WIRE,
  TICK,
  flyTick,
  planeOf,
  planesOf,
  type DogfightEvent,
  type DogfightInput,
  type DogfightRoster,
  type DogfightSnap,
  type DogfightWorldNet,
  type PlaneNet,
  type PlaneWire,
} from "../../src/demos/dogfight/rules";
import { Replica, SNAP_BYTE, TickClient, WORLD_BYTE, readSnap, type TickEvent, type TickRoster, type TickShared, type TickSnapshot } from "../../src/index";
import type { HostedRoom } from "../../src/server";
import { loopback } from "../../src/testing";

/**
 * The dogfight demo's server (D-113, D-114, D-116, D-118) over the real
 * flying level, in Node: the world from the committed package, a room with a
 * made-up transport and ticks stepped by hand, or the loopback with latency.
 */

const ROOT = new URL("../../../../", import.meta.url);
let world: DogfightWorld;

beforeAll(async () => {
  vi.stubGlobal("fetch", async (url: string | URL) => {
    try {
      return new Response(readFileSync(new URL(`fixtures${new URL(String(url)).pathname}`, ROOT)));
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
  world = await openDogfightWorld("https://pixelworld.test/southwest-fly/");
});
afterAll(() => {
  vi.unstubAllGlobals();
});
// respawns are random: the same ones each run, or a plane may spawn where a test's terrain doesn't do what it expects
beforeEach(() => {
  let seed = 1;
  vi.spyOn(Math, "random").mockImplementation(() => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646);
});
afterEach(() => {
  vi.restoreAllMocks();
});

type Msg = Uint8Array | (TickRoster & DogfightRoster) | (TickSnapshot & DogfightSnap) | TickEvent<DogfightEvent>;

/** A room over a transport that keeps what it sends, by page. */
function room(w = world) {
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
  const game = new DogfightRoom(hosted, Promise.resolve(w), false);
  const join = async (id: string, name = id, watch = false) => {
    inbox.set(id, []);
    game.join(id);
    game.message(id, { k: "hello", join: { name, watch } });
    await new Promise((r) => setTimeout(r, 0)); // the world arrives
  };
  /** The shared snapshots a page got, as its page puts them together: the planes replicated in binary (D-123), with the roster's names and scores. */
  const worlds = (id: string) => {
    const replica = new Replica(PLANE_WIRE);
    const states = new Map<string, PlaneWire>();
    let pilots: DogfightRoster["pilots"] = {};
    const out: (TickShared & DogfightWorldNet & { planes: PlaneNet[] })[] = [];
    for (const m of inbox.get(id)!) {
      if (!(m instanceof Uint8Array)) {
        if (m.k === "roster") pilots = (m as DogfightRoster).pilots;
        continue;
      }
      if (m[0] !== WORLD_BYTE) continue;
      const u = replica.read(m);
      for (const [i, s] of u.states) states.set(i, s);
      for (const i of u.gone) states.delete(i);
      out.push({ ...(u.extras as DogfightWorldNet), k: "world", t: u.tick * TICK, planes: planesOf(states, pilots) });
    }
    return out;
  };
  /** A page's own snapshots, in binary (D-123), read back. */
  const snaps = (id: string): (TickSnapshot & DogfightSnap)[] =>
    inbox
      .get(id)!
      .filter((m): m is Uint8Array => m instanceof Uint8Array && m[0] === SNAP_BYTE)
      .map((m) => readSnap(m, PLANE_STATE, TICK));
  const events = (kind?: DogfightEvent["kind"]) =>
    all.filter((m): m is TickEvent<DogfightEvent> => !(m instanceof Uint8Array) && m.k === "ev" && (!kind || (m as TickEvent<DogfightEvent>).e.kind === kind)).map((m) => ({ ...m.e, t: m.t }));
  const send = (id: string, seq: number, i: Partial<DogfightInput>, seen: number | null = null) =>
    game.message(id, { k: "in", seq, i: { ...LEVEL_FLIGHT, fire: false, ...i }, seen });
  const play = () => game.match.set("playing", game.time, MATCH.seconds);
  return { game, join, worlds, snaps, events, send, play };
}

const ahead = (a: PlaneState, gap: number): PlaneState => ({ ...a, x: a.x + Math.cos(a.heading) * gap, y: a.y + Math.sin(a.heading) * gap });

describe("the dogfight demo's server (D-113, D-114, D-116, D-118)", () => {
  it("flies each page's inputs through the flight model, and a page predicting with the same inputs lands exactly where the server says", async () => {
    const { game, join, snaps, worlds, send } = room();
    await join("a", "Alex");
    const start = { ...game.plane("a")!.s } as PlaneState;
    const inputs = Array.from({ length: 30 }, (_, n) => ({ pitch: n < 10 ? 0.5 : 0, roll: n >= 10 && n < 20 ? -1 : 0, throttle: 1, yaw: 0 }));
    inputs.forEach((i, n) => {
      send("a", n + 1, i); // one a tick, as a page sends them
      game.tick();
    });
    const last = snaps("a").at(-1)!;
    expect(last.ack).toBe(30);
    const predicted = { ...start };
    for (const i of inputs) flyPlane(predicted, i, world.fly, world.params, TICK);
    expect(planeOf(last)).toEqual(predicted);
    expect(predicted.x).not.toBe(start.x);
    // the shared snapshot: Alex, the bot a pilot alone gets, and the match
    const w = worlds("a").at(-1)!;
    expect(w.planes).toEqual([
      expect.objectContaining({ id: "a", name: "Alex", hp: HP, kills: 0, deaths: 0 }),
      expect.objectContaining({ id: BOT, name: "Bot", bot: true }),
    ]);
    expect(w.match).toEqual({ phase: "staging", until: expect.any(Number), kills: MATCH.kills, winner: null });
  });

  it("cleans a pilot's name, and gives a pilot alone a bot, which goes when another pilot arrives; watchers don't count", async () => {
    const { game, join } = room();
    await join("a", "  Ace‮\u0000 ");
    expect(game.joinOf("a")!.name).toBe("Ace");
    expect(game.playerIds()).toEqual(["a", BOT]);
    await join("w", "Watcher", true);
    expect([game.playerIds(), game.spectatorIds()]).toEqual([["a", BOT], ["w"]]);
    await join("b");
    expect(game.playerIds()).toEqual(["a", "b"]);
    game.leave("a");
    expect(game.playerIds()).toEqual(["b", BOT]);
    game.leave("b");
    expect(game.playerIds()).toEqual([]);
  });

  it("gives a watcher the shared snapshot and the events, and no plane of its own", async () => {
    const { game, join, snaps, worlds } = room();
    await join("a");
    await join("w", "Watcher", true);
    for (let t = 0; t < 3; t++) game.tick();
    expect(game.plane("w")).toBeUndefined();
    expect(snaps("w")).toEqual([]);
    expect(worlds("w").at(-1)!.planes.map((p) => p.id)).toEqual(["a", BOT]);
  });

  it("runs a match: waiting, the countdown with the guns cold, play to the kill limit, the end screen, and the next with the scores back to nothing", async () => {
    const { game, join, events } = room();
    expect(game.match.net()).toEqual({ phase: "staging", until: null });
    await join("a");
    game.tick();
    expect(game.match.phase).toBe("staging");
    expect(game.match.left(game.time)).toBeCloseTo(MATCH.staging, 1);
    game.plane("a")!.s.h += 0; // cold guns: firing in the countdown fires nothing
    game.message("a", { k: "in", seq: 1, i: { ...LEVEL_FLIGHT, fire: true }, seen: null });
    game.tick();
    expect(events("fire")).toEqual([]);
    for (let t = 0; t < MATCH.staging / TICK; t++) game.tick();
    expect(game.match.phase).toBe("playing");
    (game.plane("a") as { kills: number }).kills = MATCH.kills; // the limit
    game.tick();
    expect([game.match.phase, events("phase").at(-1)]).toEqual(["ended", expect.objectContaining({ phase: "ended", winner: "a" })]);
    for (let t = 0; t < MATCH.ended / TICK + 1; t++) game.tick();
    expect([game.match.phase, game.plane("a")!.kills]).toEqual(["staging", 0]);
  });

  it("fires the guns, names each round by its shooter's input, judges hits, and shoots a plane down: its shooter scores, it respawns on a new life", async () => {
    const { game, join, worlds, events, send, play } = room();
    await join("a", "Alex");
    await join("b", "Bo");
    play();
    const a = game.plane("a")!;
    const b = game.plane("b")!;
    Object.assign(b.s, ahead(a.s, 3)); // b 3 cells ahead of a, the same way, at the same height
    const life = worlds("a").at(-1)?.planes.find((p) => p.id === "b")?.life ?? 1;
    for (let seq = 1; seq <= 120 && b.deaths === 0; seq++) {
      send("a", seq, { fire: true }, game.time);
      send("b", seq, {});
      game.tick();
    }
    const fires = events("fire");
    const hits = events("hit");
    expect(fires.length).toBeGreaterThanOrEqual(HP / GUN.damage);
    expect(hits.length).toBe(HP / GUN.damage);
    // each hit names the round that made it: one a's page fired, by its input's number
    const fired = new Set(fires.map((f) => f.kind === "fire" && f.seq));
    expect(hits.every((h) => h.kind === "hit" && h.by === "a" && h.to === "b" && fired.has(h.seq) && h.t > 0)).toBe(true);
    expect(events("down")).toEqual([expect.objectContaining({ kind: "down", who: "b", by: "a", t: game.time })]);
    expect([a.kills, b.deaths, b.hp]).toEqual([1, 1, HP]);
    for (let t = 0; t < 3; t++) game.tick();
    expect(worlds("a").at(-1)!.planes.find((p) => p.id === "b")).toMatchObject({ hp: HP, deaths: 1, life: life + 1 });
  });

  it("counts a crash soon after a hit for the shooter", async () => {
    const { game, join, events, send, play } = room();
    await join("a");
    await join("b");
    play();
    const b = game.plane("b")!;
    (b as { lastHit: unknown }).lastHit = { by: "a", at: game.time };
    b.s.h = (world.fly.groundAt(b.s.x, b.s.y) ?? 0) + 0.05; // into the ground
    send("b", 1, {});
    game.tick();
    expect(events("down")).toEqual([expect.objectContaining({ who: "b", by: "a" })]);
    expect(game.plane("a")!.kills).toBe(1);
  });

  it("flies a bot after the pilot and fires when it is near the nose", async () => {
    const { game, join, events, play } = room();
    await join("a");
    play();
    const a = game.plane("a")!;
    Object.assign(game.plane(BOT)!.s, ahead(a.s, -4)); // the bot 4 cells behind a, the same way
    for (let t = 0; t < 30; t++) game.tick(); // a sends nothing: it holds still on the server
    expect(events("fire").filter((e) => e.kind === "fire" && e.by === BOT).length).toBeGreaterThan(0);
    expect(events("hit").filter((e) => e.kind === "hit" && e.by === BOT && e.to === "a").length).toBeGreaterThan(0);
  });

  it("loads the level around the start and the planes, not whole: a plane over ground still loading waits, then flies on (D-120)", async () => {
    const fresh = await openDogfightWorld("https://pixelworld.test/southwest-fly/");
    const { query, world: info, stats } = fresh.opened;
    expect(stats().chunksLoaded).toBeLessThan(stats().chunksTotal);
    const { game, join, send } = room(fresh);
    await join("a");
    // somewhere not loaded yet
    const far = Array.from({ length: 24 }, (_, n) => [(n % 6) * 64 + 32, Math.floor(n / 6) * 64 + 32] as const).find(([x, y]) => x < info.cellsX && y < info.cellsY && !query.isLoaded(x - 2, y - 2, x + 2, y + 2))!;
    const p = game.plane("a")!;
    Object.assign(p.s, { x: far[0], y: far[1], h: query.coarseHeightAt(far[0], far[1])!.lo }); // low: it can't fly on by the coarse heights
    send("a", 1, {});
    game.tick(); // it waits, and its area is asked for
    expect([game.ackOf("a"), p.s.x]).toEqual([0, far[0]]);
    for (let n = 0; n < 100 && !query.isLoaded(far[0] - 2, far[1] - 2, far[0] + 2, far[1] + 2); n++) await new Promise((r) => setTimeout(r, 5));
    game.tick();
    expect(game.ackOf("a")).toBe(1);
    expect(game.plane("a")!.s.x).not.toBe(far[0]);
  });

  it("keeps the ground respawns read loaded under a tight budget (2 MB: about 9 lean chunks of 24), while planes far off load and let go of theirs (D-120)", async () => {
    const tight = await openDogfightWorld("https://pixelworld.test/southwest-fly/", { chunkBudgetMB: 2 });
    const { query, world: info, stats } = tight.opened;
    const { game, join, send } = room(tight);
    await join("a");
    const p = game.plane("a")!;
    const [sx, sy] = tight.start;
    const startArea = () => query.isLoaded(sx - 32, sy - 32, sx + 32, sy + 32);
    expect(startArea()).toBe(true);
    let seq = 0;
    // a far corner at a time: the plane waits there for its ground, which loads and pushes older chunks out
    for (const [x, y] of [[20, 20], [info.cellsX - 20, 20], [20, info.cellsY - 20], [info.cellsX - 20, info.cellsY - 20]] as const) {
      Object.assign(p.s, { x, y, h: query.coarseHeightAt(x, y)!.lo });
      send("a", ++seq, {});
      game.tick();
      for (let n = 0; n < 100 && game.ackOf("a") < seq; n++) {
        await new Promise((r) => setTimeout(r, 5));
        game.tick();
      }
      expect(game.ackOf("a")).toBe(seq);
    }
    expect(stats().chunksEvicted).toBeGreaterThan(0);
    expect(stats().chunksMB).toBeLessThanOrEqual(2);
    expect(startArea()).toBe(true);
  });

  it("flies a plane on over ground not loaded yet when it is clear above the coarse heights there (D-123)", async () => {
    const fresh = await openDogfightWorld("https://pixelworld.test/southwest-fly/");
    const { query, world: info } = fresh.opened;
    const { game, join, send } = room(fresh);
    await join("a");
    const far = Array.from({ length: 24 }, (_, n) => [(n % 6) * 64 + 32, Math.floor(n / 6) * 64 + 32] as const).find(([x, y]) => x < info.cellsX && y < info.cellsY && !query.isLoaded(x - 2, y - 2, x + 2, y + 2))!;
    const p = game.plane("a")!;
    Object.assign(p.s, { x: far[0], y: far[1], h: fresh.params.ceiling - 1 });
    send("a", 1, {});
    game.tick();
    expect(game.ackOf("a")).toBe(1); // no wait
    expect(p.s.x).not.toBe(far[0]);
  });

  it("clamps a page's stick and trigger to what they can be", async () => {
    const { game, join } = room();
    await join("a");
    const s = { ...game.plane("a")!.s } as PlaneState;
    game.message("a", { k: "in", seq: 1, i: { pitch: Number.NaN, roll: 9, throttle: "x", fire: "yes" }, seen: null });
    game.tick();
    flyPlane(s, { pitch: 0, roll: 1, throttle: 0, yaw: 0 }, world.fly, world.params, TICK);
    expect(game.plane("a")!.s).toEqual(s);
    expect(game.plane("a")!.cooldown).toBe(0); // "yes" didn't fire
  });

  it("keeps a page's prediction exact through the loopback, 50 ms each way, rolling and pulling with the real flight model", async () => {
    const lb = loopback((r) => new DogfightRoom(r, Promise.resolve(world), false));
    const page = lb.join(0.05);
    const plane = { s: null as PlaneState | null, corr: 0, before: { x: 0, y: 0, h: 0 } };
    const client = new TickClient<DogfightInput, DogfightSnap, DogfightWorldNet, DogfightEvent>(page.room, {
      tick: TICK,
      snapSchema: PLANE_STATE,
      step: (i) => plane.s && void flyTick(plane.s, i, world.fly, world.params),
      restore: (snap) => {
        if (plane.s) plane.before = { x: plane.s.x, y: plane.s.y, h: plane.s.h };
        const first = !plane.s;
        plane.s = planeOf(snap);
        if (first) plane.before = { x: snap.x, y: snap.y, h: snap.h };
      },
      reconciled: () => {
        const s = plane.s!;
        plane.corr = Math.max(plane.corr, Math.hypot(s.x - plane.before.x, s.y - plane.before.y, s.h - plane.before.h));
      },
      now: lb.now,
    });
    client.hello({ name: "Alex", watch: false });
    await new Promise((r) => setTimeout(r, 0)); // the world arrives
    let n = 0;
    const stick = (): DogfightInput => {
      n++;
      return { pitch: n % 120 < 40 ? 0.6 : 0, roll: n % 90 < 30 ? 1 : n % 90 < 45 ? -1 : 0, throttle: 0, yaw: 0, fire: false };
    };
    lb.run(0.5, (dt) => client.advance(dt, () => ({ ...LEVEL_FLIGHT, fire: false }))); // the first snapshot: the page takes its plane from it
    plane.corr = 0;
    lb.run(4, (dt) => client.advance(dt, stick));
    expect(plane.corr).toBe(0);
    expect(client.ping).toBeCloseTo(100, 6);
  });
});
