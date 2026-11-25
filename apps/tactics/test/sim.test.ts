import type { CombatEvent } from "@pixelworlds/tactics";
import { describe, expect, it } from "vitest";
import { damageShares, kindsOf, roomTerm } from "../src/sim";

/** The map survey's simulation measures (D-181). */
describe("the simulation's measures", () => {
  // units 0–2 the squad, 3 and 4 invaders
  const invader = (u: number) => u >= 3;

  it("gives the weapons the damage straight after a rig's strike, the city the rest", () => {
    const events: CombatEvent[] = [
      { t: "strike", unit: 0, at: 5, weapon: 0 },
      { t: "damage", unit: 3, amount: 2 }, // the ram's own hit
      { t: "push", unit: 3, from: 5, to: 6 },
      { t: "fall", unit: 3, drop: 4 },
      { t: "damage", unit: 3, amount: 1 }, // off a roof
      { t: "strike", unit: 4, at: 6, weapon: 0 },
      { t: "damage", unit: 3, amount: 1 }, // its own side's strike
      { t: "strike", unit: 1, at: 7, weapon: 0 },
      { t: "push", unit: 4, from: 7, to: 8 },
      { t: "down", unit: 4, at: 8, drowned: true }, // drowned, no damage event
    ];
    expect(damageShares(events, invader)).toEqual({ city: 3, weapons: 2 });
    expect([...kindsOf(events, invader)].sort()).toEqual(["drown", "fall", "turn"]);
  });

  it("knows a topple's crush, fire and a blocked arrival", () => {
    const events: CombatEvent[] = [
      { t: "topple", id: 2, dir: 1, cells: [9] },
      { t: "crush", at: 9 },
      { t: "damage", unit: 4, amount: 2 },
      { t: "ignite", at: 11 },
      { t: "blocked", unit: 1, at: 12 },
    ];
    expect([...kindsOf(events, invader)].sort()).toEqual(["block", "crush", "fire", "topple"]);
  });

  it("likes a few ways to hold a fight: one a pure puzzle, dozens too easy", () => {
    expect(roomTerm(1)).toBe(0.5);
    expect(roomTerm(4)).toBe(1);
    expect(roomTerm(16)).toBeCloseTo(2 / 3);
    expect(roomTerm(64)).toBe(0);
  });
});
