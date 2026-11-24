import { describe, expect, it } from "vitest";
import { drawBlock, drawOperation, type Block } from "../src/sites";

/** A run's blocks drawn from the surveyed boards (D-178). */
describe("drawing an operation's blocks", () => {
  const at = (name: string, zone: number, x0: number, score: number): Block => ({ name, zone, x0, y0: 0, cell: 2, score });
  const pool = [at("towers", 1, 0, 0.7), at("towers", 1, 40, 0.68), at("brownstones", 2, 80, 0.6), at("lofts", 3, 120, 0.5), at("by the river", 4, 10, 0.75)];
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  it("draws three apart, from three zones and names, the best last", () => {
    for (let run = 0; run < 50; run++) {
      const ops = drawOperation(pool, random);
      expect(ops).toHaveLength(3);
      expect(new Set(ops.map((b) => b.zone)).size).toBe(3);
      expect(new Set(ops.map((b) => b.name)).size).toBe(3);
      for (const a of ops) for (const b of ops) if (a !== b) expect(Math.abs(a.x0 - b.x0)).toBeGreaterThanOrEqual(24);
      expect(ops.map((b) => b.score)).toEqual([...ops.map((b) => b.score)].sort((p, q) => p - q));
    }
  });

  it("draws the better boards more often", () => {
    const n = new Map<string, number>();
    for (let k = 0; k < 2000; k++) {
      const b = drawBlock(pool, [], random)!;
      n.set(b.name + b.x0, (n.get(b.name + b.x0) ?? 0) + 1);
    }
    expect(n.get("by the river10")!).toBeGreaterThan(n.get("towers0")!);
    expect(n.get("towers0")!).toBeGreaterThan(n.get("lofts120") ?? 0);
  });

  it("leaves out the boards given up on, and gives null when none is left", () => {
    expect(drawBlock([pool[0]!], [], random, [pool[0]!])).toBeNull();
    expect(drawBlock(pool, [pool[0]!], random, pool.slice(2))).toBe(pool[1]); // same zone and name, but nothing else is left
  });
});
