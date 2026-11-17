import { A_WATER, FIGHTERS, INVADERS, SQUAD, standAt, teamOf, type Arrow, type Combat, type Mark } from "@pixelworlds/tactics";

/**
 * The board from above (D-154): its cells, buildings shaded by height, water,
 * fire, the marks and arrows the board shows, and every unit, turned 45° so
 * its corners sit where the city view's do. Nothing stands in the way here,
 * and it takes clicks and hovers like the board. M makes it larger.
 */

export interface MapState {
  state: Combat;
  marks: readonly Mark[];
  arrows: readonly Arrow[];
  acted: ReadonlySet<number>;
  striking: number;
  order: ReadonlyMap<number, number>;
}

const FILL: Partial<Record<Mark["kind"], string>> = { move: "rgba(89,195,106,0.55)", attack: "rgba(242,193,78,0.6)", danger: "rgba(229,72,77,0.45)", info: "rgba(242,193,78,0.25)" };
const ARROW: Record<string, string> = { attack: "#ff7a6b", move: "#8fe39a", info: "#ffd166" };

export class TacticalMap {
  readonly el: HTMLCanvasElement;
  private big = false;
  /** Board (i, j) → the map's unturned grid: each board axis along one of its axes, either way. */
  private axes: { i: [number, number]; j: [number, number] } = { i: [1, 0], j: [0, 1] };
  private last: MapState | null = null;
  private hover = -1;

  constructor(
    parent: HTMLElement,
    private readonly w: number,
    private readonly h: number,
    on: { click(k: number): void; hover(k: number): void; back(): void },
  ) {
    this.el = document.createElement("canvas");
    this.el.className = "map";
    parent.append(this.el);
    this.el.addEventListener("pointermove", (e) => {
      const k = this.cellAt(e.offsetX, e.offsetY);
      if (k === this.hover) return;
      this.hover = k;
      on.hover(k);
      this.redraw();
    });
    this.el.addEventListener("pointerleave", () => {
      this.hover = -1;
      on.hover(-1);
      this.redraw();
    });
    this.el.addEventListener("click", (e) => {
      const k = this.cellAt(e.offsetX, e.offsetY);
      if (k >= 0) on.click(k);
    });
    this.el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      on.back();
    });
  }

  /** Lay the map as the city view lies: board axis screen directions (from the camera) to the map's. */
  orient(di: { x: number; y: number }, dj: { x: number; y: number }): void {
    // turned 45° clockwise, the map's +x runs down-right on screen and its +y down-left, as the view's u and v
    const axis = (d: { x: number; y: number }): [number, number] => (d.y > 0 ? (d.x > 0 ? [1, 0] : [0, 1]) : d.x < 0 ? [-1, 0] : [0, -1]);
    this.axes = { i: axis(di), j: axis(dj) };
    this.redraw();
  }

  toggle(): void {
    this.big = !this.big;
    this.el.classList.toggle("big", this.big);
    this.redraw();
  }

  draw(s: MapState): void {
    this.last = s;
    this.redraw();
  }

  private get cell(): number {
    return this.big ? 46 : 22;
  }

  /** The map's grid size, and a board cell's place on it. */
  private grid(): { gw: number; gh: number; at(i: number, j: number): [number, number] } {
    const { i, j } = this.axes;
    const gw = i[0] !== 0 ? this.w : this.h;
    const gh = i[0] !== 0 ? this.h : this.w;
    const at = (bi: number, bj: number): [number, number] => {
      let x = i[0] * bi + j[0] * bj;
      let y = i[1] * bi + j[1] * bj;
      if (i[0] < 0 || j[0] < 0) x += gw - 1;
      if (i[1] < 0 || j[1] < 0) y += gh - 1;
      return [x, y];
    };
    return { gw, gh, at };
  }

  /** The canvas's size, and where a grid point lands on it (turned 45° about its middle). */
  private frame(): { size: number; to(x: number, y: number): [number, number] } {
    const { gw, gh } = this.grid();
    const c = this.cell;
    const size = Math.ceil(((gw + gh) * c) / Math.SQRT2) + 8;
    const r = Math.SQRT1_2;
    return {
      size,
      to: (x, y) => {
        const px = (x - gw / 2) * c;
        const py = (y - gh / 2) * c;
        return [size / 2 + r * (px - py), size / 2 + r * (px + py)];
      },
    };
  }

  private cellAt(cx: number, cy: number): number {
    const { gw, gh, at } = this.grid();
    const { size } = this.frame();
    const c = this.cell;
    const r = Math.SQRT1_2;
    const dx = cx - size / 2;
    const dy = cy - size / 2;
    const x = Math.floor((r * (dx + dy)) / c + gw / 2);
    const y = Math.floor((r * (dy - dx)) / c + gh / 2);
    if (x < 0 || y < 0 || x >= gw || y >= gh) return -1;
    for (let bj = 0; bj < this.h; bj++)
      for (let bi = 0; bi < this.w; bi++) {
        const [mx, my] = at(bi, bj);
        if (mx === x && my === y) return bj * this.w + bi;
      }
    return -1;
  }

  private redraw(): void {
    const s = this.last;
    if (!s) return;
    const c = s.state;
    const a = c.arena;
    const { at } = this.grid();
    const { size, to } = this.frame();
    const dpr = window.devicePixelRatio || 1;
    if (this.el.width !== size * dpr) {
      this.el.width = this.el.height = size * dpr;
      this.el.style.width = this.el.style.height = `${size}px`;
    }
    const g = this.el.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    const corners = (k: number, inset = 0): [number, number][] => {
      const [x, y] = at(k % a.w, Math.floor(k / a.w));
      return [to(x + inset, y + inset), to(x + 1 - inset, y + inset), to(x + 1 - inset, y + 1 - inset), to(x + inset, y + 1 - inset)];
    };
    const centre = (k: number): [number, number] => {
      const [x, y] = at(k % a.w, Math.floor(k / a.w));
      return to(x + 0.5, y + 0.5);
    };
    const poly = (pts: [number, number][]) => {
      g.beginPath();
      pts.forEach(([x, y], n) => (n ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
    };
    // the ground, water and buildings: the taller the lighter
    for (let k = 0; k < a.w * a.h; k++) {
      const sid = a.struct[k]!;
      poly(corners(k));
      if (sid >= 0 && c.structHp[sid]! > 0) {
        const l = 34 + Math.round(40 * Math.min(1, standAt(c, k) / 30));
        g.fillStyle = `hsl(230, 8%, ${l}%)`;
      } else g.fillStyle = sid >= 0 ? "#5d4f43" : a.flags[k]! & A_WATER ? "#2d5b8a" : "#2c2b36";
      g.fill();
      g.strokeStyle = "rgba(232,220,188,0.08)";
      g.lineWidth = 1;
      g.stroke();
    }
    // a building's outline: where its cells meet another's, or the street
    g.strokeStyle = "rgba(14,13,22,0.9)";
    g.lineWidth = 2;
    for (let k = 0; k < a.w * a.h; k++) {
      const sid = a.struct[k]!;
      if (sid < 0) continue;
      const i = k % a.w;
      const j = Math.floor(k / a.w);
      const p = corners(k);
      const edge = (n: number, ni: number, nj: number) => {
        const out = ni < 0 || nj < 0 || ni >= a.w || nj >= a.h || a.struct[nj * a.w + ni] !== sid;
        if (!out) return;
        g.beginPath();
        g.moveTo(...p[n]!);
        g.lineTo(...p[(n + 1) % 4]!);
        g.stroke();
      };
      // the corners go round the grid cell (x, y)…(x+1, y+1): the side a board neighbour faces (off the board too) by where it lands
      const [x, y] = at(i, j);
      for (const [ni, nj] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]] as const) {
        const [nx, ny] = at(ni, nj);
        const side = ny < y ? 0 : nx > x ? 1 : ny > y ? 2 : 3;
        edge(side, ni, nj);
      }
    }
    // fire
    for (let k = 0; k < a.w * a.h; k++)
      if (c.fire[k]) {
        const [x, y] = centre(k);
        g.fillStyle = "rgba(255,140,40,0.8)";
        g.beginPath();
        g.arc(x, y, this.cell * 0.18, 0, 2 * Math.PI);
        g.fill();
      }
    // the board's marks
    for (const m of s.marks) {
      const k = m.j * a.w + m.i;
      if (m.kind === "select") {
        poly(corners(k, 0.06));
        g.strokeStyle = "#ffffff";
        g.lineWidth = 2;
        g.stroke();
      } else if (FILL[m.kind]) {
        poly(corners(k));
        g.fillStyle = FILL[m.kind]!;
        g.fill();
      }
    }
    if (this.hover >= 0) {
      poly(corners(this.hover, 0.04));
      g.strokeStyle = "rgba(255,255,255,0.7)";
      g.lineWidth = 1.5;
      g.stroke();
    }
    // arrows
    for (const r of s.arrows) {
      const [x0, y0] = centre(r.from[1] * a.w + r.from[0]);
      const [x1, y1] = centre(r.to[1] * a.w + r.to[0]);
      const col = ARROW[r.kind] ?? "#ffd166";
      const t = Math.atan2(y1 - y0, x1 - x0);
      const hd = this.cell * 0.3;
      g.strokeStyle = g.fillStyle = col;
      g.lineWidth = this.big ? 3 : 2;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1 - Math.cos(t) * hd * 0.6, y1 - Math.sin(t) * hd * 0.6);
      g.stroke();
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x1 - Math.cos(t - 0.45) * hd, y1 - Math.sin(t - 0.45) * hd);
      g.lineTo(x1 - Math.cos(t + 0.45) * hd, y1 - Math.sin(t + 0.45) * hd);
      g.closePath();
      g.fill();
    }
    // arrivals and units
    const font = (px: number) => `bold ${Math.round(px)}px ui-monospace, Menlo, monospace`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (const { at: k } of c.schedule[c.round] ?? []) {
      const [x, y] = centre(k);
      g.fillStyle = "#ffd166";
      g.font = font(this.cell * 0.6);
      g.fillText("▼", x, y);
    }
    for (let u = 0; u < c.roster.length; u++) {
      if (c.hp[u]! <= 0) continue;
      const [x, y] = centre(c.pos[u]!);
      const squad = teamOf(c, u) === SQUAD;
      const r = this.cell * 0.36;
      g.globalAlpha = squad && s.acted.has(u) ? 0.55 : 1;
      g.fillStyle = squad ? "#7fc8ff" : "#ff7a6b";
      g.beginPath();
      g.arc(x, y, r, 0, 2 * Math.PI);
      g.fill();
      if (u === s.striking) {
        g.strokeStyle = "#ffffff";
        g.lineWidth = 2.5;
        g.stroke();
      }
      g.fillStyle = "#1e1c2b";
      g.font = font(r * 1.2);
      g.fillText(FIGHTERS[c.roster[u]!].name[0]!, x, y + 0.5);
      const n = teamOf(c, u) === INVADERS ? s.order.get(u) : undefined;
      if (n) {
        g.fillStyle = "#ff7a6b";
        g.font = font(r * 0.95);
        g.fillText(String(n), x + r * 1.15, y - r * 1.05);
      }
      g.globalAlpha = 1;
    }
  }
}
