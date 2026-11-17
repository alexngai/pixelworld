import { toWorld, type Board, type WorldView } from "@pixelworlds/engine";
import { standAt, type Combat, type Mark } from "@pixelworlds/tactics";

/**
 * The board over the city view in the screen's own pixels (D-156). Every cell
 * is a quad where a unit there would stand (the ground, or a roof), so the
 * grid reads on stepped roofs and in every rotation. Marked cells are filled
 * see-through, with a glow. The pointer's and the keyboard's cells are
 * outlined, with lines down to the ground when they stand on a roof. A cell
 * hidden behind a building is outlined dashed, seen through it. It is redrawn
 * every frame (the camera moves), on a 2D canvas over the world: no bakes, so
 * the cursor moves at once.
 */

export interface GlassState {
  state: Combat;
  marks: readonly Mark[];
  cursor: number;
  hover: number;
  /** Cells the selected rig could strike from the cell pointed at (outlined, faint). */
  reach: readonly number[];
}

const COLOUR: Record<Mark["kind"], string> = {
  move: "89,195,106",
  attack: "242,193,78",
  danger: "229,72,77",
  select: "255,255,255",
  ally: "127,200,255",
  enemy: "255,122,107",
  info: "242,193,78",
};
const FILL: Partial<Record<Mark["kind"], number>> = { move: 0.26, attack: 0.34, danger: 0.3, info: 0.16, select: 0.12 };

export class BoardGlass {
  readonly el: HTMLCanvasElement;
  private s: GlassState | null = null;
  /** Per cell: a building other than its own stands between it and the camera; and what that was worked out for. */
  private hidden: Uint8Array;
  private hiddenFor = "";

  constructor(
    parent: HTMLElement,
    private readonly view: WorldView,
    private readonly board: Board,
  ) {
    this.el = document.createElement("canvas");
    this.el.className = "glass";
    parent.before(this.el);
    this.hidden = new Uint8Array(board.w * board.h);
  }

  set(s: GlassState): void {
    this.s = s;
  }

  /** Which cells a building hides, by picking down each cell's view ray (again when the camera turns or the world changes). */
  private occlusion(c: Combat): void {
    const { camera, query, edits } = this.view;
    const key = `${camera.rotation}:${edits.version}:${c.structHp.join("")}`;
    if (key === this.hiddenFor) return;
    this.hiddenFor = key;
    const a = c.arena;
    for (let k = 0; k < a.w * a.h; k++) {
      const p = toWorld(this.board, { x: (k % a.w) + 0.5, y: Math.floor(k / a.w) + 0.5 });
      const at = camera.project(p.x, p.y, standAt(c, k) + 0.05);
      const hit = query.pickObject(at.x, at.y);
      const sid = a.struct[k]!;
      const own = sid >= 0 && c.structHp[sid]! > 0 ? a.structures[sid]!.object : -1;
      this.hidden[k] = hit && hit.index !== own && !hit.group.startsWith("tree") ? 1 : 0;
    }
  }

  frame(): void {
    const s = this.s;
    const canvas = this.view.canvas;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (this.el.width !== Math.round(W * dpr) || this.el.height !== Math.round(H * dpr)) {
      this.el.width = Math.round(W * dpr);
      this.el.height = Math.round(H * dpr);
    }
    const g = this.el.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!s) return;
    const c = s.state;
    const a = c.arena;
    this.occlusion(c);
    const { camera } = this.view;
    const quad = (k: number, h: number, inset = 0): [number, number][] =>
      [
        [inset, inset],
        [1 - inset, inset],
        [1 - inset, 1 - inset],
        [inset, 1 - inset],
      ].map(([di, dj]) => {
        const p = toWorld(this.board, { x: (k % a.w) + di!, y: Math.floor(k / a.w) + dj! });
        const q = camera.project(p.x, p.y, h);
        return [q.x, q.y];
      });
    const path = (pts: [number, number][]) => {
      g.beginPath();
      pts.forEach(([x, y], n) => (n ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
    };
    const lift = 0.08;
    // the grid: faint, dashed through a building
    g.lineWidth = 1;
    for (let k = 0; k < a.w * a.h; k++) {
      path(quad(k, standAt(c, k) + lift));
      g.setLineDash(this.hidden[k] ? [3, 3] : []);
      g.strokeStyle = this.hidden[k] ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.13)";
      g.stroke();
    }
    g.setLineDash([]);
    // marked cells: see-through fills, glowing edges
    for (const m of s.marks) {
      const k = m.j * a.w + m.i;
      const rgb = COLOUR[m.kind];
      const fill = FILL[m.kind];
      const pts = quad(k, standAt(c, k) + lift, 0.04);
      path(pts);
      if (fill) {
        g.fillStyle = `rgba(${rgb},${this.hidden[k] ? fill * 0.7 : fill})`;
        g.fill();
      }
      g.save();
      g.shadowColor = `rgba(${rgb},0.9)`;
      g.shadowBlur = 8;
      g.setLineDash(this.hidden[k] ? [4, 3] : []);
      g.strokeStyle = `rgba(${rgb},${m.kind === "ally" || m.kind === "enemy" ? 0.55 : 0.85})`;
      g.lineWidth = m.kind === "select" ? 2.5 : 1.5;
      g.stroke();
      g.restore();
    }
    // what could be struck from where the rig would go
    g.save();
    g.setLineDash([3, 2]);
    g.lineWidth = 1.5;
    g.strokeStyle = "rgba(242,193,78,0.85)";
    for (const k of s.reach) {
      path(quad(k, standAt(c, k) + lift, 0.18));
      g.stroke();
    }
    g.restore();
    // the pointer's and the keyboard's cells; down to the ground from a roof
    for (const [k, rgb, w] of [
      [s.hover, "255,255,255", 1.5],
      [s.cursor, "255,209,102", 2.5],
    ] as const) {
      if (k < 0) continue;
      const h = standAt(c, k) + lift;
      const top = quad(k, h, 0.02);
      g.save();
      g.shadowColor = `rgba(${rgb},1)`;
      g.shadowBlur = 10;
      g.strokeStyle = `rgba(${rgb},0.95)`;
      g.lineWidth = w;
      path(top);
      g.stroke();
      const ground = a.height[k]!;
      if (h - ground > 1.5) {
        const foot = quad(k, ground + lift, 0.02);
        g.shadowBlur = 0;
        g.lineWidth = 1;
        g.setLineDash([2, 3]);
        g.strokeStyle = `rgba(${rgb},0.5)`;
        for (let n = 0; n < 4; n++) {
          g.beginPath();
          g.moveTo(...top[n]!);
          g.lineTo(...foot[n]!);
          g.stroke();
        }
        path(foot);
        g.stroke();
      }
      g.restore();
    }
  }

  dispose(): void {
    this.el.remove();
  }
}
