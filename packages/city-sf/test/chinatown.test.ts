import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHINATOWN_GENERATORS } from "../src/chinatown";
import { generateModel, type AssetCatalog, type VoxelModel } from "pixelworld/generators";
import { register } from "../src/index";

await register(); // the city pack's generators, on this thread

/**
 * Chinatown's street pieces: the gate over Grant Avenue and the lanterns
 * strung across it. Generic shapes in the style's ramps; nothing floats.
 */
const style = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../worlds/_styles/bay-area/style.json", import.meta.url)), "utf8"),
) as { assets: AssetCatalog; ramps: Record<string, string[]> };
const rampIds = new Map(Object.keys(style.ramps).map((name, i) => [name, i + 1]));
const rampName = new Map([...rampIds].map(([n, i]) => [i, n]));
const rampAt = (m: VoxelModel, x: number, y: number, z: number) => {
  const v = m.get(x, y, z);
  return v ? (rampName.get(m.materials[v]!) ?? "?") : null;
};

/** Voxels not joined (face to face) to the ground, or for a hung model to its largest part. */
function loose(m: VoxelModel, fromGround: boolean): number {
  const seen = new Uint8Array(m.sx * m.sy * m.sz);
  const idx = (x: number, y: number, z: number) => (z * m.sy + y) * m.sx + x;
  const parts: number[] = [];
  let total = 0;
  for (let z = 0; z < m.sz; z++)
    for (let y = 0; y < m.sy; y++)
      for (let x = 0; x < m.sx; x++) {
        if (!m.get(x, y, z)) continue;
        total++;
        if (seen[idx(x, y, z)] || (fromGround && z > 0)) continue;
        let n = 0;
        const stack: [number, number, number][] = [[x, y, z]];
        seen[idx(x, y, z)] = 1;
        while (stack.length) {
          const [a, b, c] = stack.pop()!;
          n++;
          for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
            const [p, q, r] = [a + dx, b + dy, c + dz];
            if (m.get(p, q, r) && !seen[idx(p, q, r)]) {
              seen[idx(p, q, r)] = 1;
              stack.push([p, q, r]);
            }
          }
        }
        parts.push(n);
      }
  const held = fromGround ? parts.reduce((s, n) => s + n, 0) : Math.max(0, ...parts);
  return total - held;
}

describe("Chinatown's gate", () => {
  for (const H of [10, 16, 22, 30])
    it(`stands three openings under green tile roofs, symmetric and on the ground (H ${H})`, () => {
      const m = generateModel(style.assets, rampIds, "landmark.gate", { seed: 1, heightVox: H });
      expect(loose(m, true)).toBe(0);
      // symmetric about its middle column
      for (let z = 0; z < m.sz; z++)
        for (let y = 0; y < m.sy; y++)
          for (let x = 0; x < m.sx; x++) expect(rampAt(m, x, y, z), `${x},${y},${z}`).toBe(rampAt(m, m.sx - 1 - x, y, z));
      // at the street, across the middle of its depth: three clear runs between four piers
      const y = Math.floor(m.sy / 2);
      const open = Array.from({ length: m.sx }, (_, x) => !m.get(x, y, 2));
      const runs = open.map((o, x) => (o && (x === 0 || !open[x - 1]) ? 1 : 0)).reduce((s: number, v) => s + v, 0);
      expect(runs).toBe(3);
      // the middle opening is the widest, under the highest roof
      const mid = Math.floor(m.sx / 2);
      let w = 0;
      while (open[mid + w]) w++;
      expect(2 * w - 1).toBeGreaterThan(m.sx * 0.3);
      const top = (x: number) => {
        for (let z = m.sz - 1; z >= 0; z--) if (m.get(x, y, z)) return z;
        return -1;
      };
      expect(top(mid)).toBeGreaterThan(top(1));
      // roofs of jade tile cover it all, gold ornaments on their ridges; only the style's ramps
      for (let x = 0; x < m.sx; x++)
        for (let yy = 0; yy < m.sy; yy++) {
          let z = m.sz - 1;
          while (z > 0 && !m.get(x, yy, z)) z--;
          expect(["jade", "tower-gold"]).toContain(rampAt(m, x, yy, z));
        }
      const used = new Set<string>();
      for (let z = 0; z < m.sz; z++)
        for (let yy = 0; yy < m.sy; yy++) for (let x = 0; x < m.sx; x++) if (m.get(x, yy, z)) used.add(rampAt(m, x, yy, z)!);
      expect([...used].sort()).toEqual(["chinatown-red", "granite", "jade", "paint-white", "tower-gold"]);
    });
});

describe("lanterns strung across a street", () => {
  for (const group of ["prop.lanterns", "prop.lanterns.wide"])
    it(`hang red (and gold) lanterns from a wire across the whole span (${group})`, () => {
      for (let seed = 1; seed <= 8; seed++) {
        const m = generateModel(style.assets, rampIds, group, { seed });
        // the wire reaches both ends, sagging toward the middle
        const wireZ = (x: number) => {
          for (let z = m.sz - 1; z >= 0; z--) if (rampAt(m, x, 0, z) === "asphalt") return z;
          return -1;
        };
        const wireLow = (x: number) => {
          for (let z = 0; z < m.sz; z++) if (rampAt(m, x, 0, z) === "asphalt") return z;
          return -1;
        };
        expect(wireZ(0)).toBeGreaterThan(0);
        expect(wireZ(m.sx - 1)).toBe(wireZ(0));
        expect(wireZ(Math.floor(m.sx / 2))).toBeLessThan(wireZ(0));
        // every lantern hangs from it: one piece, high over the street
        expect(loose(m, false)).toBe(0);
        let lanterns = 0;
        for (let x = 0; x < m.sx; x++) {
          const r = rampAt(m, x, 0, wireLow(x) - 1);
          if (r) expect(["chinatown-red", "tower-gold"]).toContain(r);
          if (r === "chinatown-red") lanterns++;
          for (let z = 0; z < Math.min(...[0, m.sx - 1].map(wireZ)) - 6; z++) expect(m.get(x, 0, z)).toBe(0);
        }
        expect(lanterns).toBeGreaterThanOrEqual(4);
      }
    });

  it("are registered with the style's groups", () => {
    expect(Object.keys(CHINATOWN_GENERATORS).sort()).toEqual(["gate", "lanterns"]);
    expect(style.assets["landmark.gate"]!.generator).toBe("gate");
    expect(style.assets["prop.lanterns"]!.generator).toBe("lanterns");
  });
});
