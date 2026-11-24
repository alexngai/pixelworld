import type { HostedRoom } from "@pixelworlds/multiplayer/server";
import { CALM, newCombat, planInvaders, toWire, type Arena } from "@pixelworlds/tactics";
import { describe, expect, it, vi } from "vitest";
import type { CoopOut } from "../src/coop";
import { CHOOSE_MS, CoopRoom } from "../src/coopServer";

/** A row of open ground with a low building (100 people) at its fifth cell. */
const ROW: Arena = (() => {
  const n = 6;
  const a: Arena = { w: n, h: 1, flags: new Uint8Array(n), height: new Float32Array(n), roof: new Float32Array(n), struct: new Int16Array(n).fill(-1), structures: [], metersPerStep: 3, climb: 1, fall: 2, reach: 2 };
  a.struct[4] = 0;
  a.roof[4] = 2;
  a.structures.push({ object: -1, name: "#", hp: 1, people: 100, flammable: false, cells: [4], topple: 0 });
  return a;
})();

/**
 * A fight as a page reports it (D-186): held, a rig with no invader about (it
 * ends after a turn); lost, a brute beside the building, left to strike it for
 * the fight's three rounds.
 */
function fought(threat: number, held: boolean, razed: number[] = []) {
  const start = newCombat(ROW, held ? [{ kind: "wrecker", at: 0 }] : [{ kind: "wrecker", at: 0 }, { kind: "brute", at: 3 }]);
  planInvaders(start);
  return { k: "fought", threat, start: toWire(start), turns: held ? [[]] : [[], [], []], razed };
}

/** A co-op room (D-179) with pages that only listen: what it broadcast last, and what it sent each one. */
function room() {
  const sent: Record<string, CoopOut[]> = {};
  const kicked: Record<string, string> = {};
  let last: Extract<CoopOut, { k: "front" }> | null = null;
  const hosted = {
    name: "TEST",
    settings: undefined,
    isPublic: false,
    send: (to: string, d: unknown) => (sent[to] ??= []).push(JSON.parse(JSON.stringify(d)) as CoopOut),
    broadcast: (d: unknown) => void (last = JSON.parse(JSON.stringify(d)) as typeof last),
    players: () => [],
    kick: (id: string, why: string) => void (kicked[id] = why),
    close() {},
    fail(e: unknown) {
      throw e;
    },
    log() {},
  } satisfies HostedRoom;
  return { host: new CoopRoom(hosted), sent, kicked, last: () => last! };
}

describe("co-op rooms (D-179)", () => {
  it("defends one city with every squad: a threat each and one more, a wave closed when all have fought", () => {
    const r = room();
    r.host.message("a", { k: "hello", world: "nyc-walk", name: "Ana", squad: "Fire Brigade" });
    expect(r.last().front.threats.length).toBe(2);
    r.host.message("b", { k: "hello", world: "nyc-walk", name: "Bo<b>", squad: "Heavy Works" });
    const f = r.last().front;
    expect(f.threats.length).toBe(3);
    expect(f.trust).toBe(9);
    expect(r.last().crews.b).toEqual({ name: "Bob", squad: "Heavy Works" });
    // another city is turned away
    r.host.message("c", { k: "hello", world: "kyoto-walk", name: "Cy", squad: "x" });
    expect(r.kicked.c).toMatch(/another city/);

    const [ta, tb] = f.threats;
    r.host.message("a", { k: "claim", threat: ta!.id });
    r.host.message("b", { k: "claim", threat: ta!.id });
    expect(r.sent.b?.at(-1)).toEqual({ k: "no", why: "another squad is on it" });
    r.host.message("b", { k: "claim", threat: tb!.id });
    r.host.message("a", fought(ta!.id, true, [12, 40]));
    expect(r.last().front.wave).toBe(1);
    // nonsense is dropped
    r.host.message("b", { k: "report", threat: tb!.id, held: true, lost: 0, razed: [] });
    expect(r.sent.b?.at(-1)).toEqual({ k: "no", why: "a fight is reported by its moves" });
    r.host.message("b", { ...fought(tb!.id, true), turns: [[{ unit: 0, dest: 5, strike: null }]] });
    expect(r.sent.b?.at(-1)).toEqual({ k: "no", why: "that fight doesn't replay" });
    expect(r.last().front.wave).toBe(1);
    r.host.message("b", fought(tb!.id, false, [40, 41]));
    const g = r.last().front;
    expect(g.wave).toBe(2);
    expect(g.razed).toEqual([12, 40, 41]);
    expect(g.pressure[ta!.district]).toBe(CALM);
    expect(g.trust).toBe(8);
  });

  it("lets go of a leaver's block, and the wave goes on without them", () => {
    const r = room();
    r.host.message("a", { k: "hello", world: "sf-walk", name: "Ana", squad: "Demolition Crew" });
    r.host.message("b", { k: "hello", world: "sf-walk", name: "Bo", squad: "Demolition Crew" });
    const [ta, tb] = r.last().front.threats;
    r.host.message("a", { k: "claim", threat: ta!.id });
    r.host.message("b", { k: "claim", threat: tb!.id });
    r.host.message("a", fought(ta!.id, true));
    r.host.leave("b");
    expect(r.last().front.wave).toBe(2);
    expect(Object.keys(r.last().crews)).toEqual(["a"]);
  });

  it("gives the squads still choosing a while once one has chosen, then sits them out (D-182)", () => {
    vi.useFakeTimers();
    const r = room();
    r.host.message("a", { k: "hello", world: "sf-walk", name: "Ana", squad: "Demolition Crew" });
    r.host.message("b", { k: "hello", world: "sf-walk", name: "Bo", squad: "Demolition Crew" });
    expect(r.last().choose).toBeNull();
    const [ta] = r.last().front.threats;
    r.host.message("a", { k: "claim", threat: ta!.id });
    expect(r.last().choose).toBe(CHOOSE_MS);
    vi.advanceTimersByTime(CHOOSE_MS);
    expect(r.last().front.passed).toEqual(["b"]);
    expect(r.last().choose).toBeNull();
    r.host.message("a", fought(ta!.id, true));
    expect(r.last().front.wave).toBe(2);
    r.host.close();
    vi.useRealTimers();
  });
});
