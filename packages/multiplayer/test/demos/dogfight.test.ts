import { readFileSync } from "node:fs";
import { LEVEL_FLIGHT, flyPlane, type PlaneState } from "@pixelworlds/game/src/plane";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DogfightRoom, openDogfightWorld, type DogfightWorld } from "../../src/demos/dogfight/server";
import { GUN, HP, TICK, type DogfightInput, type ServerMsg } from "../../src/demos/dogfight/rules";
import type { HostedRoom } from "../../src/server";

/**
 * The dogfight demo's server (D-113, D-114) over the real flying level, in
 * Node: the world from the committed package, a room with a made-up
 * transport, and ticks stepped by hand.
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
    game.join(id);
    game.message(id, { k: "hello", name });
    await new Promise((r) => setTimeout(r, 0)); // the world arrives
  };
  const snaps = (id: string) => inbox.get(id)!.filter((m): m is Extract<ServerMsg, { k: "snap" }> => m.k === "snap");
  const send = (id: string, seq: number, i: Partial<DogfightInput>, seen: number | null = null) =>
    game.message(id, { k: "in", seq, i: { ...LEVEL_FLIGHT, fire: false, ...i }, seen });
  return { game, join, all, snaps, send };
}

describe("the dogfight demo's server (D-113, D-114)", () => {
  it("flies each page's inputs through the flight model, and a page predicting with the same inputs lands exactly where the server says", async () => {
    const { game, join, snaps, send } = room();
    await join("a", "Alex");
    const start = { ...game.plane("a")!.s } as PlaneState;
    const inputs = Array.from({ length: 30 }, (_, n) => ({ pitch: n < 10 ? 0.5 : 0, roll: n >= 10 && n < 20 ? -1 : 0, throttle: 1, yaw: 0 }));
    inputs.forEach((i, n) => send("a", n + 1, i));
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

  it("fires the guns, judges hits, and shoots a plane down: its shooter scores, and it respawns", async () => {
    const { game, join, all, snaps, send } = room();
    await join("a", "Alex");
    await join("b", "Bot");
    const a = game.plane("a")!;
    const b = game.plane("b")!;
    // b 3 cells ahead of a, the same way, at the same height
    Object.assign(b.s, { ...a.s, x: a.s.x + Math.cos(a.s.heading) * 3, y: a.s.y + Math.sin(a.s.heading) * 3 });
    for (let seq = 1; seq <= 120 && b.deaths === 0; seq++) {
      send("a", seq, { fire: true }, game.time);
      send("b", seq, {});
      game.tick();
    }
    const hits = all.filter((m) => m.k === "hit");
    expect(all.filter((m) => m.k === "fire").length).toBeGreaterThanOrEqual(HP / GUN.damage);
    expect(hits.length).toBe(HP / GUN.damage);
    expect(hits.every((m) => m.k === "hit" && m.by === "a" && m.to === "b")).toBe(true);
    expect(all.filter((m) => m.k === "down")).toEqual([expect.objectContaining({ k: "down", who: "b", by: "a" })]);
    expect([a.kills, b.deaths, b.hp]).toEqual([1, 1, HP]);
    for (let t = 0; t < 3; t++) game.tick();
    expect(snaps("a").at(-1)!.planes.find((p) => p.id === "b")).toMatchObject({ hp: HP, deaths: 1 });
    // flagged once after each jump, so the pages don't slide it there: when it joined, and now
    expect(snaps("a").filter((s) => s.planes.find((p) => p.id === "b")?.jump).length).toBe(2);
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

  it("clamps a page's stick and trigger to what they can be", async () => {
    const { game, join, snaps, send } = room();
    await join("a");
    const s = { ...game.plane("a")!.s } as PlaneState;
    game.message("a", { k: "in", seq: 1, i: { pitch: Number.NaN, roll: 9, throttle: "x", fire: "yes" }, seen: null });
    game.tick();
    flyPlane(s, { pitch: 0, roll: 1, throttle: 0, yaw: 0 }, world.fly, world.params, TICK);
    expect(snaps("a").length ? snaps("a").at(-1)!.you : game.plane("a")!.s).toEqual(s);
    send("a", 2, {});
    expect(game.plane("a")!.cooldown).toBe(0); // "yes" didn't fire
  });
});
