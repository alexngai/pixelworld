import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Prediction, SERVER, Smoothing, TickClient, joinRoom, type Room, type TickMessage } from "../src/index";
import { History, TickRoom, attachRelay, serveStatic, type HostedRoom, type Relay } from "../src/server";

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

describe("rooms the server runs (D-113)", () => {
  it("sends players' messages to the room's game, which answers one or all; it closes when the room empties", async () => {
    const log: string[] = [];
    let hosted: HostedRoom | null = null;
    const { join, relay } = await setup({
      host: (room) => {
        hosted = room;
        log.push(`open ${room.name}`);
        return {
          join: (id) => log.push(`join ${id}`),
          message: (id, data) => {
            log.push(`${id}: ${JSON.stringify(data)}`);
            room.send(id, { echo: data });
            room.broadcast({ players: room.players() });
          },
          leave: (id) => log.push(`leave ${id}`),
          close: () => log.push("close"),
        };
      },
    });
    const a = await join("arena");
    const b = await join("arena");
    const toA: unknown[] = [];
    const toB: unknown[] = [];
    a.onMessage = (from, data) => toA.push([from, data]);
    let gotB: () => void;
    const bGot = new Promise<void>((r) => (gotB = r));
    b.onMessage = (from, data) => {
      toB.push([from, data]);
      gotB();
    };
    a.send({ in: 1 });
    await bGot;
    await new Promise((r) => setTimeout(r, 20));
    expect(toA).toEqual([
      [SERVER, { echo: { in: 1 } }],
      [SERVER, { players: [a.id, b.id] }],
    ]);
    expect(toB).toEqual([[SERVER, { players: [a.id, b.id] }]]); // not a's message itself
    expect(hosted!.name).toBe("arena");
    const bLeft = once<[string]>((f) => (a.onLeave = f));
    b.close();
    await bLeft;
    a.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(log).toEqual([`open arena`, `join ${a.id}`, `join ${b.id}`, `${a.id}: {"in":1}`, `leave ${b.id}`, `leave ${a.id}`, "close"]);
    expect(relay.rooms().size).toBe(0);
  });
});

/** A toy game at a fixed tick: each player is a number its inputs (−1 to 1) add to. */
class Toy extends TickRoom<number> {
  readonly at = new Map<string, number>();
  readonly log: string[] = [];
  protected input(data: unknown): number | null {
    return typeof data === "number" && Number.isFinite(data) ? Math.max(-1, Math.min(1, data)) : null;
  }
  protected added(id: string, name: string): void {
    this.at.set(id, 0);
    this.log.push(`added ${id} ${name}`);
  }
  protected removed(id: string): void {
    this.at.delete(id);
    this.log.push(`removed ${id}`);
  }
  protected step(id: string, input: number, seen: number | null): void {
    this.at.set(id, this.at.get(id)! + input);
    if (seen !== null) this.log.push(`seen ${id} lag ${this.lagOf(seen, 0.5).toFixed(3)}`);
  }
  protected snapshot(id: string): object {
    return { x: this.at.get(id) };
  }
}

function toyRoom(ready?: Promise<unknown>) {
  const sent: [string, unknown][] = [];
  const hosted: HostedRoom = { name: "toy", send: (to, data) => sent.push([to, data]), broadcast: () => {}, players: () => [] };
  return { game: new Toy(hosted, { clock: false, ready, snapshotEvery: 2 }), sent };
}

describe("a game at a fixed tick (TickRoom, D-114)", () => {
  it("steps each player's inputs one a tick, catches up a backlog a few at a time, and snapshots with the last input stepped", () => {
    const { game, sent } = toyRoom();
    game.join("1");
    game.message("1", { k: "hello", name: "  Alex Alexander Alexandrovich  " });
    expect(game.nameOf("1")).toBe("Alex Alexander Alexa"); // trimmed, 20 at most
    for (let seq = 1; seq <= 20; seq++) game.message("1", { k: "in", seq, i: 1, seen: null } satisfies TickMessage<number>);
    game.tick();
    expect([game.at.get("1"), game.ackOf("1")]).toEqual([1, 1]); // one a tick: a page can't play faster than the clock
    game.tick();
    expect(sent).toEqual([["1", { k: "snap", t: 2 / 60, ack: 2, x: 2 }]]);
    for (let t = 0; t < 30; t++) game.tick(); // the rest, one a tick
    expect(game.ackOf("1")).toBe(20);
  });

  it("drops inputs out of order, past its queue, or that the game won't take", () => {
    const { game } = toyRoom();
    game.join("1");
    game.message("1", { k: "in", seq: 2, i: 1, seen: null });
    game.message("1", { k: "in", seq: 2, i: 1, seen: null }); // repeated
    game.message("1", { k: "in", seq: 1, i: 1, seen: null }); // older
    game.message("1", { k: "in", seq: 3, i: "far", seen: null }); // not an input
    game.message("1", { k: "in", seq: 4, i: 9, seen: null }); // clamped to 1
    game.message("1", { k: "in", seq: 5.5, i: 1, seen: null }); // not a whole number
    game.message("1", null);
    for (let t = 0; t < 5; t++) game.tick();
    expect([game.at.get("1"), game.ackOf("1")]).toEqual([2, 4]);
  });

  it("holds players until the game is ready, and rewinds by a page's lag at most `max`", async () => {
    let ready!: () => void;
    const { game } = toyRoom(new Promise<void>((r) => (ready = r)));
    game.join("1");
    game.message("1", { k: "hello", name: "Bo" });
    game.tick();
    expect(game.playerIds()).toEqual([]);
    ready();
    await new Promise((r) => setTimeout(r, 0));
    expect(game.log).toEqual(["added 1 Bo"]);
    for (let t = 0; t < 30; t++) game.tick();
    game.message("1", { k: "in", seq: 1, i: 0, seen: game.time - 0.2 });
    game.message("1", { k: "in", seq: 2, i: 0, seen: game.time - 9 });
    game.tick();
    game.tick();
    expect(game.log.slice(1)).toEqual(["seen 1 lag 0.217", "seen 1 lag 0.500"]);
    game.leave("1");
    expect(game.log.at(-1)).toBe("removed 1");
  });
});

describe("where things were (History)", () => {
  it("rewinds between records, holds the oldest, and gives where it is now past the newest", () => {
    const h = new History(1);
    for (let t = 0; t <= 2; t += 0.5) h.record(t, { x: t * 10, y: 0, h: 1 });
    expect(h.at(1.25, { x: 99, y: 0, h: 1 })).toEqual({ x: 12.5, y: 0, h: 1 });
    expect(h.at(0, { x: 99, y: 0, h: 1 }).x).toBe(10); // t 0.5 is the oldest kept (1 s)
    expect(h.at(3, { x: 99, y: 0, h: 1 }).x).toBe(99);
    h.clear();
    expect(h.at(1.25, { x: 99, y: 0, h: 1 }).x).toBe(99);
  });
});

describe("a page in a room the server runs (TickClient)", () => {
  it("steps fixed ticks for the time gone by, sends each input numbered with what it saw, and reconciles", () => {
    const sent: unknown[] = [];
    const room = { send: (d: unknown) => sent.push(d) } as unknown as Room;
    let x = 0;
    const client = new TickClient<number>(room, { tick: 0.1, step: (i) => (x += i), seen: () => 7, maxTicksPerFrame: 3 });
    client.hello("Alex");
    const after: number[] = [];
    client.advance(0.25, () => 1, (i) => after.push(i));
    expect([x, after]).toEqual([2, [1, 1]]);
    client.advance(1, () => 1); // a stall: at most 3 ticks
    expect(x).toBe(5);
    expect(sent.slice(0, 3)).toEqual([{ k: "hello", name: "Alex" }, { k: "in", seq: 1, i: 1, seen: 7 }, { k: "in", seq: 2, i: 1, seen: 7 }]);
    client.reconcile({ k: "snap", t: 0, ack: 4 }, () => (x = 3.5)); // the server held it back a little
    expect(x).toBe(4.5);
  });
});

describe("serving a built game (serveStatic)", () => {
  it("serves files and index.html, caches hashed assets, and nothing outside its directory", async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), "serve-"));
    mkdirSync(joinPath(dir, "assets"));
    mkdirSync(joinPath(dir, "w"));
    writeFileSync(joinPath(dir, "index.html"), "<p>game</p>");
    writeFileSync(joinPath(dir, "assets", "main-1a2b.js"), "1");
    writeFileSync(joinPath(dir, "w", "chunk.bin.gz"), "zz");
    writeFileSync(joinPath(tmpdir(), "secret.txt"), "no");
    const server = createServer(serveStatic(dir)).listen(0);
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async (path: string, method = "GET") => {
      const r = await fetch(base + path, { method });
      return [r.status, r.headers.get("content-type"), r.headers.get("cache-control"), method === "HEAD" ? "" : await r.text()];
    };
    try {
      expect(await get("/?room=canyon")).toEqual([200, "text/html; charset=utf-8", "no-cache", "<p>game</p>"]);
      expect(await get("/assets/main-1a2b.js")).toEqual([200, "text/javascript; charset=utf-8", "public, max-age=31536000, immutable", "1"]);
      expect(await get("/w/chunk.bin.gz")).toEqual([200, "application/octet-stream", "no-cache", "zz"]); // as stored: the page inflates it
      expect((await get("/../secret.txt"))[0]).toBe(404);
      expect((await get("/%2e%2e/secret.txt"))[0]).toBe(404);
      expect((await get("/w/%00"))[0]).toBe(404);
      expect((await get("/nope"))[0]).toBe(404);
      expect((await get("/", "HEAD"))[0]).toBe(200);
      expect((await get("/", "POST"))[0]).toBe(405);
    } finally {
      server.close();
    }
  });
});

describe("prediction", () => {
  it("steps inputs at once, and on the server's word puts its state back and steps the inputs it hasn't yet", () => {
    let x = 0;
    const p = new Prediction<number>((dx) => (x += dx));
    expect([p.apply(1), p.apply(2), p.apply(3)]).toEqual([1, 2, 3]);
    expect(x).toBe(6);
    // the server stepped inputs 1 and 2, but its world held the vehicle back: 2.5, not 3
    p.reconcile(2, () => (x = 2.5));
    expect(x).toBe(5.5); // 2.5, then input 3 again
    expect(p.unacknowledged).toBe(1);
    p.reconcile(3, () => (x = 5.5));
    expect([x, p.unacknowledged]).toEqual([5.5, 0]);
  });

  it("keeps at most `keep` inputs for the server", () => {
    const p = new Prediction<number>(() => {}, 3);
    for (let i = 0; i < 10; i++) p.apply(i);
    expect(p.unacknowledged).toBe(3);
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
    expect(s.time("a", 1000.14)).toBeCloseTo(0.02, 9); // when what is drawn happened, on their clock
    expect(s.time("b", 1000)).toBeNull();
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
