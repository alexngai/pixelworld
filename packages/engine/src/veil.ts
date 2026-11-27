import { fogLut, type FogField, type FogFrame, type FogLut } from "@pixelworlds/runtime";
import type { CellRect } from "./cells";
import type { FrameInfo, Layer, LayerContext, ScreenPass } from "./types";

/**
 * A veil over cells (D-125): a game sets how thick it lies on each cell of
 * a rectangle (0 clear to 1 thickest), and the compositor dithers it into
 * the frame as it does the style's fog, pixel by pixel from where each is in
 * the world, so buildings, trees and units stand in it as the ground does:
 * a strategy game's fog of war (what a side doesn't see darkened, what it
 * has never seen darker), a highlighted area, night beyond a light. Nothing
 * is baked; a new field costs one small texture.
 */

export interface VeilLayerOptions {
  /** Its id among the view's layers (default "veil"): one pass each, in the layers' order. */
  id?: string;
  label?: string;
  /** The style's ramp the veil moves colours toward, and the shade (default the darkest but its outline, 1). */
  ramp: string;
  shade?: number;
  /** How far each level moves a colour toward the ramp's (0–1, increasing), thinnest first (default [0.35, 0.6, 0.8]). */
  levels?: number[];
  /**
   * Veil only what lies below this height (steps), fading in over a step
   * (D-198): the street and the towers' faces under a rooftop board, its roofs
   * clear. Default every height.
   */
  below?: number;
  enabled?: boolean;
}

export class VeilLayer implements Layer {
  readonly id: string;
  readonly label: string;
  private on: boolean;
  private field: FogField | null = null;
  private lut: FogLut | null = null;
  private ctx: LayerContext | null = null;
  private renderScale = 1;

  constructor(private readonly opts: VeilLayerOptions) {
    this.id = opts.id ?? "veil";
    this.label = opts.label ?? "Veil";
    this.on = opts.enabled ?? true;
  }

  get enabled(): boolean {
    return this.on;
  }

  setEnabled(on: boolean): void {
    this.on = on;
    this.ctx?.invalidate();
  }

  init(ctx: LayerContext): boolean {
    const w = ctx.view.world;
    if (!w.palette.rampIds.has(this.opts.ramp)) throw new Error(`veil: the style has no ramp "${this.opts.ramp}"`);
    const fog = { ramp: this.opts.ramp, shade: this.opts.shade ?? 1, veil: this.opts.levels ?? [0.35, 0.6, 0.8], ceilingMeters: 0, fadeMeters: 1, areas: [] };
    this.lut = fogLut(fog, w.palette, Object.keys(w.style.night?.emissive ?? {}));
    this.renderScale = w.renderScale;
    this.ctx = ctx;
    return true;
  }

  /**
   * How thick the veil lies on each cell of a rectangle: one value a cell
   * (0–255 for 0–1), row by row. Beyond the rectangle it lies as on its
   * nearest edge. Between cells' middles it blends.
   */
  set(rect: CellRect, values: Uint8Array): void {
    if (values.length !== rect.w * rect.h) throw new Error(`veil: ${values.length} values for ${rect.w} × ${rect.h} cells`);
    this.field = { width: rect.w, height: rect.h, cellsPerTexel: 1, data: values, x0: rect.x0, y0: rect.y0 };
    this.ctx?.invalidate();
  }

  /** Lift it everywhere. */
  clear(): void {
    this.field = null;
    this.ctx?.invalidate();
  }

  screenPass(frame: FrameInfo): Extract<ScreenPass, { type: "fog" }> | null {
    if (!this.on || !this.field || !this.lut) return null;
    const rs = this.renderScale;
    const params: FogFrame = {
      rotation: frame.rotation,
      renderScale: rs,
      // over every height, or below the one asked for (D-198); even, still
      ceiling: this.opts.below !== undefined ? this.opts.below * rs : 1e9,
      fade: this.opts.below !== undefined ? rs : 1,
      patchHeight: 0,
      patchCells: 1,
      patchOffset: [0, 0],
      contrast: 0,
      strength: 1,
      lut: this.lut,
      night: frame.night,
    };
    return { type: "fog", field: this.field, frame: params };
  }

  dispose(): void {
    this.ctx = null;
  }
}

/** A veil over cells, set by the game (D-125): a fog of war, say. */
export function veilLayer(opts: VeilLayerOptions): VeilLayer {
  return new VeilLayer(opts);
}
