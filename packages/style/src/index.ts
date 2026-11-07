/**
 * Style packs: palette ramps, strata and surface materials. A style pack is
 * data (worlds/_styles/<id>/style.json); this module validates it and turns it
 * into the palette and lookup tables the baker and compositor use.
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
export const MAX_STRATA = 16;
/** Surface ramp value meaning "pick the ramp from the strata table by elevation". */
export const RAMP_STRATA = -1;

export const PATTERNS = { none: 0, trees: 1, speckle: 2, sparkle: 3 } as const;
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

export interface StylePack {
  id: string;
  name: string;
  shades: number;
  background: string;
  silhouette: string;
  outline: { depthThreshold: number };
  ao: { strength: number };
  ramps: Record<string, string[]>;
  strata: StrataBand[];
  surfaces: Record<string, SurfaceStyle>;
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
  if (style.strata.length === 0 || style.strata.length > MAX_STRATA)
    throw new StyleError("strata must have 1..16 bands");
  for (let i = 0; i < style.strata.length; i++) {
    const band = style.strata[i]!;
    if (!(band.ramp in style.ramps)) throw new StyleError(`strata ramp ${band.ramp} not defined`);
    if (i > 0 && band.aboveMeters >= style.strata[i - 1]!.aboveMeters)
      throw new StyleError("strata must be ordered from highest to lowest");
  }
  for (const [name, s] of Object.entries(style.surfaces)) {
    if (s.ramp !== "strata" && !(s.ramp in style.ramps))
      throw new StyleError(`surface ${name} uses undefined ramp ${s.ramp}`);
    if (!(s.pattern in PATTERNS)) throw new StyleError(`surface ${name}: unknown pattern`);
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

/** Shader lookup tables for one world (its surface ids) under one style. */
export interface MaterialTables {
  surfRamp: Int32Array; // per surface id; RAMP_STRATA for strata
  surfPattern: Int32Array;
  surfDensity: Float32Array;
  strataMinStep: Float32Array; // band lower bound, in height steps
  strataRamp: Int32Array;
  strataCount: number;
}

export function materialTables(
  style: StylePack,
  palette: Palette,
  surfaces: Record<string, string>,
  scale: { metersPerStep: number; elevationDatumMeters: number },
): MaterialTables {
  const t: MaterialTables = {
    surfRamp: new Int32Array(MAX_SURFACES),
    surfPattern: new Int32Array(MAX_SURFACES),
    surfDensity: new Float32Array(MAX_SURFACES),
    strataMinStep: new Float32Array(MAX_STRATA),
    strataRamp: new Int32Array(MAX_STRATA),
    strataCount: style.strata.length,
  };
  const fallback = style.surfaces["none"] ?? { ramp: "strata", pattern: "none" as const };
  for (let id = 0; id < MAX_SURFACES; id++) {
    const name = surfaces[String(id)];
    const s = (name !== undefined ? style.surfaces[name] : undefined) ?? fallback;
    t.surfRamp[id] = s.ramp === "strata" ? RAMP_STRATA : palette.rampIds.get(s.ramp)!;
    t.surfPattern[id] = PATTERNS[s.pattern];
    t.surfDensity[id] = s.density ?? 0;
  }
  style.strata.forEach((band, i) => {
    t.strataMinStep[i] = (band.aboveMeters - scale.elevationDatumMeters) / scale.metersPerStep;
    t.strataRamp[i] = palette.rampIds.get(band.ramp)!;
  });
  return t;
}
