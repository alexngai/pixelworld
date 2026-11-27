import type { Box, FrameInfo, Layer, LayerContext, Rotation, Sprite, SpriteDraw, WorldQuery } from "@pixelworlds/engine";
import { CELL_WALL, boardBounds, boardRect, type Board } from "@pixelworlds/engine/boards";
import { rampsFor, type Role } from "./models";

/**
 * A board's tactics overlay (D-149): tiles marked on the board's cells (move
 * range, targets, danger, the selection), its grid, and arrows for moves,
 * attacks and pushes, drawn on the ground or the roof each cell stands on.
 * It is one sprite baked from boxes, depth-tested against the world, so a
 * building in front hides what lies behind it. It bakes again when the marks,
 * the board's cells (an edit) or the view's rotation change.
 */

/** What a mark means, and so its colour. */
export type MarkKind = "move" | "attack" | "danger" | "select" | "ally" | "enemy" | "info";

const MARK_ROLE: Record<MarkKind, Role> = {
  move: "glass",
  attack: "red",
  danger: "fire",
  select: "white",
  ally: "water",
  enemy: "alien",
  info: "yellow",
};

export interface Mark {
  i: number;
  j: number;
  kind: MarkKind;
}

export interface Arrow {
  from: [number, number];
  to: [number, number];
  kind: MarkKind;
  /**
   * How it's drawn (D-192): `arc`, high over what's between, for a lob or a lift; `shot`, a low arc, for a shot along a line; `flat`,
   * short and level into the next cell, for a blow; `path`, straight from cell to cell, for a move or a push. Unset: `path` for a move,
   * else `arc`.
   */
  style?: "arc" | "shot" | "flat" | "path";
}

/** An arrow's style for a weapon's kind (D-192): a blow or a charge flat, a shot a low arc, a lob or a lift a high one. */
export const arrowStyle = (kind: string): "arc" | "shot" | "flat" => (kind === "melee" || kind === "charge" || kind === "evacuate" ? "flat" : kind === "shot" ? "shot" : "arc");

export interface BoardOverlayOptions {
  /** The layer's id (default `board-overlay`; give each board's its own). */
  id?: string;
  /** Draw the board's grid (default true). */
  grid?: boolean;
  /** A rooftop board's floor (steps, D-180): what lies lower is drawn at it, the board a plane at the roofs. */
  floor?: number;
}

/** Steps above the ground a mark floats, so the slopes under it don't swallow it. */
const LIFT = 0.12;
const THICK = 0.06;

export class BoardOverlay implements Layer {
  readonly id: string;
  readonly label = "board overlay";
  enabled = true;
  private ctx: LayerContext | null = null;
  private marks: Mark[] = [];
  private arrows: Arrow[] = [];
  private grid: boolean;
  private floor: number;
  private sprite: Sprite | null = null;
  /** What the sprite shows (rotation and a count of changes), and what is baking. */
  private shown = "";
  private baking = "";
  private version = 0;

  constructor(
    readonly board: Board,
    opts: BoardOverlayOptions = {},
  ) {
    this.id = opts.id ?? "board-overlay";
    this.grid = opts.grid ?? true;
    this.floor = opts.floor ?? -Infinity;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  init(ctx: LayerContext): boolean {
    this.ctx = ctx;
    return true;
  }

  /** Whether (i, j) is a cell of the board. */
  private on(i: number, j: number): boolean {
    return Number.isInteger(i) && Number.isInteger(j) && i >= 0 && j >= 0 && i < this.board.w && j < this.board.h;
  }

  /** Replace the marked cells. */
  setMarks(marks: readonly Mark[]): void {
    this.marks = marks.filter((m) => this.on(m.i, m.j));
    this.changed();
  }

  setArrows(arrows: readonly Arrow[]): void {
    this.arrows = [...arrows];
    this.changed();
  }

  setGrid(on: boolean): void {
    this.grid = on;
    this.changed();
  }

  /** The board's cells changed (an edit resampled them): bake again. */
  changed(): void {
    this.version++;
    this.ctx?.invalidate();
  }

  sprites(frame: FrameInfo): { list: SpriteDraw[]; complete: boolean } {
    const want = `${frame.rotation}:${this.version}`;
    if (want !== this.shown && want !== this.baking) this.bake(frame.rotation, want);
    // not over the void of tiles still baking (as traffic and entities wait)
    const [bx0, by0, bx1, by1] = boardBounds(this.board);
    const drawn = [[bx0, by0], [bx1 - 1e-3, by0], [bx0, by1 - 1e-3], [bx1 - 1e-3, by1 - 1e-3]].every(([x, y]) => frame.isDrawn(x!, y!));
    if (!this.sprite || !drawn) return { list: [], complete: want === this.shown && drawn };
    const s = frame.project(bx0, by0, 0);
    return { list: [{ sprite: this.sprite, sx: s.sx, sy: s.sy, depth: s.depth, silhouette: false }], complete: want === this.shown };
  }

  private bake(rotation: Rotation, want: string): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.baking = want;
    const boxes = this.boxes(ctx.view.query, ctx.view.world.palette.rampIds, ctx.view.world.renderScale);
    const done = (img: Sprite | null) => {
      if (this.baking !== want || this.ctx !== ctx) {
        if (img) ctx.releaseSprite(img); // a newer bake is coming, or the layer left the view
        return;
      }
      if (this.sprite) ctx.releaseSprite(this.sprite);
      this.sprite = img;
      this.shown = want;
      this.baking = "";
      ctx.invalidate();
    };
    if (!boxes.length) return done(null);
    void ctx.bakeSprite(rotation, boxes).then(done);
  }

  /** Where marks sit on a cell: the roof of what walls it, or the highest ground under it (steps). */
  private standAt(query: WorldQuery, i: number, j: number): number {
    const b = this.board;
    const k = j * b.w + i;
    if (b.flags[k]! & CELL_WALL) return Math.max(this.floor, b.top[k]!);
    const [x0, y0, x1, y1] = boardRect(b, k);
    let hi = b.height[k]!;
    for (const [x, y] of [[x0, y0], [x1 - 1e-3, y0], [x0, y1 - 1e-3], [x1 - 1e-3, y1 - 1e-3], [(x0 + x1) / 2, (y0 + y1) / 2]] as const) {
      const h = query.heightAt(x, y);
      if (h !== null) hi = Math.max(hi, h);
    }
    return Math.max(this.floor, hi);
  }

  /** The overlay's boxes (render units, from the board's corner at height 0). */
  boxes(query: WorldQuery, rampIds: ReadonlyMap<string, number>, rs: number): Box[] {
    const b = this.board;
    const ramps = rampsFor(rampIds);
    const c = b.cell;
    const out: Box[] = [];
    const heights = new Map<number, number>();
    const stand = (i: number, j: number) => {
      const k = j * b.w + i;
      let h = heights.get(k);
      if (h === undefined) heights.set(k, (h = this.standAt(query, i, j)));
      return h;
    };
    const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, ramp: number) =>
      out.push({ x0: x0 * rs, y0: y0 * rs, z0: z0 * rs, x1: x1 * rs, y1: y1 * rs, z1: z1 * rs, ramp });
    if (this.grid) {
      const w = Math.min(0.06, c * 0.06);
      for (let j = 0; j < b.h; j++)
        for (let i = 0; i < b.w; i++) {
          const h = stand(i, j) + LIFT;
          const x = i * c;
          const y = j * c;
          box(x, y, h, x + c, y + w, h + THICK, ramps.white);
          box(x, y, h, x + w, y + c, h + THICK, ramps.white);
          if (i === b.w - 1) box(x + c - w, y, h, x + c, y + c, h + THICK, ramps.white);
          if (j === b.h - 1) box(x, y + c - w, h, x + c, y + c, h + THICK, ramps.white);
        }
    }
    for (const m of this.marks) {
      const h = stand(m.i, m.j) + LIFT + THICK;
      const inset = c * 0.12;
      box(m.i * c + inset, m.j * c + inset, h, (m.i + 1) * c - inset, (m.j + 1) * c - inset, h + THICK, ramps[MARK_ROLE[m.kind]]);
    }
    for (const a of this.arrows) {
      if (!this.on(...a.from) || !this.on(...a.to)) continue;
      const ramp = ramps[MARK_ROLE[a.kind]];
      const ha = stand(...a.from) + 0.6;
      const hb = stand(...a.to) + 0.6;
      const ax = (a.from[0] + 0.5) * c;
      const ay = (a.from[1] + 0.5) * c;
      const bx = (a.to[0] + 0.5) * c;
      const by = (a.to[1] + 0.5) * c;
      const len = Math.hypot(bx - ax, by - ay);
      const arc = Math.max(0.5, len * 0.35) + Math.abs(hb - ha) * 0.3; // over what lies between
      const n = Math.max(4, Math.ceil(len / (c * 0.15)));
      const s = c * 0.08;
      for (let t = 0; t <= n; t++) {
        const f = t / n;
        const head = f > 0.82;
        const r = head ? s * (1 + (1 - f) * 10) : s;
        const x = ax + (bx - ax) * f;
        const y = ay + (by - ay) * f;
        const z = ha + (hb - ha) * f + arc * 4 * f * (1 - f);
        box(x - r, y - r, z - r, x + r, y + r, z + r, ramp);
      }
    }
    return out;
  }

  dispose(): void {
    if (this.sprite) this.ctx?.releaseSprite(this.sprite);
    this.sprite = null;
    this.ctx = null;
    this.shown = "";
    this.baking = "";
  }
}

export function boardOverlay(board: Board, opts?: BoardOverlayOptions): BoardOverlay {
  return new BoardOverlay(board, opts);
}
