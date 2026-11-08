/**
 * Routes file (`routes.json.gz`, D-060): polylines in cell coordinates that
 * ambient traffic follows, with a height in steps at every vertex, and the
 * junction nodes they meet at. See docs/world-format.md.
 */

export const ROUTES_VERSION = 1;

export type RouteNet = "road" | "rail" | "ferry";

export interface RouteJson {
  net: RouteNet;
  /** Road class name (roads). */
  cls?: string;
  /** Vehicle kind (rail and ferries): cablecar, streetcar, lightrail, train, ferry. */
  kind?: string;
  /** Junction nodes at the first and last vertex (absent on ferry lines). */
  a?: number;
  b?: number;
  /** x, y, h per vertex: cells, cells, steps. */
  pts: number[];
  /** Road half-width in cells, where the package has real widths. */
  w?: number;
  /** Some vertices are on a bridge deck. */
  deck?: boolean;
  /** The bridge landmark this route crosses on its deck. */
  bridge?: string;
  name?: string;
}

export interface RoutesFile {
  version: typeof ROUTES_VERSION;
  nodes: [number, number, number][];
  routes: RouteJson[];
}

export function parseRoutes(json: unknown): RoutesFile {
  const doc = json as Partial<RoutesFile>;
  if (!doc || doc.version !== ROUTES_VERSION) throw new Error(`routes: unsupported version ${String(doc?.version)}`);
  if (!Array.isArray(doc.nodes) || !Array.isArray(doc.routes)) throw new Error("routes: nodes and routes are required");
  for (const r of doc.routes) {
    if (!Array.isArray(r.pts) || r.pts.length < 6 || r.pts.length % 3 !== 0)
      throw new Error("routes: a route needs at least two x, y, h vertices");
  }
  return doc as RoutesFile;
}

export interface Route {
  id: number;
  net: RouteNet;
  cls: string;
  kind: string;
  /** Junction nodes at the start and end; −1 when there is none. */
  a: number;
  b: number;
  /** x, y, h per vertex. */
  pts: Float64Array;
  /** Distance along the route (cells, in plan) at each vertex. */
  cum: Float64Array;
  length: number;
  width: number;
  deck: boolean;
}

export interface RoutePoint {
  x: number;
  y: number;
  h: number;
}

/** A stretch of one route inside one bucket of the spatial index. */
export interface RouteSpan {
  route: number;
  s0: number;
  s1: number;
  /** A point in the middle of the stretch. */
  x: number;
  y: number;
}

const BUCKET = 16; // cells per spatial-index bucket

/** Routes with lookups: points along a route, routes at a node, routes near a place. */
export class RouteNetwork {
  readonly routes: Route[];
  readonly nodes: [number, number, number][];
  /** Route ids that start or end at each node. */
  readonly nodeRoutes: number[][];
  private readonly buckets = new Map<number, RouteSpan[]>();

  constructor(file: RoutesFile) {
    this.nodes = file.nodes;
    this.nodeRoutes = file.nodes.map(() => []);
    this.routes = file.routes.map((r, id) => {
      const pts = Float64Array.from(r.pts);
      const n = pts.length / 3;
      const cum = new Float64Array(n);
      for (let i = 1; i < n; i++)
        cum[i] = cum[i - 1]! + Math.hypot(pts[3 * i]! - pts[3 * i - 3]!, pts[3 * i + 1]! - pts[3 * i - 2]!);
      return {
        id,
        net: r.net,
        cls: r.cls ?? "",
        kind: r.kind ?? "",
        a: r.a ?? -1,
        b: r.b ?? -1,
        pts,
        cum,
        length: cum[n - 1]!,
        width: r.w ?? 0,
        deck: !!r.deck,
      };
    });
    for (const r of this.routes) {
      if (r.a >= 0) this.nodeRoutes[r.a]?.push(r.id);
      if (r.b >= 0 && r.b !== r.a) this.nodeRoutes[r.b]?.push(r.id);
      this.index(r);
    }
  }

  private key(bx: number, by: number): number {
    return (by + 4096) * 8192 + (bx + 4096);
  }

  private index(r: Route): void {
    const n = r.pts.length / 3;
    let cur: RouteSpan | null = null;
    let curKey = 0;
    const mine: RouteSpan[] = [];
    for (let i = 0; i < n - 1; i++) {
      // long segments are cut at about a bucket's length
      const len = r.cum[i + 1]! - r.cum[i]!;
      const parts = Math.max(1, Math.ceil(len / (BUCKET / 2)));
      for (let k = 0; k < parts; k++) {
        const s0 = r.cum[i]! + (len * k) / parts;
        const s1 = r.cum[i]! + (len * (k + 1)) / parts;
        const p = this.at(r, (s0 + s1) / 2);
        const key = this.key(Math.floor(p.x / BUCKET), Math.floor(p.y / BUCKET));
        if (cur && key === curKey) {
          cur.s1 = s1;
          continue;
        }
        cur = { route: r.id, s0, s1, x: p.x, y: p.y };
        curKey = key;
        mine.push(cur);
        let list = this.buckets.get(key);
        if (!list) this.buckets.set(key, (list = []));
        list.push(cur);
      }
    }
    // a stretch's point: its middle
    for (const span of mine) {
      const p = this.at(r, (span.s0 + span.s1) / 2);
      span.x = p.x;
      span.y = p.y;
    }
  }

  /** Point at distance s along a route (clamped to its ends). */
  at(r: Route, s: number): RoutePoint {
    const { pts, cum } = r;
    const n = cum.length;
    if (s <= 0) return { x: pts[0]!, y: pts[1]!, h: pts[2]! };
    if (s >= r.length) return { x: pts[3 * n - 3]!, y: pts[3 * n - 2]!, h: pts[3 * n - 1]! };
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! <= s) lo = mid;
      else hi = mid;
    }
    const seg = cum[hi]! - cum[lo]!;
    const t = seg > 0 ? (s - cum[lo]!) / seg : 0;
    const i = 3 * lo;
    return {
      x: pts[i]! + (pts[i + 3]! - pts[i]!) * t,
      y: pts[i + 1]! + (pts[i + 4]! - pts[i + 1]!) * t,
      h: pts[i + 2]! + (pts[i + 5]! - pts[i + 2]!) * t,
    };
  }

  /** Direction of travel (radians, x east, y south) leaving a route's end. */
  endHeading(r: Route, atStart: boolean): number {
    const p = r.pts;
    const n = p.length / 3;
    if (atStart) return Math.atan2(p[4]! - p[1]!, p[3]! - p[0]!);
    return Math.atan2(p[3 * n - 2]! - p[3 * n - 5]!, p[3 * n - 3]! - p[3 * n - 6]!);
  }

  /** Stretches of routes in the buckets overlapping a circle. */
  spansNear(x: number, y: number, radius: number): RouteSpan[] {
    const out: RouteSpan[] = [];
    const bx0 = Math.floor((x - radius) / BUCKET);
    const bx1 = Math.floor((x + radius) / BUCKET);
    const by0 = Math.floor((y - radius) / BUCKET);
    const by1 = Math.floor((y + radius) / BUCKET);
    for (let by = by0; by <= by1; by++)
      for (let bx = bx0; bx <= bx1; bx++) {
        const list = this.buckets.get(this.key(bx, by));
        if (list) for (const s of list) if (Math.hypot(s.x - x, s.y - y) <= radius) out.push(s);
      }
    return out;
  }
}
