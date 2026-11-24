import { describe, expect, it } from "vitest";
import { characterZones, hiddenPenalty, spearman, titleOf, typologyOf, WEIGHTS, type ObjectRecord } from "../src/survey";

/** The map survey's pieces (D-174, docs/tactics/map-survey.md). */
describe("the map survey", () => {
  it("measures terracing as a rank correlation: rising, flat or falling", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([4, 3, 2, 1], [10, 20, 30, 40])).toBeCloseTo(-1);
    expect(spearman([5, 5, 5, 5], [1, 2, 3, 4])).toBe(0);
  });

  it("takes more off for each hidden cell than for the one before (D-177)", () => {
    expect(hiddenPenalty(0)).toBe(0);
    expect(hiddenPenalty(8)).toBeGreaterThan(2 * hiddenPenalty(4));
    expect(hiddenPenalty(0.3 * 64)).toBeCloseTo(WEIGHTS.penalty.hidden);
  });

  it("zones a city by character where its building types tell places apart, a grid where they can't", () => {
    const W = 128;
    const H = 128;
    const none = new Uint8Array(W * H);
    // the west of brownstones, the east of towers, a few apartments everywhere: two characters
    const objects: ObjectRecord[] = [];
    for (let y = 0; y < H; y += 3)
      for (let x = 0; x < W; x += 3) objects.push({ g: x < 64 ? "building.brownstone" : x % 9 ? "building.tower" : "building.apartment", x, y });
    const z = characterZones(W, H, objects, none, none);
    expect(z.mode).toBe("character");
    expect(z.zoneAt(10, 10)).not.toBe(z.zoneAt(120, 10));
    // one kind of building everywhere: nothing to tell places apart
    const same = objects.map((o) => ({ ...o, g: "building.residential" }));
    expect(characterZones(W, H, same, none, none).mode).toBe("grid");
  });

  it("names landmarks and kinds of place", () => {
    expect(titleOf("flatiron-building")).toBe("Flatiron Building");
    expect(titleOf("pont-neuf-north")).toBe("Pont Neuf");
    expect(titleOf("ntt-docomo-yoyogi-building")).toBe("NTT Docomo Yoyogi Building");
    expect(typologyOf("building.brownstone")).toBe("brownstone blocks");
    expect(typologyOf("building.tower")).toBe("towers");
  });
});
