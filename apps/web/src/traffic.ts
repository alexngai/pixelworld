import { project, type Rotation } from "@pixelworld/grid";
import type { BakeService, Compositor, GpuImage, SpriteInstance } from "@pixelworld/runtime";
import {
  RouteNetwork,
  TICK,
  TrafficSim,
  parseRoutes,
  vehicleBoxes,
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
 */

export const HEADINGS = 16;
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
  private readonly sprites = new Map<string, GpuImage | null>();
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

  private key(p: Pose, heading: number): string {
    const part = p.part === 0 ? 0 : 1 + (p.part % 2);
    return `${p.kind}/${p.variant}/${part}/${heading}`;
  }

  private request(key: string, kind: VehicleKind, variant: number, part: number, heading: number): void {
    if (this.sprites.has(key)) return;
    this.sprites.set(key, null);
    this.pending++;
    const rs = this.opts.renderScale;
    const angle = (heading * 2 * Math.PI) / HEADINGS;
    const boxes = vehicleBoxes(kind, variant, part, angle, this.sim.scale, this.opts.ramp).map((b) =>
      rs === 1 ? b : { ...b, x0: b.x0 * rs, x1: b.x1 * rs, y0: b.y0 * rs, y1: b.y1 * rs, z0: b.z0 * rs, z1: b.z1 * rs },
    );
    void this.service.bakeSprite(0, boxes).then((img) => {
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
      // heading in this view, as a heading in rotation 0
      const k = Math.round((p.heading / (2 * Math.PI)) * HEADINGS);
      const heading = (((k + (HEADINGS / 4) * rotation) % HEADINGS) + HEADINGS) % HEADINGS;
      const key = this.key(p, heading);
      this.request(key, p.kind, p.variant, p.part, heading);
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
