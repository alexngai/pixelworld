import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { Reader, Replica, Replicator, SERVER, Schema, TickClient, Writer, angle, bool, fixed, int, joinRoom, str, type ReplicaUpdate, type TickRoster } from "../src/index";
import { TickRoom, attachRelay, type TickRole } from "../src/server";
import { loopback } from "../src/testing";

/** Compact binary for what a room sends often (D-123). */

interface Dot {
  x: number;
  y: number;
  hd: number;
  hp: number;
  on: boolean;
  tag: string;
}
const DOT = new Schema<Dot>({ x: fixed(1 / 64), y: fixed(1 / 64), hd: angle(), hp: int, on: bool, tag: str });
const dot = (x: number, y = 0, more: Partial<Dot> = {}): Dot => ({ x, y, hd: 0, hp: 100, on: true, tag: "a", ...more });

describe("the codec (D-123)", () => {
  it("writes whole numbers in as few bytes as they need, either sign, exact to 2^53", () => {
    const w = new Writer();
    const values = [0, 1, -1, 63, -64, 64, 300, -300, 2 ** 31, -(2 ** 31), 2 ** 52, -(2 ** 52)];
    for (const v of values) w.int(v);
    w.str("héllo");
    const r = new Reader(w.done());
    expect(values.map(() => r.int())).toEqual(values);
    expect(r.str()).toBe("héllo");
    expect(r.done).toBe(true);
    const one = new Writer();
    one.int(-64);
    expect(one.length).toBe(1);
    expect(() => new Reader(new Uint8Array([0x80])).uint()).toThrow("cut short");
  });

  it("rounds each field to its step, and writes a state whole or as what changed, an angle the short way round", () => {
    const a = DOT.wire(dot(10.004, -3.5, { hd: -0.03 })); // a step and a bit below 0: the last step of the turn
    expect(DOT.value(a)).toEqual({ x: 10, y: -3.5, hd: (-1 / 256) * 2 * Math.PI, hp: 100, on: true, tag: "a" });
    const full = new Writer();
    DOT.writeFull(full, a);
    expect(DOT.readFull(new Reader(full.done()))).toEqual(a);
    const b = DOT.wire(dot(10.1, -3.5, { hd: 0.02, on: false, tag: "b" }));
    const diff = new Writer();
    DOT.writeDiff(diff, b, a);
    expect(DOT.readDiff(new Reader(diff.done()), a)).toEqual(b);
    // x moved 6 steps, hd 2 steps across 0, the flag flipped, the text changed: mask, 1, 1, and the text's 2
    expect(diff.length).toBe(1 + 1 + 1 + 2);
    const same = new Writer();
    DOT.writeDiff(same, a, a);
    expect(same.length).toBe(1); // nothing changed: the mask alone
  });
});

describe("replicating to groups of pages (D-123)", () => {
  /** A replicator over `states`, `view` per group, and what each page reads. */
  function setup(view?: (g: string | undefined) => { near: string[]; far?: string[] }) {
    const states = new Map<string, Dot>();
    const rep = new Replicator(DOT, { states: () => states, view, farEvery: 2 });
    const pages = new Map<string, Replica<Dot>>();
    const got = new Map<string, ReplicaUpdate<Dot>[]>();
    let writes = 0;
    const send = (groups: Record<string, string[]>, tick = 1) => {
      const m = new Map(Object.entries(groups).map(([g, ids]) => [g === "-" ? undefined : g, ids] as const));
      rep.send(tick, m, (g) => ({ g: g ?? null }), (data, to) => {
        writes++;
        for (const p of to) {
          let r = pages.get(p);
          if (!r) pages.set(p, (r = new Replica(DOT)));
          const u = r.read(data);
          got.set(p, [...(got.get(p) ?? []), u]);
        }
      });
    };
    const lastOf = (p: string) => got.get(p)!.at(-1)!;
    return { states, rep, pages, send, lastOf, writes: () => writes };
  }

  it("sends a page new to its group a keyframe, then the changes, each thing's state written once whatever the groups", () => {
    const { states, rep, send, lastOf, pages } = setup((g) => ({ near: g === "east" ? ["b"] : ["a", "b"] }));
    states.set("a", dot(1)).set("b", dot(2));
    const whole = vi.spyOn(DOT, "writeFull");
    send({ west: ["p1", "p2"], east: ["p3"] });
    expect(whole).toHaveBeenCalledTimes(2); // b, in both groups' keyframes, written once
    whole.mockRestore();
    expect(lastOf("p1")).toMatchObject({ keyframe: true, gone: [], extras: { g: "west" } });
    expect(lastOf("p1").states.map(([id]) => id)).toEqual(["a", "b"]);
    expect(lastOf("p3").states.map(([id]) => id)).toEqual(["b"]);
    const keyframeBytes = rep.last.bytes;
    states.set("a", dot(1.5));
    send({ west: ["p1", "p2"], east: ["p3"] });
    expect(lastOf("p1").keyframe).toBe(false);
    expect(lastOf("p1").states).toEqual([["a", dot(1.5)], ["b", dot(2)]]);
    expect(rep.last.bytes).toBeLessThan(keyframeBytes);
    expect(pages.get("p1")!.ids()).toEqual(["a", "b"]);
  });

  it("drops what leaves a group's view, sends far things every few snapshots, and a keyframe to a page that changed group or was skipped", () => {
    let near = ["a"];
    const { states, send, lastOf } = setup(() => ({ near, far: ["c"] }));
    states.set("a", dot(1)).set("b", dot(2)).set("c", dot(3));
    send({ g: ["p1"] }); // snapshot 1: a keyframe with the far one too
    expect(lastOf("p1").states.map(([id]) => id)).toEqual(["a", "c"]);
    send({ g: ["p1"] }); // 2: a far tick (every 2nd)
    expect(lastOf("p1").states.map(([id]) => id)).toEqual(["a", "c"]);
    send({ g: ["p1"] }); // 3: near only
    expect(lastOf("p1").states.map(([id]) => id)).toEqual(["a"]);
    near = ["b"];
    send({ g: ["p1"] });
    expect(lastOf("p1")).toMatchObject({ keyframe: false, gone: ["a"] });
    states.delete("c"); // gone from the game
    send({ g: ["p1"] });
    expect(lastOf("p1").gone).toEqual(["c"]);
    send({ h: ["p1"] }); // into another group
    expect(lastOf("p1").keyframe).toBe(true);
    send({}); // skipped (backed up)
    send({ h: ["p1"] });
    expect(lastOf("p1").keyframe).toBe(true);
  });
});

/** A toy room replicating its dots, with a roster. */
class Dots extends TickRoom<number, string> {
  readonly dots = new Map<string, Dot>();
  names: Record<string, string> = {};
  constructor(...args: ConstructorParameters<typeof TickRoom<number, string>>) {
    super(...args);
    this.replicator = new Replicator(DOT, { states: () => this.dots }) as unknown as Replicator<object>;
  }
  protected parseJoin = (d: unknown) => String(d);
  protected added(id: string, j: string): TickRole {
    this.dots.set(id, dot(this.dots.size));
    this.names[id] = j;
    return "player";
  }
  protected removed(id: string) {
    this.dots.delete(id);
    delete this.names[id];
  }
  protected input = (d: unknown) => (typeof d === "number" ? d : null);
  protected step(id: string, dx: number) {
    this.dots.get(id)!.x += dx;
  }
  protected override shared() {
    return { phase: "play" };
  }
  protected override roster() {
    return { names: this.names };
  }
}

describe("a room in binary, with a roster (D-123)", () => {
  it("gives each page the others decoded, and the roster when it changes and as a page connects", () => {
    const lb = loopback((room) => new Dots(room, { clock: false }));
    const pages = ["ann", "bo"].map((name, n) => {
      const page = lb.join(0.05);
      const seen = { others: new Map<string, Dot>(), rosters: [] as (TickRoster & Record<string, unknown>)[], phase: "" };
      const client = new TickClient<number, unknown, { phase: string }, unknown, Dot>(page.room, {
        tick: lb.host.tickLength,
        schema: DOT,
        onWorld: (w) => {
          seen.phase = w.phase;
          for (const [id, s] of w.entities!.states) seen.others.set(id, s);
          for (const id of w.entities!.gone) seen.others.delete(id);
        },
        onRoster: (r) => seen.rosters.push(r),
        now: lb.now,
      });
      client.hello(name);
      return { page, client, seen, n };
    });
    lb.run(1, (dt) => pages.forEach((p) => p.client.advance(dt, () => (p.n ? 0.01 : 0))));
    const [ann, bo] = pages;
    expect(ann!.seen.phase).toBe("play");
    expect([...ann!.seen.others.keys()].sort()).toEqual(["1", "2"]);
    expect(ann!.seen.others.get("2")!.x).toBeCloseTo(lb.host.dots.get("2")!.x, 1);
    expect(ann!.seen.rosters.at(-1)!.names).toEqual({ "1": "ann", "2": "bo" });
    // binary world messages, and a roster only when it changed
    const worlds = bo!.page.received.filter((m) => m instanceof Uint8Array);
    expect(worlds.length).toBeGreaterThan(15);
    expect(bo!.page.received.filter((m) => (m as TickRoster).k === "roster").length).toBeLessThanOrEqual(2);
    // a page connecting late gets the roster at once
    const late = lb.join(0.05);
    lb.run(0.2);
    expect(late.received.find((m) => (m as TickRoster).k === "roster")).toMatchObject({ names: { "1": "ann", "2": "bo" } });
  });
});

describe("binary frames through the relay (D-123)", () => {
  it("sends a hosted game's bytes as a binary frame, which a page reads as bytes, beside its JSON", async () => {
    const server = createServer().listen(0);
    await new Promise((r) => server.once("listening", r));
    const relay = attachRelay(server, {
      host: (room) => ({
        message: (id) => {
          room.send(id, new Uint8Array([1, 2, 3]));
          room.broadcast({ k: "json" });
        },
      }),
    });
    const page = await joinRoom(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/relay`, "r");
    const got: unknown[] = [];
    const two = new Promise<void>((done) => {
      page.onMessage = (from, data) => {
        if (from === SERVER) got.push(data);
        if (got.length === 2) done();
      };
    });
    page.send({ hi: 1 });
    await two;
    expect(got[0]).toBeInstanceOf(Uint8Array);
    expect([...(got[0] as Uint8Array)]).toEqual([1, 2, 3]);
    expect(got[1]).toEqual({ k: "json" });
    page.close();
    relay.close();
    server.close();
  });
});
