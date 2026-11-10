import type { BakedImage } from "@pixelworlds/bake";

/**
 * Persistent cache of baked tiles in IndexedDB. Pixels are stored gzip-
 * compressed (indexed color and mostly-empty diamonds compress well). Keys
 * include the package hash, style hash and baker version, so any change to
 * the world, the style or the baker makes old entries unreachable; they are
 * pruned by least-recent use once the cache grows past `maxEntries`.
 */
export class TileCache {
  /** Completed writes (for tests and the HUD). */
  writes = 0;

  private constructor(
    private readonly db: IDBDatabase,
    private readonly maxEntries: number,
  ) {}

  static async open(name = "pixelworld-tiles", maxEntries = 600): Promise<TileCache | null> {
    if (typeof indexedDB === "undefined") return null;
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore("tiles");
          store.createIndex("used", "used");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return new TileCache(db, maxEntries);
    } catch {
      return null;
    }
  }

  async get(key: string): Promise<BakedImage | null> {
    try {
      const rec = await this.request<StoredTile | undefined>("readonly", (s) => s.get(key));
      if (!rec) return null;
      const pixels = new Uint8Array(await gunzip(rec.pixels));
      void this.request("readwrite", (s) => s.put({ ...rec, used: Date.now() }, key)).catch(() => {});
      return { left: rec.left, top: rec.top, width: rec.width, height: rec.height, depthBase: rec.depthBase, pixels };
    } catch {
      return null;
    }
  }

  async put(key: string, image: BakedImage): Promise<void> {
    try {
      const rec: StoredTile = {
        left: image.left,
        top: image.top,
        width: image.width,
        height: image.height,
        depthBase: image.depthBase,
        pixels: await gzip(image.pixels),
        used: Date.now(),
      };
      await this.request("readwrite", (s) => s.put(rec, key));
      this.writes++;
      await this.prune();
    } catch {
      // A full or unavailable cache only costs a re-bake.
    }
  }

  private async prune(): Promise<void> {
    const count = await this.request<number>("readonly", (s) => s.count());
    const excess = count - this.maxEntries;
    if (excess <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction("tiles", "readwrite");
      let left = excess;
      tx.objectStore("tiles").index("used").openCursor().onsuccess = (ev) => {
        const cursor = (ev.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (!cursor || left-- <= 0) return;
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private request<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const req = op(this.db.transaction("tiles", mode).objectStore("tiles"));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  }
}

interface StoredTile {
  left: number;
  top: number;
  width: number;
  height: number;
  depthBase: number;
  pixels: ArrayBuffer;
  used: number;
}

async function gzip(data: Uint8Array): Promise<ArrayBuffer> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

async function gunzip(data: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/** Small stable string hash (FNV-1a, 32-bit, hex) for cache keys. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
