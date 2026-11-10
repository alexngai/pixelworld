import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateModel, modelBoxes, type AssetCatalog, type VoxelModel } from "../src/index";

/**
 * Traffic vehicles (D-064): every style pack's `vehicle.*` models fill the
 * size the traffic layer asks for, stay in the pack's ramps, hang together,
 * and vary by seed.
 */
function pack(name: string) {
  const style = JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../worlds/_styles/${name}/style.json`, import.meta.url)), "utf8"),
  ) as { assets: AssetCatalog; ramps: Record<string, string[]> };
  const rampIds = new Map(Object.keys(style.ramps).map((n, i) => [n, i + 1]));
  return { assets: style.assets, rampIds };
}
const PACKS = ["bay-area", "desert-southwest"].map((n) => ({ name: n, ...pack(n) }));
const KINDS = ["car", "bus", "cablecar", "streetcar", "lightrail", "train", "ferry"] as const;

/** Voxel sizes per kind on the levels (vehicleVoxels): driving, walking, flying, a coarse driving level. */
const SIZES: Record<(typeof KINDS)[number], [number, number, number][]> = {
  car: [[9, 4, 5], [9, 4, 9], [3, 1, 2], [9, 4, 4]],
  bus: [[14, 5, 11], [19, 6, 12], [5, 2, 4], [14, 5, 18]],
  cablecar: [[12, 5, 11], [14, 5, 12], [4, 2, 4]],
  streetcar: [[16, 4, 10], [24, 5, 11], [5, 1, 3]],
  lightrail: [[20, 4, 9], [37, 5, 11], [7, 2, 3]],
  train: [[18, 4, 7], [32, 5, 13], [6, 2, 3], [18, 5, 12]],
  ferry: [[26, 10, 11], [64, 19, 20], [9, 2, 3]],
};

/** Voxels not joined face to face to the model's largest part. */
function loose(m: VoxelModel): number {
  const seen = new Uint8Array(m.sx * m.sy * m.sz);
  const idx = (x: number, y: number, z: number) => (z * m.sy + y) * m.sx + x;
  let total = 0;
  let largest = 0;
  for (let z = 0; z < m.sz; z++)
    for (let y = 0; y < m.sy; y++)
      for (let x = 0; x < m.sx; x++) {
        if (!m.get(x, y, z)) continue;
        total++;
        if (seen[idx(x, y, z)]) continue;
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
        largest = Math.max(largest, n);
      }
  return total - largest;
}

const model = (p: (typeof PACKS)[number], kind: string, seed: number, size: [number, number, number], part = 0, variant = 0) =>
  generateModel(p.assets, p.rampIds, `vehicle.${kind}`, {
    seed,
    size: { length: size[0], width: size[1], height: size[2] },
    part,
    variant,
  });

describe("traffic vehicle models", () => {
  for (const p of PACKS)
    it(`${p.name}: fill their size, use the pack's ramps and hang together`, () => {
      const ramps = new Set(p.rampIds.values());
      for (const kind of KINDS)
        for (const size of SIZES[kind])
          for (let seed = 1; seed <= 12; seed++)
            for (const part of kind === "train" ? [0, 1, 2, 3, 4] : kind === "lightrail" ? [0, 1] : [0]) {
              const m = model(p, kind, seed, size, part, seed);
              const what = `${kind} ${size.join("×")} seed ${seed} part ${part}`;
              expect([m.sx, m.sy], what).toEqual([size[0], size[1]]);
              expect(m.sz, what).toBeGreaterThanOrEqual(size[2]);
              expect(m.sz, what).toBeLessThanOrEqual(size[2] + 12);
              expect(m.count(), what).toBeGreaterThan(0);
              for (const id of m.materials.slice(1)) expect(ramps.has(id), what).toBe(true);
              expect(loose(m), what).toBe(0);
            }
    });

  it("are the same for the same seed", () => {
    const p = PACKS[0]!;
    for (const kind of KINDS) {
      const size = SIZES[kind][0]!;
      expect(model(p, kind, 7, size, 1, 1).data).toEqual(model(p, kind, 7, size, 1, 1).data);
    }
  });

  it("cars come in several body types, with wheels showing on both sides", () => {
    const p = PACKS[0]!;
    const shapes = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      const m = model(p, "car", seed, [9, 4, 5]);
      shapes.add(Array.from(m.data, (v) => (v ? 1 : 0)).join(""));
      let near = 0;
      let far = 0;
      for (let x = 0; x < m.sx; x++) {
        if (m.get(x, 0, 0)) near++;
        if (m.get(x, m.sy - 1, 0)) far++;
      }
      expect(near).toBeGreaterThanOrEqual(2);
      expect(far).toBeGreaterThanOrEqual(2);
    }
    expect(shapes.size).toBeGreaterThanOrEqual(6);
  });

  it("a train's locomotive differs from its wagons, and freight wagons vary", () => {
    const p = PACKS[0]!;
    const size: [number, number, number] = [18, 4, 7];
    const shape = (m: VoxelModel) => Array.from(m.data, (v) => (v ? 1 : 0)).join("");
    const loco = shape(model(p, "train", 3, size, 0, 0));
    const wagons = new Set<string>();
    for (let seed = 1; seed <= 8; seed++) for (const part of [1, 2, 3, 4]) wagons.add(shape(model(p, "train", seed, size, part, 0)));
    expect(wagons.has(loco)).toBe(false);
    expect(wagons.size).toBeGreaterThanOrEqual(4);
    // passenger trains (odd variants) have coaches with windows
    const coach = model(p, "train", 3, size, 2, 1);
    const win = p.rampIds.get("lit")!;
    expect(coach.materials.includes(win)).toBe(true);
  });

  it("become boxes that cover their voxels exactly", () => {
    const p = PACKS[0]!;
    for (const kind of KINDS) {
      const m = model(p, kind, 5, SIZES[kind][0]!);
      const boxes = modelBoxes(m, { h: 1, v: 1 });
      const volume = boxes.reduce((s, b) => s + (b.x1 - b.x0) * (b.y1 - b.y0) * (b.z1 - b.z0), 0);
      expect(volume).toBeCloseTo(m.count(), 6);
      expect(boxes.length).toBeLessThan(m.count()); // runs merge
      for (const b of boxes) expect(m.materials.includes(b.ramp)).toBe(true);
      // centred on the origin, standing on z = 0
      const minX = Math.min(...boxes.map((b) => b.x0));
      const maxX = Math.max(...boxes.map((b) => b.x1));
      expect(minX + maxX).toBeCloseTo(0, 6);
      expect(Math.min(...boxes.map((b) => b.z0))).toBe(0);
    }
  });
});

/**
 * The player's vehicles (M4): a car in the pack's player paint, and a light
 * aircraft with its drop shadow (`vehicle.plane`, part 1).
 */
describe("player vehicles", () => {
  const PLANE_SIZES: [number, number, number][] = [
    [20, 22, 7], // the flying levels
    [12, 13, 5],
    [6, 6, 2], // too small for detail
  ];

  for (const p of PACKS)
    it(`${p.name}: a plane fills its size, uses the pack's ramps and hangs together`, () => {
      const ramps = new Set(p.rampIds.values());
      for (const size of PLANE_SIZES)
        for (let seed = 1; seed <= 12; seed++) {
          const m = model(p, "plane", seed, size);
          const what = `plane ${size.join("×")} seed ${seed}`;
          expect([m.sx, m.sy, m.sz], what).toEqual(size);
          for (const id of m.materials.slice(1)) expect(ramps.has(id), what).toBe(true);
          expect(loose(m), what).toBe(0);
          // the wing spans the model
          const wingZ = size[2] > 3 ? Math.max(2, Math.min(size[2] - 2, Math.round(size[2] * 0.55))) : 1;
          let span = 0;
          for (let v = 0; v < m.sy; v++)
            for (let u = 0; u < m.sx; u++)
              if (m.get(u, v, wingZ)) {
                span++;
                break;
              }
          expect(span, what).toBe(m.sy);
          // symmetric about its centre line (the propeller's blades aside)
          for (let z = 0; z < m.sz; z++)
            for (let v = 0; v < m.sy; v++)
              for (let u = 0; u < m.sx - 1; u++) expect(!!m.get(u, v, z), `${what} at ${u},${v},${z}`).toBe(!!m.get(u, m.sy - 1 - v, z));
        }
    });

  it("planes come in several liveries by seed", () => {
    const p = PACKS[0]!;
    const liveries = new Set<string>();
    for (let seed = 1; seed <= 24; seed++) liveries.add(model(p, "plane", seed, [20, 22, 7]).materials.join(","));
    expect(liveries.size).toBeGreaterThanOrEqual(2);
  });

  it("a plane's shadow is its outline from above, one voxel thick and dithered", () => {
    for (const p of PACKS) {
      const plane = model(p, "plane", 3, [20, 22, 7]);
      const shadow = model(p, "plane", 3, [20, 22, 7], 1);
      expect([shadow.sx, shadow.sy, shadow.sz]).toEqual([20, 22, 1]);
      expect(shadow.materials.slice(1)).toEqual([p.rampIds.get("asphalt")]);
      let outline = 0;
      for (let v = 0; v < 22; v++)
        for (let u = 0; u < 20; u++) {
          let any = false;
          for (let z = 0; z < plane.sz; z++) any ||= plane.get(u, v, z) > 0;
          if (any) outline++;
          const s = shadow.get(u, v, 0) > 0;
          // every other voxel of the outline, so the ground shows through
          expect(s).toBe(any && (u + v) % 2 === 0);
          if (s) expect(shadow.get(u + 1, v, 0) || shadow.get(u, v + 1, 0)).toBe(0);
        }
      expect(shadow.count()).toBeGreaterThan(outline * 0.4);
    }
  });

  it("the player's car is a car in the pack's own player paint", () => {
    for (const p of PACKS) {
      const paint = p.rampIds.get(p.name === "bay-area" ? "bridge-orange" : "neon-cyan")!;
      for (let seed = 1; seed <= 8; seed++) {
        const m = generateModel(p.assets, p.rampIds, "vehicle.car.player", { seed, size: { length: 11, width: 5, height: 5 } });
        expect([m.sx, m.sy]).toEqual([11, 5]);
        expect(m.materials).toContain(paint);
        expect(loose(m)).toBe(0);
      }
    }
  });
});
