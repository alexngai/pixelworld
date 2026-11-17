import type { WorldView } from "./types";

/**
 * The whole world from above (D-158), in square tiles baked on demand: each
 * `tile` cells across at `px` screen px a cell, by `WorldView.bakeTopDown`,
 * kept here and with the view's tiles, the nearest to what's asked for first,
 * a couple at a time so the city view keeps its bakers. An app draws the ready
 * ones (`tiles`), panning and zooming as it likes; `onChange` says when more
 * came in. After edits (a building taken out) `forget` lets them bake again.
 *
 *   const top = new TopDownMap(view, { tile: 64, px: 4 });
 *   top.onChange(redraw);
 *   for (const t of top.tiles(x0, y0, x1, y1)) ctx.drawImage(t.image, (t.x - x0) * k, (t.y - y0) * k, t.w * k, t.h * k);
 */

export interface TopDownTile {
  /** Its top-left cell, and its size in cells (`tile`, less at the world's edge). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** `w × px` by `h × px`, north up. */
  image: HTMLCanvasElement;
}

export class TopDownMap {
  readonly tile: number;
  readonly px: number;
  private readonly ready = new Map<string, TopDownTile | null>();
  private readonly baking = new Set<string>();
  private queue: [number, number][] = [];
  private readonly listeners = new Set<() => void>();
  private readonly concurrency: number;
  private epoch = 0;

  constructor(
    private readonly view: WorldView,
    opts: { tile?: number; px?: number; concurrency?: number } = {},
  ) {
    this.tile = opts.tile ?? 64;
    this.px = opts.px ?? 4;
    this.concurrency = opts.concurrency ?? 2;
  }

  /** The tiles meeting a rectangle of cells that are baked; the rest are asked for, from its middle out. */
  tiles(x0: number, y0: number, x1: number, y1: number): TopDownTile[] {
    const { cellsX, cellsY } = this.view.world.manifest;
    const t = this.tile;
    const out: TopDownTile[] = [];
    const want: [number, number][] = [];
    for (let ty = Math.max(0, Math.floor(y0 / t)); ty <= Math.min(Math.ceil(cellsY / t) - 1, Math.floor(y1 / t)); ty++)
      for (let tx = Math.max(0, Math.floor(x0 / t)); tx <= Math.min(Math.ceil(cellsX / t) - 1, Math.floor(x1 / t)); tx++) {
        const got = this.ready.get(`${tx},${ty}`);
        if (got) out.push(got);
        else if (got === undefined) want.push([tx, ty]);
      }
    const mx = (x0 + x1) / 2 / t - 0.5;
    const my = (y0 + y1) / 2 / t - 0.5;
    this.queue = want.sort((a, b) => Math.hypot(a[0] - mx, a[1] - my) - Math.hypot(b[0] - mx, b[1] - my));
    this.pump();
    return out;
  }

  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  /** Drop the tiles meeting a rectangle of cells (or every one), to bake them again: the world was edited there. */
  forget(x0 = -Infinity, y0 = -Infinity, x1 = Infinity, y1 = Infinity): void {
    const t = this.tile;
    for (const id of [...this.ready.keys()]) {
      const [tx, ty] = id.split(",").map(Number) as [number, number];
      if (tx * t < x1 && (tx + 1) * t > x0 && ty * t < y1 && (ty + 1) * t > y0) this.ready.delete(id);
    }
    this.epoch++;
    this.listeners.forEach((f) => f());
  }

  private pump(): void {
    while (this.baking.size < this.concurrency && this.queue.length) {
      const [tx, ty] = this.queue.shift()!;
      const id = `${tx},${ty}`;
      if (this.baking.has(id) || this.ready.has(id)) continue;
      this.baking.add(id);
      const epoch = this.epoch;
      const { cellsX, cellsY } = this.view.world.manifest;
      const t = this.tile;
      const [x0, y0] = [tx * t, ty * t];
      const [x1, y1] = [Math.min(cellsX, x0 + t), Math.min(cellsY, y0 + t)];
      void this.view
        .bakeTopDown(x0, y0, x1, y1, { px: this.px, shadows: false, cache: true })
        .catch(() => null)
        .then((img) => {
          this.baking.delete(id);
          if (epoch !== this.epoch) return this.pump();
          let tile: TopDownTile | null = null;
          if (img) {
            const image = document.createElement("canvas");
            image.width = img.width;
            image.height = img.height;
            image.getContext("2d")!.putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
            tile = { x: x0, y: y0, w: x1 - x0, h: y1 - y0, image };
          }
          this.ready.set(id, tile);
          this.listeners.forEach((f) => f());
          this.pump();
        });
    }
  }
}
