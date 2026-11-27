import { describe, expect, it } from "vitest";
import {
  A_BURNS,
  A_WATER,
  INVADERS,
  act,
  cloneCombat,
  endRound,
  generatePuzzle,
  newCombat,
  objectiveCandidates,
  objectiveMet,
  objectiveState,
  objectiveText,
  planInvaders,
  resolveInvaders,
  solveFight,
  teamOf,
  type Arena,
  type Combat,
  type FighterKind,
  type Objective,
} from "../src/index";

/** A small arena: `.` open, `~` water, `*` ground that burns, `#` a low building (1 hp, 100 people), `H` a tower (2 hp, 1,000 people, topples 3). */
function arena(rows: string[]): Arena {
  const [w, h] = [rows[0]!.length, rows.length];
  const n = w * h;
  const a: Arena = { w, h, flags: new Uint8Array(n), height: new Float32Array(n), roof: new Float32Array(n), struct: new Int16Array(n).fill(-1), structures: [], metersPerStep: 3, climb: 1, fall: 2, reach: 2 };
  const ch = (k: number) => rows[Math.floor(k / w)]![k % w]!;
  for (let k = 0; k < n; k++) {
    if (ch(k) === "~") a.flags[k] = A_WATER;
    if (ch(k) === "*") a.flags[k] = A_BURNS;
    if (!"#H".includes(ch(k)) || a.struct[k]! >= 0) continue;
    const tower = ch(k) === "H";
    const id = a.structures.length;
    a.structures.push({ object: -1, name: tower ? "building.tower.deco" : "building.rowhouse", hp: tower ? 2 : 1, people: tower ? 1000 : 100, flammable: false, cells: [], topple: tower ? 3 : 0 });
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
const at = (a: Arena, x: number, y: number) => y * a.w + x;
const fight = (a: Arena, list: [FighterKind, number, number][]) => newCombat(a, list.map(([kind, x, y]) => ({ kind, at: at(a, x, y) })));

describe("bonus objectives (D-199)", () => {
  const a = arena(["HH..#...", "H...#.**", "...H..**", "~~......", "~~..##..", "...H....", "#.....~~", "##...w~~"]);
  const start = () => fight(a, [["wrecker", 4, 6], ["pumper", 3, 6], ["crane", 2, 5], ["brute", 3, 1], ["flyer", 1, 5]]);

  it("says what each asks, the tower by its name", () => {
    const c = start();
    expect(objectiveText({ kind: "evacuate", structure: 0 }, c)).toBe("Evacuate the tower deco");
    const named = fight(arena(["HH.##"]), [["wrecker", 2, 0], ["brute", 4, 0]]);
    named.arena.structures[0]!.name = "building.commercial";
    expect(objectiveText({ kind: "evacuate", structure: 0 }, named)).toBe("Evacuate the commercial tower");
    expect(objectiveText({ kind: "fires" }, c)).toBe("No fire left burning");
  });

  it("follows each through a fight: open while it goes on, met or failed by what happened", () => {
    const s = start();
    const open = (o: Objective, c: Combat) => objectiveState(o, s, c, false);
    const end = (o: Objective, c: Combat) => objectiveState(o, s, c, true);
    const c = cloneCombat(s);
    // nothing happened yet: those judged at the end are open, and met if it ended so
    for (const kind of ["fires", "unhurt", "property"] as const) {
      expect(open({ kind }, c)).toBe("open");
      expect(end({ kind }, c)).toBe("met");
    }
    // a rig scratched, a building hit: failed at once, for good
    const hurt = cloneCombat(s);
    hurt.hp[0]! -= 1;
    expect(open({ kind: "unhurt" }, hurt)).toBe("failed");
    const razed = cloneCombat(s);
    razed.razed += 1;
    expect(open({ kind: "property" }, razed)).toBe("failed");
    // a fire still burning at the end
    const burning = cloneCombat(s);
    burning.fire[at(a, 6, 1)] = 2;
    expect(open({ kind: "fires" }, burning)).toBe("open");
    expect(end({ kind: "fires" }, burning)).toBe("failed");
    // the tower: met once emptied, failed if it falls first or the fight ends with it full
    const tower: Objective = { kind: "evacuate", structure: 0 };
    const emptied = cloneCombat(s);
    emptied.evacuated[0] = 1;
    expect(open(tower, emptied)).toBe("met");
    const fallen = cloneCombat(s);
    fallen.structHp[0] = 0;
    expect(open(tower, fallen)).toBe("failed");
    expect(end(tower, c)).toBe("failed");
    // every invader down, none to come
    const routed = cloneCombat(s);
    routed.roster.forEach((_, u) => teamOf(routed, u) === INVADERS && (routed.hp[u] = 0));
    expect(open({ kind: "rout" }, routed)).toBe("met");
    expect(open({ kind: "rout" }, c)).toBe("open");
    expect(end({ kind: "rout" }, c)).toBe("failed");
  });

  it("offers the board's own: fire where ground burns and something sets it alight, the fullest tower that topples", () => {
    const kinds = (c: Combat) => objectiveCandidates(c).map((o) => o.kind);
    expect(kinds(start())).toEqual(["fires", "evacuate", "unhurt", "property", "rout"]);
    expect(objectiveCandidates(start()).find((o) => o.kind === "evacuate")).toEqual({ kind: "evacuate", structure: 0 });
    // no flyer to set it alight: no fire to keep out
    expect(kinds(fight(a, [["wrecker", 4, 6], ["brute", 3, 1]]))).not.toContain("fires");
    // no tower: nobody to evacuate
    const low = arena(["..#.....", "........", "....#...", "........"]);
    expect(kinds(fight(low, [["wrecker", 0, 3], ["brute", 7, 0]]))).toEqual(["unhurt", "property", "rout"]);
  });

  it("the fight solver holds the fight and meets a goal, or finds no line", () => {
    const c = start();
    c.aim.set([-1, -1, -1, 2, 1]);
    const plain = solveFight(c, { rounds: 2 });
    expect(plain.winnable).toBe(true);
    expect(solveFight(c, { rounds: 2, goal: () => true }).winnable).toBe(true);
    expect(solveFight(c, { rounds: 2, goal: () => false }).winnable).toBe(false);
    // a line found for a goal ends with it met
    const unhurt: Objective = { kind: "unhurt" };
    const f = solveFight(c, { rounds: 2, goal: (end) => objectiveMet(unhurt, c, end) });
    if (f.winnable) {
      let d = cloneCombat(c);
      for (const plan of f.line) {
        for (const x of plan) act(d, x.unit, x.dest, x.strike);
        resolveInvaders(d);
        endRound(d);
        planInvaders(d);
        d = cloneCombat(d);
      }
      expect(objectiveMet(unhurt, c, d)).toBe(true);
    }
  });

  it("gives a puzzle up to two objectives, each reachable along with holding the fight", async () => {
    const p = await generatePuzzle(a, { seed: 3, attempts: 60, timeMs: 20_000, rounds: 3, clever: false, target: 3, objectives: 2 });
    expect(p?.fight).toBeTruthy();
    const objectives = p!.objectives ?? [];
    expect(objectives.length).toBeGreaterThan(0);
    expect(objectives.length).toBeLessThanOrEqual(2);
    for (const o of objectives) expect(solveFight(p!.combat, { rounds: 3, evacuate: o.kind === "evacuate", goal: (end) => objectiveMet(o, p!.combat, end) }).winnable).toBe(true);
    // without asking, none
    expect((await generatePuzzle(a, { seed: 3, attempts: 60, timeMs: 20_000, rounds: 3, clever: false, target: 3 }))?.objectives).toBeUndefined();
  }, 120_000);
});
