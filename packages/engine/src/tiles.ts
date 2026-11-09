import type { Rotation } from "@pixelworld/grid";
import { cellsScreenRect, type TileRequest } from "@pixelworld/runtime";

const PREFETCH_PX = 96; // bake tiles this far outside the view

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
    private readonly tileSize: number,
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

  /** Tiles on or near a view (render px), visible ones first, then by distance from the centre. */
  inView(r: Rotation, view: { left: number; top: number; width: number; height: number }): TileInView[] {
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
}
