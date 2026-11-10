import type { AssetSpec, GenContext } from "./assets";
import { KNOWN_PLUGIN_GENERATORS, getGenerator, listGenerators } from "./registry";
import { VoxelModel } from "./voxel";

/**
 * Failure containment for object models (D-072). A model whose generator
 * isn't registered, throws, or returns no model is drawn as a small
 * missing-model marker, and the failure is recorded for the bake to report,
 * so one bad model no longer blanks every tile around it.
 */

/** A model that failed to generate, as buildObjects records it. */
export interface ModelFailure {
  /** The object's semantic group, e.g. "building.residential". */
  group: string;
  /** The generator the style's asset names. */
  generator: string;
  /** The seed the generator was given. */
  seed: number;
  /** The object's cell; for a repeated object (vegetation, rocks), its first placement in the bake. */
  x: number;
  y: number;
  /** Footprint objects: the footprint's size in cells and its mask in voxels. */
  footprint?: { cells: [number, number]; voxels: [number, number] };
  /** The height the generator was asked for, in voxels (buildings, landmarks). */
  heightVox?: number;
  /** A repeated object's variant: one model, drawn at each of its placements. */
  repeated?: boolean;
  /** Who registered the generator (a plugin's name, or the built-ins); null when it isn't registered. */
  source: string | null;
  /** For a generator that isn't registered: the plugin known to provide it, if any (KNOWN_PLUGIN_GENERATORS). */
  plugin: string | null;
  /** The error, `Name: message`. */
  error: string;
}

/** The square of the marker's checkerboard, in voxels (8 × 4 px at native zoom). */
const SQUARE = 4;

/**
 * The model drawn where one fails to generate: a checkerboard of the style's
 * `marker` ramp and the asset's own first ramp. Over a footprint it is a low
 * slab (the marker squares 4 voxels high, the others 2); without one, a
 * block of 8 voxels in a 3D checkerboard. Small, so it can't pass for the
 * model it stands in for.
 */
export function missingModel(mask: GenContext["mask"], marker: number, other: number): VoxelModel {
  if (mask) {
    const m = new VoxelModel(mask.sx, mask.sy, 4);
    const a = m.material(marker);
    const b = m.material(other);
    for (let j = 0; j < mask.sy; j++)
      for (let i = 0; i < mask.sx; i++) {
        if (!mask.on[j * mask.sx + i]) continue;
        const odd = (Math.floor(i / SQUARE) + Math.floor(j / SQUARE)) & 1;
        m.fill(i, j, 0, i + 1, j + 1, odd ? 2 : 4, odd ? b : a);
      }
    return m;
  }
  const n = 2 * SQUARE;
  const m = new VoxelModel(n, n, n);
  const a = m.material(marker);
  const b = m.material(other);
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) m.set(x, y, z, (Math.floor(x / SQUARE) + Math.floor(y / SQUARE) + Math.floor(z / SQUARE)) & 1 ? b : a);
  return m;
}

/** Whether a generator's result is a voxel model (of this package's copy or a plugin's own). */
function isModel(m: unknown): m is VoxelModel {
  if (m instanceof VoxelModel) return true;
  const v = m as Partial<VoxelModel> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    [v.sx, v.sy, v.sz].every((n) => Number.isInteger(n) && n! >= 0) &&
    v.data instanceof Uint8Array &&
    Array.isArray(v.materials)
  );
}

const describe = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "an array" : typeof v === "object" ? "an object" : String(v));

/** Where and how a model is generated, for its failure record. */
export type ModelSite = Pick<ModelFailure, "group" | "seed" | "x" | "y" | "footprint" | "repeated">;

/**
 * Generate one model for a group with the style's asset: the generator's
 * model, or, when it fails, the missing-model marker in the style's ramps,
 * with the failure added to `failures`.
 */
export function generateContained(
  spec: AssetSpec,
  ctx: GenContext,
  site: ModelSite,
  rampIds: Map<string, number>,
  failures: ModelFailure[],
): VoxelModel {
  try {
    const model: unknown = getGenerator(spec.generator, site.group)(ctx);
    if (!isModel(model)) throw new TypeError(`generator '${spec.generator}' returned ${describe(model)}, not a VoxelModel`);
    return model;
  } catch (e) {
    const source = listGenerators().find((g) => g.name === spec.generator)?.source ?? null;
    const named = (e as { plugin?: unknown }).plugin;
    failures.push({
      ...site,
      generator: spec.generator,
      ...(ctx.heightVox !== undefined ? { heightVox: ctx.heightVox } : {}),
      source,
      plugin: source ? null : typeof named === "string" ? named : (KNOWN_PLUGIN_GENERATORS[spec.generator] ?? null),
      error: e instanceof Error ? `${e.name}: ${e.message}` : `thrown: ${String(e)}`,
    });
    const own = Object.values(spec.ramps)
      .map((name) => rampIds.get(name))
      .find((id) => id !== undefined);
    const marker = rampIds.get("marker") ?? own ?? 0;
    return missingModel(ctx.mask, marker, own ?? marker);
  }
}
