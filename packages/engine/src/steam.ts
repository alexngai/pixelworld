import type { ObjectInstance } from "@pixelworlds/generators";
import { MAX_PLUMES, fogLut, loadObjects, type FogLut, type SteamFrame } from "@pixelworlds/runtime";
import type { SteamStyle } from "@pixelworlds/style";
import type { FrameInfo, Layer, LayerContext, ScreenPass } from "./types";

/**
 * Steam (D-138), an atmosphere layer: a plume over every placed object of
 * the style's steam sources (hot pools, geysers), drawn by the compositor's
 * steam pass as a veil dithered into the frame, rising on its own clock.
 */

/** Redraws per second while steam is in view (the puffs rise a few pixels a second). */
const RISE_FPS = 12;
/** How fast the puffs rise, in metres a second at the objects' scale. */
const RISE_MPS = 1.5;

/** A plume, where it stands (cells, steps) and how big it is. */
export interface Plume {
  x: number;
  y: number;
  /** Its vent's height (steps) where the object has one (`z0`); else the ground's there. */
  z0?: number;
  /** Radius at the vent (cells) and height (steps). */
  radius: number;
  height: number;
  density: number;
  seed: number;
}

function polygonArea(fp: readonly (readonly [number, number])[]): number {
  let a = 0;
  for (let i = 0; i < fp.length; i++) {
    const [x0, y0] = fp[i]!;
    const [x1, y1] = fp[(i + 1) % fp.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

/**
 * The plumes of a world's placed objects: one for each object whose group
 * has a source (the longest dotted prefix, as for assets). A footprint's
 * plume is at least two-thirds as wide as its outline and rises higher the
 * bigger it is (metres at the objects' scale: a voxel is a sixteenth of a
 * cell across, an eighth of a step tall, times the height stretch).
 */
export function steamPlumes(
  instances: readonly ObjectInstance[],
  steam: Pick<SteamStyle, "sources">,
  metersPerCell: number,
  heightStretch = 1,
): Plume[] {
  const source = (group: string) => {
    for (let g = group; g; g = g.includes(".") ? g.slice(0, g.lastIndexOf(".")) : "") if (steam.sources[g]) return steam.sources[g];
    return undefined;
  };
  const stepsPerMeter = (2 * heightStretch) / metersPerCell;
  const out: Plume[] = [];
  for (const inst of instances) {
    const s = source(inst.g);
    if (!s) continue;
    // its outline's radius (cells): that of a disc of its area
    const area = inst.fp && inst.fp.length >= 3 ? polygonArea(inst.fp) : 0;
    if (s.minAreaMeters && area * metersPerCell ** 2 < s.minAreaMeters) continue;
    const r = Math.sqrt(area / Math.PI);
    out.push({
      x: inst.x,
      y: inst.y,
      ...(inst.z0 !== undefined ? { z0: inst.z0 } : {}),
      radius: Math.max(s.radiusMeters / metersPerCell, (2 / 3) * r),
      height: (s.heightMeters + 1.5 * r * metersPerCell) * stepsPerMeter,
      density: s.density,
      seed: ((Math.abs(inst.s) * 0.618034) % 1) * 37,
    });
  }
  return out;
}

export interface SteamLayerOptions {
  /** Start switched on (default true). */
  enabled?: boolean;
  /** The steam's clock at the start (seconds of play). */
  time?: number;
  /** Hold the puffs still. */
  paused?: boolean;
}

export class SteamLayer implements Layer {
  readonly id = "steam";
  readonly label = "Steam";
  private on: boolean;
  private hold: boolean;
  private clock: number;
  private inView = false;
  private ctx: LayerContext | null = null;
  private plumes: Plume[] = [];
  private lut: FogLut | null = null;
  private style: SteamStyle | null = null;
  private renderScale = 1;
  private stepsPerMeter = 1;
  private metersPerCell = 1;
  private readonly a = new Float32Array(MAX_PLUMES * 4);
  private readonly b = new Float32Array(MAX_PLUMES * 4);

  constructor(opts: SteamLayerOptions = {}) {
    this.on = opts.enabled ?? true;
    this.clock = opts.time ?? 0;
    this.hold = opts.paused ?? false;
  }

  get enabled(): boolean {
    return this.on;
  }

  /** Whether the last frame drew steam (some lay in view). */
  get drawn(): boolean {
    return this.on && this.inView;
  }

  setEnabled(on: boolean): void {
    this.on = on;
    this.ctx?.invalidate();
  }

  /** Hold the puffs or set the clock (seconds of play). */
  set(opts: { paused?: boolean; time?: number }): void {
    if (opts.paused !== undefined) this.hold = opts.paused;
    if (opts.time !== undefined) this.clock = opts.time;
    this.ctx?.invalidate();
  }

  async init(ctx: LayerContext): Promise<boolean> {
    const w = ctx.view.world;
    const steam = w.style.atmosphere?.steam;
    if (!steam || !w.objectCount) return false;
    const objects = await loadObjects(w.url, w.manifest);
    const mpc = w.manifest.scale.metersPerCell;
    const stretch = w.manifest.depiction?.heightStretch ?? w.style.objects?.heightStretch ?? 1;
    this.plumes = steamPlumes(objects?.instances ?? [], steam, mpc, stretch);
    if (!this.plumes.length) return false;
    this.lut = fogLut({ ...steam, ceilingMeters: 0, fadeMeters: 1, areas: [] }, w.palette, Object.keys(w.style.night?.emissive ?? {}));
    this.style = steam;
    this.renderScale = w.renderScale;
    this.stepsPerMeter = (2 * stretch) / mpc;
    this.metersPerCell = mpc;
    this.ctx = ctx;
    return true;
  }

  update(dt: number): boolean {
    if (this.hold) return false;
    const before = Math.floor(this.clock * RISE_FPS);
    this.clock += dt;
    return this.inView && Math.floor(this.clock * RISE_FPS) !== before;
  }

  screenPass(frame: FrameInfo): Extract<ScreenPass, { type: "steam" }> | null {
    const steam = this.style;
    this.inView = false;
    if (!this.on || !steam || !this.lut || !this.ctx) return null;
    const strength = frame.night ? (steam.night?.density ?? 0) : 1;
    if (!(strength > 0)) return null;
    const rs = this.renderScale;
    const query = this.ctx.view.query;
    // the wind: a plume's top leans downwind by up to 0.8 of its height (cells per step of it), full at 6 m/s
    const bearing = ((steam.wind?.toward ?? 0) * Math.PI) / 180;
    const lean = (Math.min(1, (steam.wind?.speed ?? 0) / 6) * 0.8) / (this.stepsPerMeter * this.metersPerCell);
    const v = frame.view;
    const across = Math.hypot(frame.projection.x[0], frame.projection.x[1]);
    const cx = v.left + v.width / 2;
    const cy = v.top + v.height / 2;
    const seen: { d: number; vals: number[] }[] = [];
    for (const p of this.plumes) {
      if (!frame.isDrawn(p.x, p.y)) continue;
      const h = p.z0 ?? query.heightAt(p.x, p.y);
      if (h === null) continue;
      const base = frame.project(p.x, p.y, h);
      const reach = p.height * lean;
      const top = frame.project(p.x + Math.sin(bearing) * reach, p.y - Math.cos(bearing) * reach, h + p.height);
      // a circle of radius r cells is 16√2 r render px across its widest, from its middle (the projection's cell width × √2)
      const r = across * p.radius * rs;
      const height = base.sy - top.sy;
      const shift = top.sx - base.sx;
      const left = Math.min(base.sx, base.sx + shift) - 2 * r;
      const right = Math.max(base.sx, base.sx + shift) + 2 * r;
      if (right < v.left || left > v.left + v.width || base.sy + r < v.top || top.sy - r > v.top + v.height) continue;
      seen.push({ d: Math.hypot(base.sx - cx, base.sy - cy), vals: [base.sx, base.sy, base.depth, r, height, p.density, p.seed, shift] });
    }
    seen.sort((p, q) => p.d - q.d);
    const count = Math.min(seen.length, MAX_PLUMES);
    for (let i = 0; i < count; i++) {
      const vals = seen[i]!.vals;
      this.a.set(vals.slice(0, 4), i * 4);
      this.b.set(vals.slice(4), i * 4);
    }
    this.inView = count > 0;
    if (!count) return null;
    const pxPerStep = -frame.projection.y[2] * rs;
    const params: SteamFrame = {
      a: this.a,
      b: this.b,
      count,
      rise: this.clock * RISE_MPS * this.stepsPerMeter * pxPerStep,
      strength,
      lut: this.lut,
      night: frame.night,
    };
    return { type: "steam", frame: params };
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

  dispose(): void {
    this.ctx = null;
  }
}

/** Steam from the style pack's atmosphere over the world's placed objects (D-138). */
export function steamLayer(opts: SteamLayerOptions = {}): SteamLayer {
  return new SteamLayer(opts);
}
