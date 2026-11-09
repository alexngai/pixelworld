import { describe, expect, it } from "vitest";
import {
  BENCH_CASES,
  BENCH_ZOOMS,
  bakeSummary,
  percentile,
  reportText,
  summarize,
  type BenchReport,
  type TileBake,
} from "../src/benchReport";

const tile = (tx: number, meshMs: number, bakeMs: number): TileBake => ({ rotation: 0, tx, ty: 0, meshMs, bakeMs, vertices: 10 });

describe("bench report", () => {
  it("covers both regions' driving and walking levels at zooms 1 to 3", () => {
    expect(BENCH_CASES.map((c) => c.world).sort()).toEqual(["/sf-walk/", "/sf/", "/southwest-walk/", "/southwest/"]);
    expect(new Set(BENCH_CASES.map((c) => c.id)).size).toBe(BENCH_CASES.length);
    expect([...BENCH_ZOOMS].sort()).toEqual([1, 2, 3]);
  });

  it("summarises timings with nearest-rank percentiles", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(percentile([], 50)).toBeNaN();
    const s = summarize([30, 10, 20, 40])!;
    expect(s).toEqual({ n: 4, meanMs: 25, medianMs: 20, p95Ms: 40, maxMs: 40 });
    expect(summarize([])).toBeNull();
  });

  it("reports the first tile, which compiles the shaders, apart", () => {
    const tiles = [tile(0, 100, 900), tile(1, 5, 20), tile(2, 5, 30)];
    const all = bakeSummary(tiles, tiles[0]!);
    expect(all.firstMs).toBe(1000);
    expect(all.tile).toMatchObject({ n: 2, medianMs: 25, maxMs: 35 });
    expect(all.mesh?.meanMs).toBe(5);
    // a later zoom's tiles don't include the case's first tile
    const later = bakeSummary(tiles.slice(1), tiles[0]!);
    expect(later.firstMs).toBeNull();
    expect(later.tile?.n).toBe(2);
  });

  it("prints a copyable text report with every case, zoom and layer set", () => {
    const tiles = [tile(0, 2, 8), tile(1, 3, 9)];
    const report: BenchReport = {
      version: 1,
      date: "2026-11-09T00:00:00.000Z",
      userAgent: "test",
      renderer: "Test GPU",
      canvas: [1280, 720],
      devicePixelRatio: 1,
      cores: 8,
      cases: [
        {
          id: "sf-walk",
          label: "San Francisco, walking",
          world: "/sf-walk/",
          level: "walk",
          packageHash: "abc",
          rotation: 0,
          lon: 0,
          lat: 0,
          loadMs: 1200,
          bakeMode: "worker",
          bake: bakeSummary(tiles, tiles[0]!),
          zooms: [
            {
              zoom: 3,
              readyMs: 1200,
              tiles,
              bake: bakeSummary(tiles, tiles[0]!),
              frames: [
                { traffic: false, fog: false, drawMs: 1.5, frame: summarize([16.7, 16.6]), cpuMs: NaN, vehiclesDrawn: null, fogInView: null },
                { traffic: true, fog: true, drawMs: 2.5, frame: summarize([16.7, 16.8]), cpuMs: 1.2, vehiclesDrawn: 40, fogInView: false },
              ],
              memory: { tilesMB: 12.5, tilesOnGpu: 9, chunksLoaded: 4, jsHeapMB: null, trafficSprites: 30 },
            },
          ],
        },
        {
          id: "sw-drive",
          label: "Southwest, driving",
          world: "/southwest/",
          level: null,
          packageHash: null,
          rotation: 2,
          lon: 0,
          lat: 0,
          loadMs: NaN,
          bakeMode: "",
          bake: bakeSummary([]),
          zooms: [],
          error: "the app did not start",
        },
      ],
    };
    const text = reportText(report);
    expect(text).toContain("GPU: Test GPU");
    expect(text).toMatch(/sf-walk\s+3×\s+2\s+12\s+12\s+12/); // tiles, median, p95, max
    expect(text).toMatch(/sf-walk\s+all\s+1\s+12/); // the first tile apart
    expect(text).toContain("first tile 10 · worker");
    expect(text).toMatch(/traffic\+fog\s+2\.5\s+16\.8\s+1\.2\s+40 · none in view/);
    expect(text).toMatch(/none\s+1\.5\s+16\.7\s+–/);
    expect(text).toMatch(/sf-walk\s+3×\s+13 \(9\)\s+–\s+4\s+30/);
    expect(text).toContain("sw-drive  error: the app did not start");
  });
});
