/**
 * Style packs: palette ramps, strata, surface materials and roads. A style pack
 * is data (worlds/_styles/<id>/style.json); this module validates it and turns
 * it into the palette and lookup tables the baker and compositor use.
 *
 * Palette layout (256 entries, indexed color — see docs/architecture.md §8):
 *   0                      background / empty
 *   1 + ramp*SHADES + s    ramp `ramp`, shade s (0 = darkest/outline … 5 = lightest)
 *   INDEX_SILHOUETTE       occluded-player highlight
 */

export const SHADES = 6;
export const MAX_RAMPS = 42; // ramp 41, shade 5 → index 252, below the specials
export const INDEX_BACKGROUND = 0;
export const INDEX_SILHOUETTE = 253;
export const MAX_SURFACES = 16;
export const MAX_STRATA = 16; // bands per strata set
export const MAX_STRATA_SETS = 4;
export const MAX_PROVINCES = 16;
export const MAX_ROAD_CLASSES = 16;
/** Surface ramp value meaning "pick the ramp from the strata table by elevation". */
export const RAMP_STRATA = -1;

export const PATTERNS = { none: 0, trees: 1, speckle: 2, sparkle: 3, fields: 4, blocks: 5 } as const;
export type PatternName = keyof typeof PATTERNS;

export interface SurfaceStyle {
  ramp: string; // ramp name, or "strata"
  pattern: PatternName;
  density?: number;
}

export interface StrataBand {
  name: string;
  aboveMeters: number;
  ramp: string;
}

export interface RoadClassStyle {
  halfWidth: number; // in cells
  centerLine: boolean;
}

export interface StylePack {
  id: string;
  name: string;
  shades: number;
  background: string;
  silhouette: string;
  outline: { depthThreshold: number };
  ao: { strength: number };
  ramps: Record<string, string[]>;
  strataSets: Record<string, StrataBand[]>;
  /** Strata set for worlds or provinces without a mapping. */
  defaultStrata: string;
  /** Geology province name → strata set name. */
  provinces?: Record<string, string>;
  surfaces: Record<string, SurfaceStyle>;
  roads?: { asphalt: string; marking: string; classes: Record<string, RoadClassStyle> };
}

export class StyleError extends Error {}

export function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new StyleError(`bad color ${hex}`);
  const v = parseInt(m[1]!, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function validateStyle(style: StylePack): StylePack {
  if (style.shades !== SHADES) throw new StyleError(`style must use ${SHADES} shades`);
  const names = Object.keys(style.ramps);
  if (names.length > MAX_RAMPS) throw new StyleError(`too many ramps (${names.length})`);
  for (const [name, colors] of Object.entries(style.ramps)) {
    if (colors.length !== SHADES) throw new StyleError(`ramp ${name} needs ${SHADES} colors`);
    colors.forEach(parseHex);
  }
  parseHex(style.background);
  parseHex(style.silhouette);
  const sets = Object.entries(style.strataSets ?? {});
  if (sets.length === 0 || sets.length > MAX_STRATA_SETS)
    throw new StyleError(`strataSets must have 1..${MAX_STRATA_SETS} sets`);
  for (const [setName, bands] of sets) {
    if (bands.length === 0 || bands.length > MAX_STRATA)
      throw new StyleError(`strata set ${setName} must have 1..${MAX_STRATA} bands`);
    bands.forEach((band, i) => {
      if (!(band.ramp in style.ramps)) throw new StyleError(`strata ramp ${band.ramp} not defined`);
      if (i > 0 && band.aboveMeters >= bands[i - 1]!.aboveMeters)
        throw new StyleError(`strata set ${setName} must be ordered from highest to lowest`);
    });
  }
  if (!(style.defaultStrata in style.strataSets))
    throw new StyleError(`defaultStrata ${style.defaultStrata} is not a strata set`);
  for (const [province, set] of Object.entries(style.provinces ?? {}))
    if (!(set in style.strataSets)) throw new StyleError(`province ${province} uses unknown set ${set}`);
  for (const [name, s] of Object.entries(style.surfaces)) {
    if (s.ramp !== "strata" && !(s.ramp in style.ramps))
      throw new StyleError(`surface ${name} uses undefined ramp ${s.ramp}`);
    if (!(s.pattern in PATTERNS)) throw new StyleError(`surface ${name}: unknown pattern`);
  }
  if (style.roads) {
    for (const r of [style.roads.asphalt, style.roads.marking])
      if (!(r in style.ramps)) throw new StyleError(`road ramp ${r} not defined`);
  }
  return style;
}

export interface Palette {
  /** 256 RGBA entries. */
  rgba: Uint8Array;
  rampIds: Map<string, number>;
}

export function paletteIndex(rampId: number, shade: number): number {
  return 1 + rampId * SHADES + shade;
}

export function buildPalette(style: StylePack): Palette {
  validateStyle(style);
  const rgba = new Uint8Array(256 * 4);
  const put = (i: number, hex: string) => {
    const [r, g, b] = parseHex(hex);
    rgba.set([r, g, b, 255], i * 4);
  };
  put(INDEX_BACKGROUND, style.background);
  const rampIds = new Map<string, number>();
  Object.entries(style.ramps).forEach(([name, colors], rampId) => {
    rampIds.set(name, rampId);
    colors.forEach((hex, s) => put(paletteIndex(rampId, s), hex));
  });
  put(INDEX_SILHOUETTE, style.silhouette);
  return { rgba, rampIds };
}

/** What a world declares (manifest fields) that the tables depend on. */
export interface WorldVocabulary {
  /** Surface id (string key) → name. */
  surfaces: Record<string, string>;
  /** Road class id → name. */
  roadClasses?: Record<string, string>;
  /** Geology province id → name. */
  geology?: Record<string, string>;
}

/**
 * Shader lookup tables for one world under one style, packed for vec4/ivec4
 * uniform arrays (an array of scalars costs a whole vector slot per element).
 */
export interface MaterialTables {
  /** Per surface id: (ramp or RAMP_STRATA, pattern, density, 0). */
  surfaces: Float32Array;
  /** Strata band lower bounds in steps, set s band i at s*MAX_STRATA + i. */
  strataMin: Float32Array;
  strataRamp: Int32Array;
  strataCount: Int32Array;
  /** Geology province id → strata set index. */
  provinceSet: Int32Array;
  /** Per road class id: (half width in cells, centre line 0/1, 0, 0). */
  roads: Float32Array;
  asphaltRamp: number;
  markingRamp: number;
}

export function materialTables(
  style: StylePack,
  palette: Palette,
  world: WorldVocabulary,
  metersToSteps: (meters: number) => number,
): MaterialTables {
  const t: MaterialTables = {
    surfaces: new Float32Array(MAX_SURFACES * 4),
    strataMin: new Float32Array(MAX_STRATA_SETS * MAX_STRATA),
    strataRamp: new Int32Array(MAX_STRATA_SETS * MAX_STRATA),
    strataCount: new Int32Array(MAX_STRATA_SETS),
    provinceSet: new Int32Array(MAX_PROVINCES),
    roads: new Float32Array(MAX_ROAD_CLASSES * 4),
    asphaltRamp: palette.rampIds.get(style.roads?.asphalt ?? "") ?? 0,
    markingRamp: palette.rampIds.get(style.roads?.marking ?? "") ?? 0,
  };
  const ramp = (name: string) => palette.rampIds.get(name)!;

  const fallback = style.surfaces["none"] ?? { ramp: "strata", pattern: "none" as const };
  for (let id = 0; id < MAX_SURFACES; id++) {
    const name = world.surfaces[String(id)];
    const s = (name !== undefined ? style.surfaces[name] : undefined) ?? fallback;
    t.surfaces.set(
      [s.ramp === "strata" ? RAMP_STRATA : ramp(s.ramp), PATTERNS[s.pattern], s.density ?? 0, 0],
      id * 4,
    );
  }

  const setNames = Object.keys(style.strataSets);
  setNames.forEach((setName, s) => {
    const bands = style.strataSets[setName]!;
    t.strataCount[s] = bands.length;
    bands.forEach((band, i) => {
      t.strataMin[s * MAX_STRATA + i] = metersToSteps(band.aboveMeters);
      t.strataRamp[s * MAX_STRATA + i] = ramp(band.ramp);
    });
  });
  const defaultSet = setNames.indexOf(style.defaultStrata);
  t.provinceSet.fill(defaultSet);
  for (const [id, province] of Object.entries(world.geology ?? {})) {
    const set = style.provinces?.[province];
    if (set !== undefined) t.provinceSet[Number(id)] = setNames.indexOf(set);
  }

  for (const [id, cls] of Object.entries(world.roadClasses ?? {})) {
    const r = style.roads?.classes[cls];
    if (r) t.roads.set([r.halfWidth, r.centerLine ? 1 : 0, 0, 0], Number(id) * 4);
  }
  return t;
}
