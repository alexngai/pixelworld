import { describe, expect, it } from "vitest";
import { A_CHASM, act, endRound, movesOf, newCombat, rooftop, rooftopFloor, strike, strikeTarget, type Arena, type CombatEvent, type FighterKind } from "../src";

/**
 * Rooftop maps (D-180): towers in capitals (their roofs 10 steps, 30 m up), a
 * low house `h` (one step), the street `.`.
 */
function city(rows: string[], tall = 10): Arena {
  const h = rows.length;
  const w = rows[0]!.length;
  const n = w * h;
  const a: Arena = { w, h, flags: new Uint8Array(n), height: new Float32Array(n), roof: new Float32Array(n), struct: new Int16Array(n).fill(-1), structures: [], metersPerStep: 3, climb: 1, fall: 2, reach: 2 };
  const ids = new Map<string, number>();
  for (let k = 0; k < n; k++) {
    const ch = rows[Math.floor(k / w)]![k % w]!;
    if (ch === ".") continue;
    if (!ids.has(ch)) {
      ids.set(ch, a.structures.length);
      a.structures.push({ object: -1, name: ch, hp: 2, people: 100, flammable: false, cells: [], topple: 0 });
    }
    a.struct[k] = ids.get(ch)!;
    a.structures[ids.get(ch)!]!.cells.push(k);
    a.roof[k] = ch === "h" ? 1 : tall;
  }
  return a;
}
const ROWS = ["AA.BB.", "AA.BB.", "hh.CC.", "hh...."];
const at = (x: number, y: number) => y * 6 + x;
const EAST = 1;
const SOUTH = 2;

describe("rooftop maps", () => {
  it("finds the floor where towers stand far above the street, and none where nothing does", () => {
    expect(rooftopFloor(city(ROWS), 3)).toBe(10);
    expect(rooftopFloor(city(ROWS, 3), 3)).toBeNull(); // 9 m: no rooftops
  });

  it("keeps the towers and makes the rest a chasm", () => {
    const r = rooftop(city(ROWS), 10);
    expect(r.floor).toBe(10);
    expect(r.structures.map((s) => s.name)).toEqual(["A", "B", "C"]);
    expect(r.struct[at(0, 2)]).toBe(-1); // the house is gone below
    expect(r.roof[at(0, 2)]).toBe(0);
    expect([...r.flags].every((f) => f === A_CHASM)).toBe(true);
  });

  it("lets every walker leap a gap between roofs, and none walk into the chasm", () => {
    const r = rooftop(city(ROWS), 10);
    const c = newCombat(r, [{ kind: "crane" as FighterKind, at: at(1, 1) }]);
    const moves = movesOf(c, 0);
    expect(moves).toContain(at(3, 1)); // across the street (the crane doesn't leap on the ground)
    for (const k of moves) expect(r.struct[k]).toBeGreaterThanOrEqual(0);
  });

  it("loses a walker pushed into the chasm, not a flyer", () => {
    const r = rooftop(city(ROWS), 10);
    const c = newCombat(r, [
      { kind: "wrecker", at: at(3, 0) },
      { kind: "crawler", at: at(4, 0) },
      { kind: "pumper", at: at(3, 1) },
      { kind: "flyer", at: at(4, 1) },
    ]);
    const log: CombatEvent[] = [];
    strike(c, 0, { weapon: 0, dir: EAST, range: 1 }, log);
    expect(c.hp[1]).toBe(0);
    expect(log.map((e) => e.t)).toEqual(["strike", "damage", "push", "fall", "damage", "down"]);
    strike(c, 2, { weapon: 0, dir: EAST, range: 1 });
    expect(c.hp[3]).toBe(1); // the cannon's point, no fall
    expect(c.pos[3]).toBe(at(5, 1));
  });

  it("drops what stands on a tower brought down into the chasm", () => {
    const r = rooftop(city(ROWS), 10);
    const c = newCombat(r, [
      { kind: "wrecker", at: at(3, 1) },
      { kind: "crawler", at: at(4, 2) },
    ]);
    act(c, 0, at(3, 1), { weapon: 0, dir: SOUTH, range: 1 });
    expect(c.structHp[2]).toBe(0);
    expect(c.hp[1]).toBe(0);
  });

  it("lands arrivals on the roofs, none in the chasm or on a tower brought down", () => {
    const r = rooftop(city(ROWS), 10);
    const c = newCombat(r, [{ kind: "wrecker", at: at(0, 0) }], [[{ kind: "brute", at: at(4, 0) }, { kind: "crawler", at: at(2, 3) }, { kind: "flyer", at: at(4, 2) }]]);
    c.structHp[2] = 0; // C fell
    endRound(c);
    expect(c.roster).toEqual(["wrecker", "brute"]);
    expect(c.pos[1]).toBe(at(4, 0));
  });

  it("names what a strike lands on as the rules do: a unit on a roof, or the wall under it past a melee blow's reach", () => {
    const c = newCombat(city(ROWS), [
      { kind: "wrecker", at: at(2, 0) },
      { kind: "crawler", at: at(1, 0) },
      { kind: "wrecker", at: at(4, 0) },
      { kind: "brute", at: at(4, 1) },
    ]);
    const WEST = 3;
    expect(strikeTarget(c, 0, { weapon: 0, dir: WEST, range: 1 })).toEqual({ unit: -1, structure: 0 }); // 30 m up from the street
    expect(strikeTarget(c, 2, { weapon: 0, dir: SOUTH, range: 1 })).toEqual({ unit: 3, structure: -1 }); // roof to roof
    expect(strikeTarget(c, 2, { weapon: 0, dir: EAST, range: 1 })).toEqual({ unit: -1, structure: -1 }); // the street, empty
  });
});
