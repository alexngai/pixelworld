import type { TerrainGrid } from "@pixelworlds/grid";
import {
  assembleTerrain,
  decodeChunk,
  fetchWorldFile,
  maybeGunzip,
  parseWorldFile,
  type WorldManifest,
} from "@pixelworlds/world-format";
import { INCOMPLETE_PACKAGE, loadManifest } from "./chunkStore";

export interface LoadedWorld {
  manifest: WorldManifest;
  terrain: TerrainGrid;
}

/** Fetch a world package (manifest + all chunks) from a base URL. Errors name the URL (D-072). */
export async function loadWorld(baseUrl: string): Promise<LoadedWorld> {
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  const manifest = await loadManifest(base);
  const chunks = await Promise.all(
    manifest.chunks.map(async (ref) => {
      const url = base + ref.path;
      const what = `world chunk ${ref.x},${ref.y}`;
      const bytes = await fetchWorldFile(url, { label: what, expected: "a chunk the manifest lists", hint: INCOMPLETE_PACKAGE });
      return parseWorldFile(url, what, async () => decodeChunk(await maybeGunzip(bytes)));
    }),
  );
  return { manifest, terrain: assembleTerrain(manifest, chunks) };
}
