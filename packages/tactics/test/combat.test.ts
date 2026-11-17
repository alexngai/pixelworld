import { readFileSync } from "node:fs";
import { Boards, openWorld } from "@pixelworlds/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  A_BURNS,
  A_WATER,
  act,
  arenaFromBoard,
  cloneCombat,
  endRound,
  generatePuzzle,
  greedyTurn,
  mechanicsOf,
  movesOf,
  newCombat,
  outcome,
  planInvaders,
  playOut,
  resolveInvaders,
  solveFight,
  solveTurn,
  standAt,
  strike,
  type Arena,
  type CombatEvent,
  type FighterKind,
  type Strike,
} from "../src/index";

/**
 * Turn-based combat (D-150, D-151): the rules on small arenas drawn as text,
 * the turn solver, and the puzzles it makes. A step is 3 m: rigs climb 15 m,
 * brutes 4 m, crawlers any wall; a fall hurts a point every 2 steps; melee
 * reaches 2 steps up or down.
 *
 *   .  open ground      ~  water        *  lawn (burns)
 *   #  a low building: roof 2 steps (6 m), 1 hp, 100 people
 *   w  a wooden house: the same, and fire beside it burns it
 *   H  a tower: roof 30 steps (90 m), 2 hp, 1,000 people; it topples 3 cells
 * Neighbouring cells of one letter are one structure.
 */
function arena(rows: string[]): Arena {
  const h = rows.length;
  const w = rows[0]!.length;
  const n = w * h;
  const a: Arena = {
    w,
    h,
    flags: new Uint8Array(n),
    height: new Float32Array(n),
    roof: new Float32Array(n),
    struct: new Int16Array(n).fill(-1),
    structures: [],
    metersPerStep: 3,
    climb: 1,
    fall: 2,
    reach: 2,
  };
  const ch = (k: number) => rows[Math.floor(k / w)]![k % w]!;
  for (let k = 0; k < n; k++) {
    if (ch(k) === "~") a.flags[k] = A_WATER;
    if (ch(k) === "*") a.flags[k] = A_BURNS;
    if (!"#wH".includes(ch(k)) || a.struct[k]! >= 0) continue;
    const tower = ch(k) === "H";
    const id = a.structures.length;
    a.structures.push({ object: -1, name: ch(k), hp: tower ? 2 : 1, people: tower ? 1000 : 100, flammable: ch(k) === "w", cells: [], topple: tower ? 3 : 0 });
    // the structure: this cell and its neighbours of the same letter
    const queue = [k];
    a.struct[k] = id;
    for (let q = 0; q < queue.length; q++) {
      const c = queue[q]!;
      a.structures[id]!.cells.push(c);
      a.roof[c] = tower ? 30 : 2;
      for (const nb of [c - w, c + w, c % w ? c - 1 : -1, (c + 1) % w ? c + 1 : -1])
        if (nb >= 0 && nb < n && a.struct[nb] === -1 && ch(nb) === ch(k)) {
          a.struct[nb] = id;
          queue.push(nb);
        }
    }
  }
  return a;
}
const cell = (a: Arena, x: number, y: number) => y * a.w + x;
const units = (a: Arena, list: [FighterKind, number, number][]) => list.map(([kind, x, y]) => ({ kind, at: cell(a, x, y) }));
const NORTH = 0;
const EAST = 1;
const SOUTH = 2;
const WEST = 3;
/** A strike with a fighter's first weapon, unless said. */
const S = (dir: number, range = 1, weapon = 0, to?: number): Strike => ({ weapon, dir, range, ...(to !== undefined ? { to } : {}) });
const HOIST = 1;
const EVACUATE = (k: FighterKind) => (k === "crane" ? 2 : 1);

describe("the rules (D-150)", () => {
  it("a shot strikes the first thing on its line and pushes it on: into water a walker drowns, a flyer hovers", () => {
    const a = arena(["..~."]);
    const walker = newCombat(a, units(a, [["pumper", 0, 0], ["crawler", 1, 0]]));
    const log: CombatEvent[] = [];
    strike(walker, 0, S(EAST), log);
    expect(log.map((e) => e.t)).toEqual(["strike", "damage", "push", "damage", "down"]);
    expect(log.at(-1)).toEqual({ t: "down", unit: 1, at: cell(a, 2, 0), drowned: true });
    const flyer = newCombat(a, units(a, [["pumper", 0, 0], ["flyer", 1, 0]]));
    strike(flyer, 0, S(EAST));
    expect([flyer.hp[1], flyer.pos[1]]).toEqual([1, cell(a, 2, 0)]);
  });

  it("a push into a unit hurts both; up a building's wall, the unit and the building, and its people are lost", () => {
    const a = arena(["...#"]);
    const c = newCombat(a, units(a, [["wrecker", 0, 0], ["brute", 1, 0], ["crawler", 2, 0]]));
    strike(c, 0, S(EAST));
    expect([c.hp[1], c.hp[2]]).toEqual([1, 2]); // the brute (4): 2 from the ram, 1 from the bump; the crawler (3): the bump
    const b = arena(["..#"]);
    const d = newCombat(b, units(b, [["wrecker", 0, 0], ["brute", 1, 0]]));
    strike(d, 0, S(EAST));
    expect([d.hp[1], d.structHp[0], d.razed, d.lost]).toEqual([1, 0, 1, 100]);
  });

  it("a lob strikes over what is between, and pushes what stands round its target outward (the arena's edge holds)", () => {
    const a = arena([".......", "......."]);
    const c = newCombat(a, units(a, [["crane", 0, 0], ["crawler", 2, 0], ["brute", 3, 0], ["crawler", 4, 0], ["brute", 3, 1]]));
    strike(c, 0, S(EAST, 3));
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
    act(c, 1, cell(a, 1, 0), S(SOUTH)); // the pumper shoots it south, a row down
    expect(c.pos[0]).toBe(cell(a, 1, 2));
    expect(playOut(c).razed).toBe(0); // its bite lands west of where it stands now: on open ground
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
    c.aim[0] = WEST;
    resolveInvaders(c);
    expect([c.hp[1], c.fire[cell(a, 1, 0)]]).toEqual([2, 1]);
    const burnt = cloneCombat(c);
    endRound(burnt);
    expect([burnt.hp[1], burnt.structHp[0]]).toEqual([1, 0]);
    act(c, 2, cell(a, 1, 1), S(NORTH));
    expect(c.fire[cell(a, 1, 0)]).toBe(0);
    endRound(c);
    expect(c.structHp[0]).toBe(1);
  });
});

describe("roofs and buildings (D-151)", () => {
  it("rigs climb onto low roofs and not towers; crawlers climb anything; brutes keep to the ground", () => {
    const a = arena(["...#H", "....."]);
    const c = newCombat(a, units(a, [["wrecker", 2, 0], ["crawler", 2, 1], ["brute", 1, 1]]));
    expect(movesOf(c, 0)).toContain(cell(a, 3, 0));
    expect(movesOf(c, 0)).not.toContain(cell(a, 4, 0));
    expect(movesOf(c, 1)).toContain(cell(a, 4, 0));
    expect(movesOf(c, 2)).not.toContain(cell(a, 3, 0));
    expect(standAt(c, cell(a, 3, 0))).toBe(2);
  });

  it("a rig on a low roof takes the bite meant for the building under it; on a tower's roof, a slam from the street reaches only the wall", () => {
    const a = arena(["#.", "H."]);
    const low = newCombat(a, units(a, [["pumper", 0, 0], ["crawler", 1, 0]]));
    low.aim[1] = WEST;
    resolveInvaders(low);
    expect([low.hp[0], low.structHp[0], low.lost]).toEqual([2, 1, 0]);
    // the slam brings the tower down (2), its 1,000 people with it, and the pumper on its roof falls 30 steps
    const high = newCombat(a, units(a, [["pumper", 0, 1], ["brute", 1, 1]]));
    high.aim[1] = WEST;
    const log: CombatEvent[] = [];
    resolveInvaders(high, log);
    expect([high.structHp[1], high.lost, high.hp[0]]).toEqual([0, 1000, 0]);
    expect(log.find((e) => e.t === "fall")).toEqual({ t: "fall", unit: 0, drop: 30 });
  });

  it("pushed off a roof, a unit falls: a point every 2 steps of drop; a flyer glides down", () => {
    const a = arena(["##."]);
    const c = newCombat(a, units(a, [["wrecker", 0, 0], ["crawler", 1, 0]]));
    const log: CombatEvent[] = [];
    strike(c, 0, S(EAST), log);
    expect(log.find((e) => e.t === "fall")).toEqual({ t: "fall", unit: 1, drop: 2 });
    expect(c.hp[1]).toBe(0); // 2 from the ram, 1 from the drop
    const t = arena(["HH."]);
    const off = newCombat(t, units(t, [["pumper", 0, 0], ["crawler", 1, 0]]));
    strike(off, 0, S(EAST)); // shot off the tower's roof into the street
    expect(off.hp[1]).toBe(0);
    const glide = newCombat(t, units(t, [["pumper", 0, 0], ["flyer", 1, 0]]));
    strike(glide, 0, S(EAST));
    expect([glide.hp[1], glide.pos[1]]).toEqual([1, cell(t, 2, 0)]);
  });

  it("a shot from a roof flies over lower roofs; from the street it strikes the first wall", () => {
    const a = arena(["H#.."]);
    const high = newCombat(a, units(a, [["pumper", 0, 0], ["crawler", 3, 0]]));
    strike(high, 0, S(EAST));
    expect([high.hp[1], high.structHp[1]]).toEqual([2, 1]);
    const b = arena([".#.."]);
    const low = newCombat(b, units(b, [["pumper", 0, 0], ["crawler", 3, 0]]));
    strike(low, 0, S(EAST));
    expect([low.hp[1], low.structHp[0], low.lost]).toEqual([3, 0, 100]);
  });

  it("a building brought down drops what stands on its roof", () => {
    const a = arena(["##", ".."]);
    const c = newCombat(a, units(a, [["crawler", 0, 0], ["pumper", 1, 1]]));
    strike(c, 1, S(NORTH)); // the shot strikes the building's other cell: down it comes
    expect([c.structHp[0], c.hp[0], standAt(c, cell(a, 0, 0))]).toEqual([0, 2, 0]);
  });

  it("a tower brought down topples along the line it was struck on, crushing what stands across it", () => {
    const a = arena(["..H..#.."]);
    const c = newCombat(a, units(a, [["brute", 1, 0], ["crawler", 4, 0]]));
    c.aim[0] = EAST;
    const log: CombatEvent[] = [];
    resolveInvaders(c, log);
    expect(log.find((e) => e.t === "topple")).toEqual({ t: "topple", id: 0, dir: EAST, cells: [cell(a, 3, 0), cell(a, 4, 0), cell(a, 5, 0)] });
    expect([c.hp[1], c.structHp[1], c.lost]).toEqual([1, 0, 1100]); // the crawler crushed for 2; the low building beyond, and its people
  });

  it("the crane hoists the unit beside it onto a cell within two: a roof no rig could climb, or water to drown in", () => {
    const a = arena(["H..", "..~"]);
    const c = newCombat(a, units(a, [["crane", 1, 1], ["wrecker", 1, 0], ["crawler", 2, 1]]));
    strike(c, 0, S(NORTH, 1, HOIST, cell(a, 0, 0)));
    expect([c.pos[1], standAt(c, c.pos[1]!)]).toEqual([cell(a, 0, 0), 30]);
    const d = newCombat(a, units(a, [["crane", 0, 1], ["crawler", 1, 1]]));
    strike(d, 0, S(EAST, 1, HOIST, cell(a, 2, 1)));
    expect(d.hp[1]).toBe(0);
  });

  it("an evacuation empties a building by the round's end: hit this round its people are lost, after that none", () => {
    const a = arena(["#.", ".."]);
    const c = newCombat(a, units(a, [["wrecker", 1, 0], ["crawler", 0, 1]]));
    c.aim[1] = NORTH;
    act(c, 0, cell(a, 1, 0), S(WEST, 1, EVACUATE("wrecker")));
    const now = playOut(c);
    expect(now.lost).toBe(100);
    const later = cloneCombat(c);
    endRound(later);
    resolveInvaders(later);
    expect([later.razed, later.lost]).toEqual([1, 0]);
  });
});

describe("the turn solver (D-150)", () => {
  // a brute beside a tower: it takes all 4 of the squad's damage to bring down, and pushing it west breaks the tower
  const a = arena(["H.....", "......", "......", "......"]);
  const position = (crane: [number, number]) => {
    const c = newCombat(a, units(a, [["wrecker", 1, 3], ["pumper", 4, 3], ["crane", ...crane], ["brute", 1, 0]]));
    c.aim[3] = WEST;
    return c;
  };

  it("finds the turns that lose nobody, each playing out as found: here all three strikes, the pushing one last", () => {
    const c = position([5, 3]);
    expect(playOut(c).lost).toBe(1000); // left alone, the tower falls
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

  it("with the crane near, one hoist lifting the brute off its line will do", () => {
    const c = position([3, 1]);
    const res = solveTurn(c, { keep: 50 });
    expect(res.minStrikes).toBe(1);
    const lift = res.perfect.find((s) => s.plan.some((x) => x.strike?.weapon === HOIST))!;
    expect(mechanicsOf(c, lift.plan)).toContain("redirect");
  });

  it("finds nothing perfect where nobody can reach in time, but still the best it can do", () => {
    const far = arena(["#.........", ".........."]);
    const c = newCombat(far, units(far, [["crawler", 1, 0], ["wrecker", 9, 1]]));
    planInvaders(c);
    const res = solveTurn(c, { mode: "best" });
    expect(res.perfect).toEqual([]);
    expect(res.best!.outcome.lost).toBe(100);
  });

  it("the greedy player plays each rig's best on its own, in turn", () => {
    const g = greedyTurn(position([5, 3]));
    expect(g.plan.map((x) => x.unit)).toEqual([0, 1, 2]);
    expect(Number.isFinite(g.outcome.score)).toBe(true);
  });
});

describe("what a turn takes (D-150, D-151)", () => {
  it("names the mechanics a plan uses: pushed off its line, turned on its own, crushed under a toppling tower", () => {
    const a = arena(["....", "#...", "...."]);
    const c = newCombat(a, units(a, [["crawler", 1, 1], ["pumper", 1, 0]]));
    planInvaders(c);
    expect(mechanicsOf(c, [{ unit: 1, dest: cell(a, 1, 0), strike: S(SOUTH) }])).toEqual(["redirect"]);
    const d = newCombat(a, units(a, [["crawler", 1, 1], ["brute", 2, 2], ["pumper", 1, 0]]));
    d.aim[0] = WEST;
    d.aim[1] = WEST;
    expect(mechanicsOf(d, [{ unit: 2, dest: cell(a, 1, 0), strike: S(SOUTH) }]).sort()).toEqual(["redirect", "turn"]);
    // a tower already struck once, shot from the west: it topples east onto a crawler
    const t = arena(["..H...."]);
    const e = newCombat(t, units(t, [["pumper", 0, 0], ["crawler", 4, 0]]));
    e.structHp[0] = 1;
    expect(mechanicsOf(e, [{ unit: 0, dest: cell(t, 0, 0), strike: S(EAST) }])).toContain("crush");
  });
});

describe("a fight over several rounds (D-152)", () => {
  // streets by a river, two brutes aiming: wrecker (4,6), pumper (3,6), crane (2,5); brutes at (3,1) aiming south, (1,5) aiming east
  const a = arena(["HH..#...", "H...#.**", "...H..**", "~~......", "~~..##..", "...H....", "#.....~~", "##...w~~"]);
  const position = () => {
    const c = newCombat(a, units(a, [["wrecker", 4, 6], ["pumper", 3, 6], ["crane", 2, 5], ["brute", 3, 1], ["brute", 1, 5]]));
    c.aim.set([-1, -1, -1, SOUTH, EAST]);
    return c;
  };
  /** The round played on from a turn, as a fight does: the invaders strike, fire burns, they aim again. */
  const after = (c: ReturnType<typeof position>, plan: { unit: number; dest: number; strike: Strike | null }[]) => {
    const n = cloneCombat(c);
    for (const x of plan) act(n, x.unit, x.dest, x.strike);
    resolveInvaders(n);
    endRound(n);
    planInvaders(n);
    return n;
  };

  it("finds a line that holds every round, each turn losing nobody", () => {
    const c = position();
    const f = solveFight(c, { rounds: 3 });
    expect(f.winnable).toBe(true);
    let d = c;
    for (const plan of f.line) {
      const n = cloneCombat(d);
      for (const x of plan) act(n, x.unit, x.dest, x.strike);
      expect(outcome(d, playOut(n)).perfect).toBe(true);
      d = after(d, plan);
    }
  });

  it("some turns that lose nobody now lose the fight later: the player can corner the squad", () => {
    const c = position();
    const f = solveFight(c, { rounds: 3, count: true, maxNodes: 2_000_000 });
    expect(f.safeFirstTurns).toBeGreaterThan(0);
    expect(f.safeFirstTurns).toBeLessThan(f.firstTurns);
    // find one such trap among the perfect first turns, and check it from the round after
    const trap = solveTurn(c, { keep: 256 }).perfect.find((t) => {
      const later = solveFight(after(c, t.plan), { rounds: 2, maxNodes: 400_000 });
      return later.complete && !later.winnable;
    })!;
    const played = cloneCombat(c);
    for (const x of trap.plan) act(played, x.unit, x.dest, x.strike);
    expect(outcome(c, playOut(played)).perfect).toBe(true); // nobody lost this round…
    expect(solveFight(after(c, trap.plan), { rounds: 2 }).winnable).toBe(false); // …and the next two can't both be held
  });

  it("weighs rigs that have acted: with them done, only this round's ending is searched", () => {
    const c = position();
    const f = solveFight(c, { rounds: 3 });
    const d = cloneCombat(c);
    for (const x of f.line[0]!) act(d, x.unit, x.dest, x.strike);
    const done = solveFight(d, { rounds: 3, acted: [0, 1, 2] });
    expect(done.winnable).toBe(true);
    expect(done.line[0]).toEqual([]);
  });

  it("makes puzzles whose whole fight can be held, the line kept with them", async () => {
    const p = await generatePuzzle(a, { seed: 3, attempts: 60, timeMs: 20_000, rounds: 3, clever: false, target: 3 });
    expect(p?.fight?.line.length).toBeGreaterThan(0);
    expect(p!.solution.plan).toEqual(p!.fight!.line[0]);
    let d = p!.combat;
    for (const plan of p!.fight!.line) {
      const n = cloneCombat(d);
      for (const x of plan) act(n, x.unit, x.dest, x.strike);
      expect(outcome(d, playOut(n)).perfect).toBe(true);
      d = after(d, plan);
    }
  }, 60_000);
});

describe("puzzles (D-150)", () => {
  // streets by a river: low buildings, towers, a park, water, a wooden house
  const a = arena([
    "HH..#...",
    "H...#.**",
    "...H..**",
    "~~......",
    "~~..##..",
    "...H....",
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

describe("on a real city's board (D-150, D-151)", () => {
  const ROOT = new URL("../../../", import.meta.url);
  const style = (id: string) => JSON.parse(readFileSync(new URL(`worlds/_styles/${id}/style.json`, ROOT), "utf8")) as object;
  afterEach(() => void vi.unstubAllGlobals());

  it("makes an arena of Lower Manhattan's buildings, roofs, people and streets, and a clever puzzle on it", async () => {
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
    expect(a.structures.every((s) => s.object >= 0 && s.hp >= 1 && s.hp <= 4 && s.cells.length > 0)).toBe(true);
    expect(a.structures.reduce((n, s) => n + s.people, 0)).toBeGreaterThan(5000);
    expect(a.structures.some((s) => s.topple >= 3)).toBe(true); // the Financial District's towers fall far
    const p = await generatePuzzle(a, { seed: 1, timeMs: 15_000, attempts: 300 });
    expect(p).not.toBeNull();
    expect(p!.mechanics.some((m) => m !== "kill")).toBe(true);
    const d = cloneCombat(p!.combat);
    for (const x of p!.solution.plan) act(d, x.unit, x.dest, x.strike);
    expect(outcome(p!.combat, playOut(d)).perfect).toBe(true);
    expect(greedyTurn(p!.combat).outcome.perfect).toBe(false);
  }, 60_000);
});
