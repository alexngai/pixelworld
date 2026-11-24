import { describe, expect, it } from "vitest";
import { ATTACKED, CALM, OVERRUN, THREATENED, choosing, districtsOf, frontAct, frontJoined, frontLeft, frontMessage, newFront, waveDone, type FrontSite } from "../src/front";

// 72 sites on a 12 × 6 grid, 40 cells apart, named after three places
const SITES: FrontSite[] = Array.from({ length: 72 }, (_, i) => ({
  name: ["Towers near SoHo", "By the Bridge", "Brownstone blocks"][i % 3]!,
  x: (i % 12) * 40,
  y: Math.floor(i / 12) * 40,
  score: 0.5 + ((i * 7) % 10) / 100,
}));

describe("the city's front (D-179)", () => {
  it("groups the sites into named, connected districts, the same each time", () => {
    const d = districtsOf(SITES);
    expect(d.length).toBeGreaterThanOrEqual(4);
    expect(districtsOf(SITES)).toEqual(d);
    expect(d.flatMap((x) => x.sites).sort((a, b) => a - b)).toEqual(SITES.map((_, i) => i));
    expect(new Set(d.map((x) => x.name)).size).toBe(d.length);
    // every district reached from the first along neighbours
    const seen = new Set([0]);
    for (const j of seen) for (const n of d[j]!.neighbours) seen.add(n);
    expect(seen.size).toBe(d.length);
    expect(d.some((x) => x.edge) && d.some((x) => !x.edge)).toBe(true);
  });

  it("opens one more threat than there are players, in districts under pressure", () => {
    const f = newFront(SITES, { seed: 7 });
    expect(f.threats.length).toBe(2);
    expect(new Set(f.threats.map((t) => t.district)).size).toBe(2);
    for (const t of f.threats) expect(f.pressure[t.district]).toBeGreaterThan(CALM);
    // a second player joins: a third threat
    frontJoined(f, SITES, ["a", "b"]);
    expect(f.threats.length).toBe(3);
  });

  it("closes a wave once every player has fought: held calms, left alone presses harder", () => {
    const f = newFront(SITES, { seed: 3 });
    const [mine, other] = f.threats;
    expect(frontAct(f, SITES, ["a"], "a", { k: "claim", threat: mine!.id })).toBeNull();
    expect(frontAct(f, SITES, ["a"], "a", { k: "claim", threat: other!.id })).toMatch(/its block/);
    expect(frontAct(f, SITES, ["a"], "b", { k: "report", threat: mine!.id, held: true, lost: 0, razed: [] })).toMatch(/isn't yours/);
    frontAct(f, SITES, ["a"], "a", { k: "report", threat: mine!.id, held: true, lost: 0, razed: [5, 9] });
    expect(f.wave).toBe(2);
    expect(f.pressure[mine!.district]).toBe(CALM);
    expect(f.pressure[other!.district]).toBe(ATTACKED);
    expect(f.razed).toEqual([5, 9]);
    expect(f.trust).toBe(7);
    // the district pressed hardest is offered again
    expect(f.threats.some((t) => t.district === other!.district)).toBe(true);
    expect(f.news.some((n) => /left alone/.test(n))).toBe(true);
  });

  it("a district left alone is overrun: trust lost, a calm neighbour threatened", () => {
    const f = newFront(SITES, { seed: 11 });
    const ignored = f.threats[1]!.district;
    for (let w = 0; w < 2; w++) {
      const t = f.threats.find((x) => x.district !== ignored)!;
      frontAct(f, SITES, ["a"], "a", { k: "claim", threat: t.id });
      frontAct(f, SITES, ["a"], "a", { k: "report", threat: t.id, held: true, lost: 0, razed: [] });
    }
    expect(f.pressure[ignored]).toBe(OVERRUN);
    expect(f.trust).toBe(5);
    expect(f.news.find((n) => /overrun/.test(n))).toMatch(/spreads to/);
    expect(f.threats.every((t) => t.district !== ignored)).toBe(true);
  });

  it("waits for every player, lets go of a leaver's block, and ends held or lost", () => {
    const f = newFront(SITES, { seed: 5, players: 2 });
    const [a, b] = f.threats;
    frontAct(f, SITES, ["p", "q"], "p", { k: "claim", threat: a!.id });
    frontAct(f, SITES, ["p", "q"], "q", { k: "claim", threat: b!.id });
    frontAct(f, SITES, ["p", "q"], "p", { k: "report", threat: a!.id, held: false, lost: 3, razed: [] });
    expect(waveDone(f, ["p", "q"])).toBe(false);
    expect(f.wave).toBe(1);
    // q leaves without fighting: the wave closes on p's fight alone
    frontLeft(f, SITES, ["p"], "q");
    expect(f.wave).toBe(2);
    expect(f.trust).toBe(8);
    expect(f.pressure[a!.district]).toBe(THREATENED);
    // the rest fought and held
    while (!f.over) {
      const t = f.threats[0]!;
      frontAct(f, SITES, ["p"], "p", { k: "claim", threat: t.id });
      frontAct(f, SITES, ["p"], "p", { k: "report", threat: t.id, held: true, lost: 0, razed: [] });
    }
    expect(f.wave).toBe(4);
    expect(f.trust).toBeGreaterThan(0);
    // losing every fight loses the city
    const g = newFront(SITES, { seed: 5, trust: 2 });
    while (!g.over) {
      const t = g.threats[0]!;
      frontAct(g, SITES, ["p"], "p", { k: "claim", threat: t.id });
      frontAct(g, SITES, ["p"], "p", { k: "report", threat: t.id, held: false, lost: 4, razed: [] });
    }
    expect(g.over).toBe("lost");
  });

  it("lets a squad sit a wave out (D-182): the wave waits only on those choosing", () => {
    const f = newFront(SITES, { seed: 9, players: 2 });
    const [a] = f.threats;
    frontAct(f, SITES, ["p", "q"], "p", { k: "claim", threat: a!.id });
    expect(choosing(f, ["p", "q"])).toEqual(["q"]);
    frontAct(f, SITES, ["p", "q"], "p", { k: "report", threat: a!.id, held: true, lost: 0, razed: [] });
    expect(f.wave).toBe(1);
    expect(frontAct(f, SITES, ["p", "q"], "p", { k: "pass" })).toMatch(/its block/);
    frontAct(f, SITES, ["p", "q"], "q", { k: "pass" });
    expect(f.wave).toBe(2);
    expect(f.passed).toEqual([]);
    // a squad that sat out can't then take one
    frontAct(f, SITES, ["p", "q"], "q", { k: "pass" });
    expect(frontAct(f, SITES, ["p", "q"], "q", { k: "claim", threat: f.threats[0]!.id })).toMatch(/sits this wave out/);
    // nobody left: the wave doesn't close on its own
    expect(waveDone(f, [])).toBe(false);
  });

  it("checks what a page sends", () => {
    expect(frontMessage({ k: "claim", threat: 3 })).toEqual({ k: "claim", threat: 3 });
    expect(frontMessage({ k: "claim", threat: "3" })).toBeNull();
    expect(frontMessage({ k: "report", threat: 1, held: true, lost: -2, razed: [1, -1, 2.5, "x", 4] })).toEqual({ k: "report", threat: 1, held: true, lost: 0, razed: [1, 4] });
    expect(frontMessage({ k: "nuke", threat: 1 })).toBeNull();
    expect(frontMessage({ k: "pass" })).toEqual({ k: "pass" });
  });
});
