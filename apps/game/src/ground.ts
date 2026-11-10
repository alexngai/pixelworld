import type { ObjectHit, RoadInfo, SurfaceInfo } from "@pixelworlds/engine";
import type { NearbyVehicle, RouteNetwork } from "@pixelworlds/sim";
import { boxesOverlap, type CarBody, type CarWorld } from "./car";
import { roadUnder, segmentDistance } from "./roads";
import { OFFROAD_SPEED, ROAD_SPEED, ROAD_SPEED_DEFAULT, SURFACE_FACTOR, SURFACE_FACTOR_DEFAULT } from "./tuning";

/**
 * The world as the car and the plane see it, read through the engine's
 * public queries: ground heights, bridge decks (from the traffic routes),
 * surfaces and roads for top speeds, placed objects and traffic for
 * collisions.
 */

/** The queries the game reads (a `WorldQuery` has them all). */
export interface GameQuery {
  heightAt(x: number, y: number): number | null;
  surfaceAt(x: number, y: number): SurfaceInfo | null;
  roadAt(x: number, y: number): RoadInfo | null;
  objectsAt(x: number, y: number): ObjectHit[];
}

/** Something with traffic in it (the traffic layer). */
export interface TrafficSource {
  vehiclesNear(x: number, y: number, radius: number): NearbyVehicle[];
}

/**
 * Buildings don't stop a car within this many cells of a road's asphalt:
 * driving levels draw roads wider than real (D-049), and buildings stand over
 * their edges, or over a whole cell a one-cell jog of the road crosses.
 */
export const BUILDING_ROAD_MARGIN = 0.35;

/** Whether a placed object stops a car: buildings and landmarks, except bridges (their decks are driven on). */
export function blocksCar(o: ObjectHit): boolean {
  if (o.group.startsWith("landmark.bridge")) return false;
  return o.group.startsWith("building.") || o.group.startsWith("landmark.");
}

/** A road's top speed (cells/s at pace 1). */
export function roadSpeed(cls: string | null): number {
  return (cls && ROAD_SPEED[cls]) || ROAD_SPEED_DEFAULT;
}

/** Off-road top speed on a surface (cells/s at pace 1). */
export function surfaceSpeed(name: string): number {
  return OFFROAD_SPEED * (SURFACE_FACTOR[name] ?? SURFACE_FACTOR_DEFAULT);
}

/** A point on a road's surface or a bridge deck. */
export interface DeckHit {
  h: number;
  cls: string;
  /** A deck, over whatever is under it (else a road on the ground). */
  deck: boolean;
}

/** A straight piece of road surface: from (ax, ay, ah) to (bx, by, bh), driven within `reach` cells of its line. */
interface DeckSegment {
  ax: number;
  ay: number;
  ah: number;
  bx: number;
  by: number;
  bh: number;
  reach: number;
  cls: string;
  /** A deck (or a join across a gap): over whatever is under it. */
  deck: boolean;
}

const DECK_BUCKET = 8;

/**
 * The roads' surfaces for the car, from traffic's routes (D-060): every
 * vertex carries the drawn surface's height, or a bridge deck's, so a route
 * is the road's graded profile, the one traffic drives. A car on a road rides
 * it; the micro-terrain beside a road cut into a slope, or a dip where a
 * deck meets the land, doesn't stop it.
 *
 * - **Decks:** routes marked `deck`, at their own height over water and
 *   canyons; and joins across the road network's gaps, where two routes' ends
 *   stop a cell or two apart at about one height (a deck's routes stopping
 *   short of each other, a road cut by a river's water). The road-route
 *   planner joins the same gaps (route.ts), so the car can drive what it plans.
 * - **Heights:** a surface counts only near the car's height (from 1.5 steps
 *   below to 1 above): a car on a bridge or an overpass, not one under it.
 */
export class Decks {
  private readonly buckets = new Map<number, DeckSegment[]>();
  private segments = 0;

  constructor(net: RouteNetwork | null, opts: { margin?: number; roadMargin?: number; gap?: number } = {}) {
    const margin = opts.margin ?? 0.45;
    const roadMargin = opts.roadMargin ?? 0.25;
    const gap = opts.gap ?? 2.5;
    const ends: { x: number; y: number; h: number; route: number; cls: string; width: number }[] = [];
    for (const r of net?.routes ?? []) {
      if (r.net !== "road") continue;
      const n = r.pts.length;
      ends.push({ x: r.pts[0]!, y: r.pts[1]!, h: r.pts[2]!, route: r.id, cls: r.cls, width: r.width });
      ends.push({ x: r.pts[n - 3]!, y: r.pts[n - 2]!, h: r.pts[n - 1]!, route: r.id, cls: r.cls, width: r.width });
      // a deck is driven a little wider than its line (its abutments); a road on its asphalt
      const reach = r.deck ? Math.max(r.width, 0.35) + margin : Math.max(r.width, 0.125) + roadMargin;
      for (let i = 0; i + 5 < n; i += 3)
        this.add(r.pts[i]!, r.pts[i + 1]!, r.pts[i + 2]!, r.pts[i + 3]!, r.pts[i + 4]!, r.pts[i + 5]!, reach, r.cls, r.deck);
    }
    // joins across gaps, found through a grid of the ends
    const grid = new Map<string, number[]>();
    const key = (x: number, y: number) => `${Math.floor(x / gap)},${Math.floor(y / gap)}`;
    ends.forEach((e, i) => {
      const k = key(e.x, e.y);
      const list = grid.get(k);
      if (list) list.push(i);
      else grid.set(k, [i]);
    });
    ends.forEach((a, i) => {
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++)
          for (const j of grid.get(`${Math.floor(a.x / gap) + di},${Math.floor(a.y / gap) + dj}`) ?? []) {
            const b = ends[j]!;
            if (j <= i || a.route === b.route) continue;
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            // ends at one node are joined already; far or at other heights, they aren't one road
            if (d < 0.5 || d > gap || Math.abs(a.h - b.h) > 1) continue;
            this.add(a.x, a.y, a.h, b.x, b.y, b.h, Math.max(a.width, b.width, 0.35) + margin, a.cls, true);
          }
    });
  }

  private add(ax: number, ay: number, ah: number, bx: number, by: number, bh: number, reach: number, cls: string, deck: boolean): void {
    const seg: DeckSegment = { ax, ay, ah, bx, by, bh, reach, cls: cls || "road", deck };
    this.segments++;
    const x0 = Math.floor((Math.min(ax, bx) - reach) / DECK_BUCKET);
    const x1 = Math.floor((Math.max(ax, bx) + reach) / DECK_BUCKET);
    const y0 = Math.floor((Math.min(ay, by) - reach) / DECK_BUCKET);
    const y1 = Math.floor((Math.max(ay, by) + reach) / DECK_BUCKET);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const k = (y + 1024) * 4096 + (x + 1024);
        const list = this.buckets.get(k);
        if (list) list.push(seg);
        else this.buckets.set(k, [seg]);
      }
  }

  /** Surface segments known. */
  get count(): number {
    return this.segments;
  }

  /**
   * The road or deck under a point within its reach, whose height there is
   * near `h` (from 1.5 steps below to 1 above): a car on the bridge, not one
   * in the canyon under it. The nearest line wins.
   */
  at(x: number, y: number, h: number): DeckHit | null {
    const list = this.buckets.get((Math.floor(y / DECK_BUCKET) + 1024) * 4096 + (Math.floor(x / DECK_BUCKET) + 1024));
    if (!list) return null;
    let best: DeckHit | null = null;
    let bestD = Infinity;
    for (const s of list) {
      const d = segmentDistance(x, y, s.ax, s.ay, s.bx, s.by);
      if (d > s.reach || d >= bestD) continue;
      const len2 = (s.bx - s.ax) ** 2 + (s.by - s.ay) ** 2;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - s.ax) * (s.bx - s.ax) + (y - s.ay) * (s.by - s.ay)) / len2)) : 0;
      const dh = s.ah + (s.bh - s.ah) * t;
      if (dh < h - 1.5 || dh > h + 1) continue;
      best = { h: dh, cls: s.cls, deck: s.deck };
      bestD = d;
    }
    return best;
  }
}

/** The world for the car: a `CarWorld` over the view's queries. */
export class DriveWorld implements CarWorld {
  /** Vehicles hit in the last test (for the HUD and tests). */
  lastHit: string | null = null;

  constructor(
    private readonly q: GameQuery,
    readonly cellsX: number,
    readonly cellsY: number,
    private readonly decks: Decks,
    private readonly traffic: () => TrafficSource | null,
  ) {}

  /**
   * The road surface or bridge deck at a point near the car's height: a
   * route's (traffic's), else a bridge landmark's footprint at its deck height
   * (its top), which also spans the gaps between a bridge's deck routes.
   */
  deckAt(x: number, y: number, h: number): DeckHit | null {
    const deck = this.decks.at(x, y, h);
    if (deck) return deck;
    for (const o of this.q.objectsAt(x, y))
      if (o.group.startsWith("landmark.bridge") && o.top !== null && o.top >= h - 1.5 && o.top <= h + 1) return { h: o.top, cls: "bridge", deck: true };
    return null;
  }

  /** The height to drive on: a road's graded surface, a deck over what is under it, else the drawn ground. */
  groundAt(x: number, y: number, h: number): number | null {
    const g = this.q.heightAt(x, y);
    if (g === null) return null;
    const s = this.deckAt(x, y, h);
    if (!s) return g;
    return s.deck ? Math.max(g, s.h) : s.h;
  }

  onRoad(x: number, y: number, h: number): boolean {
    return this.roadClassAt(x, y, h) !== null;
  }

  /** The road the car is on at a point, if any: a drawn road's asphalt, or a deck. */
  roadClassAt(x: number, y: number, h: number): string | null {
    const deck = this.deckAt(x, y, h);
    if (deck && (!deck.deck || deck.h >= (this.q.heightAt(x, y) ?? -Infinity) - 0.05)) return deck.cls;
    const road = roadUnder(this.q, x, y, 0.25);
    return road ? (road.class ?? "road") : null;
  }

  topSpeedAt(x: number, y: number, h: number): number {
    const deck = this.deckAt(x, y, h);
    const ground = this.q.heightAt(x, y);
    if (deck && ground !== null && (!deck.deck || deck.h >= ground - 0.05)) return roadSpeed(deck.cls);
    const surface = this.q.surfaceAt(x, y);
    if (!surface) return 0;
    // a road's asphalt over a narrow channel is still road (the drawn network breaks at water, D-060)
    const road = roadUnder(this.q, x, y, 0.25);
    if (road) return roadSpeed(road.class);
    if (surface.waterLevel !== null && ground !== null && surface.waterLevel >= ground) return 0;
    return surfaceSpeed(surface.name);
  }

  obstacle(body: CarBody): string | null {
    const c = Math.cos(body.heading);
    const s = Math.sin(body.heading);
    const half = body.length / 2;
    const side = body.width / 2;
    // buildings: the leading end's middle and corners, unless that point is on a road's asphalt
    // (driving levels draw roads wider than real, and buildings stand over their edges)
    for (const w of [0, -1, 1]) {
      const px = body.x + c * half * body.dir - s * side * w;
      const py = body.y + s * half * body.dir + c * side * w;
      const hit = this.q.objectsAt(px, py).find(blocksCar);
      if (hit && !roadUnder(this.q, px, py, BUILDING_ROAD_MARGIN)) {
        this.lastHit = hit.id ?? hit.group;
        return "building";
      }
    }
    // traffic: a vehicle the moved car overlaps, ahead of it
    const t = this.traffic();
    if (t) {
      for (const v of t.vehiclesNear(body.x, body.y, body.length + 2)) {
        if (!boxesOverlap(body, v)) continue;
        const ahead = (v.x - body.x) * c * body.dir + (v.y - body.y) * s * body.dir;
        if (ahead <= 0) continue; // it ran into us from behind: let the car pull away
        this.lastHit = v.kind;
        return "vehicle";
      }
    }
    return null;
  }
}

/** What the plane flies over. */
export interface PlaneWorld {
  readonly cellsX: number;
  readonly cellsY: number;
  /** The top of what is drawn (steps): the ground, or water over it; null where nothing is loaded. */
  groundAt(x: number, y: number): number | null;
  /** The top of the tallest object at a point with a known height (towers), or null. */
  objectTopAt(x: number, y: number): number | null;
}

export class FlyWorld implements PlaneWorld {
  constructor(
    private readonly q: GameQuery,
    readonly cellsX: number,
    readonly cellsY: number,
  ) {}

  groundAt(x: number, y: number): number | null {
    const g = this.q.heightAt(x, y);
    if (g === null) return null;
    const w = this.q.surfaceAt(x, y)?.waterLevel ?? null;
    return w === null ? g : Math.max(g, w);
  }

  objectTopAt(x: number, y: number): number | null {
    let top: number | null = null;
    for (const o of this.q.objectsAt(x, y)) if (o.top !== null && !o.group.startsWith("landmark.bridge")) top = Math.max(top ?? -Infinity, o.top);
    return top;
  }
}
