import { describe, expect, it } from "vitest";
import styleJson from "../../../worlds/_styles/desert-southwest/style.json";
import {
  INDEX_SILHOUETTE,
  MAX_STRATA,
  PATTERNS,
  RAMP_STRATA,
  StyleError,
  buildPalette,
  materialTables,
  paletteIndex,
  validateStyle,
  type FogStyle,
  type StylePack,
} from "../src/index";

const style = styleJson as unknown as StylePack;

describe("desert-southwest style pack", () => {
  it("validates", () => {
    expect(() => validateStyle(style)).not.toThrow();
  });

  it("lays out ramps below the special indices", () => {
    const p = buildPalette(style);
    const last = paletteIndex(p.rampIds.size - 1, 5);
    expect(last).toBeLessThan(INDEX_SILHOUETTE);
    expect(Array.from(p.rgba.slice(INDEX_SILHOUETTE * 4, INDEX_SILHOUETTE * 4 + 3))).toEqual([
      0xff, 0xe3, 0x6e,
    ]);
  });

  it("maps provinces to strata sets and falls back to the default set", () => {
    const p = buildPalette(style);
    const t = materialTables(
      style,
      p,
      { surfaces: { "1": "rock", "2": "urban" }, geology: { "0": "basin-and-range", "1": "colorado-plateau", "2": "unknown" } },
      (m) => m / 100,
    );
    const sets = Object.keys(style.strataSets);
    expect(t.provinceSet[0]).toBe(sets.indexOf("desert-ranges"));
    expect(t.provinceSet[1]).toBe(sets.indexOf("grand-canyon"));
    expect(t.provinceSet[2]).toBe(sets.indexOf("grand-canyon")); // defaultStrata
    const gc = sets.indexOf("grand-canyon");
    expect(t.strataMin[gc * MAX_STRATA]).toBeCloseTo(20.5); // Kaibab above 2050 m at 100 m/step
    expect(t.strataCount[gc]).toBe(style.strataSets["grand-canyon"]!.length);
    expect(t.surfaces[1 * 4]).toBe(RAMP_STRATA);
    expect(t.surfaces[2 * 4 + 1]).toBe(PATTERNS.blocks);
  });

  it("builds road tables from the world's class ids", () => {
    const p = buildPalette(style);
    const t = materialTables(style, p, { surfaces: {}, roadClasses: { "4": "motorway", "1": "secondary" } }, (m) => m);
    expect(t.roads[4 * 4]).toBeCloseTo(0.2);
    expect(t.roads[4 * 4 + 1]).toBe(1);
    expect(t.roads[1 * 4 + 1]).toBe(0);
    expect(t.roads[2 * 4]).toBe(0); // undeclared class → no road
    expect(t.asphaltRamp).toBe(p.rampIds.get("asphalt"));
  });

  it("builds path tables: a ramp per class, stripes for crosswalks", () => {
    const p = buildPalette(style);
    const vocab = { surfaces: {}, pathClasses: { "1": "footway", "3": "crosswalk", "4": "unknown" } };
    const t = materialTables(style, p, vocab, (m) => m);
    expect(t.paths[1 * 4]).toBe(p.rampIds.get("concrete"));
    expect(t.paths[1 * 4 + 1]).toBe(0);
    expect(t.paths[3 * 4]).toBe(p.rampIds.get("concrete"));
    expect(t.paths[3 * 4 + 1]).toBe(1);
    expect(t.paths[4 * 4]).toBe(-1); // a class the style doesn't know stays undrawn
    expect(t.roads[4 * 4 + 2]).toBe(0); // no world road classes → empty table
  });

  it("keeps road widths in pixels on fine worlds, at most a cell wide", () => {
    const p = buildPalette(style);
    const vocab = { surfaces: {}, roadClasses: { "4": "motorway", "1": "secondary" } };
    const t = materialTables(style, p, vocab, (m) => m, 0.25);
    expect(t.roads[1 * 4]).toBeCloseTo(0.28); // 0.07 render units = 0.28 cells at 1/4
    expect(t.roads[4 * 4]).toBe(0.5); // 0.8 clamps to the cell
  });

  it("builds a night palette: same indices, dimmed ramps, glowing emissive ramps", () => {
    const day = buildPalette(style);
    const night = buildPalette(style, "night");
    expect([...night.rampIds]).toEqual([...day.rampIds]);
    const rgb = (pal: typeof day, ramp: string, shade: number) => {
      const i = paletteIndex(pal.rampIds.get(ramp)!, shade) * 4;
      return Array.from(pal.rgba.slice(i, i + 3));
    };
    const lum = ([r, g, b]: number[]) => 0.299 * r! + 0.587 * g! + 0.114 * b!;
    // ordinary ramps get darker and bluer
    const dDay = rgb(day, "desert", 4);
    const dNight = rgb(night, "desert", 4);
    expect(lum(dNight)).toBeLessThan(lum(dDay) * 0.5);
    expect(dNight[2]!).toBeGreaterThan(dNight[0]!);
    // lit windows look like glass by day and glow at night
    expect(rgb(day, "lit", 3)).toEqual(rgb(day, "glass", 3));
    expect(lum(rgb(night, "lit", 3))).toBeGreaterThan(lum(rgb(day, "lit", 3)));
    expect(rgb(night, "lit", 3)).toEqual([0xf2, 0xb7, 0x48]);
  });

  it("validates asset roles and night ramps", () => {
    expect(() =>
      validateStyle({ ...style, assets: { x: { generator: "blob", ramps: { body: "nope" } } } }),
    ).toThrow(StyleError);
    expect(() =>
      validateStyle({ ...style, night: { ...style.night!, emissive: { nope: style.ramps.lit! } } }),
    ).toThrow(StyleError);
    const { night: _night, ...dayOnly } = style;
    expect(() => buildPalette(dayOnly, "night")).toThrow(StyleError);
  });

  it("rejects broken packs", () => {
    expect(() => validateStyle({ ...style, defaultStrata: "nope" })).toThrow(StyleError);
    expect(() =>
      validateStyle({ ...style, provinces: { x: "missing-set" } }),
    ).toThrow(StyleError);
  });

  it("validates an atmosphere's fog: ramps, veil levels, areas, drift and levels", () => {
    const fog: FogStyle = {
      ramp: "sand",
      shade: 5,
      veil: [0.3, 0.6, 1],
      ceilingMeters: 200,
      fadeMeters: 100,
      areas: [{ name: "box", density: 0.8, edgeMeters: 500, polygon: [[-115, 36], [-114, 36], [-114, 37]] }],
      drift: { speed: 4, toward: 90, sizeMeters: 400, contrast: 0.5 },
      levels: { walk: 0 },
      night: { density: 0.5 },
    };
    const withFog = (f: Partial<FogStyle>) => ({ ...style, atmosphere: { fog: { ...fog, ...f } } });
    expect(() => validateStyle(withFog({}))).not.toThrow();
    expect(() => validateStyle(withFog({ ramp: "nope" }))).toThrow(StyleError);
    expect(() => validateStyle(withFog({ shade: 6 }))).toThrow(StyleError);
    expect(() => validateStyle(withFog({ veil: [0.6, 0.3] }))).toThrow(StyleError); // must increase
    expect(() => validateStyle(withFog({ veil: [] }))).toThrow(StyleError);
    expect(() => validateStyle(withFog({ fadeMeters: 0 }))).toThrow(StyleError);
    expect(() => validateStyle(withFog({ areas: [{ density: 0.5, polygon: [[0, 0], [1, 1]] }] }))).toThrow(StyleError);
    expect(() => validateStyle(withFog({ areas: [{ density: 1.5, polygon: [[0, 0], [1, 1], [1, 0]] }] }))).toThrow(StyleError);
    expect(() => validateStyle(withFog({ areas: [{ density: 1, polygon: [[0, 0], [1, 100], [1, 0]] }] }))).toThrow(StyleError);
    expect(() => validateStyle(withFog({ drift: { speed: 1, toward: 0, sizeMeters: 0, contrast: 0 } }))).toThrow(StyleError);
    expect(() => validateStyle(withFog({ levels: { fly: -1 } }))).toThrow(StyleError);
  });
});
