import { generateContained, type ModelFailure, type ModelSite } from "./failures";
import { MeshBuilder, type MeshData } from "./mesh";
import { getGenerator } from "./registry";
import { VoxelModel, meshVoxels, rng, type VoxelScale } from "./voxel";

/**
 * Procedural assets for semantic groups (D-030). A style pack maps group
 * names to a generator and its parameters; the pipeline only names groups.
 * Generators are looked up by name in the registry (registry.ts): the
 * built-ins, and whatever plugins registered (D-071).
 *
 * Objects use a fixed pixel scale: one voxel is a 2×1 px top and 1 px tall
 * at native zoom, whatever the map's layout scale (object scale, D-010).
 */

/** An object placed by the pipeline (world cell coordinates). */
export interface ObjectInstance {
  /** Semantic group, e.g. "tree.conifer" or "building.tower". */
  g: string;
  x: number;
  y: number;
  /** Seed: picks the variant and drives the generator. */
  s: number;
  /** Quarter turns (vegetation, and landmarks without a footprint). */
  r?: number;
  /** Footprint polygon in world cells (buildings). */
  fp?: [number, number][];
  /** Real height in metres (buildings, landmarks). */
  hm?: number;
  /** Real metres per cell at the instance (warped worlds; the world's scale otherwise). */
  m?: number;
  /** Absolute top height in steps (dam crests), overriding hm. */
  top?: number;
  /** Landmark registry id (landmarks, M3). */
  id?: string;
  /** Overture roof shape (buildings, M3): flat, pyramidal, dome, hipped, gabled, … */
  rs?: string;
  /** Overture facade material, e.g. glass (buildings, M3). */
  fm?: string;
  /** Overture facade / roof colour (#rrggbb), kept for later use. */
  fc?: string;
  rc?: string;
  /** Typology hints (D-055): the direction the front faces (0-7, 45° steps from +x), a corner lot, year built, storeys. */
  fr?: number;
  cn?: number;
  yr?: number;
  fl?: number;
  /** Base height in steps (long landmarks, so every tile builds them alike). */
  z0?: number;
  /** A piece of a long landmark: the whole line's ends [ax, ay, bx, by] and half-width, in cells. */
  ln?: [number, number, number, number];
  lw?: number;
}

/** Footprints wider than this (cells) are owned per voxel column (see meshVoxels). */
export const BIG_FOOTPRINT_CELLS = 16;

/** A footprint's bounding box in cells: [x0, y0, x1, y1]. */
export function footprintBounds(fp: [number, number][]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of fp) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

/** Style-pack entry for a group: generator name, role → ramp name, parameters. */
export interface AssetSpec {
  generator: string;
  ramps: Record<string, string>;
  params?: Record<string, number | number[]>;
}

export type AssetCatalog = Record<string, AssetSpec>;

/** Find the spec for a group by longest dotted prefix ("tree.conifer.ponderosa" → "tree.conifer"). */
export function resolveAsset(catalog: AssetCatalog, group: string): AssetSpec | null {
  for (let g = group; g; g = g.includes(".") ? g.slice(0, g.lastIndexOf(".")) : "") {
    const spec = catalog[g];
    if (spec) return spec;
  }
  return null;
}

export interface GenContext {
  rand: () => number;
  ramp: (role: string) => number;
  /** Ramp ids of every role named `role` or `role.<variant>` (e.g. wall, wall.gold). */
  ramps: (role: string) => number[];
  param: (name: string, fallback: number) => number;
  /** Footprint mask in voxels (buildings). */
  mask?: { sx: number; sy: number; on: Uint8Array };
  /** Target height in voxels (buildings, landmarks). */
  heightVox?: number;
  /**
   * Hints from the data (buildings): Overture roof shape and facade material,
   * and the typology's street front, corner lot, year built and storeys (D-055).
   */
  hints?: { roof?: string; facade?: string; front?: number; corner?: boolean; year?: number; floors?: number };
  /**
   * Where the model sits (footprint objects): its (0, 0) corner in world cells
   * and the voxel size in cells; for a piece of a long landmark, the whole line.
   */
  frame?: { x0: number; y0: number; voxel: number; line?: { a: [number, number]; b: [number, number]; half: number } };
  /** Target size in voxels (traffic vehicles, D-064): along, across, up. */
  size?: { length: number; width: number; height: number };
  /** Which car of a consist (traffic vehicles): 0 the head, then its wagons. */
  part?: number;
  /** The vehicle's variant (traffic vehicles), as the simulation picked it. */
  variant?: number;
}

export type Generator = (ctx: GenContext) => VoxelModel;

/**
 * Generate one model for a group, as buildObjects would (used by tests and
 * the offline hero bake): footprint mask, height in voxels, seed and hints.
 */
export function generateModel(
  catalog: AssetCatalog,
  rampIds: Map<string, number>,
  group: string,
  opts: {
    seed: number;
    mask?: { sx: number; sy: number; on: Uint8Array };
    heightVox?: number;
    hints?: GenContext["hints"];
    frame?: GenContext["frame"];
    size?: GenContext["size"];
    part?: number;
    variant?: number;
  },
): VoxelModel {
  const spec = resolveAsset(catalog, group);
  if (!spec) throw new Error(`no asset for group ${group}`);
  const gen = getGenerator(spec.generator, group);
  const ctx = makeContext(spec, { rampIds } as ObjectBuildOptions, opts.seed);
  ctx.mask = opts.mask;
  ctx.heightVox = opts.heightVox;
  ctx.hints = opts.hints;
  ctx.frame = opts.frame;
  ctx.size = opts.size;
  ctx.part = opts.part;
  ctx.variant = opts.variant;
  return gen(ctx);
}

/** Rotate a model by quarter turns around the vertical axis. */
export function rotateModel(model: VoxelModel, quarters: number): VoxelModel {
  let m = model;
  for (let q = 0; q < (((quarters % 4) + 4) % 4); q++) {
    const out = new VoxelModel(m.sy, m.sx, m.sz, [...m.materials]);
    for (let z = 0; z < m.sz; z++)
      for (let y = 0; y < m.sy; y++) for (let x = 0; x < m.sx; x++) out.set(m.sy - 1 - y, x, z, m.get(x, y, z));
    m = out;
  }
  return m;
}

/**
 * Voxel size in world units for a render scale: objects keep a fixed pixel
 * size (2×1 px voxel tops, 1 px tall) however large a world cell is drawn.
 */
export function objectVoxelScale(renderScale: number): VoxelScale {
  return { h: 1 / (16 * renderScale), v: 1 / (8 * renderScale) };
}

export interface ObjectBuildOptions {
  catalog: AssetCatalog;
  rampIds: Map<string, number>;
  /** Voxel size in world units. */
  voxel: VoxelScale;
  /** Voxel size in metres (horizontal), for converting building footprints and heights. */
  voxelMeters: number;
  /** Extra vertical stretch for buildings and landmarks (pixel-art cities read taller). */
  heightStretch: number;
  /** Terrain height (world steps) under a point. */
  heightAt: (x: number, y: number) => number;
  /** Variants generated per group for instanced objects. */
  variants?: number;
}

export interface InstancedBatch {
  mesh: MeshData;
  /** xyz per instance, world units. */
  offsets: Float32Array;
  /** owning cell per instance. */
  cells: Float32Array;
}

export interface ObjectMeshes {
  /** Unique objects (buildings, landmarks) merged into one mesh. */
  merged: MeshData;
  /** Repeated objects (vegetation, rocks) drawn instanced per variant. */
  batches: InstancedBatch[];
  skipped: number;
  /** Models that failed to generate, drawn as missing-model markers instead (D-072). */
  failures: ModelFailure[];
}

function makeContext(spec: AssetSpec, opts: ObjectBuildOptions, seed: number): GenContext {
  const rand = rng(seed);
  return {
    rand,
    ramp: (role) => {
      const name = spec.ramps[role];
      const id = name !== undefined ? opts.rampIds.get(name) : undefined;
      if (id === undefined) throw new Error(`asset ramp '${role}' (${name}) is not in the palette`);
      return id;
    },
    ramps: (role) =>
      Object.keys(spec.ramps)
        .filter((k) => k === role || k.startsWith(role + "."))
        .sort()
        .map((k) => {
          const id = opts.rampIds.get(spec.ramps[k]!);
          if (id === undefined) throw new Error(`asset ramp '${k}' (${spec.ramps[k]}) is not in the palette`);
          return id;
        }),
    param: (name, fallback) => {
      const v = spec.params?.[name];
      return typeof v === "number" ? v : fallback;
    },
  };
}

/** Rasterize a footprint polygon (world cells) into voxel columns. */
export function footprintMask(
  fp: [number, number][],
  voxelCells: number,
): { mask: { sx: number; sy: number; on: Uint8Array }; x0: number; y0: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of fp) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const x0 = Math.floor(minX / voxelCells) * voxelCells;
  const y0 = Math.floor(minY / voxelCells) * voxelCells;
  const sx = Math.max(1, Math.ceil((maxX - x0) / voxelCells));
  const sy = Math.max(1, Math.ceil((maxY - y0) / voxelCells));
  const on = new Uint8Array(sx * sy);
  for (let j = 0; j < sy; j++)
    for (let i = 0; i < sx; i++) {
      const px = x0 + (i + 0.5) * voxelCells;
      const py = y0 + (j + 0.5) * voxelCells;
      let inside = false;
      for (let a = 0, b = fp.length - 1; a < fp.length; b = a++) {
        const [xa, ya] = fp[a]!;
        const [xb, yb] = fp[b]!;
        if (ya > py !== yb > py && px < ((xb - xa) * (py - ya)) / (yb - ya) + xa) inside = !inside;
      }
      on[j * sx + i] = inside ? 1 : 0;
    }
  // tiny footprints still get one column
  if (!on.some((v) => v)) on[Math.floor(sy / 2) * sx + Math.floor(sx / 2)] = 1;
  return { mask: { sx, sy, on }, x0, y0 };
}

/** Build meshes for a set of instances. */
export function buildObjects(instances: ObjectInstance[], opts: ObjectBuildOptions): ObjectMeshes {
  const merged = new MeshBuilder();
  const variants = new Map<string, { mesh: MeshData; offsets: number[]; cells: number[] }>();
  const nVariants = opts.variants ?? 6;
  let skipped = 0;
  const failures: ModelFailure[] = [];
  for (const inst of instances) {
    const spec = resolveAsset(opts.catalog, inst.g);
    if (!spec) {
      skipped++;
      continue;
    }
    // a model that fails to generate is drawn as a marker, not left to fail the whole bake (D-072)
    const gen = (ctx: GenContext, site: Partial<ModelSite> = {}) =>
      generateContained(spec, ctx, { group: inst.g, seed: inst.s, x: inst.x, y: inst.y, ...site }, opts.rampIds, failures);
    const cell: [number, number] = [Math.floor(inst.x), Math.floor(inst.y)];
    // Footprints sit on their lowest corner so slopes don't leave them floating.
    const base =
      inst.z0 !== undefined
        ? inst.z0
        : inst.fp
          ? Math.min(...inst.fp.map(([x, y]) => opts.heightAt(x, y)))
          : opts.heightAt(inst.x, inst.y);
    if (inst.fp || inst.hm !== undefined || inst.top !== undefined) {
      // unique object: footprint building or landmark
      const ctx = makeContext(spec, opts, inst.s);
      if (inst.rs || inst.fm || inst.fr !== undefined || inst.fl !== undefined)
        ctx.hints = {
          roof: inst.rs,
          facade: inst.fm,
          front: inst.fr,
          corner: inst.cn === 1,
          year: inst.yr,
          floors: inst.fl,
        };
      // voxel metres follow the local scale on warped worlds
      const voxelMeters = inst.m !== undefined ? opts.voxel.h * inst.m : opts.voxelMeters;
      if (inst.hm !== undefined) ctx.heightVox = (inst.hm / voxelMeters) * opts.heightStretch;
      if (inst.top !== undefined) ctx.heightVox = Math.max(1, (inst.top - base) / opts.voxel.v);
      let origin: [number, number, number];
      let model: VoxelModel;
      if (inst.fp) {
        const fpm = footprintMask(inst.fp, opts.voxel.h);
        ctx.mask = fpm.mask;
        ctx.frame = { x0: fpm.x0, y0: fpm.y0, voxel: opts.voxel.h };
        if (inst.ln && inst.lw !== undefined)
          ctx.frame.line = { a: [inst.ln[0], inst.ln[1]], b: [inst.ln[2], inst.ln[3]], half: inst.lw };
        const [bx0, by0, bx1, by1] = footprintBounds(inst.fp);
        model = gen(ctx, { footprint: { cells: [bx1 - bx0, by1 - by0], voxels: [fpm.mask.sx, fpm.mask.sy] } });
        origin = [fpm.x0, fpm.y0, base];
        if (Math.max(bx1 - bx0, by1 - by0) > BIG_FOOTPRINT_CELLS) {
          meshVoxels(model, opts.voxel, origin, "column", merged);
          continue;
        }
      } else {
        // landmarks may be turned (an observation wheel's plane)
        model = inst.r ? rotateModel(gen(ctx), inst.r) : gen(ctx);
        origin = [inst.x - (model.sx * opts.voxel.h) / 2, inst.y - (model.sy * opts.voxel.h) / 2, base];
      }
      meshVoxels(model, opts.voxel, origin, cell, merged);
      continue;
    }
    const variant = Math.abs(inst.s) % nVariants;
    const key = `${inst.g}#${variant}#${inst.r ?? 0}`;
    let batch = variants.get(key);
    if (!batch) {
      const seed = 1000 + variant * 7919 + hash(inst.g);
      const model = rotateModel(gen(makeContext(spec, opts, seed), { seed, repeated: true }), inst.r ?? 0);
      // instance origin is the model's bottom centre
      const origin: [number, number, number] = [-(model.sx * opts.voxel.h) / 2, -(model.sy * opts.voxel.h) / 2, 0];
      batch = { mesh: meshVoxels(model, opts.voxel, origin, [0, 0]).build(), offsets: [], cells: [] };
      variants.set(key, batch);
    }
    batch.offsets.push(inst.x, inst.y, base);
    batch.cells.push(cell[0], cell[1]);
  }
  return {
    merged: merged.build(),
    // an empty variant would have no bounds: leave it out
    batches: [...variants.values()].filter((b) => b.mesh.vertexCount > 0).map((b) => ({
      mesh: b.mesh,
      offsets: new Float32Array(b.offsets),
      cells: new Float32Array(b.cells),
    })),
    skipped,
    failures,
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
