import { unprojectAtHeight, type Rotation } from "@pixelworlds/grid";
import { fogInView, fogNoise, fogPatchOffset, setupFog, type FogFrame, type FogSetup } from "@pixelworlds/runtime";
import type { FrameInfo, Layer, LayerContext, ScreenPass, WorldInfo, WorldQuery } from "./types";

/**
 * Fog (D-063), an atmosphere layer: where the style pack has fog over the
 * world and level, a clock for its drift and the parameters of the
 * compositor's fog pass each frame. The time is seconds of play, so a fixed
 * `time` with the clock paused always draws the same fog.
 */

/** Redraws per second while the fog drifts on its own (it moves a few pixels a second). */
const DRIFT_FPS = 12;

export interface FogLayerOptions {
  /** Start switched on (default true). */
  enabled?: boolean;
  /** The fog's clock at the start (seconds of play). */
  time?: number;
  /** Hold the drift. */
  paused?: boolean;
}

export class FogLayer implements Layer {
  readonly id = "fog";
  readonly label = "Fog";
  private on: boolean;
  private hold: boolean;
  private clock: number;
  /** Whether the last frame drawn found fog in view. */
  private inView = false;
  private setup: FogSetup | null = null;
  private ctx: LayerContext | null = null;
  private renderScale = 1;
  private floor = 0;

  constructor(opts: FogLayerOptions = {}) {
    this.on = opts.enabled ?? true;
    this.clock = opts.time ?? 0;
    this.hold = opts.paused ?? false;
  }

  get enabled(): boolean {
    return this.on;
  }

  get paused(): boolean {
    return this.hold;
  }

  /** Seconds of play since the fog's clock started. */
  get time(): number {
    return this.clock;
  }

  init(ctx: LayerContext): boolean {
    const w = ctx.view.world;
    const query = ctx.view.query;
    this.setup = setupFog(w.style, w.palette, w.manifest, w.hasGeo ? (x, y) => query.cellToLonLat(x, y)! : null);
    if (!this.setup) return false;
    this.ctx = ctx;
    this.renderScale = w.renderScale;
    this.floor = w.floor;
    return true;
  }

  /** Whether the last frame drew fog (some lay in view). */
  get drawn(): boolean {
    return this.enabled && this.inView;
  }

  setEnabled(on: boolean): void {
    this.on = on;
    this.ctx?.invalidate();
  }

  /** Pause the drift or set the clock (seconds of play). */
  set(opts: { paused?: boolean; time?: number }): void {
    if (opts.paused !== undefined) this.hold = opts.paused;
    if (opts.time !== undefined) this.clock = opts.time;
    this.ctx?.invalidate();
  }

  update(dt: number): boolean {
    const s = this.setup;
    if (!s || this.hold || (s.drift[0] === 0 && s.drift[1] === 0)) return false;
    const before = Math.floor(this.clock * DRIFT_FPS);
    this.clock += dt;
    return this.inView && Math.floor(this.clock * DRIFT_FPS) !== before;
  }

  screenPass(frame: FrameInfo): ScreenPass | null {
    if (!this.setup) return null;
    // fog over the target (one pixel wider than the view, for the sub-pixel offset)
    const v = frame.view;
    const params = this.frameParams(frame.rotation, frame.night, {
      left: v.left,
      top: v.top,
      width: v.width + 1,
      height: v.height + 1,
    });
    return params ? { type: "fog", field: this.setup.field, frame: params } : null;
  }

  /** The fog pass's parameters for a view (render px), or null when no fog is drawn there. */
  private frameParams(
    rotation: Rotation,
    night: boolean,
    view: { left: number; top: number; width: number; height: number },
  ): FogFrame | null {
    const s = this.setup!;
    const rs = this.renderScale;
    const strength = s.strength * (night ? s.nightStrength : 1);
    this.inView =
      this.on &&
      strength > 0 &&
      // only pixels below the ceiling take fog
      fogInView(
        s.field,
        view,
        (sx, sy, h) => {
          const [x, y] = unprojectAtHeight(sx, sy, h, rotation);
          return [x / rs, y / rs];
        },
        [this.floor * rs, s.ceiling * rs],
      );
    if (!this.inView) return null;
    return {
      rotation,
      renderScale: rs,
      ceiling: s.ceiling * rs,
      fade: s.fade * rs,
      // patches float at the top of the thick fog
      patchHeight: Math.max(0, s.ceiling - s.fade) * rs,
      patchCells: s.patchCells,
      patchOffset: fogPatchOffset(s, this.clock),
      contrast: s.contrast,
      strength,
      lut: s.lut,
      night,
    };
  }

  serialize(): { enabled: boolean; paused: boolean; time: number } {
    return { enabled: this.on, paused: this.hold, time: this.clock };
  }

  restore(state: unknown): void {
    const s = state as { enabled?: boolean; paused?: boolean; time?: number };
    if (s.enabled !== undefined) this.on = s.enabled;
    if (s.paused !== undefined) this.hold = s.paused;
    if (s.time !== undefined) this.clock = s.time;
    this.ctx?.invalidate();
  }
}

/** Fog from the style pack's atmosphere (D-063), where it reaches the world. */
export function fogLayer(opts: FogLayerOptions = {}): FogLayer {
  return new FogLayer(opts);
}

/**
 * The style's fog as a number (D-125): how thick it is at a place, a height
 * and a time, as the fog layer draws it there then (its areas, its drift and
 * patches, and its ceiling), for a game in which fog hides things. A server
 * reads it through `openWorld` as a page does through its view; both give it
 * the same clock (`FogLayer.set({ time })` on the page).
 */
export interface FogSampler {
  /** Fog (0–1) at a point (cells) and a height (steps), at `seconds` on the fog's clock; `night` as the layer takes it. */
  at(x: number, y: number, h: number, seconds: number, night?: boolean): number;
  /** Where the fog's top is (steps): nothing higher stands in it. */
  readonly ceiling: number;
}

/** A world's fog as a number, or null where its style draws none there (as `fogLayer`). */
export function fogSampler(world: Pick<WorldInfo, "style" | "palette" | "manifest" | "hasGeo">, query: Pick<WorldQuery, "cellToLonLat">): FogSampler | null {
  const s = setupFog(world.style, world.palette, world.manifest, world.hasGeo ? (x, y) => query.cellToLonLat(x, y)! : null);
  return s ? new Sampler(s) : null;
}

class Sampler implements FogSampler {
  readonly ceiling: number;
  constructor(private readonly s: FogSetup) {
    this.ceiling = s.ceiling;
  }

  at(x: number, y: number, h: number, seconds: number, night = false): number {
    const s = this.s;
    const strength = s.strength * (night ? s.nightStrength : 1);
    const vertical = Math.max(0, Math.min(1, (s.ceiling - h) / s.fade));
    if (!(strength > 0) || vertical <= 0) return 0;
    const area = this.area(x, y);
    if (area <= 0) return 0;
    // the patches, as the pass puts them (on their plane, drifting); here under the point itself
    const [ox, oy] = fogPatchOffset(s, seconds);
    const n = fogNoise(x / s.patchCells - ox, y / s.patchCells - oy);
    const t = Math.max(0, Math.min(1, (n - 0.25) / 0.5));
    const patchiness = 1 + (t * t * (3 - 2 * t) - 1) * s.contrast;
    return Math.min(1, area * vertical * patchiness * strength);
  }

  /** The areas' coverage at a point, between the field's texels as the pass filters it. */
  private area(x: number, y: number): number {
    const f = this.s.field;
    const u = x / f.cellsPerTexel - 0.5;
    const v = y / f.cellsPerTexel - 0.5;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const at = (a: number, b: number) => f.data[Math.min(f.height - 1, Math.max(0, b)) * f.width + Math.min(f.width - 1, Math.max(0, a))]! / 255;
    const fx = u - i;
    const fy = v - j;
    const top = at(i, j) + (at(i + 1, j) - at(i, j)) * fx;
    const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fx;
    return top + (bottom - top) * fy;
  }
}
