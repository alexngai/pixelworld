import {
  INDEX_BACKGROUND,
  SHADES,
  paletteIndex,
  type FogArea,
  type FogStyle,
  type Palette,
  type StylePack,
} from "@pixelworld/style";

/**
 * Fog (an atmosphere layer): where it lies and how thick it is. The style
 * pack names areas in lon/lat; a world turns them into a coverage field over
 * its cells through its geo grid (D-048), once at load. The compositor's fog
 * pass (fogPass.ts) samples that field per pixel, takes the pixel's height
 * from the frame's depth and dithers the fog into the palette, so nothing is
 * baked and nothing re-bakes.
 */

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320;

/** An area in local metres (east, north) around its own reference point. */
interface PreparedArea {
  lon0: number;
  lat0: number;
  kx: number;
  xs: Float64Array;
  ys: Float64Array;
  density: number;
  edge: number;
  /** Bounding box in metres, grown by half the edge. */
  box: [number, number, number, number];
}

function prepareArea(a: FogArea): PreparedArea {
  const lon0 = a.polygon.reduce((s, p) => s + p[0], 0) / a.polygon.length;
  const lat0 = a.polygon.reduce((s, p) => s + p[1], 0) / a.polygon.length;
  const kx = M_PER_DEG_LON * Math.cos((lat0 * Math.PI) / 180);
  const xs = Float64Array.from(a.polygon, (p) => (p[0] - lon0) * kx);
  const ys = Float64Array.from(a.polygon, (p) => (p[1] - lat0) * M_PER_DEG_LAT);
  const edge = a.edgeMeters ?? 0;
  const half = edge / 2;
  return {
    lon0,
    lat0,
    kx,
    xs,
    ys,
    density: a.density,
    edge,
    box: [Math.min(...xs) - half, Math.min(...ys) - half, Math.max(...xs) + half, Math.max(...ys) + half],
  };
}

/** Signed distance from a point to a polygon's outline: negative inside, positive outside. */
export function polygonSignedDistance(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number, y: number): number {
  let inside = false;
  let best = Infinity;
  const n = xs.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = xs[j]!;
    const ay = ys[j]!;
    const bx = xs[i]!;
    const by = ys[i]!;
    if (by > y !== ay > y && x < ((ax - bx) * (y - by)) / (ay - by) + bx) inside = !inside;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return inside ? -best : best;
}

function smoothstep01(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

function areaCoverage(a: PreparedArea, lon: number, lat: number): number {
  const x = (lon - a.lon0) * a.kx;
  const y = (lat - a.lat0) * M_PER_DEG_LAT;
  if (x < a.box[0] || y < a.box[1] || x > a.box[2] || y > a.box[3]) return 0;
  const sd = polygonSignedDistance(a.xs, a.ys, x, y);
  // full coverage half an edge inside the outline, none half an edge outside
  if (a.edge <= 0) return sd <= 0 ? a.density : 0;
  return a.density * smoothstep01(0.5 - sd / a.edge);
}

/** Coverage (0–1) of a set of fog areas at a lon/lat: the densest area wins. */
export function fogAreaCoverage(areas: FogArea[], lon: number, lat: number): number {
  return prepared(areas).reduce((m, a) => Math.max(m, areaCoverage(a, lon, lat)), 0);
}

const preparedCache = new WeakMap<FogArea[], PreparedArea[]>();
function prepared(areas: FogArea[]): PreparedArea[] {
  let p = preparedCache.get(areas);
  if (!p) preparedCache.set(areas, (p = areas.map(prepareArea)));
  return p;
}

/**
 * The fog's thickness along a pixel's line of sight (0–1) for a surface at
 * height h: the share of the fog layer between the surface and the eye. Full
 * below `ceiling − fade`, thinning to nothing at the ceiling, so low ground
 * is buried and hills and towers rise out of it. The fog pass computes the same.
 */
export function fogVertical(h: number, ceiling: number, fade: number): number {
  return Math.max(0, Math.min(1, (ceiling - h) / fade));
}

/** Coverage multiplier for a scale level (manifest `level`): 1 unless the style lists it. */
export function fogLevelStrength(fog: FogStyle, level: string | undefined): number {
  return level !== undefined ? (fog.levels?.[level] ?? 1) : 1;
}

/** Time compression of a level, as for ambient traffic (D-060): real time when walking. */
export function fogTimeScale(metersPerCell: number, level: string | undefined): number {
  return level === "walk" ? 1 : Math.max(1, Math.pow(metersPerCell / 10, 0.75));
}

/** Area coverage over a world's cells: one texel per `cellsPerTexel` cells, sampled at texel centres. */
export interface FogField {
  width: number;
  height: number;
  cellsPerTexel: number;
  /** Coverage × 255, row-major (y outer). */
  data: Uint8Array;
}

/**
 * Sample fog areas over a world through its cell → lon/lat mapping (the geo
 * grid). Null when no area reaches the world, so worlds outside the fog get no layer.
 */
export function buildFogField(
  areas: FogArea[],
  toLonLat: (x: number, y: number) => [number, number],
  cellsX: number,
  cellsY: number,
  cellsPerTexel: number,
): FogField | null {
  const width = Math.max(1, Math.ceil(cellsX / cellsPerTexel));
  const height = Math.max(1, Math.ceil(cellsY / cellsPerTexel));
  const data = new Uint8Array(width * height);
  const ps = prepared(areas);
  let any = false;
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) {
      const [lon, lat] = toLonLat((i + 0.5) * cellsPerTexel, (j + 0.5) * cellsPerTexel);
      let c = 0;
      for (const a of ps) c = Math.max(c, areaCoverage(a, lon, lat));
      const v = Math.round(c * 255);
      data[j * width + i] = v;
      if (v > 0) any = true;
    }
  return any ? { width, height, cellsPerTexel, data } : null;
}

/** The world facts a fog layer depends on (manifest fields). */
export interface FogWorld {
  level?: string;
  cellsX: number;
  cellsY: number;
  scale: { metersPerCell: number; metersPerStep: number; elevationDatumMeters: number };
}

/** A style's fog resolved for one world: everything but the time of day and the clock. */
export interface FogSetup {
  field: FogField;
  /** Top of the fog and its thinning band, in steps. */
  ceiling: number;
  fade: number;
  /** Coverage multiplier for this level. */
  strength: number;
  /** Coverage multiplier by night; 0 draws no fog at night. */
  nightStrength: number;
  /** The veil: palette index per index and level (`fogLut`). */
  lut: FogLut;
  /** Patch size in cells, and drift in cells per second of play (x east, y south). */
  patchCells: number;
  drift: [number, number];
  contrast: number;
}

/**
 * What fog makes of each palette index: `levels` rows by day, then `levels`
 * rows by night, 256 indices each. Row l is veil level l + 1 (level 0 is the
 * pixel itself).
 */
export interface FogLut {
  levels: number;
  data: Uint8Array;
}

/** sRGB (0–255) to OKLab: perceptual lightness L and opponent axes a, b. */
export function oklab(r: number, g: number, b: number): [number, number, number] {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/**
 * The veil as a lookup table. For each level, every ramp colour is moved that
 * far toward the fog's colour (in OKLab) and snapped to the nearest palette
 * colour that is no more saturated than it and no farther in lightness from
 * the fog: fog only fades and pales a colour. Emissive ramps are never chosen
 * (they would glow at night), nor outline shades; the fog's own ramp is the
 * fallback. The day palette decides; the indices swap to night unchanged.
 * Not the nearest colour alone: shadowed water would snap to a brighter teal
 * than lit water, and light colours would keep their saturation.
 * The background, the silhouette and other special indices are never veiled,
 * nor, by night, the emissive ramps: lit windows show through.
 */
export function fogLut(fog: FogStyle, palette: Palette, emissive: string[] = []): FogLut {
  const { rgba, rampIds } = palette;
  const levels = fog.veil.length;
  const rampCount = rampIds.size;
  const lab = Array.from({ length: 256 }, (_, i) => oklab(rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!));
  const chroma = lab.map(([, a, b]) => Math.hypot(a, b));
  const fogIndex = paletteIndex(rampIds.get(fog.ramp)!, fog.shade);
  const target = lab[fogIndex]!;
  const glows = new Set(emissive.map((n) => rampIds.get(n)!));
  const fogRamp = rampIds.get(fog.ramp)!;
  const candidates: number[] = [];
  for (let r = 0; r < rampCount; r++)
    if (!glows.has(r)) for (let s = 1; s < SHADES; s++) candidates.push(paletteIndex(r, s));
  const data = new Uint8Array(256 * levels * 2);
  const EPS = 0.01;
  for (let l = 0; l < levels; l++) {
    const k = fog.veil[l]!;
    for (let i = 0; i < 256; i++) {
      const ramp = Math.floor((i - 1) / SHADES);
      let out = i;
      if (i !== INDEX_BACKGROUND && ramp < rampCount) {
        if (k >= 1) out = fogIndex;
        else {
          const c = lab[i]!;
          const t = c.map((v, ch) => v + k * (target[ch]! - v));
          const lightGap = Math.abs(c[0] - target[0]);
          let best = Infinity;
          let bestFallback = Infinity;
          let fallback = fogIndex;
          for (const j of candidates) {
            const q = lab[j]!;
            const d = (q[0] - t[0]!) ** 2 + (q[1] - t[1]!) ** 2 + (q[2] - t[2]!) ** 2;
            if (Math.floor((j - 1) / SHADES) === fogRamp && d < bestFallback) {
              bestFallback = d;
              fallback = j;
            }
            if (chroma[j]! > chroma[i]! + EPS || Math.abs(q[0] - target[0]) > lightGap + EPS) continue;
            if (d < best) {
              best = d;
              out = j;
            }
          }
          if (best === Infinity) out = fallback;
        }
      }
      data[l * 256 + i] = out;
      data[(levels + l) * 256 + i] = glows.has(ramp) ? i : out;
    }
  }
  return { levels, data };
}

/** About 100 m per field texel: fog edges are hundreds of metres wide. */
export function fogCellsPerTexel(metersPerCell: number): number {
  return Math.max(1, Math.round(100 / metersPerCell));
}

/**
 * Resolve a style's fog for a world, or null when it draws none there: the
 * style has no fog, the level turns it off, no area reaches the world, or the
 * world has no geo grid to place lon/lat areas with.
 */
export function setupFog(
  style: StylePack,
  palette: Palette,
  world: FogWorld,
  toLonLat: ((x: number, y: number) => [number, number]) | null,
): FogSetup | null {
  const fog = style.atmosphere?.fog;
  if (!fog || !toLonLat) return null;
  const strength = fogLevelStrength(fog, world.level);
  if (!(strength > 0)) return null;
  const { metersPerCell, metersPerStep, elevationDatumMeters } = world.scale;
  const field = buildFogField(fog.areas, toLonLat, world.cellsX, world.cellsY, fogCellsPerTexel(metersPerCell));
  if (!field) return null;
  const timeScale = fogTimeScale(metersPerCell, world.level);
  const drift = fog.drift;
  const bearing = ((drift?.toward ?? 0) * Math.PI) / 180;
  const cellsPerSecond = drift ? (drift.speed * timeScale) / metersPerCell : 0;
  return {
    field,
    ceiling: (fog.ceilingMeters - elevationDatumMeters) / metersPerStep,
    fade: fog.fadeMeters / metersPerStep,
    strength,
    nightStrength: fog.night?.density ?? 0,
    lut: fogLut(fog, palette, Object.keys(style.night?.emissive ?? {})),
    patchCells: drift ? drift.sizeMeters / metersPerCell : 1,
    // compass bearing → grid: x grows east, y grows south
    drift: [Math.sin(bearing) * cellsPerSecond, -Math.cos(bearing) * cellsPerSecond],
    contrast: drift?.contrast ?? 0,
  };
}

/** Period of the patch noise, in lattice units (one lattice unit is a patch's size). */
export const FOG_NOISE_PERIOD = 64;
/** Texels per lattice unit in the noise tile. */
export const FOG_NOISE_TEXELS = 4;

function latticeHash(x: number, y: number): number {
  const p = FOG_NOISE_PERIOD;
  let h = Math.imul(((x % p) + p) % p, 0x8da6b343) ^ Math.imul(((y % p) + p) % p, 0xd8163841);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h & 0xffff) / 65535;
}

/** Periodic value noise (smoothstep between hashed lattice points). */
export function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = latticeHash(ix, iy) + sx * (latticeHash(ix + 1, iy) - latticeHash(ix, iy));
  const b = latticeHash(ix, iy + 1) + sx * (latticeHash(ix + 1, iy + 1) - latticeHash(ix, iy + 1));
  return a + sy * (b - a);
}

/** The patches' noise at a lattice position: two octaves, periodic in FOG_NOISE_PERIOD. */
export function fogNoise(x: number, y: number): number {
  return 0.65 * valueNoise(x, y) + 0.35 * valueNoise(2 * x + 37, 2 * y + 11);
}

/**
 * The patch noise as a tile the pass samples with linear filtering and wrap
 * (one texture read per pixel instead of eight hashes, which matters on
 * software rasterizers). Square, FOG_NOISE_PERIOD × FOG_NOISE_TEXELS on a side.
 */
export function fogNoiseTile(): Uint8Array {
  const n = FOG_NOISE_PERIOD * FOG_NOISE_TEXELS;
  const out = new Uint8Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++)
      out[j * n + i] = Math.round(255 * fogNoise((i + 0.5) / FOG_NOISE_TEXELS, (j + 0.5) / FOG_NOISE_TEXELS));
  return out;
}

/**
 * Whether any fog lies in a view: the cells under its screen rectangle (render
 * px, at the world's lowest and highest heights) against the field. The pass
 * is skipped where the answer is no, so views without fog cost nothing.
 */
export function fogInView(
  field: FogField,
  rect: { left: number; top: number; width: number; height: number },
  toCell: (sx: number, sy: number, h: number) => [number, number],
  heights: [number, number],
): boolean {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const h of heights)
    for (const [sx, sy] of [
      [rect.left, rect.top],
      [rect.left + rect.width, rect.top],
      [rect.left, rect.top + rect.height],
      [rect.left + rect.width, rect.top + rect.height],
    ] as const) {
      const [x, y] = toCell(sx, sy, h);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  const s = field.cellsPerTexel;
  // one texel of margin: the pass filters the field linearly
  const i0 = Math.max(0, Math.floor(x0 / s) - 1);
  const j0 = Math.max(0, Math.floor(y0 / s) - 1);
  const i1 = Math.min(field.width - 1, Math.floor(x1 / s) + 1);
  const j1 = Math.min(field.height - 1, Math.floor(y1 / s) + 1);
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) if (field.data[j * field.width + i]! > 0) return true;
  return false;
}

/** Offset of the patch noise at a time, in lattice units, wrapped to the noise's period. */
export function fogPatchOffset(setup: FogSetup, seconds: number): [number, number] {
  const wrap = (v: number) => ((v % FOG_NOISE_PERIOD) + FOG_NOISE_PERIOD) % FOG_NOISE_PERIOD;
  return [wrap((setup.drift[0] * seconds) / setup.patchCells), wrap((setup.drift[1] * seconds) / setup.patchCells)];
}
