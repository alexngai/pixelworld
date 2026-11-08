import { TerrainGrid, copyCells, emptyMicro } from "@pixelworld/grid";
import type { Chunk } from "./chunk";

/** World package manifest, format v0. Spec: docs/world-format.md. */

export const WORLD_FORMAT = "pixelworld-world";
export const WORLD_FORMAT_VERSION = 0;

export interface ChunkRef {
  x: number;
  y: number;
  path: string;
  sha256?: string;
  /** Lowest and highest corner height in the chunk (steps). */
  heightRange?: [number, number];
  /** Mean real metres per cell in the chunk (warped worlds). */
  metersPerCell?: number;
}

export interface Attribution {
  name: string;
  license: string;
  url?: string;
}

export interface WorldManifest {
  format: typeof WORLD_FORMAT;
  formatVersion: number;
  id: string;
  name: string;
  chunkSize: number;
  cellsX: number;
  cellsY: number;
  chunks: ChunkRef[];
  scale: {
    metersPerCell: number;
    metersPerStep: number;
    elevationDatumMeters: number;
    /**
     * Vertical exaggeration relative to true proportions (1 = real slopes),
     * already applied when the pipeline quantized heights. Informational:
     * metersPerStep is what converts steps to real metres.
     */
    verticalExaggeration?: number;
  };
  /** Surface id (as string key) → surface name. */
  surfaces: Record<string, string>;
  style: string;
  /** Lowest and highest corner height in the world (steps). */
  heightRange?: [number, number];
  /** Suggested starting cell for the camera and player. */
  start?: { x: number; y: number };
  /** Road class id (as string key) → class name, for the RCLS layer. */
  roadClasses?: Record<string, string>;
  /** Path class id (as string key) → class name, for the PCLS layer (D-050). */
  pathClasses?: Record<string, string>;
  /** Geology province id (as string key) → province name, for the GEOL layer. */
  geology?: Record<string, string>;
  /** SHA-256 over the manifest content and every chunk; identical for identical builds. */
  packageHash?: string;
  source?: { crs?: string; bounds?: [number, number, number, number] };
  attribution: Attribution[];
  generator?: { name: string; version?: string; params?: Record<string, unknown> };
  /**
   * How the world is drawn (optional; defaults to 1 render unit per cell).
   * Fine worlds set scale < 1 so a cell covers fewer pixels; tileSize is the
   * bake tile edge in cells.
   */
  render?: { scale: number; tileSize?: number };
  /** Micro-terrain (M1.6): every chunk carries K×K micro-cells per cell (MHGT). */
  micro?: { k: number };
  /** Elastic map (M2): how the world was laid out (informational). */
  warp?: {
    method: string;
    background: number;
    focus: { name: string; target: number; achieved: number; error: number }[];
    pins: number;
    vertical?: Record<string, number> | null;
  };
  /** Placed objects (a JSON file relative to the manifest); see docs/world-format.md. */
  objects?: { path: string; sha256?: string; count?: number };
  /** How objects are drawn at this scale level; overrides the style pack (D-047). */
  depiction?: { heightStretch?: number; scatter?: number };
  /** This world's scale level (D-046), e.g. "fly", "drive", "walk". */
  level?: string;
  /** Every level of the region; `world` is the sibling package's id (its directory). */
  levels?: LevelRef[];
  /** Lon/lat of cell corners every `step` cells (geo.ts), for moving between levels. */
  geo?: { path: string; step: number; size: [number, number]; sha256?: string };
  /** Painted-over hero landmarks (M3, D-053): one entry per landmark and rotation. */
  heroes?: HeroRef[];
}

export interface HeroRef {
  id: string;
  rotation: 0 | 1 | 2 | 3;
  /** Absolute screen pixels of the bake's top-left corner in this rotation. */
  left: number;
  top: number;
  width: number;
  height: number;
  depthBase: number;
  /** The offline bake (RGBA PNG: index, depth hi, depth lo, coverage). */
  bake: string;
  /** The paint-over (indexed PNG, 0 = keep the bake). */
  paint: string;
  sha256?: string;
}

export interface LevelRef {
  name: string;
  world: string;
  label?: string;
}

/**
 * Objects file: semantic-group instances placed by the pipeline, as read by
 * `parseObjects`: footprints are in absolute cells whichever version was
 * stored (version 2 stores them relative to the anchor).
 */
export interface ObjectsFile {
  version: 1 | 2;
  instances: {
    g: string;
    x: number;
    y: number;
    s: number;
    r?: number;
    /** Footprint polygon in cells. */
    fp?: [number, number][];
    hm?: number;
    /** Real metres per cell at the instance (warped worlds). */
    m?: number;
    /** Absolute top height in steps (dam crests, bridge decks). */
    top?: number;
    /** Landmark registry id (M3). */
    id?: string;
    /** Overture roof shape and facade material hints (M3). */
    rs?: string;
    fm?: string;
    /** Typology hints (D-055): front direction (0-7), corner lot, year built, storeys. */
    fr?: number;
    cn?: number;
    yr?: number;
    fl?: number;
    /** Base height in steps (long landmarks). */
    z0?: number;
    /** A piece of a long landmark: the whole line's ends and half-width, in cells. */
    ln?: [number, number, number, number];
    lw?: number;
  }[];
}

export class ManifestError extends Error {}

export function parseManifest(json: unknown): WorldManifest {
  if (typeof json !== "object" || json === null) throw new ManifestError("manifest must be an object");
  const m = json as Partial<WorldManifest>;
  if (m.format !== WORLD_FORMAT) throw new ManifestError(`unexpected format ${String(m.format)}`);
  if (m.formatVersion !== WORLD_FORMAT_VERSION)
    throw new ManifestError(`unsupported formatVersion ${String(m.formatVersion)}`);
  for (const key of ["id", "name", "style"] as const)
    if (typeof m[key] !== "string") throw new ManifestError(`missing ${key}`);
  for (const key of ["chunkSize", "cellsX", "cellsY"] as const)
    if (!Number.isInteger(m[key]) || (m[key] as number) <= 0)
      throw new ManifestError(`invalid ${key}`);
  if (!Array.isArray(m.chunks)) throw new ManifestError("missing chunks");
  if (!m.scale || typeof m.scale.metersPerStep !== "number")
    throw new ManifestError("missing scale");
  if (m.micro !== undefined && ![2, 4, 8].includes(m.micro.k))
    throw new ManifestError("micro.k must be 2, 4 or 8");
  if (m.render !== undefined) {
    const sc = m.render.scale;
    if (!(typeof sc === "number" && sc > 0 && sc <= 1)) throw new ManifestError("render.scale must be in (0, 1]");
    const ts = m.render.tileSize;
    if (ts !== undefined && !(Number.isInteger(ts) && ts > 0)) throw new ManifestError("invalid render.tileSize");
  }
  const ve = m.scale.verticalExaggeration;
  if (ve !== undefined && !(typeof ve === "number" && ve > 0))
    throw new ManifestError("verticalExaggeration must be a positive number");
  if (!m.surfaces || typeof m.surfaces !== "object") throw new ManifestError("missing surfaces");
  if (!Array.isArray(m.attribution)) throw new ManifestError("missing attribution");
  return m as WorldManifest;
}

/** Surface name → id lookup for a manifest. */
export function surfaceIds(manifest: WorldManifest): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, name] of Object.entries(manifest.surfaces)) out.set(name, Number(id));
  return out;
}

/** Assemble decoded chunks into one TerrainGrid covering the whole world. */
export function assembleTerrain(manifest: WorldManifest, chunks: Chunk[]): TerrainGrid {
  const micro = manifest.micro ? emptyMicro(manifest.micro.k, manifest.cellsX, manifest.cellsY) : null;
  const grid = new TerrainGrid(manifest.cellsX, manifest.cellsY, { micro });
  for (const c of chunks) {
    const t = c.terrain;
    copyCells(t, 0, 0, grid, c.x * manifest.chunkSize, c.y * manifest.chunkSize, t.width, t.height);
  }
  return grid;
}

/** Exaggeration implied by the scale: true step height (cell · 1/√6) over metres per step. */
export function verticalExaggeration(scale: WorldManifest["scale"]): number {
  return scale.verticalExaggeration ?? (scale.metersPerCell / Math.sqrt(6)) / scale.metersPerStep;
}
