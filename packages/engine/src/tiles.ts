import type { Rotation } from "@pixelworlds/grid";
import { cellsScreenRect, type TileRequest } from "@pixelworlds/runtime";

const PREFETCH_PX = 96; // bake tiles this far outside the view

/** A view rectangle in render px: whole-pixel top-left and size. */
export interface ViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TileInView extends TileRequest {
  /** On screen now (else only near it, baked ahead). */
  visible: boolean;
  /** Screen distance of its centre from the view's centre. */
  dist: number;
}

/**
 * The world's bake tiles and their height ranges (from the manifest, for
 * screen-rect estimates before baking): which tiles a view needs, nearest
 * first.
 */
export class TileGrid {
  readonly tilesX: number;
  readonly tilesY: number;
  private readonly heights: [number, number][] = [];

  constructor(
    private readonly cellsX: number,
    private readonly cellsY: number,
    readonly tileSize: number,
    private readonly renderScale: number,
    floor: number,
    /** Tall objects rise above the terrain: room for them in the estimates. */
    private readonly objects: boolean,
    heightRangeFor: (x0: number, y0: number, x1: number, y1: number) => [number, number],
  ) {
    this.tilesX = Math.ceil(cellsX / tileSize);
    this.tilesY = Math.ceil(cellsY / tileSize);
    for (let ty = 0; ty < this.tilesY; ty++)
      for (let tx = 0; tx < this.tilesX; tx++) {
        const x0 = tx * tileSize;
        const y0 = ty * tileSize;
        const [lo, hi] = heightRangeFor(x0, y0, x0 + tileSize, y0 + tileSize);
        const edge = tx === 0 || ty === 0 || tx === this.tilesX - 1 || ty === this.tilesY - 1;
        this.heights.push([edge ? floor : lo, hi]);
      }
  }

  get count(): number {
    return this.tilesX * this.tilesY;
  }

  /** The tile whose cells hold a point (cells), or null outside the world. */
  tileAt(x: number, y: number): { tx: number; ty: number } | null {
    if (!(x >= 0 && y >= 0 && x < this.cellsX && y < this.cellsY)) return null;
    return { tx: Math.floor(x / this.tileSize), ty: Math.floor(y / this.tileSize) };
  }

  /** Tiles with cells within a radius (cells) of a point, nearest first. */
  around(r: Rotation, x: number, y: number, radius: number): TileRequest[] {
    const ts = this.tileSize;
    const out: (TileRequest & { d: number })[] = [];
    const tx0 = Math.max(0, Math.floor((x - radius) / ts));
    const ty0 = Math.max(0, Math.floor((y - radius) / ts));
    const tx1 = Math.min(this.tilesX - 1, Math.floor((x + radius) / ts));
    const ty1 = Math.min(this.tilesY - 1, Math.floor((y + radius) / ts));
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        // distance from the point to the tile's cells
        const dx = Math.max(tx * ts - x, 0, x - Math.min(this.cellsX, (tx + 1) * ts));
        const dy = Math.max(ty * ts - y, 0, y - Math.min(this.cellsY, (ty + 1) * ts));
        const d = Math.hypot(dx, dy);
        if (d <= radius) out.push({ rotation: r, tx, ty, d });
      }
    out.sort((a, b) => a.d - b.d);
    return out.map(({ rotation, tx, ty }) => ({ rotation, tx, ty }));
  }

  /** Tiles on or near a view (render px), visible ones first, then by distance from the centre. */
  inView(r: Rotation, view: ViewRect): TileInView[] {
    const RS = this.renderScale;
    const ts = this.tileSize;
    const viewL = view.left;
    const viewT = view.top;
    const viewR = view.left + view.width;
    const viewB = view.top + view.height;
    const cx = (viewL + viewR) / 2;
    const cy = (viewT + viewB) / 2;
    const list: TileInView[] = [];
    for (let ty = 0; ty < this.tilesY; ty++)
      for (let tx = 0; tx < this.tilesX; tx++) {
        const [lo, hi] = this.heights[ty * this.tilesX + tx]!;
        const rect = cellsScreenRect(
          tx * ts * RS,
          ty * ts * RS,
          Math.min(this.cellsX, (tx + 1) * ts) * RS,
          Math.min(this.cellsY, (ty + 1) * ts) * RS,
          lo * RS,
          hi * RS + (this.objects ? 12 : 0), // tall objects rise up to ~96 px above the terrain
          r,
        );
        const near =
          rect.right >= viewL - PREFETCH_PX &&
          rect.left <= viewR + PREFETCH_PX &&
          rect.bottom >= viewT - PREFETCH_PX &&
          rect.top <= viewB + PREFETCH_PX;
        if (!near) continue;
        const visible = rect.right >= viewL && rect.left <= viewR && rect.bottom >= viewT && rect.top <= viewB;
        const dist = Math.hypot((rect.left + rect.right) / 2 - cx, (rect.top + rect.bottom) / 2 - cy);
        list.push({ rotation: r, tx, ty, visible, dist });
      }
    list.sort((a, b) => Number(b.visible) - Number(a.visible) || a.dist - b.dist);
    return list;
  }

  /** The tiles visible from a view (render px), nearest its centre first. */
  visibleFrom(r: Rotation, view: ViewRect): TileRequest[] {
    return this.inView(r, view).filter((t) => t.visible);
  }
}

/** Which tiles are baked, per rotation (`WorldView.isDrawn`). */
export class BakedTiles {
  private readonly bits: Uint8Array;

  constructor(private readonly grid: TileGrid) {
    this.bits = new Uint8Array(4 * grid.count);
  }

  private index(r: Rotation, tx: number, ty: number): number {
    return r * this.grid.count + ty * this.grid.tilesX + tx;
  }

  set(r: Rotation, tx: number, ty: number, baked: boolean): void {
    if (tx < 0 || ty < 0 || tx >= this.grid.tilesX || ty >= this.grid.tilesY) return;
    this.bits[this.index(r, tx, ty)] = baked ? 1 : 0;
  }

  has(r: Rotation, tx: number, ty: number): boolean {
    return this.bits[this.index(r, tx, ty)] === 1;
  }

  /** Whether the tile under a point (cells) is baked in a rotation; false outside the world. */
  at(r: Rotation, x: number, y: number): boolean {
    const t = this.grid.tileAt(x, y);
    return !!t && this.has(r, t.tx, t.ty);
  }

  clear(): void {
    this.bits.fill(0);
  }
}

/** Faster than this (cells per second) the camera jumped (a teleport, a restore), it didn't move. */
export const MAX_CAMERA_SPEED = 30;
/** The camera's measured velocity eases over this long (seconds). */
const MOTION_EASE = 0.25;

/** The camera's recent velocity (cells per second, wall-clock), to bake ahead of it. */
export class CameraMotion {
  vx = 0;
  vy = 0;
  private last: { x: number; y: number } | null = null;

  /** The focus (cells) this frame, `dt` wall-clock seconds after the last. */
  update(x: number, y: number, dt: number): void {
    const last = this.last;
    this.last = { x, y };
    if (!last || dt <= 0) return;
    const vx = (x - last.x) / dt;
    const vy = (y - last.y) / dt;
    if (Math.hypot(vx, vy) > MAX_CAMERA_SPEED) {
      this.vx = 0;
      this.vy = 0;
      return;
    }
    const a = 1 - Math.exp(-dt / MOTION_EASE);
    this.vx += (vx - this.vx) * a;
    this.vy += (vy - this.vy) * a;
  }

  /** How far (cells) the focus goes in `seconds` at this velocity. */
  ahead(seconds: number): [number, number] {
    return [this.vx * seconds, this.vy * seconds];
  }
}

/** A view moved by a screen offset (render px), no further than one view's size. */
export function shiftView(view: ViewRect, dsx: number, dsy: number): ViewRect {
  const k = Math.min(1, view.width / Math.max(1e-9, Math.abs(dsx)), view.height / Math.max(1e-9, Math.abs(dsy)));
  return { left: view.left + dsx * k, top: view.top + dsy * k, width: view.width, height: view.height };
}

/** A place asked for with `WorldView.prefetch`. */
export interface PrefetchArea {
  x: number;
  y: number;
  /** Cells; none: the tiles a view centred there would show. */
  radius?: number;
}

interface Prefetch {
  area: PrefetchArea;
  resolve: () => void;
  /** Its tiles, for the rotation and view size in `key`. */
  tiles: TileRequest[];
  key: string;
}

/** The places asked for with `WorldView.prefetch`, until their tiles are baked. */
export class Prefetches {
  private readonly list: Prefetch[] = [];

  get size(): number {
    return this.list.length;
  }

  add(area: PrefetchArea): Promise<void> {
    return new Promise((resolve) => this.list.push({ area, resolve, tiles: [], key: "" }));
  }

  /**
   * Every request's tiles, in the order asked. `key` names what the tiles
   * depend on (the rotation, the view's size); `tilesFor` works them out
   * when it changes.
   */
  wanted(key: string, tilesFor: (area: PrefetchArea) => TileRequest[]): TileRequest[] {
    const out: TileRequest[] = [];
    for (const p of this.list) {
      if (p.key !== key) {
        p.tiles = tilesFor(p.area);
        p.key = key;
      }
      for (const t of p.tiles) out.push(t);
    }
    return out;
  }

  /** Resolve the requests whose tiles (as last worked out) are all baked. */
  settle(baked: (t: TileRequest) => boolean): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i]!;
      if (p.key && p.tiles.every(baked)) {
        this.list.splice(i, 1);
        p.resolve();
      }
    }
  }

  /** Resolve every request (the view is going away). */
  clear(): void {
    for (const p of this.list.splice(0)) p.resolve();
  }
}

/**
 * The order to bake tiles in: the visible ones, then those ahead of the
 * camera's motion, then those asked for, then the rest around the view;
 * each once.
 */
export function bakeOrder(near: readonly TileInView[], ahead: readonly TileRequest[], asked: readonly TileRequest[]): TileRequest[] {
  const seen = new Set<string>();
  const out: TileRequest[] = [];
  const push = (t: TileRequest) => {
    const k = `${t.rotation}:${t.tx},${t.ty}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  for (const t of near) if (t.visible) push(t);
  for (const t of ahead) push(t);
  for (const t of asked) push(t);
  for (const t of near) push(t);
  return out;
}
