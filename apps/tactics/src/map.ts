import { A_WATER, FIGHTERS, FIRE_ASH, isBurning, INVADERS, SQUAD, standAt, teamOf, type Arrow, type Combat, type Mark } from "@pixelworlds/tactics";

/**
 * The board from above (D-154, D-155): the city baked straight down
 * (`WorldView.bakeTopDown`) once it's ready, a diagram of its buildings till
 * then; over it the grid, the board's marks and arrows, and every unit. Laid
 * as the city view lies (its u axis to the right, v down: the view turned 45°
 * left), never at a slant, so the art stays crisp. It takes clicks, hovers
 * and right-clicks like the board; M makes it larger.
 */

export interface MapState {
  state: Combat;
  marks: readonly Mark[];
  arrows: readonly Arrow[];
  acted: ReadonlySet<number>;
  striking: number;
  order: ReadonlyMap<number, number>;
  /** The keyboard's cell, or −1. */
  cursor: number;
}

const FILL: Partial<Record<Mark["kind"], string>> = { move: "rgba(89,195,106,0.45)", attack: "rgba(242,193,78,0.55)", danger: "rgba(229,72,77,0.42)", info: "rgba(242,193,78,0.22)" };
const ARROW: Record<string, string> = { attack: "#ff7a6b", move: "#8fe39a", info: "#ffd166" };
const PAD = 6;

export class TacticalMap {
  readonly el: HTMLCanvasElement;
  private big = false;
  /** Board (i, j) → the map's grid: each board axis along one of its axes, either way. */
  private axes: { i: [number, number]; j: [number, number] } = { i: [1, 0], j: [0, 1] };
  private last: MapState | null = null;
  private hover = -1;
  /** The board baked from above, board-aligned: `scale` of its px a board cell. */
  private art: { image: HTMLCanvasElement; scale: number } | null = null;

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

  /** Lay the map as the city view lies: the board axes' screen directions there (from the camera). */
  orient(di: { x: number; y: number }, dj: { x: number; y: number }): void {
    // the map's +x is the view's u (down-right on screen), its +y the view's v (down-left)
    const axis = (d: { x: number; y: number }): [number, number] => (d.y > 0 ? (d.x > 0 ? [1, 0] : [0, 1]) : d.x < 0 ? [-1, 0] : [0, -1]);
    this.axes = { i: axis(di), j: axis(dj) };
    this.redraw();
  }

  /** The board from above: RGBA covering it exactly, board i along x and j along y. */
  setArt(rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): void {
    const image = document.createElement("canvas");
    image.width = width;
    image.height = height;
    image.getContext("2d")!.putImageData(new ImageData(rgba, width, height), 0, 0);
    this.art = { image, scale: width / this.w };
    this.redraw();
  }

  toggle(): void {
    this.big = !this.big;
    this.el.classList.toggle("big", this.big);
    this.redraw();
  }

  get isBig(): boolean {
    return this.big;
  }

  draw(s: MapState): void {
    this.last = s;
    this.redraw();
  }

  /** Map px a board cell: small, the art's own (baked at it, D-163); large, exactly twice, so it stays crisp. */
  static readonly SMALL = 30;
  private get cell(): number {
    return this.big ? 2 * TacticalMap.SMALL : TacticalMap.SMALL;
  }

  /** The map's grid size; a board point (continuous) on it. */
  private grid(): { gw: number; gh: number; at(bi: number, bj: number): [number, number] } {
    const { i, j } = this.axes;
    const gw = i[0] !== 0 ? this.w : this.h;
    const gh = i[0] !== 0 ? this.h : this.w;
    // a reversed axis runs from the far edge: a cell [b, b + 1] lands on [g − b − 1, g − b]
    const ox = i[0] < 0 || j[0] < 0 ? gw : 0;
    const oy = i[1] < 0 || j[1] < 0 ? gh : 0;
    return { gw, gh, at: (bi, bj) => [i[0] * bi + j[0] * bj + ox, i[1] * bi + j[1] * bj + oy] };
  }

  /** A board cell's corners and middle on the canvas. */
  private cellRect(k: number, inset = 0): { x: number; y: number; s: number; cx: number; cy: number } {
    const { at } = this.grid();
    const bi = k % this.w;
    const bj = Math.floor(k / this.w);
    const [ax, ay] = at(bi, bj);
    const [bx, by] = at(bi + 1, bj + 1);
    const c = this.cell;
    const x = PAD + Math.min(ax, bx) * c;
    const y = PAD + Math.min(ay, by) * c;
    return { x: x + inset * c, y: y + inset * c, s: c * (1 - 2 * inset), cx: x + c / 2, cy: y + c / 2 };
  }

  private cellAt(cx: number, cy: number): number {
    const c = this.cell;
    const x = Math.floor((cx - PAD) / c);
    const y = Math.floor((cy - PAD) / c);
    for (let k = 0; k < this.w * this.h; k++) {
      const r = this.cellRect(k);
      if (Math.floor((r.x - PAD) / c + 0.5) === x && Math.floor((r.y - PAD) / c + 0.5) === y) return k;
    }
    return -1;
  }

  private redraw(): void {
    const s = this.last;
    if (!s) return;
    const c = s.state;
    const a = c.arena;
    const { gw, gh, at } = this.grid();
    const cs = this.cell;
    const W = gw * cs + 2 * PAD;
    const H = gh * cs + 2 * PAD + (this.big ? LEGEND : 0);
    const dpr = window.devicePixelRatio || 1;
    if (this.el.width !== Math.round(W * dpr) || this.el.height !== Math.round(H * dpr)) {
      this.el.width = Math.round(W * dpr);
      this.el.height = Math.round(H * dpr);
      this.el.style.width = `${W}px`;
      this.el.style.height = `${H}px`;
    }
    const g = this.el.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const rect = (k: number, inset = 0) => {
      const r = this.cellRect(k, inset);
      g.beginPath();
      g.rect(r.x, r.y, r.s, r.s);
    };

    // the ground: the city from above, or a diagram of it
    if (this.art) {
      const { i, j } = this.axes;
      const [ox, oy] = at(0, 0);
      const k = (cs / this.art.scale) * dpr;
      g.setTransform(k * i[0], k * i[1], k * j[0], k * j[1], dpr * (PAD + ox * cs), dpr * (PAD + oy * cs));
      g.imageSmoothingEnabled = k < 1;
      g.drawImage(this.art.image, 0, 0);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    for (let k = 0; k < a.w * a.h; k++) {
      const sid = a.struct[k]!;
      const razed = sid >= 0 && c.structHp[sid]! <= 0;
      if (this.art && !razed) continue;
      rect(k);
      if (razed) g.fillStyle = this.art ? "rgba(93,79,67,0.85)" : "#5d4f43";
      else if (sid >= 0) g.fillStyle = `hsl(230, 8%, ${34 + Math.round(40 * Math.min(1, standAt(c, k) / 30))}%)`;
      else g.fillStyle = a.flags[k]! & A_WATER ? "#2d5b8a" : "#2c2b36";
      g.fill();
    }
    // the grid, and each building's outline
    g.strokeStyle = this.art ? "rgba(255,255,255,0.16)" : "rgba(232,220,188,0.1)";
    g.lineWidth = 1;
    for (let k = 0; k < a.w * a.h; k++) {
      rect(k);
      g.stroke();
    }
    g.lineWidth = this.big ? 2.5 : 2;
    for (let k = 0; k < a.w * a.h; k++) {
      const sid = a.struct[k]!;
      if (sid < 0 || c.structHp[sid]! <= 0) continue;
      // each building outlined in its height's colour (D-163): what can climb onto it reads at a glance
      g.strokeStyle = band(standAt(c, k) * a.metersPerStep).colour;
      const r = this.cellRect(k);
      const bi = k % a.w;
      const bj = Math.floor(k / a.w);
      for (const [ni, nj] of [[bi - 1, bj], [bi + 1, bj], [bi, bj - 1], [bi, bj + 1]] as const) {
        if (ni >= 0 && nj >= 0 && ni < a.w && nj < a.h && a.struct[nj * a.w + ni] === sid) continue;
        // the side facing that neighbour (off the board too), by where its cell lands
        const [nx, ny] = at(ni + 0.5, nj + 0.5);
        const mx = PAD + nx * cs;
        const my = PAD + ny * cs;
        const [x0, y0, x1, y1] =
          my < r.y ? [r.x, r.y, r.x + r.s, r.y] : my > r.y + r.s ? [r.x, r.y + r.s, r.x + r.s, r.y + r.s] : mx < r.x ? [r.x, r.y, r.x, r.y + r.s] : [r.x + r.s, r.y, r.x + r.s, r.y + r.s];
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(x1, y1);
        g.stroke();
      }
    }
    // how tall each building stands, on the large map (the small one has the colours)
    if (this.big) {
      g.font = "bold 11px ui-monospace, Menlo, monospace";
      g.textAlign = "left";
      g.textBaseline = "top";
      const done = new Set<number>();
      for (let k = 0; k < a.w * a.h; k++) {
        const sid = a.struct[k]!;
        if (sid < 0 || done.has(sid) || c.structHp[sid]! <= 0) continue;
        done.add(sid);
        const m = Math.round(standAt(c, k) * a.metersPerStep);
        const r = this.cellRect(k);
        const text = `${m} m`;
        g.fillStyle = "rgba(14,13,22,0.78)";
        g.fillRect(r.x + 2, r.y + 2, g.measureText(text).width + 6, 15);
        g.fillStyle = band(m).colour;
        g.fillText(text, r.x + 5, r.y + 4);
      }
    }
    // fire, and ash where it burnt out
    for (let k = 0; k < a.w * a.h; k++) {
      if (c.fire[k] === FIRE_ASH) {
        rect(k);
        g.fillStyle = "rgba(30,28,32,0.55)";
        g.fill();
      }
      if (isBurning(c, k)) {
        const r = this.cellRect(k);
        g.fillStyle = "rgba(255,140,40,0.85)";
        g.beginPath();
        g.arc(r.cx, r.cy, cs * 0.18, 0, 2 * Math.PI);
        g.fill();
      }
    }
    // the board's marks, the pointer's and the keyboard's cells
    for (const m of s.marks) {
      const k = m.j * a.w + m.i;
      if (m.kind === "select") {
        rect(k, 0.06);
        g.strokeStyle = "#ffffff";
        g.lineWidth = 2;
        g.stroke();
      } else if (FILL[m.kind]) {
        rect(k);
        g.fillStyle = FILL[m.kind]!;
        g.fill();
      }
    }
    for (const [k, col] of [
      [this.hover, "rgba(255,255,255,0.75)"],
      [s.cursor, "#ffd166"],
    ] as const) {
      if (k < 0) continue;
      rect(k, 0.03);
      g.strokeStyle = col;
      g.lineWidth = 2;
      g.stroke();
    }
    // arrows
    for (const r of s.arrows) {
      const p = this.cellRect(r.from[1] * a.w + r.from[0]);
      const q = this.cellRect(r.to[1] * a.w + r.to[0]);
      const col = ARROW[r.kind] ?? "#ffd166";
      const t = Math.atan2(q.cy - p.cy, q.cx - p.cx);
      const hd = cs * 0.3;
      g.strokeStyle = g.fillStyle = col;
      g.lineWidth = this.big ? 3 : 2;
      g.beginPath();
      g.moveTo(p.cx, p.cy);
      g.lineTo(q.cx - Math.cos(t) * hd * 0.6, q.cy - Math.sin(t) * hd * 0.6);
      g.stroke();
      g.beginPath();
      g.moveTo(q.cx, q.cy);
      g.lineTo(q.cx - Math.cos(t - 0.45) * hd, q.cy - Math.sin(t - 0.45) * hd);
      g.lineTo(q.cx - Math.cos(t + 0.45) * hd, q.cy - Math.sin(t + 0.45) * hd);
      g.closePath();
      g.fill();
    }
    // arrivals and units
    const font = (px: number) => `bold ${Math.round(px)}px ui-monospace, Menlo, monospace`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (const { at: k } of c.schedule[c.round] ?? []) {
      const r = this.cellRect(k);
      g.fillStyle = "#ffd166";
      g.font = font(cs * 0.6);
      g.fillText("▼", r.cx, r.cy);
    }
    for (let u = 0; u < c.roster.length; u++) {
      if (c.hp[u]! <= 0) continue;
      const p = this.cellRect(c.pos[u]!);
      const squad = teamOf(c, u) === SQUAD;
      const r = cs * 0.34;
      g.globalAlpha = squad && s.acted.has(u) ? 0.55 : 1;
      g.fillStyle = squad ? "#7fc8ff" : "#ff7a6b";
      g.strokeStyle = u === s.striking ? "#ffffff" : "rgba(14,13,22,0.9)";
      g.lineWidth = u === s.striking ? 3 : 1.5;
      g.beginPath();
      g.arc(p.cx, p.cy, r, 0, 2 * Math.PI);
      g.fill();
      g.stroke();
      g.fillStyle = "#1e1c2b";
      g.font = font(r * 1.15);
      g.fillText(FIGHTERS[c.roster[u]!].name[0]!, p.cx, p.cy + 0.5);
      // on a roof: how high, in its height's colour
      if (a.struct[c.pos[u]!]! >= 0 && c.structHp[a.struct[c.pos[u]!]!]! > 0) {
        const m = Math.round(standAt(c, c.pos[u]!) * a.metersPerStep);
        g.font = font(this.big ? 11 : 9);
        const text = `▲${m}`;
        const tw = g.measureText(text).width + 4;
        g.fillStyle = "rgba(14,13,22,0.85)";
        g.fillRect(p.cx - r - tw + 2, p.cy - r * 1.1 - 6, tw, 12);
        g.fillStyle = band(m).colour;
        g.fillText(text, p.cx - r - tw / 2 + 2, p.cy - r * 1.1);
      }
      // its hit points, on the large map
      if (this.big) {
        const f = FIGHTERS[c.roster[u]!];
        const pw = (2 * r) / f.hp;
        for (let i = 0; i < f.hp; i++) {
          g.fillStyle = i < c.hp[u]! ? (squad ? "#7fc8ff" : "#ff7a6b") : "rgba(14,13,22,0.8)";
          g.fillRect(p.cx - r + i * pw + 0.5, p.cy + r + 3, pw - 1, 3);
        }
      }
      const n = teamOf(c, u) === INVADERS ? s.order.get(u) : undefined;
      if (n) {
        g.fillStyle = "#ff7a6b";
        g.font = font(r * 0.95);
        g.fillText(String(n), p.cx + r * 1.15, p.cy - r * 1.05);
      }
      g.globalAlpha = 1;
    }
    // the height colours, on the large map
    if (this.big) {
      g.font = "11px ui-monospace, Menlo, monospace";
      g.textAlign = "left";
      g.textBaseline = "middle";
      let x = PAD;
      const y = H - LEGEND / 2;
      for (const b of BANDS) {
        g.fillStyle = b.colour;
        g.fillRect(x, y - 4, 10, 8);
        g.fillStyle = "#c9bfa3";
        g.fillText(b.name, x + 14, y);
        x += 14 + g.measureText(b.name).width + 12;
      }
    }
  }
}

/** Height bands (D-163): low roofs, what a rig climbs onto (15 m), mid-rise, towers. */
const BANDS = [
  { upTo: 6, colour: "#8fe39a", name: "≤6 m" },
  { upTo: 15, colour: "#6fd3c6", name: "≤15 m rigs climb" },
  { upTo: 40, colour: "#9fb2ff", name: "≤40 m" },
  { upTo: Infinity, colour: "#d39cff", name: "taller" },
] as const;
const band = (m: number) => BANDS.find((b) => m <= b.upTo)!;
const LEGEND = 22;
