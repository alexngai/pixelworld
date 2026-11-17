import { readFileSync } from "node:fs";
import { Boards, openWorld } from "@pixelworlds/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  arenaFromBoard,
  mechanicsOf,
  A_BURNS,
  A_WATER,
  act,
  cloneCombat,
  endRound,
  generatePuzzle,
  greedyTurn,
  newCombat,
  outcome,
  planInvaders,
  playOut,
  resolveInvaders,
  solveTurn,
  strike,
  type Arena,
  type CombatEvent,
  type FighterKind,
} from "../src/index";

/**
 * Turn-based combat (D-150): the rules on small arenas drawn as text, the
 * turn solver, and the puzzles it makes.
 *
 *   .  open ground      ~  water        *  lawn (burns)
 *   #  a building (1 hp, 100 people)    w  a wooden house (1 hp, catches fire from beside)
 */
function arena(rows: string[]): Arena {
  const h = rows.length;
  const w = rows[0]!.length;
  const a: Arena = { w, h, flags: new Uint8Array(w * h), height: new Float32Array(w * h), struct: new Int16Array(w * h).fill(-1), structures: [], climb: 1, fall: 2 };
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const k = y * w + x;
      if (ch === "~") a.flags[k] = A_WATER;
      if (ch === "*") a.flags[k] = A_BURNS;
      if (ch === "#" || ch === "w") {
        a.struct[k] = a.structures.length;
        a.structures.push({ object: -1, name: ch, hp: 1, people: 100, flammable: ch === "w" });
      }
    }),
  );
  return a;
}
const cell = (a: Arena, x: number, y: number) => y * a.w + x;
const units = (a: Arena, list: [FighterKind, number, number][]) => list.map(([kind, x, y]) => ({ kind, at: cell(a, x, y) }));
const WEST = 3;
const NORTH = 0;
const EAST = 1;
const SOUTH = 2;

describe("the rules (D-150)", () => {
  it("a shot strikes the first thing on its line and pushes it on: into water a walker drowns, a flyer hovers", () => {
    const a = arena(["..~."]);
    const walker = newCombat(a, units(a, [["pumper", 0, 0], ["crawler", 1, 0]]));
    const log: CombatEvent[] = [];
    strike(walker, 0, { dir: EAST, range: 1 }, log);
    expect(log.map((e) => e.t)).toEqual(["strike", "damage", "push", "damage", "down"]);
    expect(log.at(-1)).toEqual({ t: "down", unit: 1, at: cell(a, 2, 0), drowned: true });
    const flyer = newCombat(a, units(a, [["pumper", 0, 0], ["flyer", 1, 0]]));
    strike(flyer, 0, { dir: EAST, range: 1 });
    expect([flyer.hp[1], flyer.pos[1]]).toEqual([1, cell(a, 2, 0)]);
  });

  it("a push into a unit hurts both; into a building, the unit and the building, and its people are lost", () => {
    const a = arena(["...#"]);
    const c = newCombat(a, units(a, [["wrecker", 0, 0], ["brute", 1, 0], ["crawler", 2, 0]]));
    strike(c, 0, { dir: EAST, range: 1 });
    expect([c.hp[1], c.hp[2]]).toEqual([1, 2]); // the brute (4): 2 from the ram, 1 from the bump; the crawler (3): the bump
    const b = arena(["..#"]);
    const d = newCombat(b, units(b, [["wrecker", 0, 0], ["brute", 1, 0]]));
    strike(d, 0, { dir: EAST, range: 1 });
    expect([d.hp[1], d.structHp[0], d.razed, d.lost]).toEqual([1, 0, 1, 100]);
  });

  it("a lob strikes over what is between, and pushes what stands round its target outward (the arena's edge holds)", () => {
    const a = arena([".......", "......."]);
    const c = newCombat(a, units(a, [["crane", 0, 0], ["crawler", 2, 0], ["brute", 3, 0], ["crawler", 4, 0], ["brute", 3, 1]]));
    strike(c, 0, { dir: EAST, range: 3 });
    expect(c.hp[2]).toBe(3);
    expect([c.pos[1], c.pos[3], c.pos[4]]).toEqual([cell(a, 1, 0), cell(a, 5, 0), cell(a, 3, 1)]);
    expect([c.hp[1], c.hp[3], c.hp[4]]).toEqual([3, 3, 4]);
  });

  it("an invader strikes as it aimed from wherever it stands then: pushed off its line it misses, or strikes its own", () => {
    const a = arena(["....", "#...", "...."]);
    const c = newCombat(a, units(a, [["crawler", 1, 1], ["pumper", 1, 0]]));
    planInvaders(c);
    expect(c.aim[0]).toBe(WEST); // at the building
    expect(playOut(c).razed).toBe(1);
    act(c, 1, cell(a, 1, 0), { dir: SOUTH, range: 1 }); // the pumper shoots it south, a row down
    expect(c.pos[0]).toBe(cell(a, 1, 2));
    expect(playOut(c).razed).toBe(0); // its bite lands west of where it stands now: on open ground
    // with a brute standing there, the bite takes the brute
    const d = newCombat(a, units(a, [["crawler", 1, 2], ["brute", 0, 2]]));
    d.aim[0] = WEST;
    resolveInvaders(d);
    expect(d.hp[1]).toBe(3);
  });

  it("invaders strike in order: a later one's slam lands on an earlier one", () => {
    const a = arena(["#...", "...."]);
    const c = newCombat(a, units(a, [["crawler", 1, 0], ["brute", 1, 1]]));
    c.aim[0] = WEST;
    c.aim[1] = NORTH;
    resolveInvaders(c);
    expect([c.razed, c.hp[0]]).toEqual([1, 1]); // the crawler bit first; the slam then took 2 of its 3
  });

  it("a spit sets the lawn it lands on alight; fire burns who stands there and the wooden house beside it; a pumper's shot puts it out", () => {
    const a = arena(["w*..", "...."]);
    const c = newCombat(a, units(a, [["flyer", 3, 0], ["pumper", 1, 0], ["pumper", 1, 1]]));
    c.aim[0] = WEST; // the first thing west is the pumper on the lawn
    resolveInvaders(c);
    expect([c.hp[1], c.fire[cell(a, 1, 0)]]).toEqual([2, 1]);
    const burnt = cloneCombat(c);
    endRound(burnt);
    expect([burnt.hp[1], burnt.structHp[0]]).toEqual([1, 0]);
    act(c, 2, cell(a, 1, 1), { dir: NORTH, range: 1 }); // the other pumper shoots the burning one: the fire goes out
    expect(c.fire[cell(a, 1, 0)]).toBe(0);
    endRound(c);
    expect(c.structHp[0]).toBe(1);
  });
});

describe("the turn solver (D-150)", () => {
  // a brute beside a building: it takes all 4 of the squad's damage to bring down, and pushing it west breaks the building
  const a = arena(["#.....", "......", "......", "......"]);
  const position = () => {
    const c = newCombat(a, units(a, [["wrecker", 1, 3], ["pumper", 4, 3], ["crane", 5, 3], ["brute", 1, 0]]));
    c.aim[3] = WEST;
    return c;
  };

  it("finds the turns that lose nobody, each playing out as found: here all three strikes, the pushing one last", () => {
    const c = position();
    expect(playOut(c).razed).toBe(1); // left alone, the building falls
    const res = solveTurn(c);
    expect(res.complete).toBe(true);
    expect(res.perfect.length).toBeGreaterThan(0);
    expect(res.minStrikes).toBe(3);
    expect(res.perfectLeaves).toBeLessThan(res.leaves);
    for (const s of res.perfect) {
      const d = cloneCombat(c);
      for (const x of s.plan) act(d, x.unit, x.dest, x.strike);
      expect(outcome(c, playOut(d)).perfect).toBe(true);
      expect(d.hp[3]).toBe(0);
    }
  });

  it("finds nothing perfect where nobody can reach in time, but still the best it can do", () => {
    const far = arena(["#.........", ".........."]);
    const c = newCombat(far, units(far, [["crawler", 1, 0], ["wrecker", 9, 1]]));
    planInvaders(c);
    const res = solveTurn(c, { mode: "best" });
    expect(res.perfect).toEqual([]);
    expect(res.best!.outcome.razed).toBe(1);
  });

  it("the greedy player plays each rig's best on its own, in turn", () => {
    const g = greedyTurn(position());
    expect(g.plan.map((x) => x.unit)).toEqual([0, 1, 2]);
    expect(Number.isFinite(g.outcome.score)).toBe(true);
  });
});

describe("puzzles (D-150)", () => {
  // streets by a river: buildings, a park, water, a wooden house
  const a = arena([
    "##..#...",
    "#...#.**",
    "...#..**",
    "~~......",
    "~~..##..",
    "...#....",
    "#.....~~",
    "##...w~~",
  ]);

  it("are solvable, not solved by the greedy player, and come out the same from the same seed", async () => {
    const opts = { seed: 7, attempts: 80, timeMs: 20_000, target: 3, clever: false };
    const p = await generatePuzzle(a, opts);
    expect(p).not.toBeNull();
    const d = cloneCombat(p!.combat);
    for (const x of p!.solution.plan) act(d, x.unit, x.dest, x.strike);
    expect(outcome(p!.combat, playOut(d)).perfect).toBe(true);
    expect(greedyTurn(p!.combat).outcome.perfect).toBe(false);
    expect(p!.difficulty).toBeGreaterThan(0);
    const again = await generatePuzzle(a, opts);
    expect(Array.from(again!.combat.pos)).toEqual(Array.from(p!.combat.pos));
  }, 60_000);
});

describe("what a turn takes (D-150)", () => {
  it("names the mechanics a plan uses: an invader pushed off its line, invaders turned on their own", () => {
    const a = arena(["....", "#...", "...."]);
    const c = newCombat(a, units(a, [["crawler", 1, 1], ["pumper", 1, 0]]));
    planInvaders(c);
    expect(mechanicsOf(c, [{ unit: 1, dest: cell(a, 1, 0), strike: { dir: SOUTH, range: 1 } }])).toEqual(["redirect"]);
    // shot south, the crawler lands on the brute's line: its bite misses the building, and the brute's slam takes it
    const d = newCombat(a, units(a, [["crawler", 1, 1], ["brute", 2, 2], ["pumper", 1, 0]]));
    d.aim[0] = WEST;
    d.aim[1] = WEST;
    expect(mechanicsOf(d, [{ unit: 2, dest: cell(a, 1, 0), strike: { dir: SOUTH, range: 1 } }]).sort()).toEqual(["redirect", "turn"]);
  });
});

describe("on a real city's board (D-150)", () => {
  const ROOT = new URL("../../../", import.meta.url);
  const style = (id: string) => JSON.parse(readFileSync(new URL(`worlds/_styles/${id}/style.json`, ROOT), "utf8")) as object;
  afterEach(() => void vi.unstubAllGlobals());

  it("makes an arena of Lower Manhattan's buildings, people and streets, and a clever puzzle on it", async () => {
    vi.stubGlobal("fetch", async (url: string | URL) => {
      try {
        return new Response(readFileSync(new URL(`fixtures${new URL(String(url)).pathname}`, ROOT)));
      } catch {
        return new Response("not found", { status: 404 });
      }
    });
    const w = await openWorld({ worldUrl: "nyc-walk/", base: "https://pixelworld.test/", style });
    const [x, y] = w.query.lonLatToCell(-74.0125, 40.7055)!;
    const board = await new Boards(w).add({ x0: Math.floor(x) - 8, y0: Math.floor(y) - 8, w: 8, h: 8, cell: 2 });
    const a = arenaFromBoard(board, w.query, w.world.manifest.surfaces, { metersPerCell: 10 });
    expect(a.structures.length).toBeGreaterThan(10);
    expect(a.structures.every((s) => s.object >= 0 && s.hp >= 1 && s.hp <= 4)).toBe(true);
    expect(a.structures.reduce((n, s) => n + s.people, 0)).toBeGreaterThan(5000);
    const p = await generatePuzzle(a, { seed: 1, timeMs: 15_000, attempts: 300 });
    expect(p).not.toBeNull();
    expect(p!.mechanics.some((m) => m !== "kill")).toBe(true);
    const d = cloneCombat(p!.combat);
    for (const x of p!.solution.plan) act(d, x.unit, x.dest, x.strike);
    expect(outcome(p!.combat, playOut(d)).perfect).toBe(true);
    expect(greedyTurn(p!.combat).outcome.perfect).toBe(false);
  }, 60_000);
});
