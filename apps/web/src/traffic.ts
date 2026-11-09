import { generateModel, modelBoxes, resolveAsset, type AssetCatalog, type Box, type VoxelModel } from "@pixelworld/generators";
import { project, type Rotation } from "@pixelworld/grid";
import type { BakeService, Compositor, GpuImage, SpriteInstance } from "@pixelworld/runtime";
import {
  RouteNetwork,
  TICK,
  TrafficSim,
  parseRoutes,
  vehicleBoxes,
  vehicleVoxels,
  type Pose,
  type RampLookup,
  type VehicleKind,
} from "@pixelworld/sim";
import { maybeGunzip, type WorldManifest } from "@pixelworld/world-format";

/**
 * Ambient traffic in the viewer (D-060): runs the simulation from the frame
 * loop and draws its vehicles as depth-tested sprites.
 *
 * Sprites are baked through the bake service like the rover's, once per
 * vehicle model and heading, in view rotation 0 only: a model turned by θ
 * seen in rotation r is the model turned by θ + r·90° seen in rotation 0
 * (rotateXY), and lighting is view-relative, so 16 headings in one rotation
 * serve all four.
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

export async function loadRoutes(worldUrl: string, manifest: WorldManifest): Promise<RouteNetwork | null> {
  if (!manifest.routes) return null;
  const base = worldUrl.endsWith("/") ? worldUrl : worldUrl + "/";
  const res = await fetch(base + manifest.routes.path);
  if (!res.ok) throw new Error(`${manifest.routes.path}: HTTP ${res.status}`);
  const bytes = await maybeGunzip(await res.arrayBuffer());
  return new RouteNetwork(parseRoutes(JSON.parse(new TextDecoder().decode(bytes))));
}

export interface TrafficOptions {
  seed: number;
  /** Render units per cell (manifest render.scale). */
  renderScale: number;
  ramp: RampLookup;
  density?: number;
  /** The style pack's assets and palette ramp ids, for its `vehicle.*` models. */
  assets?: AssetCatalog;
  rampIds?: Map<string, number>;
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

export class TrafficLayer {
  readonly sim: TrafficSim;
  enabled = true;
  paused = false;
  /** Sublayers drawn; the simulation runs them all, so toggling one changes nothing else. */
  readonly layers = new Set<TrafficSublayer>(TRAFFIC_SUBLAYERS);
  private readonly sprites = new Map<string, GpuImage | null>();
  private readonly models = new Map<string, VoxelModel>();
  private pending = 0;
  /** Milliseconds spent this frame: simulation, and turning poses into sprites. */
  simMs = 0;
  drawMs = 0;
  drawn: DrawnVehicle[] = [];

  constructor(
    net: RouteNetwork,
    manifest: WorldManifest,
    private readonly service: BakeService,
    private readonly compositor: Compositor,
    private readonly opts: TrafficOptions,
    private readonly onSprite: () => void,
  ) {
    this.sim = new TrafficSim(net, {
      seed: opts.seed,
      metersPerCell: manifest.scale.metersPerCell,
      level: manifest.level,
      density: opts.density,
      heightStretch: manifest.depiction?.heightStretch,
      vehicleScale: manifest.depiction?.vehicleScale,
    });
  }

  /** Keep traffic around the view: a circle (cells) covering it with a margin. */
  focus(x: number, y: number, internalWidth: number, internalHeight: number, zoomOut = 1): void {
    const rs = this.opts.renderScale;
    // a cell is 22.6 px across the screen along one diagonal and 11.3 px along the other
    const r = Math.hypot(internalWidth / 22.6, internalHeight / 11.3) / 2 / rs;
    this.sim.setFocus(x, y, (r + 4) * zoomOut);
  }

  /** Advance by a frame's time (unless paused); true when anything may have moved. */
  update(dt: number): boolean {
    if (!this.enabled || this.paused) return false;
    const t0 = performance.now();
    const n = this.sim.advance(dt);
    this.simMs = performance.now() - t0;
    return n > 0 && this.sim.vehicles.length > 0;
  }

  /** Run whole ticks at once (tests, a fixed simulation time). */
  step(seconds: number): void {
    const n = Math.round(seconds / TICK);
    for (let i = 0; i < n; i++) this.sim.tick();
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
    const rs = this.opts.renderScale;
    const angle = (heading * 2 * Math.PI) / HEADINGS;
    const { assets, rampIds } = this.opts;
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
    return vehicleBoxes(kind, variant, part, angle, this.sim.scale, this.opts.ramp).map((b) =>
      rs === 1 ? b : { ...b, x0: b.x0 * rs, x1: b.x1 * rs, y0: b.y0 * rs, y1: b.y1 * rs, z0: b.z0 * rs, z1: b.z1 * rs },
    );
  }

  private request(key: string, kind: VehicleKind, variant: number, part: number, heading: number): void {
    if (this.sprites.has(key)) return;
    this.sprites.set(key, null);
    this.pending++;
    void this.service.bakeSprite(0, this.boxes(kind, variant, part, heading)).then((img) => {
      this.pending--;
      if (img) this.sprites.set(key, this.compositor.upload(img));
      this.onSprite();
    });
  }

  /** Sprites for this frame's vehicles; `complete` is false while some are still baking. */
  instances(rotation: Rotation): { list: SpriteInstance[]; complete: boolean } {
    const list: SpriteInstance[] = [];
    this.drawn = [];
    if (!this.enabled) return { list, complete: true };
    const t0 = performance.now();
    const rs = this.opts.renderScale;
    let complete = true;
    for (const p of this.sim.poses(this.paused ? 1 : this.sim.alpha)) {
      if (!this.layers.has(SUBLAYER_OF[p.kind])) continue;
      // heading in this view, as a heading in rotation 0
      const k = Math.round((p.heading / (2 * Math.PI)) * HEADINGS);
      const heading = (((k + (HEADINGS / 4) * rotation) % HEADINGS) + HEADINGS) % HEADINGS;
      const key = this.key(p, heading);
      this.request(key, p.kind, p.variant, TrafficLayer.partKey(p.part), heading);
      const sprite = this.sprites.get(key);
      const s = project(p.x * rs, p.y * rs, (p.h + LIFT) * rs, rotation);
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

  get spriteCount(): number {
    return this.sprites.size;
  }
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
