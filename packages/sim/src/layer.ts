import type { FrameInfo, Layer, LayerContext, Sprite, SpriteDraw, Sublayer } from "@pixelworlds/engine";
import { generateModel, modelBoxes, resolveAsset, type AssetCatalog, type Box, type VoxelModel } from "@pixelworlds/generators";
import { fetchWorldJson, parseWorldFile, type WorldManifest } from "@pixelworlds/world-format";
import type { VehicleKind } from "./catalog";
import { modelSize, vehicleBoxes, vehicleVoxels, type RampLookup } from "./models";
import { RouteNetwork, parseRoutes } from "./routes";
import { TICK, TrafficSim, type Pose, type SimState } from "./sim";

/**
 * Ambient traffic as a runtime layer of a world view (D-060): runs the
 * simulation from the frame loop and draws its vehicles as depth-tested
 * sprites.
 *
 * Sprites are baked through the view, once per vehicle model and heading,
 * in view rotation 0 only: a model turned by θ seen in rotation r is the
 * model turned by θ + r·90° seen in rotation 0 (rotateXY), and lighting is
 * view-relative, so 16 headings in one rotation serve all four.
 *
 * A vehicle is the style pack's `vehicle.<kind>` asset where the pack has one:
 * a procedural voxel model (D-064) sized for the level, turned into boxes for
 * the sprite bake. Packs without vehicle assets get generic box models.
 */

export const HEADINGS = 16;

/** Parts of the traffic layer that switch on and off on their own. */
export type TrafficSublayer = "road" | "rail" | "ferry";
export const TRAFFIC_SUBLAYERS: readonly TrafficSublayer[] = ["road", "rail", "ferry"];
export const SUBLAYER_LABELS: Record<TrafficSublayer, string> = {
  road: "road vehicles",
  rail: "rail and transit",
  ferry: "ferries",
};
const SUBLAYER_OF: Record<VehicleKind, TrafficSublayer> = {
  car: "road",
  bus: "road",
  cablecar: "rail",
  streetcar: "rail",
  lightrail: "rail",
  train: "rail",
  ferry: "ferry",
};
const LIFT = 0.2; // steps above the route, so a car's floor isn't lost in the road surface

/** A world package's routes (`routes.json.gz`), or null when it has none. */
export async function loadRoutes(worldUrl: string, manifest: WorldManifest): Promise<RouteNetwork | null> {
  if (!manifest.routes) return null;
  const base = worldUrl.endsWith("/") ? worldUrl : worldUrl + "/";
  // errors name the URL (D-072)
  const url = base + manifest.routes.path;
  const json = await fetchWorldJson(url, { label: "world routes", expected: "the routes file the manifest names" });
  return parseWorldFile(url, "world routes", () => new RouteNetwork(parseRoutes(json)));
}

export interface TrafficLayerOptions {
  /** The simulation's seed (default 1). */
  seed?: number;
  /** Multiplies every kind's density (default 1). */
  density?: number;
  /** Start switched on (default true). */
  enabled?: boolean;
  /** Hold the simulation still. */
  paused?: boolean;
  /** Start the simulation this far along (seconds of play): fixed scenes. */
  time?: number;
  /** The sublayers drawn (default all). */
  sublayers?: readonly TrafficSublayer[];
  /** Routes to run on instead of the world package's. */
  routes?: RouteNetwork;
}

/** The layer's whole state, for determinism. */
export interface TrafficLayerState {
  enabled: boolean;
  paused: boolean;
  sublayers: TrafficSublayer[];
  sim: SimState;
}

/** Object voxel size in render units (objectVoxelScale at render scale 1, D-010). */
const VOXEL = { h: 1 / 16, v: 1 / 8 };

/** A small stable hash for model seeds. */
function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A vehicle drawn this frame, for tests: screen position and depth. */
export interface DrawnVehicle extends Pose {
  sx: number;
  sy: number;
  depth: number;
}

/** A vehicle's car near a place (`TrafficLayer.vehiclesNear`): its pose and its size in plan (cells). */
export interface NearbyVehicle extends Pose {
  /** Along its heading, and across. */
  length: number;
  width: number;
}

/** A palette ramp lookup by name with fallbacks. */
export function rampLookup(rampIds: Map<string, number>): RampLookup {
  return (names) => {
    for (const n of names) {
      const id = rampIds.get(n);
      if (id !== undefined) return id;
    }
    return 0;
  };
}

export class TrafficLayer implements Layer {
  readonly id = "traffic";
  readonly label = "Traffic";
  readonly sublayers: readonly Sublayer[] = TRAFFIC_SUBLAYERS.map((id) => ({ id, label: SUBLAYER_LABELS[id] }));
  /** Sublayers drawn; the simulation runs them all, so toggling one changes nothing else. */
  readonly shown: Set<TrafficSublayer>;
  private on: boolean;
  private hold: boolean;
  private simulation: TrafficSim | null = null;
  private ctx: LayerContext | null = null;
  private net: RouteNetwork | null = null;
  private renderScale = 1;
  private ramp: RampLookup = () => 0;
  private assets: AssetCatalog | undefined;
  private rampIds: Map<string, number> | undefined;
  /** Vehicle sprites by model and heading: null while baking, false where the bake failed. */
  private readonly baked = new Map<string, Sprite | null | false>();
  private readonly models = new Map<string, VoxelModel>();
  private manifest: WorldManifest | null = null;
  private pending = 0;
  /** Counts the views the layer joined and left: a bake asked for in an earlier one is dropped when it arrives. */
  private generation = 0;
  /** Milliseconds spent in the last frame: simulation, and turning poses into sprites. */
  simMs = 0;
  drawMs = 0;
  /** The vehicles drawn in the last frame (empty while the layer is off). */
  drawn: DrawnVehicle[] = [];

  constructor(private readonly opts: TrafficLayerOptions = {}) {
    this.on = opts.enabled ?? true;
    this.hold = opts.paused ?? false;
    this.shown = new Set(opts.sublayers ?? TRAFFIC_SUBLAYERS);
  }

  /** The simulation (once the layer has joined a view). */
  get sim(): TrafficSim {
    if (!this.simulation) throw new Error("the traffic layer hasn't joined a view");
    return this.simulation;
  }

  get enabled(): boolean {
    return this.on;
  }

  get paused(): boolean {
    return this.hold;
  }

  async init(ctx: LayerContext): Promise<boolean> {
    const w = ctx.view.world;
    const net =
      this.opts.routes ??
      (await loadRoutes(w.url, w.manifest).catch((e: unknown) => {
        console.warn("routes:", e);
        return null;
      }));
    if (!net) return false;
    // a layer may join one view after another (a level switch): start this one's state afresh
    this.leave();
    this.models.clear(); // another world's style may draw its vehicles differently
    this.ctx = ctx;
    this.net = net;
    this.manifest = w.manifest;
    this.renderScale = w.renderScale;
    this.ramp = rampLookup(w.palette.rampIds);
    this.assets = w.style.assets;
    this.rampIds = w.palette.rampIds;
    this.simulation = this.newSim();
    // start around the camera, then as far along as asked
    this.focus(ctx.frame());
    this.runTicks(this.opts.time ?? 0);
    return true;
  }

  private newSim(state?: SimState): TrafficSim {
    const m = this.manifest;
    if (!m || !this.net) throw new Error("the traffic layer hasn't joined a view");
    return new TrafficSim(
      this.net,
      {
        seed: this.opts.seed ?? 1,
        metersPerCell: m.scale.metersPerCell,
        level: m.level,
        density: this.opts.density ?? 1,
        heightStretch: m.depiction?.heightStretch,
        vehicleScale: m.depiction?.vehicleScale,
      },
      state,
    );
  }

  setEnabled(on: boolean): void {
    this.on = on;
    if (!on) this.drawn = [];
    this.ctx?.invalidate();
  }

  setPaused(paused: boolean): void {
    this.hold = paused;
    this.ctx?.invalidate();
  }

  isSublayerEnabled(id: string): boolean {
    return this.shown.has(id as TrafficSublayer);
  }

  setSublayerEnabled(id: string, on: boolean): void {
    if (!(TRAFFIC_SUBLAYERS as readonly string[]).includes(id)) throw new Error(`no traffic sublayer ${id}`);
    if (on) this.shown.add(id as TrafficSublayer);
    else this.shown.delete(id as TrafficSublayer);
    this.ctx?.invalidate();
  }

  /** Show exactly these sublayers, in this order. */
  setSublayers(ids: readonly TrafficSublayer[]): void {
    this.shown.clear();
    for (const l of ids) this.shown.add(l);
    this.ctx?.invalidate();
  }

  /** Keep traffic around the view: a circle (cells) covering it with a margin. */
  private focus(frame: FrameInfo): void {
    const rs = this.renderScale;
    // a cell is 22.6 px across the screen along one diagonal and 11.3 px along the other
    const r = Math.hypot(frame.view.width / 22.6, frame.view.height / 11.3) / 2 / rs;
    this.sim.setFocus(frame.focus.x, frame.focus.y, r + 4);
  }

  update(dt: number, frame: FrameInfo): boolean {
    this.focus(frame);
    if (this.hold) return false;
    const t0 = performance.now();
    const n = this.sim.advance(dt);
    this.simMs = performance.now() - t0;
    return n > 0 && this.sim.vehicles.length > 0;
  }

  private runTicks(seconds: number): void {
    const n = Math.round(seconds / TICK);
    for (let i = 0; i < n; i++) this.sim.tick();
  }

  /** Run whole ticks at once around the view (seconds of play): tests, a fixed simulation time. */
  step(seconds: number): void {
    if (this.ctx) this.focus(this.ctx.frame());
    this.runTicks(seconds);
    this.ctx?.invalidate();
  }

  /** A consist's cars as models: the head, then up to four kinds of wagon. */
  private static partKey(part: number): number {
    return part === 0 ? 0 : 1 + ((part - 1) % 4);
  }

  private key(p: Pose, heading: number): string {
    return `${p.kind}/${p.variant}/${TrafficLayer.partKey(p.part)}/${heading}`;
  }

  /** The boxes of one vehicle model at one heading (render units). */
  private boxes(kind: VehicleKind, variant: number, part: number, heading: number): Box[] {
    const rs = this.renderScale;
    const angle = (heading * 2 * Math.PI) / HEADINGS;
    const { assets, rampIds } = this;
    const group = `vehicle.${kind}`;
    if (assets && rampIds && resolveAsset(assets, group)) {
      const id = `${kind}/${variant}/${part}`;
      let model = this.models.get(id);
      if (!model) {
        model = generateModel(assets, rampIds, group, {
          seed: seedOf(id),
          size: vehicleVoxels(kind, this.sim.scale, rs),
          part,
          variant,
        });
        this.models.set(id, model);
      }
      return modelBoxes(model, VOXEL, angle);
    }
    return vehicleBoxes(kind, variant, part, angle, this.sim.scale, this.ramp).map((b) =>
      rs === 1 ? b : { ...b, x0: b.x0 * rs, x1: b.x1 * rs, y0: b.y0 * rs, y1: b.y1 * rs, z0: b.z0 * rs, z1: b.z1 * rs },
    );
  }

  private request(key: string, kind: VehicleKind, variant: number, part: number, heading: number): void {
    const ctx = this.ctx;
    if (this.baked.has(key) || !ctx) return;
    this.baked.set(key, null);
    this.pending++;
    const generation = this.generation;
    void ctx.bakeSprite(0, this.boxes(kind, variant, part, heading)).then((img) => {
      if (generation !== this.generation) {
        // the layer left that view meanwhile: its sprite goes back to it, and counts for nothing here
        if (img) ctx.releaseSprite(img);
        return;
      }
      this.pending--;
      this.baked.set(key, img ?? false); // a failed bake isn't asked for again, nor waited for
    });
  }

  /** Sprites for this frame's vehicles; `complete` is false while some are still baking. */
  sprites(frame: FrameInfo): { list: SpriteDraw[]; complete: boolean } {
    const rotation = frame.rotation;
    const list: SpriteDraw[] = [];
    this.drawn = [];
    const t0 = performance.now();
    let complete = true;
    for (const p of this.sim.poses(this.hold ? 1 : this.sim.alpha)) {
      if (!this.shown.has(SUBLAYER_OF[p.kind])) continue;
      // heading in this view, as a heading in rotation 0
      const k = Math.round((p.heading / (2 * Math.PI)) * HEADINGS);
      const heading = (((k + (HEADINGS / 4) * rotation) % HEADINGS) + HEADINGS) % HEADINGS;
      const key = this.key(p, heading);
      this.request(key, p.kind, p.variant, TrafficLayer.partKey(p.part), heading);
      const sprite = this.baked.get(key);
      // its bake failed; or the ground under it is still baking: it would float over the void
      if (sprite === false || !frame.isDrawn(p.x, p.y)) continue;
      const s = frame.project(p.x, p.y, p.h + LIFT);
      this.drawn.push({ ...p, sx: s.sx, sy: s.sy, depth: s.depth });
      if (!sprite) {
        complete = false;
        continue;
      }
      list.push({ sprite, sx: Math.round(s.sx), sy: Math.round(s.sy), depth: s.depth, silhouette: false });
    }
    this.drawMs = performance.now() - t0;
    return { list, complete: complete && this.pending === 0 };
  }

  /** Vehicle sprites baked or baking. */
  get spriteCount(): number {
    return this.baked.size;
  }

  /**
   * The vehicles' cars within a radius of a place (cells), where they are
   * drawn: for a game's collisions. Hidden sublayers and a switched-off layer
   * have none (what can't be seen can't be hit).
   */
  vehiclesNear(x: number, y: number, radius: number): NearbyVehicle[] {
    if (!this.on || !this.simulation) return [];
    const out: NearbyVehicle[] = [];
    const sizes = new Map<VehicleKind, { length: number; width: number }>();
    for (const p of this.sim.poses(this.hold ? 1 : this.sim.alpha)) {
      if (!this.shown.has(SUBLAYER_OF[p.kind])) continue;
      if (Math.hypot(p.x - x, p.y - y) > radius) continue;
      let size = sizes.get(p.kind);
      if (!size) {
        const m = modelSize(p.kind, this.sim.scale);
        sizes.set(p.kind, (size = { length: m.length, width: m.width }));
      }
      out.push({ ...p, ...size });
    }
    return out;
  }

  /**
   * Leave the view: let go of the vehicle sprites and forget bakes still in
   * flight. The simulation and the switches stay (`serialize` still works),
   * and the layer may join another view (`init`), as at a level switch.
   */
  dispose(): void {
    this.leave();
    this.ctx = null;
  }

  /** Drop the state that belongs to the current view. */
  private leave(): void {
    this.generation++;
    for (const s of this.baked.values()) if (s) this.ctx?.releaseSprite(s);
    this.baked.clear();
    this.pending = 0;
    this.drawn = [];
  }

  serialize(): TrafficLayerState {
    return { enabled: this.on, paused: this.hold, sublayers: [...this.shown], sim: this.sim.serialize() };
  }

  restore(state: unknown): void {
    const s = state as TrafficLayerState;
    this.on = s.enabled;
    this.hold = s.paused;
    this.setSublayers(s.sublayers);
    this.simulation = this.newSim(s.sim);
    this.ctx?.invalidate();
  }
}

/** Ambient traffic along the world package's routes (D-060). */
export function trafficLayer(opts: TrafficLayerOptions = {}): TrafficLayer {
  return new TrafficLayer(opts);
}
