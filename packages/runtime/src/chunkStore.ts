import { NO_WATER, TerrainGrid, copyCells } from "@pixelworld/grid";
import {
  decodeChunk,
  maybeGunzip,
  parseManifest,
  type Chunk,
  type ChunkRef,
  type ObjectsFile,
  type WorldManifest,
} from "@pixelworld/world-format";

type Fetcher = (url: string) => Promise<ArrayBuffer>;

const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
};

/** Fetch and validate a world manifest. */
export async function loadManifest(baseUrl: string): Promise<WorldManifest> {
  const res = await fetch(withSlash(baseUrl) + "manifest.json");
  if (!res.ok) throw new Error(`manifest: HTTP ${res.status}`);
  return parseManifest(await res.json());
}

/** Fetch a world's placed objects, if it has any (gzip or plain JSON). */
export async function loadObjects(baseUrl: string, manifest: WorldManifest): Promise<ObjectsFile | null> {
  if (!manifest.objects) return null;
  const res = await fetch(withSlash(baseUrl) + manifest.objects.path);
  if (!res.ok) throw new Error(`${manifest.objects.path}: HTTP ${res.status}`);
  const bytes = await maybeGunzip(await res.arrayBuffer());
  const file = JSON.parse(new TextDecoder().decode(bytes)) as ObjectsFile;
  if (file.version !== 1 || !Array.isArray(file.instances)) throw new Error("unsupported objects file");
  return file;
}

function withSlash(url: string): string {
  return url.endsWith("/") ? url : url + "/";
}

/**
 * Streams chunks of a world package on demand. Chunks are immutable for a
 * given manifest, so their URLs carry the chunk hash for HTTP caching.
 */
export class ChunkStore {
  private readonly base: string;
  private readonly refs = new Map<string, ChunkRef>();
  private readonly chunks = new Map<string, Chunk>();
  private readonly pending = new Map<string, Promise<Chunk | null>>();
  readonly chunkSize: number;
  readonly cellsX: number;
  readonly cellsY: number;

  constructor(
    readonly manifest: WorldManifest,
    baseUrl: string,
    private readonly fetcher: Fetcher = defaultFetcher,
  ) {
    this.base = withSlash(baseUrl);
    this.chunkSize = manifest.chunkSize;
    this.cellsX = manifest.cellsX;
    this.cellsY = manifest.cellsY;
    for (const ref of manifest.chunks) this.refs.set(key(ref.x, ref.y), ref);
  }

  get loadedCount(): number {
    return this.chunks.size;
  }

  get(cx: number, cy: number): Chunk | undefined {
    return this.chunks.get(key(cx, cy));
  }

  ref(cx: number, cy: number): ChunkRef | undefined {
    return this.refs.get(key(cx, cy));
  }

  /** Load one chunk (deduplicated); null when the package has no such chunk. */
  ensure(cx: number, cy: number): Promise<Chunk | null> {
    const k = key(cx, cy);
    const have = this.chunks.get(k);
    if (have) return Promise.resolve(have);
    const inflight = this.pending.get(k);
    if (inflight) return inflight;
    const ref = this.refs.get(k);
    if (!ref) return Promise.resolve(null);
    const url = this.base + ref.path + (ref.sha256 ? `?v=${ref.sha256.slice(0, 16)}` : "");
    const p = this.fetcher(url)
      .then(maybeGunzip)
      .then((buf) => {
        const chunk = decodeChunk(buf);
        this.chunks.set(k, chunk);
        return chunk;
      })
      .finally(() => this.pending.delete(k));
    this.pending.set(k, p);
    return p;
  }

  /** Chunk coordinates overlapping a cell rectangle (clipped to the world). */
  chunksFor(x0: number, y0: number, x1: number, y1: number): [number, number][] {
    const s = this.chunkSize;
    const out: [number, number][] = [];
    const cx0 = Math.max(0, Math.floor(Math.max(0, x0) / s));
    const cy0 = Math.max(0, Math.floor(Math.max(0, y0) / s));
    const cx1 = Math.floor((Math.min(this.cellsX, x1) - 1) / s);
    const cy1 = Math.floor((Math.min(this.cellsY, y1) - 1) / s);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) out.push([cx, cy]);
    return out;
  }

  async ensureRect(x0: number, y0: number, x1: number, y1: number): Promise<void> {
    await Promise.all(this.chunksFor(x0, y0, x1, y1).map(([cx, cy]) => this.ensure(cx, cy)));
  }

  isLoadedRect(x0: number, y0: number, x1: number, y1: number): boolean {
    return this.chunksFor(x0, y0, x1, y1).every(([cx, cy]) => this.chunks.has(key(cx, cy)));
  }

  /**
   * Copy a world rectangle of cells (clipped to the world) into a new grid.
   * Cells in chunks that aren't loaded stay at defaults; call ensureRect first.
   */
  slice(x0: number, y0: number, x1: number, y1: number): { grid: TerrainGrid; x0: number; y0: number } {
    const sx0 = Math.max(0, x0);
    const sy0 = Math.max(0, y0);
    const sx1 = Math.min(this.cellsX, x1);
    const sy1 = Math.min(this.cellsY, y1);
    const grid = new TerrainGrid(Math.max(0, sx1 - sx0), Math.max(0, sy1 - sy0));
    const s = this.chunkSize;
    for (const [cx, cy] of this.chunksFor(sx0, sy0, sx1, sy1)) {
      const chunk = this.chunks.get(key(cx, cy));
      if (!chunk) continue;
      copyCells(chunk.terrain, 0, 0, grid, cx * s - sx0, cy * s - sy0, s, s);
    }
    return { grid, x0: sx0, y0: sy0 };
  }

  private cellOf(x: number, y: number): { chunk: Chunk; lx: number; ly: number } | null {
    if (x < 0 || y < 0 || x >= this.cellsX || y >= this.cellsY) return null;
    const s = this.chunkSize;
    const cx = Math.floor(x / s);
    const cy = Math.floor(y / s);
    const chunk = this.chunks.get(key(cx, cy));
    return chunk ? { chunk, lx: x - cx * s, ly: y - cy * s } : null;
  }

  /** Terrain surface height at a continuous world position, or null if not loaded. */
  surfaceHeightAt(x: number, y: number): number | null {
    const c = this.cellOf(Math.floor(x), Math.floor(y));
    if (!c) return null;
    return c.chunk.terrain.surfaceHeightAt(c.lx + (x - Math.floor(x)), c.ly + (y - Math.floor(y)));
  }

  isWater(x: number, y: number): boolean {
    const c = this.cellOf(Math.floor(x), Math.floor(y));
    return !!c && c.chunk.terrain.water[c.chunk.terrain.index(c.lx, c.ly)] !== NO_WATER;
  }

  /** Height range of the cells in a rectangle, from manifest chunk ranges. */
  heightRangeFor(x0: number, y0: number, x1: number, y1: number): [number, number] {
    let lo = Infinity;
    let hi = -Infinity;
    for (const [cx, cy] of this.chunksFor(x0, y0, x1, y1)) {
      const r = this.refs.get(key(cx, cy))?.heightRange ?? this.manifest.heightRange;
      if (!r) continue;
      lo = Math.min(lo, r[0]);
      hi = Math.max(hi, r[1]);
    }
    return Number.isFinite(lo) ? [lo, hi] : [0, 0];
  }
}

function key(cx: number, cy: number): string {
  return `${cx},${cy}`;
}
