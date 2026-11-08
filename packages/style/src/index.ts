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
  halfWidth: number; // in render units (cells at render scale 1)
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
  /** Semantic asset groups → generator, role ramps and parameters (D-030). */
  assets?: Record<string, AssetStyle>;
  /**
   * Object look shared by every asset group. `surfaces` replaces surface
   * styles when a world has objects (real buildings make the block pattern redundant).
   */
  objects?: { heightStretch: number; variants: number; surfaces?: Record<string, SurfaceStyle> };
  /** Night palette variant: everything darkens except emissive ramps. */
  night?: NightStyle;
}

export interface AssetStyle {
  generator: string;
  ramps: Record<string, string>;
  params?: Record<string, number | number[]>;
}

export interface NightStyle {
  background: string;
  /** 0 = greyscale, 1 = day saturation (applied before tinting). */
  saturation: number;
  /** Per-channel (r, g, b) multiplier for non-emissive ramps. */
  multiply: number[];
  /** Per-channel (r, g, b) offset (0–255) added after multiplying. */
  add: number[];
  /** Ramps that glow at night: their night colors (same shade count). */
  emissive: Record<string, string[]>;
}

export type PaletteVariant = "day" | "night";

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
  for (const [group, a] of Object.entries(style.assets ?? {}))
    for (const [role, ramp] of Object.entries(a.ramps))
      if (!(ramp in style.ramps)) throw new StyleError(`asset ${group} role ${role} uses undefined ramp ${ramp}`);
  if (style.night) {
    parseHex(style.night.background);
    if (style.night.multiply.length !== 3 || style.night.add.length !== 3)
      throw new StyleError("night multiply and add need 3 channels");
    for (const [name, colors] of Object.entries(style.night.emissive)) {
      if (!(name in style.ramps)) throw new StyleError(`night emissive ramp ${name} not defined`);
      if (colors.length !== SHADES) throw new StyleError(`night ramp ${name} needs ${SHADES} colors`);
      colors.forEach(parseHex);
    }
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

/**
 * The 256-entry palette. Indices never change between variants, so a baked
 * tile can be shown by day or by night by swapping the palette alone.
 */
export function buildPalette(style: StylePack, variant: PaletteVariant = "day"): Palette {
  validateStyle(style);
  const night = variant === "night" ? style.night : undefined;
  if (variant === "night" && !night) throw new StyleError(`style ${style.id} has no night palette`);
  const rgba = new Uint8Array(256 * 4);
  const put = (i: number, hex: string, dim = false) => {
    let [r, g, b] = parseHex(hex);
    if (dim && night) {
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      const sat = night.saturation;
      const c = [l + (r - l) * sat, l + (g - l) * sat, l + (b - l) * sat].map((v, k) =>
        Math.round(Math.min(255, Math.max(0, v * night.multiply[k]! + night.add[k]!))),
      );
      [r, g, b] = c as [number, number, number];
    }
    rgba.set([r, g, b, 255], i * 4);
  };
  put(INDEX_BACKGROUND, night ? night.background : style.background);
  const rampIds = new Map<string, number>();
  Object.entries(style.ramps).forEach(([name, colors], rampId) => {
    rampIds.set(name, rampId);
    const glow = night?.emissive[name];
    if (glow) glow.forEach((hex, s) => put(paletteIndex(rampId, s), hex));
    else colors.forEach((hex, s) => put(paletteIndex(rampId, s), hex, true));
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
  /** Render units per cell: road widths are in render units and keep their pixel size. */
  renderScale = 1,
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
    // Widths are in render units; on fine worlds a road fills at most its own cells.
    if (r) t.roads.set([Math.min(0.5, r.halfWidth / renderScale), r.centerLine ? 1 : 0, 0, 0], Number(id) * 4);
  }
  return t;
}
