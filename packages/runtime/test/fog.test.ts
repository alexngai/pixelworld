import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INDEX_BACKGROUND,
  INDEX_SILHOUETTE,
  SHADES,
  buildPalette,
  paletteIndex,
  validateStyle,
  type FogArea,
  type StylePack,
} from "@pixelworld/style";
import {
  FOG_NOISE_PERIOD,
  FOG_NOISE_TEXELS,
  buildFogField,
  fogAreaCoverage,
  fogInView,
  fogLevelStrength,
  fogLut,
  fogNoise,
  fogNoiseTile,
  fogPatchOffset,
  fogTimeScale,
  fogVertical,
  oklab,
  polygonSignedDistance,
  setupFog,
  type FogWorld,
} from "../src/fog";

const pack = (id: string) =>
  validateStyle(JSON.parse(readFileSync(join(__dirname, `../../../worlds/_styles/${id}/style.json`), "utf8")) as StylePack);
const bay = pack("bay-area");

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320;
/** A point `east` and `north` metres from a lon/lat. */
const offset = ([lon, lat]: [number, number], east: number, north: number): [number, number] => [
  lon + east / (M_PER_DEG_LON * Math.cos((lat * Math.PI) / 180)),
  lat + north / M_PER_DEG_LAT,
];

// a 10 km square west of the city, with a 1 km soft edge
const SW: [number, number] = [-122.6, 37.7];
const square = (density: number, edgeMeters?: number): FogArea => ({
  density,
  edgeMeters,
  polygon: [SW, offset(SW, 10_000, 0), offset(SW, 10_000, 10_000), offset(SW, 0, 10_000)],
});

describe("fog areas", () => {
  it("measures signed distance to a polygon's outline", () => {
    const xs = [0, 10, 10, 0];
    const ys = [0, 0, 10, 10];
    expect(polygonSignedDistance(xs, ys, 5, 5)).toBeCloseTo(-5);
    expect(polygonSignedDistance(xs, ys, 8, 5)).toBeCloseTo(-2);
    expect(polygonSignedDistance(xs, ys, 15, 5)).toBeCloseTo(5);
    expect(polygonSignedDistance(xs, ys, 10, 5)).toBeCloseTo(0);
    expect(polygonSignedDistance(xs, ys, -3, -4)).toBeCloseTo(5); // to the corner
  });

  it("covers an area fully inside, fades across an edge centred on its outline, and nothing beyond", () => {
    const areas = [square(0.8, 1000)];
    const at = (east: number, north: number) => fogAreaCoverage(areas, ...offset(SW, east, north));
    expect(at(5000, 5000)).toBeCloseTo(0.8, 5);
    expect(at(600, 5000)).toBeCloseTo(0.8, 5); // more than half an edge inside
    expect(at(0, 5000)).toBeCloseTo(0.4, 2); // on the outline: half
    expect(at(-250, 5000)).toBeGreaterThan(0);
    expect(at(-250, 5000)).toBeLessThan(0.4);
    expect(at(-600, 5000)).toBe(0);
    expect(at(30_000, 5000)).toBe(0);
    // thinning monotonically from inside to out
    const profile = [-600, -300, 0, 300, 600].map((e) => at(e, 5000));
    for (let i = 1; i < profile.length; i++) expect(profile[i]!).toBeGreaterThanOrEqual(profile[i - 1]!);
  });

  it("has hard edges without an edge width, and the densest of overlapping areas wins", () => {
    const hard = [square(0.5)];
    expect(fogAreaCoverage(hard, ...offset(SW, 10, 5000))).toBe(0.5);
    expect(fogAreaCoverage(hard, ...offset(SW, -10, 5000))).toBe(0);
    const both = [square(0.5), { ...square(0.9), polygon: square(0.9).polygon.map((p) => offset(p, 5000, 0)) }];
    expect(fogAreaCoverage(both, ...offset(SW, 2000, 5000))).toBe(0.5);
    expect(fogAreaCoverage(both, ...offset(SW, 7000, 5000))).toBe(0.9);
  });

  it("is thick on low ground, thins below its ceiling and is gone above it", () => {
    expect(fogVertical(0, 30, 20)).toBe(1);
    expect(fogVertical(10, 30, 20)).toBe(1);
    expect(fogVertical(20, 30, 20)).toBeCloseTo(0.5);
    expect(fogVertical(30, 30, 20)).toBe(0);
    expect(fogVertical(45, 30, 20)).toBe(0); // a tower top
  });

  it("is scaled per level, and compresses time like traffic", () => {
    const fog = bay.atmosphere!.fog!;
    expect(fogLevelStrength(fog, "walk")).toBe(0);
    expect(fogLevelStrength(fog, "drive")).toBe(1);
    expect(fogLevelStrength(fog, undefined)).toBe(1);
    expect(fogTimeScale(10, "walk")).toBe(1);
    expect(fogTimeScale(25, "drive")).toBeCloseTo(Math.pow(2.5, 0.75));
    expect(fogTimeScale(5, "drive")).toBe(1);
  });

  it("samples areas over a world's cells at texel centres, or gives no field when none reaches it", () => {
    // 1 cell = 100 m east and south of SW's north-west corner
    const nw = offset(SW, 0, 10_000);
    const toLonLat = (x: number, y: number) => offset(nw, x * 100, -y * 100);
    const field = buildFogField([square(0.8, 0)], toLonLat, 150, 120, 4)!;
    expect([field.width, field.height, field.cellsPerTexel]).toEqual([38, 30, 4]);
    expect(field.data[5 * field.width + 5]).toBe(Math.round(0.8 * 255)); // cells 22, 22: inside
    expect(field.data[5 * field.width + 30]).toBe(0); // cell 122: 12 km east, outside
    const far = (x: number, y: number) => offset([-100, 40], x * 100, -y * 100);
    expect(buildFogField([square(0.8, 1000)], far, 150, 120, 4)).toBeNull();
  });
});

describe("fog for a world", () => {
  const drive: FogWorld = {
    level: "drive",
    cellsX: 584,
    cellsY: 645,
    scale: { metersPerCell: 25, metersPerStep: 6.804138, elevationDatumMeters: 0 },
  };
  // San Francisco's drive level, roughly: 25 m cells from the north-west corner
  const toLonLat = (x: number, y: number) => offset([-122.52, 37.845], x * 25, -y * 25);

  it("resolves the bay-area pack's fog for the city's driving level", () => {
    const s = setupFog(bay, buildPalette(bay), drive, toLonLat)!;
    const fog = bay.atmosphere!.fog!;
    expect(s.ceiling).toBeCloseTo(fog.ceilingMeters / 6.804138);
    expect(s.fade).toBeCloseTo(fog.fadeMeters / 6.804138);
    expect(s.strength).toBe(1);
    expect(s.lut.levels).toBe(fog.veil.length);
    expect(s.field.cellsPerTexel).toBe(4);
    // the marine layer moves inland: east, a little south
    expect(s.drift[0]).toBeGreaterThan(0);
    expect(Math.abs(s.drift[1])).toBeLessThan(s.drift[0] / 4);
    expect(s.patchCells).toBeCloseTo(fog.drift!.sizeMeters / 25);
    // thickest over the Pacific off Ocean Beach, thinning inland, none over the Financial District
    const cover = (lon: number, lat: number) => fogAreaCoverage(fog.areas, lon, lat);
    const ocean = cover(-122.515, 37.76);
    const sunset = cover(-122.495, 37.755); // the Outer Sunset
    const peaks = cover(-122.4475, 37.7525); // Twin Peaks, which also rises above the ceiling
    expect(ocean).toBeGreaterThan(0.8);
    expect(sunset).toBeGreaterThan(0.4);
    expect(sunset).toBeLessThan(ocean);
    expect(peaks).toBeLessThan(sunset / 2);
    expect(cover(-122.4, 37.79)).toBe(0);
    expect(cover(-122.4775, 37.82)).toBeGreaterThan(0.8); // under the Golden Gate Bridge
  });

  it("is absent on levels that turn it off, without a geo grid, and for packs without fog", () => {
    const palette = buildPalette(bay);
    expect(setupFog(bay, palette, { ...drive, level: "walk" }, toLonLat)).toBeNull();
    expect(setupFog(bay, palette, drive, null)).toBeNull();
    const desert = pack("desert-southwest");
    expect(setupFog(desert, buildPalette(desert), drive, toLonLat)).toBeNull();
  });

  it("drifts as a function of time, wrapped to the noise's period", () => {
    const s = setupFog(bay, buildPalette(bay), drive, toLonLat)!;
    expect(fogPatchOffset(s, 0)).toEqual([0, 0]);
    const a = fogPatchOffset(s, 30);
    expect(a).toEqual(fogPatchOffset(s, 30));
    expect(a[0]).toBeCloseTo((s.drift[0] * 30) / s.patchCells);
    for (const t of [1e5, 1e7]) {
      const [x, y] = fogPatchOffset(s, t);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(FOG_NOISE_PERIOD);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(FOG_NOISE_PERIOD);
    }
  });
});

describe("fog's look", () => {
  const palette = buildPalette(bay);
  const fog = bay.atmosphere!.fog!;
  const emissive = Object.keys(bay.night!.emissive);
  const lut = fogLut(fog, palette, emissive);
  const lab = (i: number) => oklab(palette.rgba[i * 4]!, palette.rgba[i * 4 + 1]!, palette.rgba[i * 4 + 2]!);
  const chroma = (i: number) => Math.hypot(lab(i)[1], lab(i)[2]);
  const fogIndex = paletteIndex(palette.rampIds.get(fog.ramp)!, fog.shade);

  it("never veils the background or the silhouette, nor emissive ramps at night", () => {
    for (let l = 0; l < lut.levels; l++)
      for (const i of [INDEX_BACKGROUND, INDEX_SILHOUETTE]) {
        expect(lut.data[l * 256 + i]).toBe(i);
        expect(lut.data[(lut.levels + l) * 256 + i]).toBe(i);
      }
    const lit = paletteIndex(palette.rampIds.get("lit")!, 3);
    expect(lut.data[(lut.levels + 1) * 256 + lit]).toBe(lit); // a lit window glows through by night
    expect(lut.data[1 * 256 + lit]).not.toBe(lit); // and is veiled like glass by day
  });

  it("only pales a colour: never more saturated, never farther from the fog's lightness, never emissive", () => {
    const glows = new Set(emissive.map((n) => palette.rampIds.get(n)!));
    const L = lab(fogIndex)[0];
    for (let l = 0; l < lut.levels; l++)
      for (let r = 0; r < palette.rampIds.size; r++) {
        if (glows.has(r)) continue;
        for (let s = 1; s < SHADES; s++) {
          const i = paletteIndex(r, s);
          const o = lut.data[l * 256 + i]!;
          expect(glows.has(Math.floor((o - 1) / SHADES))).toBe(false);
          expect(chroma(o)).toBeLessThanOrEqual(chroma(i) + 0.011);
          expect(Math.abs(lab(o)[0] - L)).toBeLessThanOrEqual(Math.abs(lab(i)[0] - L) + 0.011);
        }
      }
    // the last level of the bay-area pack is the fog's own colour
    expect(fog.veil.at(-1)).toBe(1);
    expect(lut.data[(lut.levels - 1) * 256 + paletteIndex(palette.rampIds.get("water")!, 2)]).toBe(fogIndex);
  });

  it("drifts patches from a seamless, periodic noise tile", () => {
    expect(fogNoise(3.3 + FOG_NOISE_PERIOD, 7.7)).toBeCloseTo(fogNoise(3.3, 7.7), 12);
    expect(fogNoise(3.3, 7.7 - FOG_NOISE_PERIOD)).toBeCloseTo(fogNoise(3.3, 7.7), 12);
    const tile = fogNoiseTile();
    const n = FOG_NOISE_PERIOD * FOG_NOISE_TEXELS;
    expect(tile.length).toBe(n * n);
    let seam = 0;
    let inner = 0;
    for (let j = 0; j < n; j++) {
      seam = Math.max(seam, Math.abs(tile[j * n]! - tile[j * n + n - 1]!));
      inner = Math.max(inner, Math.abs(tile[j * n + 1]! - tile[j * n]!));
    }
    expect(seam).toBeLessThanOrEqual(inner + 1); // wrapping across the edge is like any step
    expect(Math.max(...tile) - Math.min(...tile)).toBeGreaterThan(120);
  });

  it("knows when a view has no fog, so the pass can be skipped", () => {
    const field = { width: 10, height: 10, cellsPerTexel: 4, data: new Uint8Array(100) };
    field.data[2 * 10 + 7] = 40; // cells 28–32, 8–12
    const ident = (sx: number, sy: number) => [sx, sy] as [number, number];
    expect(fogInView(field, { left: 20, top: 0, width: 10, height: 10 }, ident, [0, 1])).toBe(true);
    expect(fogInView(field, { left: 0, top: 20, width: 10, height: 10 }, ident, [0, 1])).toBe(false);
    // the height range widens the cells under the view
    const lean = (sx: number, sy: number, h: number) => [sx, sy + h] as [number, number];
    expect(fogInView(field, { left: 20, top: 25, width: 10, height: 5 }, lean, [-20, 0])).toBe(true);
  });
});
