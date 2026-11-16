import { project, unprojectAtHeight, type Rotation } from "@pixelworlds/grid";
import type { RouteNetwork } from "@pixelworlds/sim";

/**
 * A minimap of a world's roads and landmarks, drawn once per rotation, with
 * the player over it: the game's (north up, top right) and the viewer's
 * (`iso`, D-146: the world as the view sees it from above, a diamond turning
 * with the view, with the part on screen and north marked).
 */

const CLASS_COLOUR: Record<string, string> = {
  motorway: "#f2c35b",
  trunk: "#e0a35a",
  primary: "#c9b48a",
  secondary: "#8f8a7a",
};

/** The ground a view shows, as cells: its four corners at the focus height, clockwise from the top left. */
export function viewOnGround(
  focus: { x: number; y: number },
  width: number,
  height: number,
  rotation: Rotation,
  renderScale: number,
): [number, number][] {
  return [
    [-width / 2, -height / 2],
    [width / 2, -height / 2],
    [width / 2, height / 2],
    [-width / 2, height / 2],
  ].map(([sx, sy]) => {
    const [dx, dy] = unprojectAtHeight(sx!, sy!, 0, rotation);
    return [focus.x + dx / renderScale, focus.y + dy / renderScale];
  });
}

export class Minimap {
  /** The view's rotation (`iso` maps; the game's are always north up). */
  rotation: Rotation = 0;
  private world = { cellsX: 1, cellsY: 1 };
  private routes: RouteNetwork | null = null;
  private landmarks: readonly { x: number; y: number }[] = [];
  private readonly bases = new Map<Rotation, HTMLCanvasElement>();

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly iso = false,
  ) {}

  /** The world's size, roads and landmarks; the map is drawn from them when next shown. */
  setWorld(cellsX: number, cellsY: number, routes: RouteNetwork | null, landmarks: readonly { x: number; y: number }[]): void {
    this.world = { cellsX, cellsY };
    this.routes = routes;
    this.landmarks = landmarks;
    this.bases.clear();
    // iso: a world of any shape is a diamond in a 2:1 box, as the view projects it
    const w = this.iso ? 200 : 180;
    this.canvas.width = w;
    this.canvas.height = this.iso ? w / 2 : Math.max(60, Math.min(200, Math.round((w * cellsY) / cellsX)));
  }

  /** Where a cell is on the map (canvas px). */
  toMap(x: number, y: number): [number, number] {
    const { cellsX: W, cellsY: H } = this.world;
    const { width: w, height: h } = this.canvas;
    if (!this.iso) return [(x * w) / W, (y * h) / H];
    const k = w / (16 * (W + H)); // the view's 16 px per cell across, scaled so the world spans the width
    const p = project(x - W / 2, y - H / 2, 0, this.rotation);
    return [w / 2 + p.sx * k, h / 2 + p.sy * k];
  }

  /** The cell at a point of the map (canvas px): `toMap` inverted. */
  toCell(px: number, py: number): [number, number] {
    const { cellsX: W, cellsY: H } = this.world;
    const { width: w, height: h } = this.canvas;
    if (!this.iso) return [(px * W) / w, (py * H) / h];
    const k = w / (16 * (W + H));
    const [dx, dy] = unprojectAtHeight((px - w / 2) / k, (py - h / 2) / k, 0, this.rotation);
    return [W / 2 + dx, H / 2 + dy];
  }

  /** The roads and landmarks over the world's ground, in the current rotation. */
  private base(): HTMLCanvasElement {
    const r = this.iso ? this.rotation : 0;
    let base = this.bases.get(r);
    if (base) return base;
    base = document.createElement("canvas");
    base.width = this.canvas.width;
    base.height = this.canvas.height;
    const ctx = base.getContext("2d")!;
    const { cellsX: W, cellsY: H } = this.world;
    ctx.fillStyle = "#1e1c2b";
    ctx.strokeStyle = "#3b3a4c";
    ctx.beginPath();
    for (const [x, y] of [[0, 0], [W, 0], [W, H], [0, H]] as const) ctx.lineTo(...this.toMap(x, y));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    for (const cls of ["secondary", "primary", "trunk", "motorway", ""]) {
      ctx.strokeStyle = CLASS_COLOUR[cls] ?? "#6d6a60";
      ctx.lineWidth = cls === "motorway" || cls === "trunk" ? 1.2 : 0.7;
      ctx.beginPath();
      for (const route of this.routes?.routes ?? []) {
        if (route.net !== "road") continue;
        const known = route.cls in CLASS_COLOUR;
        if ((cls && route.cls !== cls) || (!cls && known)) continue;
        for (let i = 0; i < route.pts.length; i += 3) {
          const [x, y] = this.toMap(route.pts[i]!, route.pts[i + 1]!);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
    ctx.fillStyle = "#7fd0c8";
    for (const l of this.landmarks) {
      const [x, y] = this.toMap(l.x, l.y);
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
    this.bases.set(r, base);
    return base;
  }

  /**
   * The map with the player on it (cells): an arrow along a heading (radians
   * in the grid, 0 east) or a dot without one, and the ground on screen
   * (`viewOnGround`) as an outline. Not drawn while hidden.
   */
  draw(x: number, y: number, heading: number | null, colour: string, view?: readonly [number, number][]): void {
    if (this.canvas.classList.contains("hidden")) return;
    const ctx = this.canvas.getContext("2d")!;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.base(), 0, 0);
    const [px, py] = this.toMap(x, y);
    ctx.fillStyle = colour;
    ctx.strokeStyle = "#141320";
    ctx.beginPath();
    if (heading === null) ctx.arc(px, py, 3, 0, 2 * Math.PI);
    else {
      const [hx, hy] = this.toMap(x + Math.cos(heading), y + Math.sin(heading));
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(Math.atan2(hy - py, hx - px));
      ctx.moveTo(6, 0);
      ctx.lineTo(-4, 4);
      ctx.lineTo(-2, 0);
      ctx.lineTo(-4, -4);
      ctx.closePath();
      ctx.restore();
    }
    ctx.fill();
    ctx.stroke();
    // over the player: on a large level the view is only a few pixels across
    if (view) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const [cx, cy] of view) ctx.lineTo(...this.toMap(cx, cy));
      ctx.closePath();
      ctx.stroke();
    }
    if (this.iso) this.compass(ctx);
  }

  /** North (grid −y) as the view shows it: a needle in the top-left corner, which the diamond leaves empty. */
  private compass(ctx: CanvasRenderingContext2D): void {
    const [ax, ay] = this.toMap(0, 0);
    const [bx, by] = this.toMap(0, -1);
    const len = Math.hypot(bx - ax, by - ay);
    const [nx, ny] = [(bx - ax) / len, (by - ay) / len];
    const [cx, cy] = [16, 16];
    ctx.lineWidth = 2;
    for (const [end, colour] of [[-6, "#6d6a60"], [7, "#ffe36e"]] as const) {
      ctx.strokeStyle = colour;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + nx * end, cy + ny * end);
      ctx.stroke();
    }
    ctx.fillStyle = "#ffe36e";
    ctx.font = "bold 9px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("N", cx + nx * 13, cy + ny * 13);
  }
}
