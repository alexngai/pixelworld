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
  /** Fixed half-width in render units, for worlds without real widths (D-050). */
  halfWidth: number;
  centerLine: boolean;
  /** Surface ramp; the style's asphalt if absent. */
  ramp?: string;
  /** Lane lines where the world counts lanes and they are wide enough (`roads.lanes`, M3.5). */
  lanes?: boolean;
}

/**
 * Lane lines and medians (M3.5), on worlds whose roads carry lane counts and
 * carriageway pairs (the LANE layer). Without it, roads draw as before.
 */
export interface LaneStyle {
  /** Dashed lane lines and median kerbs; centre lines stay in the `marking` ramp. */
  ramp: string;
  /**
   * The narrowest lane drawn, in pixels across: a road whose lanes are
   * narrower draws fewer, wider ones, and none below two.
   */
  minPixels: number;
  /** Dash and gap along a lane line, in lane widths. */
  dash?: [number, number];
  /**
   * Medians between a divided road's carriageways: kerbs along the ground
   * between them, or, where they meet, a paved strip this many lane widths
   * across carved between them. 0 or absent: no medians.
   */
  median?: number;
}

/** A path class (footway, sidewalk, crosswalk, …), drawn at its real width (D-050). */
export interface PathClassStyle {
  ramp: string;
  /** Alternate the ramp with asphalt in pixel stripes (crosswalks). */
  stripes?: boolean;
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
  /** `rail`: the ramp rails in the street are drawn in (M3.5); without it, no rails. */
  roads?: {
    asphalt: string;
    marking: string;
    rail?: string;
    lanes?: LaneStyle;
    classes: Record<string, RoadClassStyle>;
  };
  paths?: { classes: Record<string, PathClassStyle> };
  /** Semantic asset groups → generator, role ramps and parameters (D-030). */
  assets?: Record<string, AssetStyle>;
  /**
   * Object look shared by every asset group. `surfaces` replaces surface
   * styles when a world has objects (real buildings make the block pattern redundant).
   */
  objects?: { heightStretch: number; variants: number; surfaces?: Record<string, SurfaceStyle> };
  /**
   * Decorative scatter (M3): surface name → objects the client adds per cell,
   * on worlds whose manifest asks for it (`depiction.scatter`).
   */
  scatter?: Record<string, { group: string; perCell: number }[]>;
  /** Night palette variant: everything darkens except emissive ramps. */
  night?: NightStyle;
  /** Micro-terrain look (M1.6). */
  terrain?: {
    /** Micro-cell tops steeper than this rise over run are bare rock (D-036). */
    steepRockSlope?: number;
  };
  /**
   * Atmosphere layers drawn over the baked world by the compositor (fog).
   * They never change a bake, so they are left out of the tile cache key.
   */
  atmosphere?: AtmosphereStyle;
}

export interface AtmosphereStyle {
  fog?: FogStyle;
}

/**
 * A fog layer: dithered in the palette over the areas it names, thick on low
 * ground and gone above its ceiling, so hills and towers rise out of it.
 *
 * Fog is a veil: each level moves every pixel's colour part of the way toward
 * the fog's own colour and snaps it to the nearest palette colour that pales
 * it (no more saturated, no farther in lightness from the fog), so the result
 * stays in the palette and swaps to night with it.
 */
export interface FogStyle {
  /** The fog's own colour: a ramp and one of its shades. */
  ramp: string;
  shade: number;
  /** Veil levels, thin → thick: how far each moves a colour toward the fog's (0–1, increasing; 1 is the fog's colour). */
  veil: number[];
  /** Top of the fog, in metres of drawn terrain height (the level's metres per step). */
  ceilingMeters: number;
  /** The fog thins to nothing over this many metres below its ceiling. */
  fadeMeters: number;
  /** Where the fog lies; where areas overlap, the densest wins. */
  areas: FogArea[];
  /** Patches drifting through the areas with the wind. Without it the fog is even and still. */
  drift?: FogDrift;
  /** Coverage per scale level (manifest `level`): multiplies every area's density. Unlisted levels: 1; 0 turns fog off. */
  levels?: Record<string, number>;
  /** By night: coverage multiplier (0 = no fog at night). Emissive ramps show through. Without it: no fog at night. */
  night?: { density: number };
}

export interface FogArea {
  name?: string;
  /** Outline as [lon, lat] points (WGS84); the last point joins the first. */
  polygon: [number, number][];
  /** Coverage inside, 0–1: the share of pixels the fog takes over low ground. */
  density: number;
  /** Width of the soft edge in metres, centred on the outline (0: a hard edge). */
  edgeMeters?: number;
}

export interface FogDrift {
  /** Wind speed in real metres per second (levels compress time as traffic does, D-060). */
  speed: number;
  /** Compass bearing the fog moves toward, in degrees (90 = east). */
  toward: number;
  /** Size of a patch, in metres. */
  sizeMeters: number;
  /** 0 = even fog, 1 = patches with clear gaps between them. */
  contrast: number;
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
    const extra = [style.roads.rail, style.roads.lanes?.ramp].filter((r): r is string => !!r);
    for (const r of [style.roads.asphalt, style.roads.marking, ...extra])
      if (!(r in style.ramps)) throw new StyleError(`road ramp ${r} not defined`);
    const lanes = style.roads.lanes;
    if (lanes) {
      if (!(lanes.minPixels > 0)) throw new StyleError("roads.lanes.minPixels must be > 0");
      if (lanes.dash && !(lanes.dash.length === 2 && lanes.dash[0] > 0 && lanes.dash[1] >= 0))
        throw new StyleError("roads.lanes.dash must be [dash > 0, gap ≥ 0]");
      if (lanes.median !== undefined && !(lanes.median >= 0))
        throw new StyleError("roads.lanes.median must be ≥ 0");
    }
    for (const [name, c] of Object.entries(style.roads.classes))
      if (c.ramp && !(c.ramp in style.ramps)) throw new StyleError(`road class ${name} uses undefined ramp ${c.ramp}`);
  }
  for (const [surface, rules] of Object.entries(style.scatter ?? {}))
    for (const r of rules) {
      if (!(surface in style.surfaces)) throw new StyleError(`scatter for unknown surface ${surface}`);
      if (!Object.keys(style.assets ?? {}).some((g) => r.group === g || r.group.startsWith(g + ".")))
        throw new StyleError(`scatter group ${r.group} has no asset`);
      if (!(r.perCell >= 0)) throw new StyleError(`scatter ${surface}/${r.group}: perCell must be ≥ 0`);
    }
  for (const [name, c] of Object.entries(style.paths?.classes ?? {}))
    if (!(c.ramp in style.ramps)) throw new StyleError(`path class ${name} uses undefined ramp ${c.ramp}`);
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
  if (style.atmosphere?.fog) validateFog(style.atmosphere.fog, style);
  return style;
}

function validateFog(fog: FogStyle, style: StylePack): void {
  const unit = (v: unknown) => typeof v === "number" && v >= 0 && v <= 1;
  if (!(fog.ramp in style.ramps)) throw new StyleError(`fog ramp ${fog.ramp} not defined`);
  if (!(Number.isInteger(fog.shade) && fog.shade >= 0 && fog.shade < SHADES))
    throw new StyleError(`fog shade must be 0..${SHADES - 1}`);
  if (!fog.veil.length || !fog.veil.every((k, i) => unit(k) && k > (fog.veil[i - 1] ?? 0)))
    throw new StyleError("fog veil levels must increase within 0..1");
  if (!(fog.fadeMeters > 0)) throw new StyleError("fog fadeMeters must be > 0");
  if (typeof fog.ceilingMeters !== "number") throw new StyleError("fog needs ceilingMeters");
  for (const a of fog.areas) {
    const name = a.name ?? "(unnamed)";
    if (a.polygon.length < 3) throw new StyleError(`fog area ${name} needs 3 or more points`);
    for (const p of a.polygon)
      if (p.length !== 2 || !(Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90))
        throw new StyleError(`fog area ${name}: points are [lon, lat]`);
    if (!unit(a.density)) throw new StyleError(`fog area ${name}: density must be 0..1`);
    if (a.edgeMeters !== undefined && !(a.edgeMeters >= 0)) throw new StyleError(`fog area ${name}: edgeMeters must be ≥ 0`);
  }
  if (fog.drift) {
    const d = fog.drift;
    if (!(d.speed >= 0) || !(d.sizeMeters > 0) || typeof d.toward !== "number" || !unit(d.contrast))
      throw new StyleError("fog drift needs speed ≥ 0, toward, sizeMeters > 0 and contrast 0..1");
  }
  for (const [level, k] of Object.entries(fog.levels ?? {}))
    if (!(k >= 0)) throw new StyleError(`fog level ${level}: coverage multiplier must be ≥ 0`);
  if (fog.night && !(fog.night.density >= 0)) throw new StyleError("fog night density must be ≥ 0");
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
  /** Path class id → name (D-050). */
  pathClasses?: Record<string, string>;
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
  /** Per road class id: (half width in cells, centre line 0/1, ramp or -1 for asphalt, lane lines 0/1). */
  roads: Float32Array;
  /** Per path class id: (ramp or -1 if unstyled, stripes 0/1, 0, 0). */
  paths: Float32Array;
  asphaltRamp: number;
  markingRamp: number;
  /** Ramp the rails in the street are drawn in (M3.5), -1 if the style has none. */
  railRamp: number;
  /**
   * Lane lines and medians (M3.5): (narrowest lane in pixels or -1 for none,
   * dash and gap in lane widths, median strip in lane widths).
   */
  lanes: Float32Array;
  /** Ramp lane lines and median kerbs are drawn in. */
  laneRamp: number;
}

/** The shader's lane settings (MaterialTables.lanes); x = -1 turns lanes and medians off. */
function laneTable(lanes: LaneStyle | undefined): Float32Array {
  if (!lanes) return Float32Array.of(-1, 1, 2, 0);
  const [dash, gap] = lanes.dash ?? [1, 2];
  return Float32Array.of(lanes.minPixels, dash, gap, lanes.median ?? 0);
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
    paths: new Float32Array(MAX_ROAD_CLASSES * 4).fill(-1),
    asphaltRamp: palette.rampIds.get(style.roads?.asphalt ?? "") ?? 0,
    markingRamp: palette.rampIds.get(style.roads?.marking ?? "") ?? 0,
    railRamp: palette.rampIds.get(style.roads?.rail ?? "") ?? -1,
    lanes: laneTable(style.roads?.lanes),
    laneRamp: palette.rampIds.get(style.roads?.lanes?.ramp ?? "") ?? -1,
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
    if (r)
      t.roads.set(
        [
          Math.min(0.5, r.halfWidth / renderScale),
          r.centerLine ? 1 : 0,
          r.ramp ? ramp(r.ramp) : -1,
          r.lanes ? 1 : 0,
        ],
        Number(id) * 4,
      );
  }
  for (const [id, cls] of Object.entries(world.pathClasses ?? {})) {
    const c = style.paths?.classes[cls];
    if (c) t.paths.set([ramp(c.ramp), c.stripes ? 1 : 0, 0, 0], Number(id) * 4);
  }
  return t;
}
