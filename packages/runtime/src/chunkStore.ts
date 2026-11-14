import { NO_WATER, TerrainGrid, copyCells, emptyMicro } from "@pixelworlds/grid";
import {
  decodeChunk,
  fetchWorldFile,
  fetchWorldJson,
  maybeGunzip,
  parseManifest,
  parseObjects,
  parseWorldFile,
  type Chunk,
  type ChunkRef,
  type DroppableLayer,
  type ObjectsFile,
  type WorldManifest,
} from "@pixelworlds/world-format";

/** Fetches a chunk's bytes; `what` names the chunk in errors. */
type Fetcher = (url: string, what: string) => Promise<ArrayBuffer>;

/** The advice for a file the manifest names that isn't there. */
export const INCOMPLETE_PACKAGE = "the package is incomplete, or its files are from different builds";

const defaultFetcher: Fetcher = (url, what) =>
  fetchWorldFile(url, { label: what, expected: "a chunk the manifest lists", hint: INCOMPLETE_PACKAGE });

/**
 * Fetch and validate a world manifest. Its errors name the URL (D-072): a
 * wrong `worldUrl` reads "not a world package: …/manifest.json returned an
 * HTML page (…); check worldUrl", not a JSON parser's "Unexpected token '<'".
 */
export async function loadManifest(baseUrl: string): Promise<WorldManifest> {
  const url = withSlash(baseUrl) + "manifest.json";
  const hint = `check worldUrl ("${baseUrl}")`;
  const json = await fetchWorldJson(url, { label: "not a world package", expected: "a world manifest", hint });
  return parseWorldFile(url, "world manifest", () => parseManifest(json));
}

/**
 * Fetch a world's placed objects, if it has any (gzip or plain JSON, version 1
 * or 2). Footprints come back in absolute cells whichever version was stored.
 */
export async function loadObjects(baseUrl: string, manifest: WorldManifest): Promise<ObjectsFile | null> {
  if (!manifest.objects) return null;
  const url = withSlash(baseUrl) + manifest.objects.path;
  const info = { label: "world objects", expected: "the objects file the manifest names", hint: INCOMPLETE_PACKAGE };
  const json = await fetchWorldJson(url, info);
  return parseWorldFile(url, "world objects", () => parseObjects(json));
}

/** A package's landmarks for clients that load its objects by chunk (D-123): every instance with a landmark id. */
export async function loadObjectLandmarks(baseUrl: string, manifest: WorldManifest): Promise<ObjectsFile | null> {
  const lm = manifest.objectChunks?.landmarks;
  if (!lm) return null;
  return loadObjectsFile(withSlash(baseUrl) + lm.path + version(lm.sha256), "world landmarks");
}

async function loadObjectsFile(url: string, label: string): Promise<ObjectsFile> {
  const json = await fetchWorldJson(url, { label, expected: "the objects file the manifest names", hint: INCOMPLETE_PACKAGE });
  return parseWorldFile(url, label, () => parseObjects(json));
}

/** A file's cache-busting query from its hash. */
function version(sha256: string | undefined): string {
  return sha256 ? `?v=${sha256.slice(0, 16)}` : "";
}

function withSlash(url: string): string {
  return url.endsWith("/") ? url : url + "/";
}

/** A loaded chunk, its objects (with `objectChunks`), its decoded size, and when it was last used (a count, for least recently used first). */
interface Held {
  chunk: Chunk;
  objects: ObjectsFile | null;
  bytes: number;
  used: number;
}

/**
 * Streams chunks of a world package on demand. Chunks are immutable for a
 * given manifest, so their URLs carry the chunk hash for HTTP caching.
 *
 * A memory budget (`maxBytes`, D-120): past it, the chunks least recently
 * used (read, ensured or checked) go after each load, but never one an
 * `ensureRect` is loading or has just loaded, which stays until after the
 * caller's own reads that follow its await. Unlimited by default.
 */
export class ChunkStore {
  private readonly base: string;
  private readonly refs = new Map<string, ChunkRef>();
  private readonly chunks = new Map<string, Held>();
  private readonly pending = new Map<string, Promise<Chunk | null>>();
  /** Chunks an `ensureRect` holds: how many hold each. */
  private readonly pins = new Map<string, number>();
  private uses = 0;
  private held = 0;
  readonly chunkSize: number;
  readonly cellsX: number;
  readonly cellsY: number;
  /** Bytes of decoded chunks to keep at most (default unlimited). */
  maxBytes = Infinity;
  /** Chunks let go so far to stay within `maxBytes`. */
  evicted = 0;
  /** Layers left out of every chunk loaded from now on (D-123): they read as empty. */
  dropLayers: ReadonlySet<DroppableLayer> = new Set();
  /** Load each chunk's placed objects with it, where the package has them by chunk (D-123); the budget counts terrain only. */
  objectChunks = false;
  private readonly objectRefs = new Map<string, { sha256?: string }>();

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
    for (const ref of manifest.objectChunks?.chunks ?? []) this.objectRefs.set(key(ref.x, ref.y), ref);
  }

  get loadedCount(): number {
    return this.chunks.size;
  }

  /** Bytes of the decoded chunks loaded now. */
  get loadedBytes(): number {
    return this.held;
  }

  get(cx: number, cy: number): Chunk | undefined {
    return this.use(key(cx, cy))?.chunk;
  }

  ref(cx: number, cy: number): ChunkRef | undefined {
    return this.refs.get(key(cx, cy));
  }

  /** Load one chunk (deduplicated); null when the package has no such chunk. */
  ensure(cx: number, cy: number): Promise<Chunk | null> {
    const k = key(cx, cy);
    const have = this.use(k);
    if (have) return Promise.resolve(have.chunk);
    const inflight = this.pending.get(k);
    if (inflight) return inflight;
    const ref = this.refs.get(k);
    if (!ref) return Promise.resolve(null);
    const url = this.base + ref.path + version(ref.sha256);
    const what = `world chunk ${cx},${cy}`;
    const terrain = async (): Promise<Chunk> => {
      const bytes = await this.fetcher(url, what);
      return parseWorldFile(url, what, async () => decodeChunk(await maybeGunzip(bytes), { drop: this.dropLayers }));
    };
    const oref = this.objectChunks ? this.objectRefs.get(k) : undefined;
    const objects = async (): Promise<ObjectsFile | null> =>
      oref ? loadObjectsFile(this.base + this.manifest.objectChunks!.path.replace("{x}", String(cx)).replace("{y}", String(cy)) + version(oref.sha256), `world objects of chunk ${cx},${cy}`) : null;
    const p = Promise.all([terrain(), objects()])
      .then(([chunk, objects]) => {
        const bytes = chunkBytes(chunk, this.dropLayers);
        this.chunks.set(k, { chunk, objects, bytes, used: ++this.uses });
        this.held += bytes;
        this.trim();
        return chunk;
      })
      .finally(() => this.pending.delete(k));
    this.pending.set(k, p);
    return p;
  }

  /** A loaded chunk, marked used now. */
  private use(k: string): Held | undefined {
    const h = this.chunks.get(k);
    if (h) h.used = ++this.uses;
    return h;
  }

  /** Over the budget: the least recently used chunks go, but not those an `ensureRect` holds. */
  private trim(): void {
    if (this.held <= this.maxBytes) return;
    // ponytail: a sort per load over budget, fine for hundreds of chunks; a heap if worlds hold thousands
    const old = [...this.chunks].filter(([k]) => !this.pins.has(k)).sort((a, b) => a[1].used - b[1].used);
    for (const [k, h] of old) {
      if (this.held <= this.maxBytes) break;
      this.chunks.delete(k);
      this.held -= h.bytes;
      this.evicted++;
    }
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

  /**
   * Load the chunks under a cell rectangle. They are held from the call until
   * a task after it resolves, so the budget can't let one go before the
   * caller's reads that follow its await (a tile's slice, a step).
   */
  async ensureRect(x0: number, y0: number, x1: number, y1: number): Promise<void> {
    const cs = this.chunksFor(x0, y0, x1, y1);
    const keys = cs.map(([cx, cy]) => key(cx, cy));
    for (const k of keys) this.pins.set(k, (this.pins.get(k) ?? 0) + 1);
    try {
      await Promise.all(cs.map(([cx, cy]) => this.ensure(cx, cy)));
    } finally {
      setTimeout(() => {
        for (const k of keys) {
          const n = this.pins.get(k)! - 1;
          if (n > 0) this.pins.set(k, n);
          else this.pins.delete(k);
        }
        this.trim();
      });
    }
  }

  /** The placed objects of the chunk holding a cell (`objectChunks`): null where it has none, undefined where it isn't loaded. */
  objectsIn(x: number, y: number): ObjectsFile | null | undefined {
    if (x < 0 || y < 0 || x >= this.cellsX || y >= this.cellsY) return null;
    return this.use(key(Math.floor(x / this.chunkSize), Math.floor(y / this.chunkSize)))?.objects;
  }

  /** Whether every chunk under a cell rectangle is loaded (one the package lacks has nothing to wait for), marking them used: a check is a use. */
  isLoadedRect(x0: number, y0: number, x1: number, y1: number): boolean {
    let all = true;
    for (const [cx, cy] of this.chunksFor(x0, y0, x1, y1)) if (!this.use(key(cx, cy)) && this.refs.has(key(cx, cy))) all = false;
    return all;
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
    const w = Math.max(0, sx1 - sx0);
    const h = Math.max(0, sy1 - sy0);
    const k = this.manifest.micro?.k;
    const grid = new TerrainGrid(w, h, k ? { micro: emptyMicro(k, w, h) } : undefined);
    const s = this.chunkSize;
    for (const [cx, cy] of this.chunksFor(sx0, sy0, sx1, sy1)) {
      const chunk = this.use(key(cx, cy))?.chunk;
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
    const chunk = this.use(key(cx, cy))?.chunk;
    return chunk ? { chunk, lx: x - cx * s, ly: y - cy * s } : null;
  }

  /** The loaded terrain holding a cell and the cell's index in it, or null (outside, or not loaded). */
  cell(x: number, y: number): { terrain: TerrainGrid; i: number } | null {
    const c = this.cellOf(Math.floor(x), Math.floor(y));
    return c ? { terrain: c.chunk.terrain, i: c.chunk.terrain.index(c.lx, c.ly) } : null;
  }

  /** Terrain surface height at a continuous world position, or null if not loaded. */
  surfaceHeightAt(x: number, y: number): number | null {
    const c = this.cellOf(Math.floor(x), Math.floor(y));
    if (!c) return null;
    return c.chunk.terrain.surfaceHeightAt(c.lx + (x - Math.floor(x)), c.ly + (y - Math.floor(y)));
  }

  /**
   * Real height (steps) for a drawn height at a position: undoes the vertical
   * caricature of warped worlds (VREF/VFAC); the drawn height elsewhere.
   */
  realHeightAt(x: number, y: number, h: number): number {
    const c = this.cellOf(Math.floor(x), Math.floor(y));
    if (!c) return h;
    const t = c.chunk.terrain;
    const i = t.index(c.lx, c.ly);
    const ref = t.vref[i]! / 16;
    return ref + (h - ref) * (t.vfac[i]! / 4096);
  }

  /** Real metres per cell around a position (warped worlds), else the manifest's scale. */
  metersPerCellAt(x: number, y: number): number {
    const s = this.chunkSize;
    const ref = this.refs.get(key(Math.floor(x / s), Math.floor(y / s)));
    return ref?.metersPerCell ?? this.manifest.scale.metersPerCell;
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

/** A decoded chunk's size: its layers (but the dropped, which it shares) and micro-terrain. */
function chunkBytes(chunk: Chunk, dropped: ReadonlySet<string>): number {
  let n = chunk.terrain.micro?.corners.byteLength ?? 0;
  for (const [k, a] of Object.entries(chunk.terrain.layers())) if (!dropped.has(k)) n += a.byteLength;
  return n;
}

function key(cx: number, cy: number): string {
  return `${cx},${cy}`;
}
