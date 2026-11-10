import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { GeoGrid } from "../src/geo";

// a smooth, slightly curved map: 50 × 30 cells of roughly 900 m
const lonAt = (x: number, y: number) => -115 + 0.01 * x + 0.0004 * Math.sin(y / 5);
const latAt = (x: number, y: number) => 36.2 - 0.008 * y + 0.0003 * x + 0.00001 * x * y;

function encode(cellsX: number, cellsY: number, step: number): { buf: ArrayBuffer; nx: number; ny: number } {
  const xs = [...Array(Math.ceil(cellsX / step)).keys()].map((i) => i * step).concat(cellsX);
  const ys = [...Array(Math.ceil(cellsY / step)).keys()].map((j) => j * step).concat(cellsY);
  const out = new Int32Array(xs.length * ys.length * 2);
  ys.forEach((y, j) => {
    let pa = 0;
    let pb = 0;
    xs.forEach((x, i) => {
      const a = Math.round(lonAt(x, y) * 1e6);
      const b = Math.round(latAt(x, y) * 1e6);
      out[(j * xs.length + i) * 2] = a - pa;
      out[(j * xs.length + i) * 2 + 1] = b - pb;
      pa = a;
      pb = b;
    });
  });
  const z = gzipSync(Buffer.from(out.buffer));
  return { buf: z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength) as ArrayBuffer, nx: xs.length, ny: ys.length };
}

describe("geo grid", () => {
  it("decodes the delta-coded file and interpolates between grid points", async () => {
    const { buf, nx, ny } = encode(50, 30, 4);
    expect([nx, ny]).toEqual([14, 9]); // 0, 4, …, 48, 50 and 0, 4, …, 28, 30
    const g = await GeoGrid.decode(buf, nx, ny, 4, 50, 30);
    const [lon, lat] = g.cellToLonLat(48, 28);
    expect(lon).toBeCloseTo(lonAt(48, 28), 6);
    expect(lat).toBeCloseTo(latAt(48, 28), 6);
    const [lon2, lat2] = g.cellToLonLat(21.3, 13.7);
    expect(lon2).toBeCloseTo(lonAt(21.3, 13.7), 4);
    expect(lat2).toBeCloseTo(latAt(21.3, 13.7), 4);
  });

  it("finds the cell of a lon/lat, and nothing outside the world", async () => {
    const { buf, nx, ny } = encode(50, 30, 4);
    const g = await GeoGrid.decode(buf, nx, ny, 4, 50, 30);
    for (const [x, y] of [
      [0.5, 0.5],
      [21.3, 13.7],
      [49.2, 29.9],
      [33, 4],
    ] as const) {
      const [lon, lat] = g.cellToLonLat(x, y);
      const cell = g.lonLatToCell(lon, lat);
      expect(cell).not.toBeNull();
      expect(cell![0]).toBeCloseTo(x, 3);
      expect(cell![1]).toBeCloseTo(y, 3);
    }
    expect(g.lonLatToCell(-114.0, 36.1)).toBeNull(); // 50 km east of the world
  });
});
