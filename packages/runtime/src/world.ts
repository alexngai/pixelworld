import type { TerrainGrid } from "@pixelworld/grid";
import {
  assembleTerrain,
  decodeChunk,
  maybeGunzip,
  parseManifest,
  type WorldManifest,
} from "@pixelworld/world-format";

export interface LoadedWorld {
  manifest: WorldManifest;
  terrain: TerrainGrid;
}

/** Fetch a world package (manifest + all chunks) from a base URL. */
export async function loadWorld(baseUrl: string): Promise<LoadedWorld> {
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  const res = await fetch(base + "manifest.json");
  if (!res.ok) throw new Error(`manifest: HTTP ${res.status}`);
  const manifest = parseManifest(await res.json());
  const chunks = await Promise.all(
    manifest.chunks.map(async (ref) => {
      const r = await fetch(base + ref.path);
      if (!r.ok) throw new Error(`${ref.path}: HTTP ${r.status}`);
      return decodeChunk(await maybeGunzip(await r.arrayBuffer()));
    }),
  );
  return { manifest, terrain: assembleTerrain(manifest, chunks) };
}
