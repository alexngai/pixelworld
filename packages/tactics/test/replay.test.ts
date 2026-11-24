import { describe, expect, it } from "vitest";
import { cloneCombat, fromWire, moveUnit, newCombat, planInvaders, replayFight, resolveInvaders, endRound, solveTurn, strike, toWire, type Action, type Arena, type Combat } from "../src/index";

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
    const plan = solveTurn(c, { mode: "best", maxNodes: 20_000 }).best?.plan ?? [];
    turns.push(plan);
    for (const a of plan) {
      if (a.dest !== c.pos[a.unit]) moveUnit(c, a.unit, a.dest);
      if (a.strike) strike(c, a.unit, a.strike);
    }
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
});
