import { readFileSync } from "node:fs";
import { LEVEL_FLIGHT, flyPlane, type PlaneState } from "@pixelworlds/game/src/plane";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DogfightRoom, openDogfightWorld, type DogfightWorld } from "../../src/demos/dogfight/server";
import { BOT, GUN, HP, TICK, type DogfightInput, type ServerMsg } from "../../src/demos/dogfight/rules";
import type { HostedRoom } from "../../src/server";

/**
 * The dogfight demo's server (D-113, D-114, D-116) over the real flying
 * level, in Node: the world from the committed package, a room with a
 * made-up transport, and ticks stepped by hand.
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

type Snap = Extract<ServerMsg, { k: "snap" }>;
type World = Extract<ServerMsg, { k: "world" }>;

/** A room over a transport that keeps what it sends, by page. */
function room() {
  const inbox = new Map<string, ServerMsg[]>();
  const all: ServerMsg[] = [];
  const kicked: string[] = [];
  const hosted: HostedRoom = {
    name: "test",
    send: (to, data) => inbox.get(to)?.push(data as ServerMsg),
    broadcast: (data) => {
      all.push(data as ServerMsg);
      for (const box of inbox.values()) box.push(data as ServerMsg);
    },
    players: () => [...inbox.keys()],
    kick: (id) => kicked.push(id),
    close: () => {},
  };
  const game = new DogfightRoom(hosted, Promise.resolve(world), false);
  const join = async (id: string, name = id, watch = false) => {
    inbox.set(id, []);
    game.join(id);
    game.message(id, { k: "hello", join: { name, watch } });
    await new Promise((r) => setTimeout(r, 0)); // the world arrives
  };
  const of = <K extends ServerMsg["k"]>(id: string, k: K) => inbox.get(id)!.filter((m): m is Extract<ServerMsg, { k: K }> => m.k === k);
  const send = (id: string, seq: number, i: Partial<DogfightInput>, seen: number | null = null) =>
    game.message(id, { k: "in", seq, i: { ...LEVEL_FLIGHT, fire: false, ...i }, seen });
  return { game, join, all, of, send, kicked };
}

const ahead = (a: PlaneState, gap: number): PlaneState => ({ ...a, x: a.x + Math.cos(a.heading) * gap, y: a.y + Math.sin(a.heading) * gap });

describe("the dogfight demo's server (D-113, D-114, D-116)", () => {
  it("flies each page's inputs through the flight model, and a page predicting with the same inputs lands exactly where the server says", async () => {
    const { game, join, of, send } = room();
    await join("a", "Alex");
    const start = { ...game.plane("a")!.s } as PlaneState;
    const inputs = Array.from({ length: 30 }, (_, n) => ({ pitch: n < 10 ? 0.5 : 0, roll: n >= 10 && n < 20 ? -1 : 0, throttle: 1, yaw: 0 }));
    inputs.forEach((i, n) => {
      send("a", n + 1, i); // one a tick, as a page sends them
      game.tick();
    });
    const last = of("a", "snap").at(-1)! as Snap;
    expect(last.ack).toBe(30);
    // the page's prediction: the same model, the same inputs, the same fixed step
    const predicted = { ...start };
    for (const i of inputs) flyPlane(predicted, i, world.fly, world.params, TICK);
    expect(last.you).toEqual(predicted);
    expect(predicted.x).not.toBe(start.x);
    // the shared snapshot: Alex, and the bot a pilot alone gets
    expect((of("a", "world").at(-1) as World).planes).toEqual([
      expect.objectContaining({ id: "a", name: "Alex", hp: HP, kills: 0, deaths: 0, life: 0 }),
      expect.objectContaining({ id: BOT, name: "Bot", bot: true }),
    ]);
  });

  it("gives a pilot alone a bot, which goes when another pilot arrives and comes back when one is alone again; watchers don't count", async () => {
    const { game, join } = room();
    await join("a");
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
    const { game, join, of } = room();
    await join("a");
    await join("w", "Watcher", true);
    for (let t = 0; t < 3; t++) game.tick();
    expect(game.plane("w")).toBeUndefined();
    expect(of("w", "snap")).toEqual([]);
    expect((of("w", "world").at(-1) as World).planes.map((p) => p.id)).toEqual(["a", BOT]);
  });

  it("fires the guns, judges hits, and shoots a plane down: its shooter scores, it respawns on a new life, and events carry their time", async () => {
    const { game, join, all, of, send } = room();
    await join("a", "Alex");
    await join("b", "Bo");
    const a = game.plane("a")!;
    const b = game.plane("b")!;
    Object.assign(b.s, ahead(a.s, 3)); // b 3 cells ahead of a, the same way, at the same height
    for (let seq = 1; seq <= 120 && b.deaths === 0; seq++) {
      send("a", seq, { fire: true }, game.time);
      send("b", seq, {});
      game.tick();
    }
    const hits = all.filter((m) => m.k === "hit");
    expect(all.filter((m) => m.k === "fire").length).toBeGreaterThanOrEqual(HP / GUN.damage);
    expect(hits.length).toBe(HP / GUN.damage);
    expect(hits.every((m) => m.k === "hit" && m.by === "a" && m.to === "b" && m.t > 0 && m.t <= game.time)).toBe(true);
    expect(all.filter((m) => m.k === "down")).toEqual([expect.objectContaining({ k: "down", who: "b", by: "a", t: game.time })]);
    expect([a.kills, b.deaths, b.hp]).toEqual([1, 1, HP]);
    for (let t = 0; t < 3; t++) game.tick();
    expect((of("a", "world").at(-1) as World).planes.find((p) => p.id === "b")).toMatchObject({ hp: HP, deaths: 1, life: 1 });
  });

  it("counts a crash soon after a hit for the shooter", async () => {
    const { game, join, all, send } = room();
    await join("a");
    await join("b");
    const b = game.plane("b")!;
    (b as { lastHit: unknown }).lastHit = { by: "a", at: game.time };
    b.s.h = (world.fly.groundAt(b.s.x, b.s.y) ?? 0) + 0.05; // into the ground
    send("b", 1, {});
    game.tick();
    expect(all.filter((m) => m.k === "down")).toEqual([expect.objectContaining({ who: "b", by: "a" })]);
    expect(game.plane("a")!.kills).toBe(1);
  });

  it("flies a bot after the pilot and fires when it is near the nose", async () => {
    const { game, join, all } = room();
    await join("a");
    const a = game.plane("a")!;
    Object.assign(game.plane(BOT)!.s, ahead(a.s, -4)); // the bot 4 cells behind a, the same way
    for (let t = 0; t < 30; t++) game.tick(); // a sends nothing: it holds still on the server
    expect(all.filter((m) => m.k === "fire" && m.by === BOT).length).toBeGreaterThan(0);
    expect(all.filter((m) => m.k === "hit" && m.by === BOT && m.to === "a").length).toBeGreaterThan(0);
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
});
