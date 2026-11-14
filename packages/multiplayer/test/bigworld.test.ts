import { readFileSync } from "node:fs";
import { stylePack } from "@pixelworlds/game/src/styles";
import { DRAW_ONLY_LAYERS, openWorld, type Entity, type EntityList, type EntitySpec } from "pixelworld/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RemotePlayers, TickClient, type TickEvent, type TickMessage, type TickShared } from "../src/index";
import { Areas, Interest, TickRoom, type AreaWorld, type HostedRoom, type TickRole } from "../src/server";
import { loopback } from "../src/testing";

/**
 * Rooms on worlds too big to load whole, with more players (D-120): a step
 * that waits while its area loads, interest (each page gets what is near it,
 * built once per group), the world loaded around each player, and the other
 * players coming and going as they move in and out of range. Last, dozens of
 * bots and pages spread across the whole southwest, before and after.
 */

const ROOT = new URL("../../../", import.meta.url);
beforeAll(() => {
  vi.stubGlobal("fetch", async (url: string | URL) => {
    try {
      return new Response(readFileSync(new URL(`fixtures${new URL(String(url)).pathname}`, ROOT)));
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

/** A room over a transport that keeps what each page gets, and how many times something was serialized. */
function transport(ids: string[]) {
  const inbox = new Map(ids.map((id) => [id, [] as unknown[]]));
  let serialized = 0;
  const hosted: HostedRoom = {
    name: "test",
    settings: undefined,
    isPublic: false,
    send: (to, data) => (serialized++, inbox.get(to)?.push(data)),
    broadcast: (data, except) => {
      serialized++;
      for (const [id, box] of inbox) if (!except?.has(id)) box.push(data);
    },
    players: () => [...inbox.keys()],
    kick: () => {},
    close: () => {},
    fail: (e) => {
      throw e;
    },
    log: () => {},
  };
  return { hosted, inbox, serialized: () => serialized };
}

describe("a step that waits (D-120)", () => {
  /** Each step is let through only while `open`. */
  class Gate extends TickRoom<number, string> {
    open = false;
    readonly stepped: number[] = [];
    protected parseJoin = () => "p";
    protected added = (): TickRole => "player";
    protected removed() {}
    protected input = (d: unknown) => (typeof d === "number" ? d : null);
    protected step(_id: string, _i: number, _seen: number | null, seq: number): boolean {
      if (!this.open) return false;
      this.stepped.push(seq);
      return true;
    }
  }

  it("keeps the input first in line, spends no credit and acknowledges nothing until it steps; then catches up as after a stall", () => {
    const { hosted } = transport(["a"]);
    const game = new Gate(hosted, { clock: false });
    game.join("a");
    game.message("a", { k: "hello", join: null } satisfies TickMessage<number>);
    for (let seq = 1; seq <= 20; seq++) {
      game.message("a", { k: "in", seq, i: 0, seen: null } satisfies TickMessage<number>);
      game.tick();
    }
    expect([game.ackOf("a"), game.stepped]).toEqual([0, []]); // 15 wait (6 to 20); the oldest went past the queue
    game.open = true;
    game.tick();
    expect(game.stepped).toEqual([6, 7, 8, 9, 10, 11, 12, 13]); // the credit saved while waiting: a burst
    expect(game.ackOf("a")).toBe(13);
    game.tick();
    expect(game.stepped.slice(8)).toEqual([14]); // then a little over one a tick, as after a stall
  });
});

/** Dots on a plane: each player is where it joined; pages get the dots near them. */
class Dots extends TickRoom<number, { x: number; y: number; watch?: boolean }, undefined, string> {
  readonly at = new Map<string, { x: number; y: number }>();
  readonly interest = new Interest(64);
  readonly groups: (string | undefined)[] = [];
  protected parseJoin = (d: unknown) => d as { x: number; y: number; watch?: boolean };
  protected added(id: string, j: { x: number; y: number; watch?: boolean }): TickRole {
    if (j.watch) return "spectator";
    this.at.set(id, { x: j.x, y: j.y });
    this.interest.place(id, j.x, j.y);
    return "player";
  }
  protected removed(id: string) {
    this.at.delete(id);
    this.interest.remove(id);
  }
  protected input = () => 0;
  protected step() {}
  protected override groupOf(id: string) {
    return this.interest.groupOf(id);
  }
  protected override shared(group?: string) {
    this.groups.push(group);
    return { ids: group === undefined ? [...this.at.keys()] : this.interest.near(group) };
  }
  move(id: string, x: number, y: number) {
    this.at.set(id, { x, y });
    this.interest.place(id, x, y);
  }
}

describe("interest (D-120)", () => {
  it("files things in squares and finds what is within reach of one, or of a place", () => {
    const i = new Interest(10);
    i.place("a", 5, 5);
    i.place("b", 15, 5); // the next square
    i.place("c", 25, 5); // two over
    expect(i.groupOf("a")).toBe("0,0");
    expect(i.near("0,0").sort()).toEqual(["a", "b"]);
    expect(i.around(14, 14).sort()).toEqual(["a", "b", "c"]);
    i.place("c", -5, -5); // moved
    i.remove("b");
    expect(i.near("0,0").sort()).toEqual(["a", "c"]);
    expect(i.groupOf("b")).toBeUndefined();
    expect(new Interest(10, 2).near("0,0").length).toBe(0);
  });

  it("builds and sends a shared snapshot once per group, the whole one to pages in none, and events to the pages near them", () => {
    const { hosted, inbox, serialized } = transport(["a", "b", "c", "d", "w"]);
    const game = new Dots(hosted, { clock: false, snapshotEvery: 1 });
    const at: Record<string, object> = { a: { x: 10, y: 10 }, b: { x: 20, y: 30 }, c: { x: 100, y: 10 }, d: { x: 400, y: 400 }, w: { x: 0, y: 0, watch: true } };
    for (const [id, join] of Object.entries(at)) {
      game.join(id);
      game.message(id, { k: "hello", join } satisfies TickMessage<number>);
    }
    const before = serialized();
    game.tick();
    // a and b share a square; c is the next; d far off; the watcher is in none
    expect(game.groups.sort()).toEqual(["0,0", "1,0", "6,6", undefined]);
    expect(serialized() - before).toBe(4 + 4); // 4 shared snapshots, and 4 players' own
    const ids = (id: string) => (inbox.get(id)!.find((m) => (m as TickShared).k === "world") as unknown as { ids: string[] }).ids.sort();
    expect(ids("a")).toEqual(["a", "b", "c"]);
    expect(ids("b")).toEqual(["a", "b", "c"]);
    expect(ids("c")).toEqual(["a", "b", "c"]);
    expect(ids("d")).toEqual(["d"]);
    expect(ids("w")).toEqual(["a", "b", "c", "d"]);

    game.emit("near a", game.interest.around(10, 10));
    game.emit("to everyone");
    const events = (id: string) => inbox.get(id)!.filter((m): m is TickEvent<string> => (m as TickEvent<string>).k === "ev").map((m) => m.e);
    expect(events("a")).toEqual(["near a", "to everyone"]);
    expect(events("d")).toEqual(["to everyone"]);
  });

  it("sends one shared snapshot to everyone, as before, when the game has no groups", () => {
    const { hosted, inbox } = transport(["a", "b"]);
    class Everyone extends Dots {
      protected override groupOf() {
        return undefined;
      }
    }
    const game = new Everyone(hosted, { clock: false, snapshotEvery: 1 });
    for (const [id, x] of [["a", 0], ["b", 1000]] as const) {
      game.join(id);
      game.message(id, { k: "hello", join: { x, y: 0 } });
    }
    game.tick();
    expect(game.groups).toEqual([undefined]);
    expect(inbox.get("a")!.find((m) => (m as TickShared).k === "world")).toBe(inbox.get("b")!.find((m) => (m as TickShared).k === "world"));
  });
});

describe("the world around each player (Areas, D-120)", () => {
  /** A world in 64-cell chunks whose loads wait until `land()`. */
  function world() {
    const loaded = new Set<string>();
    const asked: string[] = [];
    let waiting: (() => void)[] = [];
    let fail = false;
    const chunks = (x0: number, y0: number, x1: number, y1: number) => {
      const out: string[] = [];
      for (let cy = Math.floor(Math.max(0, y0) / 64); cy <= Math.floor((y1 - 1) / 64); cy++) for (let cx = Math.floor(Math.max(0, x0) / 64); cx <= Math.floor((x1 - 1) / 64); cx++) out.push(`${cx},${cy}`);
      return out;
    };
    const w: AreaWorld = {
      ensure: (...r) => {
        asked.push(r.join(" "));
        return new Promise((resolve, reject) =>
          waiting.push(() => {
            if (fail) return reject(new Error("no network"));
            for (const c of chunks(...r)) loaded.add(c);
            resolve();
          }),
        );
      },
      isLoaded: (...r) => chunks(...r).every((c) => loaded.has(c)),
    };
    const land = async (failing = false) => {
      fail = failing;
      const now = waiting;
      waiting = [];
      for (const f of now) f();
      await new Promise((r) => setTimeout(r, 0));
    };
    return { w, asked, loaded, land };
  }

  it("loads around a player and where it is going, asks once while loading, and says when its step may go", async () => {
    const { w, asked, land } = world();
    const areas = new Areas(w, { radius: 16, ahead: 2, reach: 2 });
    areas.track("a", 99, 100, 10, 0); // 20 cells on, east
    areas.track("a", 100, 100, 10, 0); // the same area, loading: not asked again
    expect(asked).toEqual(["80 80 136 120"]);
    expect([areas.pending, areas.ready(100, 100)]).toEqual([1, false]);
    await land();
    expect([areas.pending, areas.ready(100, 100)]).toEqual([0, true]);
    areas.track("a", 110, 100, 10, 0); // loaded: nothing to ask
    expect(asked.length).toBe(1);
    areas.track("a", 180, 100, 10, 0); // on into the next chunks
    expect(asked.at(-1)).toBe("160 80 216 120");
    await land(true); // that load failed
    expect(areas.failed).toBeInstanceOf(Error);
    areas.track("a", 180, 100, 10, 0); // asked again
    expect(asked.length).toBe(3);
    areas.forget("a");
    expect(areas.pending).toBe(0);
  });
});

describe("players coming into range and going out of it (RemotePlayers, D-120)", () => {
  function entities() {
    const live: Entity[] = [];
    const list: EntityList = {
      add(spec: EntitySpec) {
        const e = {
          id: live.length,
          x: spec.x,
          y: spec.y,
          h: spec.h ?? 0,
          heading: spec.heading ?? 0,
          pitch: 0,
          roll: 0,
          visible: true,
          silhouette: false,
          reveal: null,
          moveTo(x: number, y: number, h = 0) {
            Object.assign(this, { x, y, h });
          },
          remove: () => list.remove(e),
        } as Entity;
        live.push(e);
        return e;
      },
      remove: (e) => void live.splice(live.indexOf(e), 1),
      list: () => live,
    };
    return list;
  }

  it("drops a player that leaves the snapshot, and draws it where it is when it comes back, not slid from where it left", () => {
    const list = entities();
    const others = new RemotePlayers(list, () => ({ model: { group: "vehicle.car", seed: 1, size: [1, 1, 1] } }) as unknown as EntitySpec, { delay: 0.1 });
    // x moves east at 10 cells a second, a snapshot every 0.05 s; it arrives at once
    for (let t = 0; t <= 1; t += 0.05) others.push("x", t, { x: 10 * t, y: 0, h: 0, heading: 0 }, t);
    others.update(1);
    expect(list.list().length).toBe(1);
    expect(others.pose("x")!.x).toBeCloseTo(9, 6); // 0.1 s behind
    others.retain([]); // out of range: not in the next snapshot
    others.update(1.05);
    expect([list.list().length, others.pose("x")]).toEqual([0, null]);
    // back in range 3 s on, far from where it left
    others.push("x", 4, { x: 200, y: 50, h: 0, heading: 0 }, 4);
    others.update(4);
    expect([list.list().length, list.list()[0]!.x, list.list()[0]!.y]).toEqual([1, 200, 50]);
    others.push("x", 4.05, { x: 200.5, y: 50, h: 0, heading: 0 }, 4.05);
    others.update(4.125);
    expect(others.pose("x")!.x).toBeCloseTo(200.25, 6); // between its new samples, 0.1 s behind
  });
});

// ---------------------------------------------------------------- dozens of players across the southwest

/** A rover's input: turn left or right. */
type RoverIn = number;
interface Rover {
  x: number;
  y: number;
  h: number;
  heading: number;
}
const SPEED = 6; // cells a second
const turnOf = (heading: number, turn: number, dt: number) => heading + turn * dt;
/** Its pose after a tick, the same on both sides; it turns back at the world's edges. */
function drive(r: Rover, turn: number, dt: number, cellsX: number, cellsY: number): void {
  r.heading = turnOf(r.heading, turn, dt);
  r.x += Math.cos(r.heading) * SPEED * dt;
  r.y += Math.sin(r.heading) * SPEED * dt;
  if (r.x < 1 || r.x > cellsX - 1) r.heading = Math.PI - r.heading;
  if (r.y < 1 || r.y > cellsY - 1) r.heading = -r.heading;
  r.x = Math.max(1, Math.min(cellsX - 1, r.x));
  r.y = Math.max(1, Math.min(cellsY - 1, r.y));
}

interface Mode {
  /** Load around the players (with a budget), or the whole world as the dogfight did. */
  areas: boolean;
  budgetMB?: number;
  /** Leave out the layers only drawing reads (D-123). */
  lean?: boolean;
  /** Drive on over ground not loaded yet by the coarse heights, halfway up each block, instead of waiting (D-123). */
  coarse?: boolean;
  /** Interest squares (cells), or every page gets everyone. */
  interest: number | null;
}

/** Rovers on the ground of a real world: bots and pages spread across it. */
class Rovers extends TickRoom<RoverIn, { x: number; y: number }, Awaited<ReturnType<typeof openWorld>>> {
  readonly rovers = new Map<string, Rover>();
  readonly areas: Areas | null = null;
  readonly interest: Interest | null;
  waits = 0;
  coarseSteps = 0;
  tickMs: number[] = [];

  constructor(room: HostedRoom, world: Awaited<ReturnType<typeof openWorld>>, readonly mode: Mode) {
    super(room, { clock: false, ready: Promise.resolve(world) });
    this.areas = mode.areas ? new Areas(world.query, { radius: 8, ahead: 2, reach: 1 }) : null;
    this.interest = mode.interest === null ? null : new Interest(mode.interest);
  }
  protected parseJoin = (d: unknown) => d as { x: number; y: number };
  protected added(id: string, j: { x: number; y: number }): TickRole {
    this.rovers.set(id, { x: j.x, y: j.y, h: 0, heading: (this.rovers.size * 2.39996) % (2 * Math.PI) });
    return "player";
  }
  protected removed(id: string) {
    this.rovers.delete(id);
    this.interest?.remove(id);
    this.areas?.forget(id);
  }
  protected input = (d: unknown) => (typeof d === "number" ? Math.max(-1, Math.min(1, d)) : null);
  protected step(id: string, turn: RoverIn): boolean {
    const r = this.rovers.get(id)!;
    const c = this.areas && !this.areas.ready(r.x, r.y) ? (this.mode.coarse ? this.world.query.coarseHeightAt(r.x, r.y) : null) : undefined;
    if (c === null) return (this.waits++, false);
    drive(r, turn, this.tickLength, this.world.world.cellsX, this.world.world.cellsY);
    if (c) this.coarseSteps++;
    r.h = c ? (c.lo + c.hi) / 2 : (this.world.query.heightAt(r.x, r.y) ?? r.h);
    return true;
  }
  protected override update() {
    for (const [id, r] of this.rovers) {
      this.interest?.place(id, r.x, r.y);
      this.areas?.track(id, r.x, r.y, Math.cos(r.heading) * SPEED, Math.sin(r.heading) * SPEED);
    }
  }
  protected override groupOf(id: string) {
    return this.interest?.groupOf(id);
  }
  protected override shared(group?: string) {
    const ids = group === undefined ? [...this.rovers.keys()] : this.interest!.near(group);
    return { rovers: ids.map((id) => ({ id, ...this.rovers.get(id)! })) };
  }
  protected override snapshot(id: string) {
    return { you: this.rovers.get(id) };
  }
  override tick() {
    const t0 = performance.now();
    super.tick();
    this.tickMs.push(performance.now() - t0);
  }
}

const BOTS = 32;
const PAGES = 8;

/** Bots and pages spread across the southwest for `seconds`: what the server holds, how long it ticks, what each page gets. */
async function rovers(mode: Mode, seconds: number) {
  const mem = () => {
    (globalThis as { gc?: () => void }).gc?.(); // with node --expose-gc: what is held, not what is garbage
    const m = process.memoryUsage();
    return { heapMB: m.heapUsed / 2 ** 20, arrayBuffersMB: m.arrayBuffers / 2 ** 20 };
  };
  const m0 = mem();
  const opened = await openWorld({ worldUrl: "https://pixelworld.test/southwest/", style: stylePack, chunkBudgetMB: mode.budgetMB, dropLayers: mode.lean ? DRAW_ONLY_LAYERS : undefined });
  const { cellsX, cellsY } = opened.world;
  if (!mode.areas) await opened.query.ensure(0, 0, cellsX, cellsY); // the whole world, as the dogfight did
  // everyone on a grid over the world, where (with areas) nothing is loaded yet: they wait for their ground first
  const spots = Array.from({ length: BOTS + PAGES }, (_, n) => ({ x: (((n % 8) + 0.5) * cellsX) / 8, y: ((Math.floor(n / 8) + 0.5) * cellsY) / 5 }));
  const lb = loopback((room) => new Rovers(room, opened, mode));
  await new Promise((r) => setTimeout(r, 0)); // the world arrives
  const game = lb.host;
  spots.slice(0, BOTS).forEach((s, n) => game.addBot(`bot${n}`, s, () => Math.sin(game.time * 0.3 + n)));
  const pages = spots.slice(BOTS).map((s) => {
    const page = lb.join(0.05);
    const me: Rover = { ...s, h: 0, heading: 0 };
    const others = new Set<number>();
    const client = new TickClient<RoverIn, { you: Rover }, { rovers: { id: string }[] }>(page.room, {
      tick: game.tickLength,
      step: (turn) => drive(me, turn, game.tickLength, cellsX, cellsY),
      restore: (snap) => Object.assign(me, snap.you),
      onWorld: (w) => others.add(w.rovers.length - 1),
      now: lb.now,
    });
    client.hello(s);
    return { page, client, others };
  });
  // a second to settle, then measured: the room's loads land between slices of the made-up clock
  const run = async (s: number) => {
    for (let t = 0; t < s; t += 0.1) {
      lb.run(0.1, (dt) => pages.forEach((p, n) => p.client.advance(dt, () => Math.cos(lb.now() * 0.2 + n))));
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  await run(1);
  const from = pages.map((p) => p.page.received.length);
  const start = new Map([...game.rovers].map(([id, r]) => [id, { ...r }]));
  game.tickMs.length = 0;
  const waitsAtStart = game.waits;
  await run(seconds);
  const bytes = pages.map((p, n) => p.page.received.slice(from[n]).reduce((sum: number, m) => sum + JSON.stringify(m).length, 0));
  const moved = [...game.rovers].map(([id, r]) => Math.hypot(r.x - start.get(id)!.x, r.y - start.get(id)!.y));
  const ms = game.tickMs.sort((a, b) => a - b);
  const m1 = mem();
  return {
    world: opened.stats(),
    perPageKBs: bytes.reduce((a, b) => a + b, 0) / pages.length / seconds / 1024,
    tickMs: { mean: ms.reduce((a, b) => a + b, 0) / ms.length, p99: ms[Math.floor(ms.length * 0.99)]!, max: ms.at(-1)! },
    /** Steps that waited for their ground: in the first second (everyone on ground not loaded), and after. */
    waits: game.waits,
    waitsAtStart,
    coarseSteps: game.coarseSteps,
    slowest: Math.min(...moved),
    others: Math.max(...pages.flatMap((p) => [...p.others])),
    /** What the room and its world hold (more than when it opened). */
    heapMB: m1.heapMB - m0.heapMB,
    arrayBuffersMB: m1.arrayBuffersMB - m0.arrayBuffersMB,
  };
}

describe("dozens of players across the southwest (D-120)", () => {
  it("loads only around them within a budget and sends each page only who is near, where everyone everywhere cost the whole world and every rover", async () => {
    const seconds = Number(process.env.BIGWORLD_SECONDS ?? 4);
    const before = await rovers({ areas: false, interest: null }, seconds);
    const after = await rovers({ areas: true, budgetMB: 40, interest: 128 }, seconds);
    if (process.env.BIGWORLD_LOG) console.log(JSON.stringify({ bots: BOTS, pages: PAGES, seconds, before, after }, null, 2));
    expect(before.world.chunksLoaded).toBe(before.world.chunksTotal);
    expect(after.world.chunksMB).toBeLessThanOrEqual(40);
    expect(after.world.chunksLoaded).toBeLessThan(after.world.chunksTotal / 2);
    expect(after.perPageKBs).toBeLessThan(before.perPageKBs / 3);
    expect(after.others).toBeLessThan(before.others);
    // every rover waited for its ground at first, chunks went and came back as they moved, and nobody stayed stuck
    expect(after.waits).toBeGreaterThan(0);
    expect(after.world.chunksEvicted).toBeGreaterThan(0);
    expect(after.slowest).toBeGreaterThan(before.slowest * 0.5);
  }, 60_000);
});
