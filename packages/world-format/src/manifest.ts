import { TerrainGrid } from "@pixelworld/grid";
import type { Chunk } from "./chunk";

/** World package manifest, format v0. Spec: docs/world-format.md. */

export const WORLD_FORMAT = "pixelworld-world";
export const WORLD_FORMAT_VERSION = 0;

export interface ChunkRef {
  x: number;
  y: number;
  path: string;
  sha256?: string;
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
  source?: { crs?: string; bounds?: [number, number, number, number] };
  attribution: Attribution[];
  generator?: { name: string; version?: string; params?: Record<string, unknown> };
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
  const grid = new TerrainGrid(manifest.cellsX, manifest.cellsY);
  for (const c of chunks) {
    const ox = c.x * manifest.chunkSize;
    const oy = c.y * manifest.chunkSize;
    const t = c.terrain;
    for (let y = 0; y < t.height; y++) {
      const gy = oy + y;
      if (gy < 0 || gy >= grid.height) continue;
      for (let x = 0; x < t.width; x++) {
        const gx = ox + x;
        if (gx < 0 || gx >= grid.width) continue;
        const si = t.index(x, y);
        const di = grid.index(gx, gy);
        grid.base[di] = t.base[si]!;
        grid.shape[di] = t.shape[si]!;
        grid.surface[di] = t.surface[si]!;
        grid.water[di] = t.water[si]!;
      }
    }
  }
  return grid;
}

/** Exaggeration implied by the scale: true step height (cell · 1/√6) over metres per step. */
export function verticalExaggeration(scale: WorldManifest["scale"]): number {
  return scale.verticalExaggeration ?? (scale.metersPerCell / Math.sqrt(6)) / scale.metersPerStep;
}
