import { maybeGunzip } from "./chunk";
import { fetchWorldFile, parseWorldFile, type WorldFetch } from "./fetch";
import type { WorldManifest } from "./manifest";

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320;

/**
 * Lon/lat of cell corners at grid positions xs × ys (every `step` cells, plus
 * the far edge), from a world package's geo file (D-046). Positions in between
 * are bilinear. It works for uniform and warped (elastic-map) worlds alike, and
 * lets the client carry a place from one scale level to another.
 */
export class GeoGrid {
  readonly xs: Float64Array;
  readonly ys: Float64Array;

  constructor(
    /** Longitudes, row-major (ny rows of nx). */
    readonly lon: Float64Array,
    readonly lat: Float64Array,
    readonly nx: number,
    readonly ny: number,
    readonly step: number,
    readonly cellsX: number,
    readonly cellsY: number,
  ) {
    this.xs = Float64Array.from({ length: nx }, (_, i) => Math.min(i * step, cellsX));
    this.ys = Float64Array.from({ length: ny }, (_, j) => Math.min(j * step, cellsY));
  }

  /**
   * Decode a geo file: gzip of little-endian int32 microdegrees, (ny, nx, 2)
   * as (lon, lat), each row delta-coded along x (the first point absolute).
   */
  static async decode(
    buffer: ArrayBuffer,
    nx: number,
    ny: number,
    step: number,
    cellsX: number,
    cellsY: number,
  ): Promise<GeoGrid> {
    const raw = new DataView(await maybeGunzip(buffer));
    if (raw.byteLength !== nx * ny * 8) throw new Error(`geo file has ${raw.byteLength} bytes, expected ${nx * ny * 8}`);
    const lon = new Float64Array(nx * ny);
    const lat = new Float64Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      let a = 0;
      let b = 0;
      for (let i = 0; i < nx; i++) {
        const o = ((j * nx + i) * 2) * 4;
        a += raw.getInt32(o, true);
        b += raw.getInt32(o + 4, true);
        lon[j * nx + i] = a / 1e6;
        lat[j * nx + i] = b / 1e6;
      }
    }
    return new GeoGrid(lon, lat, nx, ny, step, cellsX, cellsY);
  }

  /** Fetch and decode the geo file a manifest names, or null if it has none. */
  static async load(manifest: WorldManifest, baseUrl: string | URL, fetcher?: WorldFetch): Promise<GeoGrid | null> {
    const g = manifest.geo;
    if (!g) return null;
    const url = new URL(g.path, baseUrl);
    const bytes = await fetchWorldFile(url, { label: "world geo grid", expected: "the geo grid the manifest names" }, fetcher);
    return parseWorldFile(url, "world geo grid", () =>
      GeoGrid.decode(bytes, g.size[0], g.size[1], g.step, manifest.cellsX, manifest.cellsY),
    );
  }

  private locate(v: number, ps: Float64Array): [number, number] {
    const n = ps.length;
    const i = Math.max(0, Math.min(n - 2, Math.floor(v / this.step)));
    const t = (v - ps[i]!) / (ps[i + 1]! - ps[i]!);
    return [i, t];
  }

  /** Lon/lat at a (continuous) cell position, clamped to the world. */
  cellToLonLat(x: number, y: number): [number, number] {
    const cx = Math.max(0, Math.min(this.cellsX, x));
    const cy = Math.max(0, Math.min(this.cellsY, y));
    const [i, u] = this.locate(cx, this.xs);
    const [j, v] = this.locate(cy, this.ys);
    const k = j * this.nx + i;
    const at = (a: Float64Array) =>
      (1 - v) * ((1 - u) * a[k]! + u * a[k + 1]!) + v * ((1 - u) * a[k + this.nx]! + u * a[k + this.nx + 1]!);
    return [at(this.lon), at(this.lat)];
  }

  /**
   * The cell position of a lon/lat (Newton's method from the nearest grid
   * point), or null if it lies outside the world.
   */
  lonLatToCell(lon: number, lat: number): [number, number] | null {
    const kx = M_PER_DEG_LON * Math.cos((lat * Math.PI) / 180);
    // metres east and north from the target
    const residual = (x: number, y: number): [number, number] => {
      const [a, b] = this.cellToLonLat(x, y);
      return [(a - lon) * kx, (b - lat) * M_PER_DEG_LAT];
    };
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < this.lon.length; k++) {
      const d = ((this.lon[k]! - lon) * kx) ** 2 + ((this.lat[k]! - lat) * M_PER_DEG_LAT) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    let x = this.xs[best % this.nx]!;
    let y = this.ys[Math.floor(best / this.nx)]!;
    let cellMeters = 1;
    for (let it = 0; it < 40; it++) {
      const h = 0.25;
      const x0 = Math.max(0, Math.min(this.cellsX - h, x));
      const y0 = Math.max(0, Math.min(this.cellsY - h, y));
      const [fx, fy] = residual(x, y);
      const [ax, ay] = residual(x0 + h, y0);
      const [bx, by] = residual(x0, y0 + h);
      const [cx, cy] = residual(x0, y0);
      // Jacobian of metres (east, north) per cell (x, y)
      const j11 = (ax - cx) / h;
      const j21 = (ay - cy) / h;
      const j12 = (bx - cx) / h;
      const j22 = (by - cy) / h;
      const det = j11 * j22 - j12 * j21;
      cellMeters = Math.sqrt(Math.abs(det));
      if (!Number.isFinite(det) || Math.abs(det) < 1e-9) break;
      const dx = (j22 * fx - j12 * fy) / det;
      const dy = (-j21 * fx + j11 * fy) / det;
      x = Math.max(0, Math.min(this.cellsX, x - dx));
      y = Math.max(0, Math.min(this.cellsY, y - dy));
      if (Math.abs(dx) + Math.abs(dy) < 1e-5) break;
    }
    const [fx, fy] = residual(x, y);
    return Math.hypot(fx, fy) <= 0.5 * cellMeters ? [x, y] : null;
  }
}
