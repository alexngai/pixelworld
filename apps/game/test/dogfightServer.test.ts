import { readFileSync } from "node:fs";
import type { HostedRoom } from "@pixelworlds/multiplayer/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GUN, HP, TICK, type ServerMsg } from "../src/dogfightRules";
import { DogfightRoom, openDogfightWorld, type DogfightWorld } from "../src/dogfightServer";
import { LEVEL_FLIGHT, flyPlane, type PlaneState } from "../src/plane";

/**
 * The dogfight's server (D-113) over the real flying level, in Node: the
 * world from the committed package, a room with a made-up transport, and
 * ticks stepped by hand.
 */

const ROOT = new URL("../../../", import.meta.url);
let world: DogfightWorld;

beforeAll(async () => {
  vi.stubGlobal("fetch", async (url: string | URL) => {
    try {
      return new Response(readFileSync(new URL(`fixtures${new URL(String(url)).pathname}`, ROOT)));
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
  world = await openDogfightWorld("https://pixelworld.test/southwest-fly/", new URL("worlds/_styles/", ROOT));
});
afterAll(() => {
  vi.unstubAllGlobals();
});

/** A room over a transport that keeps what it sends, by player. */
function room() {
  const inbox = new Map<string, ServerMsg[]>();
  const all: ServerMsg[] = [];
  const players: string[] = [];
  const hosted: HostedRoom = {
    name: "test",
    send: (to, data) => inbox.get(to)?.push(data as ServerMsg),
    broadcast: (data) => {
      all.push(data as ServerMsg);
      for (const id of players) inbox.get(id)!.push(data as ServerMsg);
    },
    players: () => players,
  };
  const game = new DogfightRoom(hosted, Promise.resolve(world), false);
  const join = async (id: string, name = id) => {
    players.push(id);
    inbox.set(id, []);
    game.message(id, { k: "hello", name });
    game.join(id);
    await Promise.resolve(); // the world arrives
  };
  const snaps = (id: string) => inbox.get(id)!.filter((m): m is Extract<ServerMsg, { k: "snap" }> => m.k === "snap");
  return { game, join, inbox, all, snaps };
}

const LEVEL = { pitch: 0, roll: 0, throttle: 0, yaw: 0 };

describe("the dogfight's server (D-113)", () => {
  it("flies each page's inputs through the flight model, and a page predicting with the same inputs lands exactly where the server says", async () => {
    const { game, join, snaps } = room();
    await join("a", "Alex");
    const start = { ...game.player("a")!.s } as PlaneState;
    const inputs = Array.from({ length: 30 }, (_, n) => ({ pitch: n < 10 ? 0.5 : 0, roll: n >= 10 && n < 20 ? -1 : 0, throttle: 1, yaw: 0 }));
    inputs.forEach((i, n) => game.message("a", { k: "in", seq: n + 1, i, f: false, seen: null }));
    for (let t = 0; t < 30; t++) game.tick();
    const last = snaps("a").at(-1)!;
    expect(last.ack).toBe(30);
    expect(last.planes).toEqual([expect.objectContaining({ id: "a", name: "Alex", hp: HP, kills: 0, deaths: 0 })]);
    // the page's prediction: the same model, the same inputs, the same fixed step
    const predicted = { ...start };
    for (const i of inputs) flyPlane(predicted, i, world.fly, world.params, TICK);
    expect(last.you).toEqual(predicted);
    expect(predicted.x).not.toBe(start.x);
  });

  it("steps a page no faster than its clock, and drops inputs it can't trust", async () => {
    const { game, join } = room();
    await join("a");
    for (let n = 1; n <= 40; n++) game.message("a", { k: "in", seq: n, i: LEVEL, f: false, seen: null });
    game.tick();
    expect(game.player("a")!.ack).toBe(1); // one step a tick (a backlog is caught up at most 8 at a time)
    game.message("a", { k: "in", seq: 3, i: LEVEL, f: false, seen: null }); // not after the last queued: dropped
    game.message("a", { k: "in", seq: 41, i: { pitch: Number.NaN, roll: 9, throttle: "x" }, f: "yes", seen: Infinity });
    const q = (game.player("a") as unknown as { queue: { seq: number; i: unknown; f: boolean; seen: unknown }[] }).queue;
    expect(q.length).toBe(40);
    expect(q.at(-1)).toEqual({ seq: 41, i: { pitch: 0, roll: 1, throttle: 0, yaw: 0 }, f: false, seen: null });
  });

  it("fires the guns, judges hits, and shoots a plane down: its shooter scores, and it respawns", async () => {
    const { game, join, all, snaps } = room();
    await join("a", "Alex");
    await join("b", "Bot");
    const a = game.player("a")!;
    const b = game.player("b")!;
    // b 3 cells ahead of a, the same way, at the same height
    Object.assign(b.s, { ...a.s, x: a.s.x + Math.cos(a.s.heading) * 3, y: a.s.y + Math.sin(a.s.heading) * 3 });
    let seq = 0;
    for (let t = 0; t < 120 && b.deaths === 0; t++) {
      seq++;
      game.message("a", { k: "in", seq, i: LEVEL_FLIGHT, f: true, seen: game.time });
      game.message("b", { k: "in", seq, i: LEVEL_FLIGHT, f: false, seen: null });
      game.tick();
    }
    const fired = all.filter((m) => m.k === "fire");
    const hits = all.filter((m) => m.k === "hit");
    expect(fired.length).toBeGreaterThanOrEqual(HP / GUN.damage);
    expect(hits.length).toBe(HP / GUN.damage);
    expect(hits.every((m) => m.k === "hit" && m.by === "a" && m.to === "b")).toBe(true);
    expect(all.filter((m) => m.k === "down")).toEqual([expect.objectContaining({ k: "down", who: "b", by: "a" })]);
    expect([a.kills, b.deaths, b.hp]).toEqual([1, 1, HP]);
    game.tick();
    game.tick();
    game.tick();
    const respawned = snaps("a").at(-1)!.planes.find((p) => p.id === "b")!;
    expect(respawned).toMatchObject({ hp: HP, deaths: 1 });
    // its respawn was flagged once, in the snapshot after it, so the pages don't slide it there
    expect(snaps("a").filter((s) => s.planes.find((p) => p.id === "b")?.jump).length).toBe(2); // when it joined, and now
  });

  it("counts a crash soon after a hit for the shooter", async () => {
    const { game, join, all } = room();
    await join("a");
    await join("b");
    const b = game.player("b")!;
    (b as { lastHit: unknown }).lastHit = { by: "a", at: game.time };
    b.s.h = (world.fly.groundAt(b.s.x, b.s.y) ?? 0) + 0.05; // into the ground
    game.message("b", { k: "in", seq: 1, i: LEVEL_FLIGHT, f: false, seen: null });
    game.tick();
    expect(all.filter((m) => m.k === "down")).toEqual([expect.objectContaining({ who: "b", by: "a" })]);
    expect(game.player("a")!.kills).toBe(1);
  });
});
