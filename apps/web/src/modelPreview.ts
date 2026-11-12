import type { BakeScene, BakedImage } from "@pixelworlds/bake";
import {
  buildBoxesMesh,
  generateModel,
  meshLines,
  meshVoxels,
  objectVoxelScale,
  registerPlugin,
  resolveAsset,
  type AssetCatalog,
  type GenContext,
  type Plugin,
  type PluginReport,
  type VoxelModel,
} from "@pixelworlds/generators";
import type { Rotation } from "@pixelworlds/grid";
import { VEHICLE_KINDS, levelScale, vehicleVoxels, type VehicleKind } from "@pixelworlds/sim";
import type { Palette, StylePack } from "@pixelworlds/style";

/**
 * The model preview (model.html, `pnpm models`): one asset group's models
 * alone, without a world, through the same steps a world's bake takes:
 * `generateModel` with the style pack's roles and parameters, `meshVoxels`
 * at the object voxel scale, and the baker, in each rotation; the day and
 * night palettes are then applied to the same baked indices. This module is
 * the part without a GPU: the URL parameters, the models and their scenes,
 * and the palette applied to a baked image.
 */

export type PaletteName = "day" | "night";

export interface PreviewSpec {
  /** Style pack id (worlds/_styles/<id>). */
  style: string;
  /** Asset group in that pack: its generator, roles and parameters. */
  group: string;
  /** Another generator to draw the group's roles and parameters with (one not in the pack yet), or null. */
  generator: string | null;
  seeds: number[];
  /** Footprints in voxels (x by y) and heights in voxels: buildings and landmarks. */
  footprints: [number, number][];
  heights: number[];
  /** Vehicles: length, width and height in voxels; null for the default of the group's kind. */
  size: { length: number; width: number; height: number } | null;
  part: number | null;
  variant: number | null;
  /** Data hints as buildings get them (D-055): front 0–7, floors, year, corner, roof, facade. */
  hints: GenContext["hints"];
  rotations: Rotation[];
  palettes: PaletteName[];
  /** Integer upscale of the baked pixels. */
  zoom: number;
  /** A ground plate under the model (to see its shadow): a ramp name, the default one, or none. */
  ground: string | "default" | null;
}

export const DEFAULT_SPEC: PreviewSpec = {
  style: "desert-southwest",
  group: "building.residential",
  generator: null,
  seeds: [1],
  footprints: [[8, 6]],
  heights: [24],
  size: null,
  part: null,
  variant: null,
  hints: undefined,
  rotations: [0, 1, 2, 3],
  palettes: ["day", "night"],
  zoom: 3,
  ground: "default",
};

/** At most this many models (seeds × footprints × heights) on a page. */
export const MAX_MODELS = 48;

/** "1-4,9" → [1, 2, 3, 4, 9]; anything unreadable is left out. */
export function parseList(text: string): number[] {
  const out: number[] = [];
  for (const part of text.split(",").map((s) => s.trim())) {
    const range = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(part);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      for (let v = Math.min(a, b); v <= Math.max(a, b) && out.length < 1000; v++) out.push(v);
    } else if (part !== "" && Number.isFinite(Number(part))) out.push(Number(part));
  }
  return out;
}

/** "8x6,12x10" → [[8, 6], [12, 10]] (also 8×6). */
export function parseSizes(text: string, dims: 2): [number, number][];
export function parseSizes(text: string, dims: 3): [number, number, number][];
export function parseSizes(text: string, dims: 2 | 3): number[][] {
  return text
    .split(",")
    .map((s) => s.trim().split(/[x×]/).map(Number))
    .filter((v) => v.length === dims && v.every((n) => Number.isInteger(n) && n > 0));
}

/** "front:2,floors:3,corner:1,roof:gabled" → the generator's data hints. */
export function parseHints(text: string): GenContext["hints"] {
  const hints: NonNullable<GenContext["hints"]> = {};
  for (const [k, v] of text.split(",").map((s) => s.split(":").map((p) => p.trim()))) {
    if (!k || v === undefined || v === "") continue;
    if (k === "front" || k === "floors" || k === "year") hints[k] = Number(v);
    else if (k === "corner") hints.corner = v === "1" || v === "true";
    else if (k === "roof" || k === "facade") hints[k] = v;
  }
  return Object.keys(hints).length ? hints : undefined;
}

function hintsText(h: GenContext["hints"]): string {
  return Object.entries(h ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}:${v === true ? 1 : v === false ? 0 : v}`)
    .join(",");
}

/** The preview a URL asks for; whatever it leaves out is the default. */
export function parseSpec(params: URLSearchParams): PreviewSpec {
  const s: PreviewSpec = { ...DEFAULT_SPEC };
  const get = (k: string) => params.get(k) ?? "";
  if (get("style")) s.style = get("style");
  if (get("group")) s.group = get("group");
  if (get("generator")) s.generator = get("generator");
  const seeds = parseList(get("seeds") || get("seed"));
  if (seeds.length) s.seeds = seeds;
  const fp = parseSizes(get("fp"), 2);
  if (fp.length) s.footprints = fp;
  const h = parseList(get("h")).filter((v) => v > 0);
  if (h.length) s.heights = h;
  const [size] = parseSizes(get("size"), 3);
  if (size) s.size = { length: size[0], width: size[1], height: size[2] };
  if (get("part") !== "") s.part = Number(get("part")) || 0;
  if (get("variant") !== "") s.variant = Number(get("variant")) || 0;
  s.hints = parseHints(get("hints"));
  const rot = parseList(get("rot")).filter((r) => r >= 0 && r <= 3) as Rotation[];
  if (rot.length) s.rotations = [...new Set(rot)];
  const pal = get("palette");
  if (pal === "day" || pal === "night") s.palettes = [pal];
  const zoom = Number(get("zoom"));
  if (Number.isInteger(zoom) && zoom >= 1 && zoom <= 8) s.zoom = zoom;
  const ground = params.get("ground");
  if (ground === "0") s.ground = null;
  else if (ground) s.ground = ground;
  return s;
}

/** The URL parameters for a preview (defaults left out), so a reload or a save shows the same. */
export function specParams(s: PreviewSpec): URLSearchParams {
  const p = new URLSearchParams();
  const d = DEFAULT_SPEC;
  p.set("style", s.style);
  p.set("group", s.group);
  if (s.generator) p.set("generator", s.generator);
  p.set("seeds", s.seeds.join(","));
  p.set("fp", s.footprints.map(([x, y]) => `${x}x${y}`).join(","));
  p.set("h", s.heights.join(","));
  if (s.size) p.set("size", `${s.size.length}x${s.size.width}x${s.size.height}`);
  if (s.part !== null) p.set("part", String(s.part));
  if (s.variant !== null) p.set("variant", String(s.variant));
  if (s.hints) p.set("hints", hintsText(s.hints));
  if (s.rotations.join() !== d.rotations.join()) p.set("rot", s.rotations.join(","));
  if (s.palettes.length === 1) p.set("palette", s.palettes[0]!);
  p.set("zoom", String(s.zoom));
  if (s.ground === null) p.set("ground", "0");
  else if (s.ground !== "default") p.set("ground", s.ground);
  return p;
}

/** The catalog to generate from: the pack's, with the group drawn by another generator if asked. */
export function previewCatalog(style: StylePack, group: string, generator: string | null): AssetCatalog {
  const catalog = (style.assets ?? {}) as AssetCatalog;
  const spec = resolveAsset(catalog, group);
  if (!spec) throw new Error(`the style pack ${style.id} has no asset for ${group}`);
  return generator && generator !== spec.generator ? { ...catalog, [group]: { ...spec, generator } } : catalog;
}

/** A vehicle group's default size: its kind (else a car) on a 25 m driving level, as traffic draws it. */
export function defaultVehicleSize(group: string): { length: number; width: number; height: number } {
  const kind = group.split(".")[1] as VehicleKind;
  return vehicleVoxels((VEHICLE_KINDS as readonly string[]).includes(kind) ? kind : "car", levelScale(25, "drive"));
}

export interface PreviewModel {
  /** "seed 3 · 8×6 · h 24", or a vehicle's "seed 3 · 10×4×5". */
  label: string;
  seed: number;
  footprint: [number, number] | null;
  height: number | null;
  model: VoxelModel | null;
  /** The generator's error, if it threw. */
  error: string | null;
}

/**
 * What a group's generator is given in a world: a footprint and a height
 * (buildings, landmarks, city blocks), a size (traffic's vehicles), or only a
 * seed (vegetation, rocks and props, drawn instanced).
 */
export function modelKind(group: string): "footprint" | "vehicle" | "seed" {
  if (group.startsWith("vehicle.")) return "vehicle";
  return /^(tree|shrub|rock|prop)(\.|$)/.test(group) ? "seed" : "footprint";
}

/**
 * Generate every model the spec asks for: each seed, footprint and height
 * (buildings and landmarks), each seed at a size (vehicles), or each seed
 * (vegetation, props). A model whose generator throws carries the error instead.
 */
export function previewModels(style: StylePack, palette: Palette, spec: PreviewSpec): PreviewModel[] {
  const catalog = previewCatalog(style, spec.group, spec.generator);
  const kind = modelKind(spec.group);
  const size = kind === "vehicle" ? (spec.size ?? defaultVehicleSize(spec.group)) : (spec.size ?? undefined);
  const voxel = objectVoxelScale(1).h;
  const cases: { seed: number; footprint: [number, number] | null; height: number | null }[] = [];
  for (const seed of spec.seeds)
    if (kind !== "footprint") cases.push({ seed, footprint: null, height: null });
    else for (const footprint of spec.footprints) for (const height of spec.heights) cases.push({ seed, footprint, height });
  return cases.slice(0, MAX_MODELS).map(({ seed, footprint, height }) => {
    const label = [
      `seed ${seed}`,
      ...(footprint ? [`${footprint[0]}×${footprint[1]}`] : []),
      ...(height !== null ? [`h ${height}`] : []),
      ...(size ? [`${size.length}×${size.width}×${size.height}`] : []),
    ].join(" · ");
    try {
      const model = generateModel(catalog, palette.rampIds, spec.group, {
        seed,
        mask: footprint ? { sx: footprint[0], sy: footprint[1], on: new Uint8Array(footprint[0] * footprint[1]).fill(1) } : undefined,
        heightVox: height ?? undefined,
        hints: spec.hints,
        frame: footprint ? { x0: 0, y0: 0, voxel } : undefined,
        size,
        part: spec.part ?? undefined,
        variant: spec.variant ?? undefined,
      });
      return { label, seed, footprint, height, model, error: null };
    } catch (e) {
      return { label, seed, footprint, height, model: null, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

// Every workspace package laid out as a city pack (D-071): `src/plugin.ts` exporting its `plugin`.
const WORKSPACE_PLUGINS = import.meta.glob("../../../packages/*/src/plugin.ts", { import: "plugin" }) as Record<
  string,
  () => Promise<Plugin>
>;

/**
 * Register the generator plugins of every workspace package laid out as a
 * city pack (`packages/<pack>/src/plugin.ts` exporting `plugin`), so their
 * generators can be previewed before a style pack names them. A plugin that
 * fails (a name clash) is reported, not thrown.
 */
export async function registerWorkspacePlugins(): Promise<{ reports: PluginReport[]; errors: string[] }> {
  const reports: PluginReport[] = [];
  const errors: string[] = [];
  for (const [path, load] of Object.entries(WORKSPACE_PLUGINS)) {
    try {
      reports.push(await registerPlugin(await load()));
    } catch (e) {
      errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { reports, errors };
}

/** The ramp of the default ground plate: the urban surface's, else asphalt, else the first ramp. */
export function defaultGroundRamp(style: StylePack): string {
  return style.objects?.surfaces?.urban?.ramp ?? style.surfaces.urban?.ramp ?? style.roads?.asphalt ?? Object.keys(style.ramps)[0]!;
}

/**
 * A model's bake scene at render scale 1, as a world tile meshes it
 * (meshVoxels and meshLines at the object voxel scale, centred on the origin,
 * standing on z = 0), on a ground plate one voxel thick and two voxels wider
 * all round.
 */
export function previewScene(model: VoxelModel, groundRamp: number | null): BakeScene {
  const voxel = objectVoxelScale(1);
  const hx = (model.sx * voxel.h) / 2;
  const hy = (model.sy * voxel.h) / 2;
  const meshes = [meshVoxels(model, voxel, [-hx, -hy, 0], [0, 0]).build()];
  // its one-pixel lines (D-098), as a world tile draws them
  if (model.lines.length) meshes.push({ ...meshLines(model, voxel, [-hx, -hy, 0], [0, 0]).build(), primitive: "lines" });
  if (groundRamp !== null) {
    const m = 2 * voxel.h;
    meshes.push(buildBoxesMesh([{ x0: -hx - m, y0: -hy - m, z0: -voxel.v, x1: hx + m, y1: hy + m, z1: 0, ramp: groundRamp }]));
  }
  return { meshes, batches: [] };
}

/** A baked image in a palette's colours (RGBA); empty pixels stay transparent. */
export function paletteImage(image: BakedImage, palette: Palette): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(image.width * image.height * 4);
  const src = image.pixels;
  for (let i = 0; i < out.length; i += 4) {
    if (src[i + 3] === 0) continue;
    const p = src[i]! * 4;
    out[i] = palette.rgba[p]!;
    out[i + 1] = palette.rgba[p + 1]!;
    out[i + 2] = palette.rgba[p + 2]!;
    out[i + 3] = 255;
  }
  return out;
}
