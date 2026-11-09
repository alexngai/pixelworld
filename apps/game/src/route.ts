import type { RouteNetwork } from "@pixelworld/sim";
import type { Point } from "./roads";

/**
 * Road routes for the scripted run, planned on the traffic routes (D-060):
 * polylines through the drawn road cells, joined at junction nodes.
 *
 * The routes graph has small gaps where the drawn network is whole: a
 * divided road's carriageways meeting diagonally, a bridge deck's route
 * ending a cell or two short of the road beyond. Nodes closer than `gap`
 * cells are joined, so a plan crosses them as the car would.
 */

export interface PlannedRoute {
  points: Point[];
  /** Length in cells. */
  length: number;
  /** Cells by road class along it ("gap" for the joins). */
  byClass: Record<string, number>;
}

/** Cells of route a step of height across a gap join costs. */
const GAP_CLIMB_COST = 4;

interface Edge {
  to: number;
  len: number;
  /** The route, or −1 for a gap join. */
  route: number;
}

/** A graph over the routes' junction nodes, for one network ("road" by default). */
export class RoadGraph {
  private readonly adj = new Map<number, Edge[]>();

  constructor(
    readonly net: RouteNetwork,
    gap = 2.5,
    readonly kind: "road" | "rail" | "ferry" = "road",
  ) {
    const add = (a: number, e: Edge) => {
      let list = this.adj.get(a);
      if (!list) this.adj.set(a, (list = []));
      list.push(e);
    };
    // the heights routes arrive at each node with (a deck's end is at deck height, the node at the ground's)
    const ends = new Map<number, number[]>();
    const end = (n: number, h: number) => {
      let list = ends.get(n);
      if (!list) ends.set(n, (list = []));
      list.push(h);
    };
    for (const r of net.routes) {
      if (r.net !== kind || r.a < 0 || r.b < 0) continue;
      add(r.a, { to: r.b, len: r.length, route: r.id });
      add(r.b, { to: r.a, len: r.length, route: r.id });
      end(r.a, r.pts[2]!);
      end(r.b, r.pts[r.pts.length - 1]!);
    }
    const climb = (n: number, m: number) => {
      let best = Infinity;
      for (const a of ends.get(n) ?? []) for (const b of ends.get(m) ?? []) best = Math.min(best, Math.abs(a - b));
      return Number.isFinite(best) ? best : 0;
    };
    // join nodes closer than the gap
    const cell = Math.max(1, gap);
    const grid = new Map<string, number[]>();
    const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    for (const n of this.adj.keys()) {
      const [x, y] = net.nodes[n]!;
      const k = key(x, y);
      let list = grid.get(k);
      if (!list) grid.set(k, (list = []));
      list.push(n);
    }
    for (const n of [...this.adj.keys()]) {
      const [x, y] = net.nodes[n]!;
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++)
          for (const m of grid.get(`${Math.floor(x / cell) + i},${Math.floor(y / cell) + j}`) ?? []) {
            if (m <= n) continue;
            const [mx, my] = net.nodes[m]!;
            const d = Math.hypot(mx - x, my - y);
            if (d > gap || this.adj.get(n)!.some((e) => e.to === m)) continue;
            // ends more than a step apart in height aren't one road (a deck's end over a road under it);
            // a smaller difference costs its climb
            const dh = climb(n, m);
            if (dh > 1) continue;
            const len = d + GAP_CLIMB_COST * dh;
            add(n, { to: m, len, route: -1 });
            add(m, { to: n, len, route: -1 });
          }
    }
  }

  /** The node nearest a place (on this network). */
  nearestNode(x: number, y: number): number {
    let best = -1;
    let bestD = Infinity;
    for (const n of this.adj.keys()) {
      const [nx, ny] = this.net.nodes[n]!;
      const d = Math.hypot(nx - x, ny - y);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  /** The nearest point on a route of this network to a place: the route, the distance along it and the point. */
  nearestOnRoute(x: number, y: number, maxRadius = 64): { route: number; s: number; point: Point; d: number } | null {
    for (let r = 4; r <= maxRadius; r *= 2) {
      const seen = new Set<number>();
      let best: { route: number; s: number; point: Point; d: number } | null = null;
      for (const span of this.net.spansNear(x, y, r)) {
        if (seen.has(span.route)) continue;
        seen.add(span.route);
        const route = this.net.routes[span.route]!;
        if (route.net !== this.kind || route.a < 0 || route.b < 0) continue;
        const p = route.pts;
        for (let i = 0; i + 5 < p.length; i += 3) {
          const ax = p[i]!;
          const ay = p[i + 1]!;
          const dx = p[i + 3]! - ax;
          const dy = p[i + 4]! - ay;
          const len2 = dx * dx + dy * dy;
          const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
          const px = ax + dx * t;
          const py = ay + dy * t;
          const d = Math.hypot(x - px, y - py);
          if (!best || d < best.d) best = { route: route.id, s: route.cum[i / 3]! + Math.sqrt(len2) * t, point: { x: px, y: py }, d };
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** A route's points between two distances along it (in that order, either way). */
  private slice(route: number, s0: number, s1: number): Point[] {
    const r = this.net.routes[route]!;
    const at = (s: number): Point => {
      const p = this.net.at(r, s);
      return { x: p.x, y: p.y };
    };
    const out: Point[] = [at(s0)];
    const n = r.cum.length;
    if (s0 <= s1) {
      for (let i = 0; i < n; i++) if (r.cum[i]! > s0 && r.cum[i]! < s1) out.push({ x: r.pts[3 * i]!, y: r.pts[3 * i + 1]! });
    } else {
      for (let i = n - 1; i >= 0; i--) if (r.cum[i]! < s0 && r.cum[i]! > s1) out.push({ x: r.pts[3 * i]!, y: r.pts[3 * i + 1]! });
    }
    out.push(at(s1));
    return out;
  }

  /**
   * The shortest way between two places along the roads, or null: from the
   * nearest point on a route to the first place, through the junctions, to
   * the nearest point on a route to the second.
   */
  plan(from: Point, to: Point): PlannedRoute | null {
    const start = this.nearestOnRoute(from.x, from.y);
    const end = this.nearestOnRoute(to.x, to.y);
    if (!start || !end) return null;
    const rs = this.net.routes[start.route]!;
    const rt = this.net.routes[end.route]!;
    const finish = (points: Point[], byClass: Record<string, number>): PlannedRoute => {
      const out: Point[] = [];
      for (const p of points) {
        const last = out[out.length - 1];
        if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-6) out.push(p);
      }
      let length = 0;
      for (let i = 1; i < out.length; i++) length += Math.hypot(out[i]!.x - out[i - 1]!.x, out[i]!.y - out[i - 1]!.y);
      return { points: out, length, byClass };
    };
    // the same route, without a junction between
    const direct = rs.id === rt.id ? Math.abs(end.s - start.s) : Infinity;
    // from the start along its route to either end node
    const dist = new Map<number, number>();
    const prev = new Map<number, { node: number; edge: Edge } | null>();
    const heap: [number, number][] = [];
    const push = (item: [number, number]) => {
      heap.push(item);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p]![0] <= heap[i]![0]) break;
        [heap[p], heap[i]] = [heap[i]!, heap[p]!];
        i = p;
      }
    };
    const pop = (): [number, number] => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
          if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i]!, heap[m]!];
          i = m;
        }
      }
      return top;
    };
    const seed = (node: number, d: number) => {
      if (d < (dist.get(node) ?? Infinity)) {
        dist.set(node, d);
        prev.set(node, null);
        push([d, node]);
      }
    };
    seed(rs.a, start.s);
    seed(rs.b, rs.length - start.s);
    // to the target: through either end node of its route
    const into = (node: number) => (node === rt.a ? end.s : node === rt.b ? rt.length - end.s : Infinity);
    let best = direct;
    let bestNode = -1;
    while (heap.length) {
      const [d, u] = pop();
      if (d > (dist.get(u) ?? Infinity)) continue;
      if (d >= best) break;
      const arrive = d + into(u);
      if (arrive < best) {
        best = arrive;
        bestNode = u;
      }
      for (const e of this.adj.get(u) ?? []) {
        const nd = d + e.len;
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          prev.set(e.to, { node: u, edge: e });
          push([nd, e.to]);
        }
      }
    }
    const routeCls = (r: number) => this.net.routes[r]!.cls || "road";
    if (bestNode < 0) {
      if (!Number.isFinite(direct)) return null;
      return finish([from, ...this.slice(rs.id, start.s, end.s)], { [routeCls(rs.id)]: direct });
    }
    // back from the node it arrives through to the start's route end it set out from
    const legs: { from: number; edge: Edge }[] = [];
    let first = bestNode;
    for (let p = prev.get(first); p; p = prev.get(first)) {
      legs.push({ from: p.node, edge: p.edge });
      first = p.node;
    }
    legs.reverse();
    const byClass: Record<string, number> = {};
    const count = (cls: string, len: number) => (byClass[cls] = (byClass[cls] ?? 0) + len);
    // from the place, along its route to the first node
    const firstS = first === rs.a ? 0 : rs.length;
    const points: Point[] = [from, ...this.slice(rs.id, start.s, firstS)];
    count(routeCls(rs.id), Math.abs(firstS - start.s));
    for (const { from: f, edge } of legs) {
      if (edge.route < 0) {
        const [fx, fy] = this.net.nodes[f]!;
        const [tx, ty] = this.net.nodes[edge.to]!;
        count("gap", Math.hypot(tx - fx, ty - fy));
        points.push({ x: tx, y: ty });
        continue;
      }
      const r = this.net.routes[edge.route]!;
      count(routeCls(r.id), r.length);
      points.push(...this.slice(r.id, r.a === f ? 0 : r.length, r.a === f ? r.length : 0));
    }
    // and along the target's route to it
    const lastS = bestNode === rt.a ? 0 : rt.length;
    points.push(...this.slice(rt.id, lastS, end.s));
    count(routeCls(rt.id), Math.abs(end.s - lastS));
    return finish(points, byClass);
  }
}
