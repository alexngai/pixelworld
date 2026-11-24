import { describe, expect, it } from "vitest";
import { INVADERS, SQUAD, aimOf, cloneCombat, fromWire, joinSquad, reinforce, loadoutOf, moveUnit, strikeCell, teamOf, newCombat, planInvaders, replayFight, resolveInvaders, endRound, solveTurn, strike, toWire, type Action, type Arena, type Combat } from "../src/index";

/** A small arena: open ground, `#` a low building (1 hp, 100 people). */
function arena(rows: string[]): Arena {
  const [w, h] = [rows[0]!.length, rows.length];
  const n = w * h;
  const a: Arena = { w, h, flags: new Uint8Array(n), height: new Float32Array(n), roof: new Float32Array(n), struct: new Int16Array(n).fill(-1), structures: [], metersPerStep: 3, climb: 1, fall: 2, reach: 2 };
  for (let k = 0; k < n; k++) {
    if (rows[Math.floor(k / w)]![k % w] !== "#") continue;
    a.struct[k] = a.structures.length;
    a.roof[k] = 2;
    a.structures.push({ object: -1, name: "#", hp: 1, people: 100, flammable: false, cells: [k], topple: 0 });
  }
  return a;
}

/** A fight played by the solver's best turn each round, recorded as a page records it. */
function played(start: Combat, rounds: number): Action[][] {
  const c = cloneCombat(start);
  const turns: Action[][] = [];
  for (let r = 0; r < rounds; r++) {
    // the solver's best turn, but for a rig an earlier action that turn has downed (a page can't act with one)
    const plan = solveTurn(c, { mode: "best", maxNodes: 20_000 }).best?.plan ?? [];
    const turn: Action[] = [];
    for (const a of plan) {
      if (c.hp[a.unit]! <= 0) continue;
      turn.push(a);
      if (a.dest !== c.pos[a.unit]) moveUnit(c, a.unit, a.dest);
      if (a.strike) strike(c, a.unit, a.strike);
    }
    turns.push(turn);
    resolveInvaders(c);
    endRound(c);
    planInvaders(c);
  }
  return turns;
}

describe("a fight replayed (D-186)", () => {
  const a = arena(["......", "..#...", "......", "...#..", "......", "......"]);
  const cell = (x: number, y: number) => y * a.w + x;
  const start = newCombat(a, [
    { kind: "wrecker", at: cell(0, 0) },
    { kind: "pumper", at: cell(5, 0) },
    { kind: "crane", at: cell(0, 5) },
    { kind: "brute", at: cell(2, 2) },
    { kind: "crawler", at: cell(4, 3) },
  ]);
  planInvaders(start);

  it("plays the recorded turns through the rules to the fight's end, the same each time and over the wire", () => {
    const turns = played(start, 2);
    const r = replayFight(start, turns, 2);
    expect(r).not.toBeNull();
    expect(r!.rounds).toBe(2);
    const wired = fromWire<Combat>(toWire(start));
    expect(wired.pos).toBeInstanceOf(Int16Array);
    expect(replayFight(wired, fromWire<Action[][]>(toWire(turns)), 2)).toEqual(r);
  });

  it("refuses moves the rules don't allow, an invader moved, a rig acting twice, and turns that stop short", () => {
    const turns = played(start, 2);
    expect(replayFight(start, turns.slice(0, 1), 2)).toBeNull();
    expect(replayFight(start, [[{ unit: 0, dest: cell(5, 5), strike: null }], []], 2)).toBeNull();
    expect(replayFight(start, [[{ unit: 3, dest: start.pos[3]!, strike: null }], []], 2)).toBeNull();
    expect(replayFight(start, [[{ unit: 0, dest: start.pos[0]!, strike: null }, { unit: 0, dest: start.pos[0]!, strike: null }], []], 2)).toBeNull();
    expect(replayFight(start, [[{ unit: 0, dest: start.pos[0]!, strike: { weapon: 0, dir: 2, range: 9 } }], []], 2)).toBeNull();
  });

  it("joins a second squad's rigs on free cells out of the invaders' way (D-187), and the fight goes on with them", () => {
    const c = cloneCombat(start);
    const rigs = [loadoutOf("pumper", [{ id: "waterCannon", ups: [0] }, null]), loadoutOf("ladder", [{ id: "deluge", ups: [] }, null])];
    const added = joinSquad(c, rigs);
    expect(added).toEqual([5, 6]);
    for (const u of added) {
      expect(teamOf(c, u)).toBe(SQUAD);
      expect(c.occ[c.pos[u]!]).toBe(u);
    }
    expect(c.arms[5]![0]!.damage).toBe(2);
    const struck = c.roster.flatMap((_, u) => (teamOf(c, u) === INVADERS && c.aim[u]! >= 0 ? [strikeCell(c, u, aimOf(c, u))] : []));
    for (const u of added) expect(struck).not.toContain(c.pos[u]);
    expect(replayFight(c, played(c, 2), 2)).not.toBeNull();
    // and two more invaders, each beside a building it aims at, out of the rigs' reach
    const more = reinforce(c, 2);
    expect(more).toHaveLength(2);
    for (const u of more) {
      expect(teamOf(c, u)).toBe(INVADERS);
      expect(c.arena.struct[strikeCell(c, u, aimOf(c, u))]).toBeGreaterThanOrEqual(0);
    }
    expect(replayFight(c, played(c, 2), 2)).not.toBeNull();
  });
});
