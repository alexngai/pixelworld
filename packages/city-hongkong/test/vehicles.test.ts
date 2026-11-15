import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateModel, type AssetCatalog, type VoxelModel } from "pixelworld/generators";
import { register as registerSf } from "@pixelworlds/city-sf";
import { register } from "../src/index";

await register();
await registerSf();

/** The double-deckers (D-133): reshaped from the traffic layer's box, two decks of windows, liveries by seed; and the boats. */
const style = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../worlds/_styles/hongkong/style.json", import.meta.url)), "utf8"),
) as { assets: AssetCatalog; ramps: Record<string, string[]> };
const rampIds = new Map(Object.keys(style.ramps).map((name, i) => [name, i + 1]));
const rampName = new Map([...rampIds].map(([n, i]) => [i, n]));

// what the traffic layer gives at the walking level (10 m cells): a streetcar 15 × 2.6 × 3.3 m, a bus 12 × 2.6 × 3.1 m
const STREETCAR = { length: 24, width: 4, height: 7 };
const BUS = { length: 19, width: 4, height: 7 };

const gen = (group: string, seed: number, size: { length: number; width: number; height: number }) =>
  generateModel(style.assets, rampIds, group, { seed, size });

/** The z of every voxel of the given ramps on a side (y = 0) of the model. */
function sideRows(m: VoxelModel, ...ramps: string[]): Set<number> {
  const rows = new Set<number>();
  for (let z = 0; z < m.sz; z++)
    for (let x = 0; x < m.sx; x++) {
      const v = m.get(x, 0, z);
      if (v && ramps.includes(rampName.get(m.materials[v]!) ?? "")) rows.add(z);
    }
  return rows;
}

describe("Hong Kong's double-deckers", () => {
  it("draws a tram shorter, narrower and taller than the streetcar box, with windows on both decks", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const m = gen("vehicle.streetcar", seed, STREETCAR);
      expect(m.sx).toBeLessThan(STREETCAR.length);
      expect(m.sy).toBeLessThan(STREETCAR.width);
      expect(m.sz).toBeGreaterThanOrEqual(Math.round(STREETCAR.height * 1.4));
      const rows = [...sideRows(m, "lit")].sort((a, b) => a - b);
      const gap = rows.findIndex((z, i) => i > 0 && z - rows[i - 1]! > 1);
      expect(gap, `two separate rows of windows (seed ${seed}: ${rows})`).toBeGreaterThan(0);
      for (const r of m.materials.slice(1)) expect(rampName.has(r), `ramp ${r}`).toBe(true);
    }
  });

  it("paints most trams in an advert's colour and some in the classic green and cream", () => {
    const bodies = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const m = gen("vehicle.streetcar", seed, STREETCAR);
      bodies.add(rampName.get(m.materials[m.get(Math.floor(m.sx / 2), 0, 1)]!)!);
    }
    expect(bodies.has("jade")).toBe(true);
    expect(bodies.size).toBeGreaterThanOrEqual(4);
  });

  it("draws a bus as tall as two decks, its windscreen and panoramic window at the front", () => {
    const m = gen("vehicle.bus", 3, BUS);
    expect(m.sx).toBe(BUS.length);
    expect(m.sz).toBe(Math.round(BUS.height * 1.4));
    const front = new Set<number>();
    for (let z = 0; z < m.sz; z++) {
      const v = m.get(m.sx - 1, Math.floor(m.sy / 2), z);
      if (v && rampName.get(m.materials[v]!) === "lit") front.add(z);
    }
    expect(front.size).toBeGreaterThanOrEqual(4);
    expect([...sideRows(m, "lit")].length).toBeGreaterThanOrEqual(4);
  });

  it("falls back to a plain body where a level draws vehicles a few voxels long", () => {
    for (const group of ["vehicle.streetcar", "vehicle.bus"]) {
      const m = gen(group, 1, { length: 4, width: 2, height: 3 });
      expect(m.sx).toBeLessThanOrEqual(4);
      expect(m.sz).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("Hong Kong's boats", () => {
  const boat = (group: string, seed: number) => generateModel(style.assets, rampIds, group, { seed });
  it("moors sampans and fishing boats, their bows narrowing", () => {
    const lengths = new Set<number>();
    for (let seed = 1; seed <= 30; seed++) {
      const m = boat("prop.boat", seed);
      lengths.add(m.sx);
      for (const r of m.materials.slice(1)) expect(rampName.has(r), `ramp ${r}`).toBe(true);
      let stern = 0;
      let bow = 0;
      for (let y = 0; y < m.sy; y++) {
        if (m.get(0, y, 0)) stern++;
        if (m.get(m.sx - 1, y, 0)) bow++;
      }
      expect(bow).toBeLessThan(stern);
    }
    expect([...lengths].sort((a, b) => a - b)).toEqual([11, 24]);
  });

  it("rigs a junk with red sails on two masts", () => {
    const m = boat("prop.boat.junk", 1);
    const red = m.materials.findIndex((r, i) => i > 0 && rampName.get(r) === "taxi");
    let sail = 0;
    for (const v of m.data) if (v === red) sail++;
    expect(sail).toBeGreaterThan(60);
    expect(m.sz).toBeGreaterThan(20);
  });
});
