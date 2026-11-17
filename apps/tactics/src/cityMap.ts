import { TopDownMap, viewOnGround, type WorldView } from "@pixelworlds/engine";

/**
 * The city from above (D-158): the world in top-down tiles (`TopDownMap`),
 * baked as the map is looked over and kept, north up, with the fight's
 * board, the operation's blocks and what the city view shows marked. C opens
 * and closes it; drag to pan, the wheel to zoom, Esc to close.
 */

export interface Place {
  name: string;
  x: number;
  y: number;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class CityMap {
  readonly el: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly top: TopDownMap;
  /** The cell at the map's middle, and screen px a cell. */
  private cx = 0;
  private cy = 0;
  private k = 2;
  private drag: { x: number; y: number; cx: number; cy: number } | null = null;

  constructor(
    parent: HTMLElement,
    private readonly view: WorldView,
    private readonly places: readonly Place[],
    private readonly board: () => Rect | null,
  ) {
    this.top = new TopDownMap(view, { tile: 64, px: 4 });
    this.el = document.createElement("div");
    this.el.className = "citymap";
    this.el.hidden = true;
    this.el.innerHTML = `<div class="caption">The city from above · drag to pan, wheel to zoom · <kbd>C</kbd> or <kbd>Esc</kbd> to close <span class="baking"></span></div>`;
    this.canvas = document.createElement("canvas");
    this.el.prepend(this.canvas);
    parent.append(this.el);
    this.top.onChange(() => this.draw());
    this.canvas.addEventListener("pointerdown", (e) => {
      this.drag = { x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!this.drag) return;
      this.cx = this.drag.cx - (e.clientX - this.drag.x) / this.k;
      this.cy = this.drag.cy - (e.clientY - this.drag.y) / this.k;
      this.draw();
    });
    this.canvas.addEventListener("pointerup", () => (this.drag = null));
    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.k = Math.min(8, Math.max(0.5, this.k * (e.deltaY < 0 ? 1.25 : 0.8)));
        this.draw();
      },
      { passive: false },
    );
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  toggle(): void {
    if (this.open) return void (this.el.hidden = true);
    const b = this.board();
    [this.cx, this.cy] = b ? [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] : [this.view.camera.x, this.view.camera.y];
    this.el.hidden = false;
    this.draw();
  }

  close(): void {
    this.el.hidden = true;
  }

  /** After the world was edited there (a building down), bake those tiles again. */
  forget(x0: number, y0: number, x1: number, y1: number): void {
    this.top.forget(x0, y0, x1, y1);
  }

  private draw(): void {
    if (!this.open) return;
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
    }
    const g = this.canvas.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#1e1c2b";
    g.fillRect(0, 0, W, H);
    const k = this.k;
    const x0 = this.cx - W / 2 / k;
    const y0 = this.cy - H / 2 / k;
    const at = (x: number, y: number): [number, number] => [(x - x0) * k, (y - y0) * k];
    const tiles = this.top.tiles(x0, y0, x0 + W / k, y0 + H / k);
    g.imageSmoothingEnabled = k < this.top.px;
    for (const t of tiles) g.drawImage(t.image, ...at(t.x, t.y), t.w * k, t.h * k);
    // what the city view shows, the board, and the blocks
    const ground = viewOnGround(this.view);
    g.strokeStyle = "rgba(255,255,255,0.6)";
    g.lineWidth = 1;
    g.setLineDash([4, 3]);
    g.beginPath();
    ground.forEach(([x, y], n) => (n ? g.lineTo(...at(x, y)) : g.moveTo(...at(x, y))));
    g.closePath();
    g.stroke();
    g.setLineDash([]);
    const b = this.board();
    if (b) {
      const [bx, by] = at(b.x0, b.y0);
      g.strokeStyle = "#ffd166";
      g.lineWidth = 2;
      g.shadowColor = "#ffd166";
      g.shadowBlur = 8;
      g.strokeRect(bx, by, (b.x1 - b.x0) * k, (b.y1 - b.y0) * k);
      g.shadowBlur = 0;
    }
    g.font = "bold 12px ui-monospace, Menlo, monospace";
    g.textAlign = "left";
    g.textBaseline = "middle";
    for (const p of this.places) {
      const [px, py] = at(p.x, p.y);
      g.fillStyle = "#ff7a6b";
      g.beginPath();
      g.arc(px, py, 5, 0, 2 * Math.PI);
      g.fill();
      g.fillStyle = "rgba(14,13,22,0.8)";
      const w = g.measureText(p.name).width;
      g.fillRect(px + 8, py - 9, w + 8, 18);
      g.fillStyle = "#e8dcbc";
      g.fillText(p.name, px + 12, py);
    }
    const baking = this.el.querySelector<HTMLElement>(".baking")!;
    baking.textContent = tiles.length ? "" : "· baking the city from above…";
  }
}
