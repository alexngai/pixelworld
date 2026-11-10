/**
 * Style packs: palette ramps, strata, surface materials and roads. A style pack
 * is data (worlds/_styles/<id>/style.json); this module validates it and turns
 * it into the palette and lookup tables the baker and compositor use.
 *
 * Palette layout (256 entries, indexed color — see docs/architecture.md §8):
 *   0                      background / empty
 *   1 + ramp*SHADES + s    ramp `ramp`, shade s (0 = darkest/outline … 5 = lightest)
 *   INDEX_SILHOUETTE       occluded-player highlight
 *
 * Packs are checked against a JSON Schema (schema.ts) and then for what a
 * schema can't say, with a path in every message (issues.ts); load.ts parses
 * their JSON and merges `extends` (D-075, docs/style-guide.md §18).
 */

import { checkSchema, STYLE_SCHEMA_VERSION } from "./schema";
import { StyleError, describe, formatPath, styleIssuesError, suggest, type PathSegment, type StyleIssue } from "./issues";

export * from "./issues";
export * from "./load";
export * from "./schema";
export * from "./schemaDocs";

export const SHADES = 6;
/**
 * Ramps a pack can hold: indices are 8-bit in the baked tiles, so the palette
 * has 256 entries: 0 the background, then 6 shades a ramp from 1 (ramp 41,
 * shade 5 → index 252), and 253 the silhouette. More needs a wider index in
 * the bake format (D-075).
 */
export const MAX_RAMPS = 42;
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
  /**
   * How micro-terrain tops are lit: by each micro-tile ("tiles", the default:
   * terraces read as steps), or by the ground's slope over about a cell
   * ("slope": a smoothed surface such as a lawn reads as one slope, and its
   * risers take its own colour a shade darker rather than pale strata).
   */
  light?: "tiles" | "slope";
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
  /** The schema, for editors (schema.ts); a loader ignores it but for its version. */
  $schema?: string;
  id: string;
  name: string;
  /** The generator plugins its assets need, by npm name (D-071). */
  plugins?: string[];
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

export function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new StyleError(`bad colour ${JSON.stringify(hex)}: want "#rrggbb"`);
  const v = parseInt(m[1]!, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What was given in place of a pack, when it plainly isn't one. */
function notAPack(v: unknown): string | null {
  if (typeof v === "string")
    return /^\s*</.test(v)
      ? "a style pack is a JSON object, not a string of HTML (is the URL right? dev servers answer a missing file with index.html)"
      : "a style pack is a JSON object, not a string (parse it first: parseStyleJson)";
  if (!isObject(v)) return `a style pack is a JSON object, not ${describe(v)}`;
  if (["ramps", "surfaces", "strataSets", "shades", "extends"].some((k) => k in v)) return null;
  if (isObject(v.default) && "ramps" in v.default) return "this is a JSON module, not a style pack: pass its default export";
  const keys = Object.keys(v);
  return `this isn't a style pack: it has none of ramps, surfaces, strataSets or shades (its keys: ${keys.slice(0, 8).join(", ") || "none"})`;
}

/**
 * Every problem with a pack, each with its path: its shape against the schema
 * (schema.ts: types, ranges, unknown keys with a "did you mean"), then what
 * the schema can't say: the ramps a pack names exist, strata run highest
 * first, scatter has assets. Empty for a good pack.
 */
export function styleIssues(style: unknown): StyleIssue[] {
  const not = notAPack(style);
  if (not) return [{ path: "", message: not }];
  const o = style as Record<string, unknown>;
  // a newer pack's keys would read as typos: say so instead
  const version = typeof o.$schema === "string" ? /style-pack\.v(\d+)\./.exec(o.$schema) : null;
  if (version && Number(version[1]) !== STYLE_SCHEMA_VERSION)
    return [{ path: "$schema", message: `the pack is written for style pack schema v${version[1]}; this pixelworld reads v${STYLE_SCHEMA_VERSION}` }];
  if (o.extends !== undefined)
    return [
      {
        path: "extends",
        message:
          `${JSON.stringify(o.extends)} isn't merged in: load the pack with resolveStyleExtends(pack, load), ` +
          "or give createWorldView a style resolver, which does (docs/style-guide.md §18)",
      },
    ];
  const shape = checkSchema(style);
  return shape.length ? shape : referenceIssues(style as StylePack);
}

/** What the schema can't check: names that must exist elsewhere in the pack, and orders. */
function referenceIssues(style: StylePack): StyleIssue[] {
  const issues: StyleIssue[] = [];
  const add = (path: PathSegment[], message: string) => issues.push({ path: formatPath(path), message });
  const has = (o: object | undefined, k: string) => o !== undefined && Object.hasOwn(o, k);
  const ramps = Object.keys(style.ramps);
  const ramp = (name: string, path: PathSegment[]) => {
    if (!has(style.ramps, name)) add(path, `no ramp named ${JSON.stringify(name)}${suggest(name, ramps)}`);
  };
  const sets = Object.keys(style.strataSets);
  for (const [setName, bands] of Object.entries(style.strataSets))
    bands.forEach((band, i) => {
      ramp(band.ramp, ["strataSets", setName, i, "ramp"]);
      if (i > 0 && band.aboveMeters >= bands[i - 1]!.aboveMeters)
        add(
          ["strataSets", setName, i, "aboveMeters"],
          `bands run from the highest down, so want < ${bands[i - 1]!.aboveMeters}, not ${band.aboveMeters}`,
        );
    });
  if (!has(style.strataSets, style.defaultStrata))
    add(["defaultStrata"], `no strata set named ${JSON.stringify(style.defaultStrata)}${suggest(style.defaultStrata, sets)}`);
  for (const [province, set] of Object.entries(style.provinces ?? {}))
    if (!has(style.strataSets, set)) add(["provinces", province], `no strata set named ${JSON.stringify(set)}${suggest(set, sets)}`);
  const surfaceRamps = (surfaces: Record<string, SurfaceStyle>, at: PathSegment[]) => {
    for (const [name, s] of Object.entries(surfaces)) if (s.ramp !== "strata") ramp(s.ramp, [...at, name, "ramp"]);
  };
  surfaceRamps(style.surfaces, ["surfaces"]);
  if (style.objects?.surfaces) surfaceRamps(style.objects.surfaces, ["objects", "surfaces"]);
  if (style.roads) {
    const r = style.roads;
    for (const k of ["asphalt", "marking", "rail"] as const) {
      const name = r[k];
      if (name !== undefined) ramp(name, ["roads", k]);
    }
    if (r.lanes) {
      ramp(r.lanes.ramp, ["roads", "lanes", "ramp"]);
      if (r.lanes.dash && !(r.lanes.dash[0] > 0 && r.lanes.dash[1] >= 0))
        add(["roads", "lanes", "dash"], `want [dash > 0, gap ≥ 0], not ${JSON.stringify(r.lanes.dash)}`);
    }
    for (const [name, c] of Object.entries(r.classes)) if (c.ramp !== undefined) ramp(c.ramp, ["roads", "classes", name, "ramp"]);
  }
  for (const [name, c] of Object.entries(style.paths?.classes ?? {})) ramp(c.ramp, ["paths", "classes", name, "ramp"]);
  const groups = Object.keys(style.assets ?? {});
  const surfaces = Object.keys(style.surfaces);
  for (const [surface, rules] of Object.entries(style.scatter ?? {})) {
    if (!has(style.surfaces, surface)) add(["scatter", surface], `no surface named ${JSON.stringify(surface)}${suggest(surface, surfaces)}`);
    rules.forEach((r, i) => {
      if (!groups.some((g) => r.group === g || r.group.startsWith(g + ".")))
        add(["scatter", surface, i, "group"], `no asset for ${JSON.stringify(r.group)}${suggest(r.group, groups)}`);
    });
  }
  for (const [group, a] of Object.entries(style.assets ?? {}))
    for (const [role, name] of Object.entries(a.ramps)) ramp(name, ["assets", group, "ramps", role]);
  for (const name of Object.keys(style.night?.emissive ?? {}))
    if (!has(style.ramps, name)) add(["night", "emissive", name], `glows, but there's no ramp named ${JSON.stringify(name)}${suggest(name, ramps)}`);
  const fog = style.atmosphere?.fog;
  if (fog) {
    ramp(fog.ramp, ["atmosphere", "fog", "ramp"]);
    fog.veil.forEach((k, i) => {
      if (i > 0 && !(k > fog.veil[i - 1]!)) add(["atmosphere", "fog", "veil", i], `veil levels increase, so want > ${fog.veil[i - 1]}, not ${k}`);
    });
    fog.areas.forEach((a, i) =>
      a.polygon.forEach((p, j) => {
        if (!(Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90))
          add(["atmosphere", "fog", "areas", i, "polygon", j], `points are [lon, lat], not ${JSON.stringify(p)}`);
      }),
    );
  }
  return issues;
}

/**
 * The asset generators a registry lacks, each at its path with a "did you
 * mean" (D-075). A view checks this once its plugins are registered;
 * `providers` names the plugin known to provide a generator, to say what to
 * load (KNOWN_PLUGIN_GENERATORS in @pixelworlds/generators).
 */
export function generatorIssues(
  style: StylePack,
  registered: readonly string[],
  providers: Readonly<Record<string, string>> = {},
): StyleIssue[] {
  const issues: StyleIssue[] = [];
  for (const [group, a] of Object.entries(style.assets ?? {})) {
    if (registered.includes(a.generator)) continue;
    const plugin = Object.hasOwn(providers, a.generator) ? providers[a.generator]! : null;
    issues.push({
      path: formatPath(["assets", group, "generator"]),
      message:
        plugin === null
          ? `no generator named ${JSON.stringify(a.generator)}${suggest(a.generator, registered)}: ` +
            `none is registered, and no plugin known here provides it (docs/plugins.md §9)`
          : style.plugins?.includes(plugin)
            ? `${JSON.stringify(a.generator)} comes with the plugin ${plugin}, which isn't loaded`
            : `${JSON.stringify(a.generator)} comes with the plugin ${plugin}: add it to the pack's "plugins", and load it`,
    });
  }
  return issues;
}

/**
 * Check a pack (`styleIssues`) and return it typed; a StyleError naming the
 * pack and listing each problem with its path if it has any:
 * `style pack "desert-adobe": ramps.desert[0]: bad colour "#3a2f3": want "#rrggbb"`.
 */
export function validateStyle(style: unknown): StylePack {
  const issues = styleIssues(style);
  if (issues.length) throw styleIssuesError(isObject(style) && typeof style.id === "string" ? style.id : null, issues);
  return style as StylePack;
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
  /** Per surface id: (ramp or RAMP_STRATA, pattern, density, 1 if lit by slope else 0). */
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
      [s.ramp === "strata" ? RAMP_STRATA : ramp(s.ramp), PATTERNS[s.pattern], s.density ?? 0, s.light === "slope" ? 1 : 0],
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
