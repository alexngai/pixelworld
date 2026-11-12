import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Smoothing, joinRoom, type Room } from "../src/index";
import { attachRelay, type Relay } from "../src/server";

/** A relay on a free port, and its URL. */
async function relay(opts: Parameters<typeof attachRelay>[1] = {}): Promise<{ url: string; relay: Relay; server: Server }> {
  const server = createServer((_, res) => res.end("an HTTP page")).listen(0);
  await new Promise((r) => server.once("listening", r));
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/relay`, relay: attachRelay(server, opts), server };
}

/** The arguments of the next call to a handler. */
const once = <A extends unknown[]>(set: (f: (...a: A) => void) => void) => new Promise<A>((resolve) => set((...a) => resolve(a)));

const open: { rooms: Room[]; servers: { relay: Relay; server: Server }[] } = { rooms: [], servers: [] };
afterEach(() => {
  for (const r of open.rooms.splice(0)) r.close();
  for (const s of open.servers.splice(0)) {
    s.relay.close();
    s.server.close();
  }
});

async function setup(opts?: Parameters<typeof attachRelay>[1]) {
  const s = await relay(opts);
  open.servers.push(s);
  const join = async (room: string) => {
    const r = await joinRoom(s.url, room);
    open.rooms.push(r);
    return r;
  };
  return { ...s, join };
}

describe("the relay and its rooms (D-112)", () => {
  it("passes each player's messages to the others in its room, with who sent them", async () => {
    const { join, relay } = await setup();
    const a = await join("canyon");
    const joined = once<[string]>((f) => (a.onJoin = f));
    const b = await join("canyon");
    const elsewhere = await join("strip");
    expect(await joined).toEqual([b.id]);
    expect([a.peers.has(b.id), b.peers.has(a.id), elsewhere.peers.size]).toEqual([true, true, 0]);
    expect(relay.rooms()).toEqual(new Map([["canyon", 2], ["strip", 1]]));

    const got = once<[string, unknown]>((f) => (b.onMessage = f));
    let strayed = false;
    elsewhere.onMessage = () => (strayed = true);
    let echoed = false;
    a.onMessage = () => (echoed = true);
    a.send({ t: 1.5, pose: { x: 1, y: 2, h: 3, heading: 0 } });
    expect(await got).toEqual([a.id, { t: 1.5, pose: { x: 1, y: 2, h: 3, heading: 0 } }]);
    await new Promise((r) => setTimeout(r, 30));
    expect([strayed, echoed]).toEqual([false, false]);

    const left = once<[string]>((f) => (b.onLeave = f));
    a.close();
    expect(await left).toEqual([a.id]);
    expect(b.peers.has(a.id)).toBe(false);
  });

  it("turns away a player when the room is full, and says so when no relay answers", async () => {
    const { join, url } = await setup({ maxPlayers: 1 });
    await join("duel");
    await expect(joinRoom(url, "duel")).rejects.toThrow('room "duel" is full');
    await expect(joinRoom("ws://127.0.0.1:9/relay", "duel")).rejects.toThrow("no relay answered at ws://127.0.0.1:9/relay");
  });

  it("holds messages back by `lag`, in order", async () => {
    const { join } = await setup({ lag: 80 });
    const a = await join("lag");
    const b = await join("lag");
    const seen: number[] = [];
    const done = new Promise<void>((resolve) => {
      b.onMessage = (_, n) => {
        seen.push(n as number);
        if (seen.length === 3) resolve();
      };
    });
    const t0 = performance.now();
    for (const n of [1, 2, 3]) a.send(n);
    await done;
    expect(performance.now() - t0).toBeGreaterThanOrEqual(75);
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe("smoothing other players' poses", () => {
  const pose = (x: number, heading = 0) => ({ x, y: 0, h: 0, heading });

  it("draws them `delay` behind on their own clock, between samples, and holds the newest", () => {
    const s = new Smoothing(0.1);
    // their clock is 1000 s behind ours; the quickest message took 20 ms
    s.push("a", 0.0, pose(0), 1000.05);
    s.push("a", 0.05, pose(5), 1000.07);
    s.push("a", 0.1, pose(10), 1000.12);
    // the gap to their clock: 1000.02 (the quickest message); at 1000.14 we draw their 0.14 − 0.02 − 0.1 (delay) = 0.02,
    // 2/5 of the way from x 0 to 5
    expect(s.at("a", 1000.1)!.x).toBe(0); // before the first: the first
    expect(s.at("a", 1000.14)!.x).toBeCloseTo(2, 9);
    expect(s.at("a", 1000.19)!.x).toBeCloseTo(7, 9);
    expect(s.at("a", 1001)!.x).toBe(10); // nothing newer: held
    expect(s.at("b", 1000)).toBeNull();
  });

  it("turns the short way round, and doesn't slide into a jump", () => {
    const s = new Smoothing(0);
    s.push("a", 0, pose(0, 3.0), 0);
    s.push("a", 1, pose(10, -3.0), 1);
    const mid = s.at("a", 0.5)!;
    expect(Math.abs(Math.atan2(Math.sin(mid.heading), Math.cos(mid.heading)))).toBeCloseTo(Math.PI, 2); // through π, not 0
    s.push("a", 2, pose(500), 2, true); // respawned far away
    expect(s.at("a", 1.5)!.x).toBe(10); // held where it was…
    expect(s.at("a", 2)!.x).toBe(500); // …then there at once
  });

  it("drops late and repeated samples", () => {
    const s = new Smoothing(0);
    s.push("a", 1, pose(1), 1);
    s.push("a", 0.5, pose(99), 1);
    s.push("a", 1, pose(99), 1);
    expect(s.at("a", 5)!.x).toBe(1);
  });
});
