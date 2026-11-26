import { toWorld, type Board, type WorldView } from "@pixelworlds/engine";
import { planeAt, standAt, type Arrow, type Combat, type Mark } from "@pixelworlds/tactics";

/**
 * The board over the city view in the screen's own pixels (D-156). Every cell
 * is a quad where a unit there would stand (the ground, or a roof), so the
 * grid reads on stepped roofs and in every rotation. Marked cells are filled
 * see-through, with a glow. The pointer's and the keyboard's cells are
 * outlined, with lines down to the ground when they stand on a roof. A cell
 * hidden behind a building is outlined dashed, seen through it; a building
 * of the fight cut down in front of a unit (D-159) is outlined whole. A cell
 * the invaders will strike is striped red, and a building of theirs outlined
 * red whole (D-170). Arrows (an invader's aim, a push, a hint) are arcs with
 * heads, a dash running along them; cells invaders land on have a beacon;
 * the chosen cell pulses, a building struck flashes, a shot flies (D-171). Redrawn
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
  /** Per cell: still hidden behind a building (dashed). */
  hidden: Uint8Array;
  /** The fight's buildings cut down (D-159), far to near, outlined whole; and how high their stumps stand (steps). */
  ghosts: readonly number[];
  stump: number;
  /** Arrows over the board (D-171). */
  arrows: readonly Arrow[];
  /** Cells invaders land on at the round's end. */
  arrivals: readonly number[];
  /** Buildings struck, by when (ms, `performance.now()`): each flashes a moment. */
  flashes: ReadonlyMap<number, number>;
  /** Shots in flight: from a cell to a cell, from when, for how long (ms). */
  shots: readonly Shot[];
  /** A strike looked at (D-191): the buildings it hurts (pulsing red), and the units it moves (a ghost sliding from cell to cell, again and again). */
  hurt?: readonly number[];
  slides?: readonly { from: number; to: number }[];
}

export interface Shot {
  from: number;
  to: number;
  t0: number;
  ms: number;
  kind: Mark["kind"];
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
/** How a building of the fight is drawn whole: its roof's edge (alpha, glow, width), its corners down, the faint panes of its sides and roof. */
interface Whole {
  edge: number;
  glow: number;
  width: number;
  corner: number;
  pane: number;
  roof: number;
}
const GLASS: Whole = { edge: 0.5, glow: 6, width: 1.2, corner: 0.2, pane: 0.012, roof: 0.03 };
const GLASS_LIT: Whole = { edge: 0.95, glow: 10, width: 1.8, corner: 0.55, pane: 0.08, roof: 0.14 };
/** A building the invaders will strike (D-170): outlined, barely filled (its roof is striped). */
const THREAT: Whole = { edge: 1, glow: 10, width: 2.2, corner: 0.85, pane: 0.14, roof: 0.22 };
/** The rest of a building struck (D-192): outlined faintly. */
const THREAT_FAINT: Whole = { edge: 0.35, glow: 3, width: 1, corner: 0.15, pane: 0, roof: 0 };
/** A building struck (D-171): white, fading. */
const FLASH_MS = 450;
/** Arrows' colours by what they mean: an invader's aim red, a push or a move blue, a hint's strike yellow. */
const ARROW: Partial<Record<Mark["kind"], string>> = { attack: "235,70,60", move: "150,210,255", info: "242,193,78" };
const FILL: Partial<Record<Mark["kind"], number>> = { move: 0.26, attack: 0.34, info: 0.16, select: 0.12 };

export class BoardGlass {
  readonly el: HTMLCanvasElement;
  private s: GlassState | null = null;

  constructor(
    parent: HTMLElement,
    private readonly view: WorldView,
    private readonly board: Board,
  ) {
    this.el = document.createElement("canvas");
    this.el.className = "glass";
    parent.before(this.el);
  }

  set(s: GlassState): void {
    this.s = s;
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
    const now = performance.now();
    const centre = (k: number) => toWorld(this.board, { x: (k % a.w) + 0.5, y: Math.floor(k / a.w) + 0.5 });
    // an arrow's or a shot's path (D-171): from above where a unit stands to the cell struck, arcing over what's between when it's a
    // shot, low when it's a push or a move
    const arc = (ka: number, kb: number, high: boolean, low = false) => {
      const pa = centre(ka);
      const pb = centre(kb);
      const ha = planeAt(c, ka) + 1;
      // the arc comes down on the cell's own plane, where its marker is (D-192)
      const hb = planeAt(c, kb) + 0.1;
      const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      const up = high ? (low ? Math.max(0.8, len * 0.3) : Math.max(1.5, len * 0.8)) + Math.abs(hb - ha) * 0.3 : 0.5 + Math.abs(hb - ha) * 0.3;
      return (f: number) => {
        const q = camera.project(pa.x + (pb.x - pa.x) * f, pa.y + (pb.y - pa.y) * f, ha + (hb - ha) * f + up * 4 * f * (1 - f));
        return [q.x, q.y] as [number, number];
      };
    };
    // a straight run from part of the way from one cell's middle toward another's to further along it, rising from one height to another
    const toward = (ka: number, kb: number, f0: number, f1: number, ha: number, hb: number) => {
      const pa = centre(ka);
      const pb = centre(kb);
      return (f: number) => {
        const e = f0 + (f1 - f0) * f;
        const q = camera.project(pa.x + (pb.x - pa.x) * e, pa.y + (pb.y - pa.y) * e, ha + (hb - ha) * f);
        return [q.x, q.y] as [number, number];
      };
    };
    // hazard stripes across a cell (D-170): bands along the edge of it that runs up to the right on screen, every other one filled
    const stripes = (pts: [number, number][], rgb: string, alpha: number) => {
      const up = (p: number, q: number) => (pts[q]![0] - pts[p]![0]) * (pts[q]![1] - pts[p]![1]) < 0;
      const [p0, p1, p3] = up(0, 1) ? [0, 1, 3] : [0, 3, 1];
      const at = (u: number, v: number): [number, number] => [
        pts[p0]![0] + u * (pts[p1]![0] - pts[p0]![0]) + v * (pts[p3]![0] - pts[p0]![0]),
        pts[p0]![1] + u * (pts[p1]![1] - pts[p0]![1]) + v * (pts[p3]![1] - pts[p0]![1]),
      ];
      g.fillStyle = `rgba(${rgb},${alpha})`;
      const n = 8;
      for (let b = 0; b < n; b += 2) {
        path([at(0, b / n), at(1, b / n), at(1, (b + 1) / n), at(0, (b + 1) / n)]);
        g.fill();
      }
    };
    // the grid: faint, dashed through a building
    g.lineWidth = 1;
    for (let k = 0; k < a.w * a.h; k++) {
      path(quad(k, planeAt(c, k) + lift));
      g.setLineDash(s.hidden[k] ? [3, 3] : []);
      g.strokeStyle = s.hidden[k] ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.13)";
      g.stroke();
    }
    g.setLineDash([]);
    // a building of the fight whole, from its foot to its roof: the roof faintly filled, its outer sides as faint panes, the roof's
    // edge plainly, its corners down faintly
    // `only`: just these of its cells, each a column from its foot to its roof (D-192)
    const building = (id: number, rgb: string, w: Whole, foot: (k: number) => number, only?: ReadonlySet<number>) => {
      const st = a.structures[id];
      if (!st || c.structHp[id]! <= 0) return;
      const mine = new Set(only ? st.cells.filter((k) => only.has(k)) : st.cells);
      for (const k of mine) {
        const i = k % a.w;
        const j = Math.floor(k / a.w);
        const roof = quad(k, standAt(c, k));
        const base = quad(k, foot(k));
        path(roof);
        g.fillStyle = `rgba(${rgb},${w.roof})`;
        g.fill();
        ([[i, j - 1, 0, 1], [i + 1, j, 1, 2], [i, j + 1, 2, 3], [i - 1, j, 3, 0]] as const).forEach(([ni, nj, p, q]) => {
          if (ni >= 0 && nj >= 0 && ni < a.w && nj < a.h && mine.has(nj * a.w + ni)) return;
          path([roof[p]!, roof[q]!, base[q]!, base[p]!]);
          g.fillStyle = `rgba(${rgb},${w.pane})`;
          g.fill();
          g.strokeStyle = `rgba(${rgb},${w.edge})`;
          g.shadowColor = `rgba(${rgb},0.8)`;
          g.shadowBlur = w.glow;
          g.lineWidth = w.width;
          g.beginPath();
          g.moveTo(...roof[p]!);
          g.lineTo(...roof[q]!);
          g.stroke();
          g.strokeStyle = `rgba(${rgb},${w.corner})`;
          g.shadowBlur = 0;
          g.lineWidth = 1.2;
          g.beginPath();
          g.moveTo(...roof[p]!);
          g.lineTo(...base[p]!);
          g.stroke();
        });
      }
    };
    // the fight's buildings cut down (D-159): as glass, from the stump; the looked-at one brighter
    const focus = s.hover >= 0 ? s.hover : s.cursor;
    const focused = focus >= 0 ? a.struct[focus]! : -1;
    // the invaders' targets among the buildings (D-170): red, whole, from the ground, over the glass
    const threatened = new Set(s.marks.filter((m) => m.kind === "danger").map((m) => a.struct[m.j * a.w + m.i]!).filter((id) => id >= 0));
    g.save();
    for (const id of s.ghosts) if (!threatened.has(id)) building(id, "170,215,255", id === focused ? GLASS_LIT : GLASS, (k) => a.height[k]! + s.stump);
    // a building the invaders strike (D-192): the cells struck red, each its column from the ground to the roof; the rest of the
    // building outlined faintly, so it still reads as the one building whose hit points they take
    const struck = new Set(s.marks.filter((m) => m.kind === "danger").map((m) => m.j * a.w + m.i));
    for (const id of threatened) {
      building(id, COLOUR.danger, THREAT_FAINT, (k) => a.height[k]!);
      building(id, COLOUR.danger, THREAT, (k) => a.height[k]!, struck);
    }
    g.restore();
    // marked cells: see-through fills, glowing edges
    for (const m of s.marks) {
      const k = m.j * a.w + m.i;
      const rgb = COLOUR[m.kind];
      const fill = FILL[m.kind];
      const pts = quad(k, planeAt(c, k) + lift, 0.04);
      path(pts);
      if (fill) {
        g.fillStyle = `rgba(${rgb},${s.hidden[k] ? fill * 0.7 : fill})`;
        g.fill();
      }
      if (m.kind === "danger") stripes(pts, rgb, s.hidden[k] ? 0.32 : 0.45);
      g.save();
      // the chosen cell breathes
      const pulse = m.kind === "select" ? 0.5 + 0.5 * Math.sin(now / 240) : 0;
      g.shadowColor = `rgba(${rgb},0.9)`;
      g.shadowBlur = 8 + 10 * pulse;
      g.setLineDash(s.hidden[k] ? [4, 3] : []);
      g.strokeStyle = `rgba(${rgb},${m.kind === "ally" || m.kind === "enemy" ? 0.55 : 0.85})`;
      g.lineWidth = m.kind === "select" ? 2.2 + 1.3 * pulse : 1.5;
      g.stroke();
      g.restore();
    }
    // buildings struck just now: white, fading
    g.save();
    for (const [id, t0] of s.flashes) {
      const f = 1 - (now - t0) / FLASH_MS;
      if (f > 0) building(id, "255,255,255", { edge: f, glow: 16, width: 3, corner: f * 0.8, pane: 0.22 * f, roof: 0.3 * f }, (k) => a.height[k]!);
    }
    // buildings the strike looked at would hurt (D-191): red, breathing
    const breath = 0.5 + 0.5 * Math.sin(now / 160);
    for (const id of s.hurt ?? []) building(id, "255,90,80", { edge: 0.6 + 0.4 * breath, glow: 8 + 10 * breath, width: 2.4, corner: 0.6, pane: 0.06 + 0.12 * breath, roof: 0.1 + 0.2 * breath }, (k) => a.height[k]!);
    g.restore();
    // where invaders land at the round's end: rings closing in on the cell, and marks falling to it from the sky
    for (const k of s.arrivals) {
      const h = planeAt(c, k) + lift;
      g.save();
      g.lineWidth = 2;
      g.shadowColor = "rgba(255,170,60,0.9)";
      g.shadowBlur = 8;
      for (let r = 0; r < 2; r++) {
        const ph = (now / 1400 + r / 2) % 1;
        path(quad(k, h, -0.35 + 0.4 * ph));
        g.strokeStyle = `rgba(255,170,60,${0.9 * Math.min(1, ph * 3) * (1 - ph)})`;
        g.stroke();
      }
      const p = centre(k);
      const top = camera.project(p.x, p.y, h + 14);
      const foot = camera.project(p.x, p.y, h);
      const beam = g.createLinearGradient(top.x, top.y, foot.x, foot.y);
      beam.addColorStop(0, "rgba(255,170,60,0)");
      beam.addColorStop(1, "rgba(255,170,60,0.55)");
      g.strokeStyle = beam;
      g.lineWidth = 3;
      g.shadowBlur = 0;
      g.beginPath();
      g.moveTo(top.x, top.y);
      g.lineTo(foot.x, foot.y);
      g.stroke();
      g.strokeStyle = "rgba(255,190,90,0.9)";
      g.lineWidth = 2;
      for (let n = 0; n < 3; n++) {
        const f = (now / 900 + n / 3) % 1;
        const x = top.x + (foot.x - top.x) * f;
        const y = top.y + (foot.y - top.y) * f;
        g.globalAlpha = Math.min(1, f * 4) * (1 - f * 0.6);
        g.beginPath();
        g.moveTo(x - 6, y - 5);
        g.lineTo(x, y);
        g.lineTo(x + 6, y - 5);
        g.stroke();
      }
      g.restore();
    }
    // arrows: an outline, the colour, a dash running along it, and a head
    for (const ar of s.arrows) {
      const ka = ar.from[1] * a.w + ar.from[0];
      const kb = ar.to[1] * a.w + ar.to[0];
      const rgb = ARROW[ar.kind] ?? COLOUR[ar.kind];
      // its style (D-192): a ranged strike arcs onto the cell's plane; a blow is short and level, from the striker into the face of
      // the cell it hits; a move or a push runs straight from cell to cell
      const style = ar.style ?? (ar.kind === "move" ? "path" : "arc");
      const at =
        style === "arc" || style === "shot"
          ? arc(ka, kb, true, style === "shot")
          : style === "flat"
            ? toward(ka, kb, 0.12, 0.62, planeAt(c, ka) + 0.7, planeAt(c, ka) + 0.7)
            : toward(ka, kb, 0, 1, planeAt(c, ka) + 0.4, planeAt(c, kb) + 0.4);
      // where an arc comes down: the cell marked, so which one it is reads at once
      if (style === "arc" || style === "shot") {
        g.save();
        path(quad(kb, planeAt(c, kb) + lift, 0.14));
        g.fillStyle = `rgba(${rgb},0.16)`;
        g.fill();
        g.strokeStyle = `rgba(${rgb},0.95)`;
        g.lineWidth = 2;
        g.shadowColor = `rgba(${rgb},0.8)`;
        g.shadowBlur = 6;
        g.stroke();
        g.restore();
      }
      const pts: [number, number][] = [];
      for (let n = 0; n <= 32; n++) pts.push(at(n / 32));
      // the shaft stops where the head begins
      const tip = pts[pts.length - 1]!;
      let back = pts.length - 1;
      while (back > 0 && Math.hypot(pts[back]![0] - tip[0], pts[back]![1] - tip[1]) < 13) back--;
      const shaft = pts.slice(0, back + 1);
      const base = shaft[shaft.length - 1]!;
      const len = Math.hypot(tip[0] - base[0], tip[1] - base[1]) || 1;
      const [dx, dy] = [(tip[0] - base[0]) / len, (tip[1] - base[1]) / len];
      const head: [number, number][] = [tip, [base[0] - dy * 7, base[1] + dx * 7], [base[0] + dy * 7, base[1] - dx * 7]];
      g.save();
      g.lineCap = "round";
      g.lineJoin = "round";
      const line = () => {
        g.beginPath();
        shaft.forEach(([x, y], n) => (n ? g.lineTo(x, y) : g.moveTo(x, y)));
      };
      line();
      g.strokeStyle = "rgba(12,12,24,0.6)";
      g.lineWidth = 7;
      g.stroke();
      path(head);
      g.lineWidth = 4;
      g.stroke();
      line();
      g.strokeStyle = `rgba(${rgb},0.95)`;
      g.lineWidth = 4;
      g.shadowColor = `rgba(${rgb},0.7)`;
      g.shadowBlur = 6;
      g.stroke();
      path(head);
      g.fillStyle = `rgba(${rgb},1)`;
      g.fill();
      g.shadowBlur = 0;
      line();
      g.setLineDash([5, 11]);
      g.lineDashOffset = -(now / 30) % 16;
      g.strokeStyle = "rgba(255,255,255,0.6)";
      g.lineWidth = 1.6;
      g.stroke();
      g.restore();
    }
    // units the strike looked at would move (D-191): a ghost of each sliding along its arrow, easing in, again and again
    for (const sl of s.slides ?? []) {
      const at = arc(sl.from, sl.to, false);
      const t = (now / 1100) % 1;
      const f = t < 0.8 ? 1 - (1 - t / 0.8) ** 3 : 1;
      const [x, y] = at(f);
      g.save();
      g.globalAlpha = t < 0.8 ? 0.9 : 0.9 * (1 - (t - 0.8) / 0.2);
      g.beginPath();
      g.arc(x, y, 8, 0, 2 * Math.PI);
      g.fillStyle = "rgba(150,210,255,0.35)";
      g.shadowColor = "rgba(150,210,255,0.9)";
      g.shadowBlur = 12;
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = "rgba(255,255,255,0.9)";
      g.stroke();
      g.restore();
    }
    // shots in flight: a glowing ball along the arrow's arc, a short trail behind
    for (const sh of s.shots) {
      const f = (now - sh.t0) / sh.ms;
      if (f < 0 || f > 1) continue;
      const at = arc(sh.from, sh.to, true);
      const rgb = ARROW[sh.kind] ?? COLOUR[sh.kind];
      g.save();
      g.lineCap = "round";
      g.beginPath();
      for (let n = 0; n <= 6; n++) {
        const [x, y] = at(Math.max(0, f - 0.18 * (1 - n / 6)));
        if (n) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.strokeStyle = `rgba(${rgb},0.65)`;
      g.lineWidth = 5;
      g.stroke();
      const [x, y] = at(f);
      g.shadowColor = `rgba(${rgb},1)`;
      g.shadowBlur = 14;
      g.fillStyle = "rgba(255,250,235,1)";
      g.beginPath();
      g.arc(x, y, 6, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
    // what could be struck from where the rig would go
    g.save();
    g.setLineDash([3, 2]);
    g.lineWidth = 1.5;
    g.strokeStyle = "rgba(242,193,78,0.85)";
    for (const k of s.reach) {
      path(quad(k, planeAt(c, k) + lift, 0.18));
      g.stroke();
    }
    g.restore();
    // the pointer's and the keyboard's cells; down to the ground from a roof
    for (const [k, rgb, w] of [
      [s.hover, "255,255,255", 1.5],
      [s.cursor, "255,209,102", 2.5],
    ] as const) {
      if (k < 0) continue;
      const h = planeAt(c, k) + lift;
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
