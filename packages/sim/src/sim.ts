import { KINDS, VEHICLE_KINDS, cells, cruiseSpeed, kindCells, levelScale, usesRoute, type LevelScale, type VehicleKind } from "./catalog";
import { Rng } from "./rng";
import type { Route, RouteNetwork, RouteSpan } from "./routes";

/**
 * Ambient traffic (D-060, architecture §9): vehicles moving along the routes
 * of a world package.
 *
 * - **Deterministic:** the simulation advances in fixed ticks and draws every
 *   random choice from its own seeded RNG, so the same seed, focus and ticks
 *   give the same traffic. Its whole state is plain JSON (`serialize`).
 * - **Around the view:** vehicles are kept at a density per kind within a
 *   circle around the focus (the camera), spawned at its edge once it is
 *   filled and dropped beyond it.
 * - **Along routes:** a vehicle is a position on a chain of legs (a route and
 *   a direction). At a junction it picks the next route, preferring to go
 *   straight; at a dead end it stands, then turns back. A vehicle slows behind
 *   the one ahead on its leg.
 */

export const TICK = 1 / 30; // seconds per simulation step
export const SIM_STATE_VERSION = 1;

export interface Leg {
  route: number;
  /** 1 from the route's first vertex to its last, −1 back. */
  dir: 1 | -1;
}

export interface Vehicle {
  id: number;
  kind: VehicleKind;
  variant: number;
  /** Legs already driven, oldest first (the tail of a long train is on them). */
  trail: Leg[];
  cur: Leg;
  /** The leg after this one, or null at a dead end. */
  next: Leg | null;
  /** Distance along the current leg, in its direction (cells). */
  s: number;
  /** Current speed and own cruising factor. */
  speed: number;
  pace: number;
  /** Seconds left standing at a dead end. */
  dwell: number;
}

export interface Focus {
  x: number;
  y: number;
  radius: number;
}

export interface SimState {
  version: typeof SIM_STATE_VERSION;
  rng: number;
  ticks: number;
  nextId: number;
  focus: Focus | null;
  /** Whether the area around the focus has been filled since it was set or jumped. */
  filled: boolean;
  /** Play time not yet stepped (less than a tick). */
  carry: number;
  vehicles: Vehicle[];
}

export interface SimOptions {
  seed?: number;
  metersPerCell: number;
  level?: string;
  /** Multiplies every kind's density. */
  density?: number;
  /** Kinds to run (default: all). */
  kinds?: readonly VehicleKind[];
  /** Most vehicles in all. */
  maxVehicles?: number;
  /** The level's object height stretch (manifest depiction.heightStretch). */
  heightStretch?: number;
}

/** One drawn car of a vehicle. */
export interface Pose {
  id: number;
  kind: VehicleKind;
  variant: number;
  /** Car index in the consist (0 = the head: a train's locomotive). */
  part: number;
  x: number;
  y: number;
  h: number;
  /** Direction the car faces (radians; x east, y south). */
  heading: number;
}

const ACCEL = 1.5; // fraction of cruising speed gained per second
const SPAWN_PER_TICK = 4;

export class TrafficSim {
  readonly scale: LevelScale;
  readonly kinds: readonly VehicleKind[];
  private rng: Rng;
  private state: SimState;
  /** Routes each kind may use (by route id). */
  private readonly usable: Map<VehicleKind, Uint8Array>;
  private readonly density: number;
  private readonly maxVehicles: number;
  private area: { key: string; spans: Map<VehicleKind, { spans: RouteSpan[]; weights: number[]; length: number }> } | null =
    null;

  constructor(
    readonly net: RouteNetwork,
    opts: SimOptions,
    state?: SimState,
  ) {
    this.scale = levelScale(opts.metersPerCell, opts.level, { heightStretch: opts.heightStretch });
    this.density = opts.density ?? 1;
    this.maxVehicles = opts.maxVehicles ?? 220;
    this.usable = new Map();
    const kinds: VehicleKind[] = [];
    for (const k of opts.kinds ?? VEHICLE_KINDS) {
      const u = new Uint8Array(net.routes.length);
      let any = false;
      for (const r of net.routes)
        if (usesRoute(k, r) && r.length > 0) {
          u[r.id] = 1;
          any = true;
        }
      if (any) {
        this.usable.set(k, u);
        kinds.push(k);
      }
    }
    this.kinds = kinds;
    if (state) {
      if (state.version !== SIM_STATE_VERSION) throw new Error(`sim state version ${state.version}`);
      this.state = structuredClone(state);
    } else {
      this.state = { version: SIM_STATE_VERSION, rng: (opts.seed ?? 1) >>> 0, ticks: 0, nextId: 1, focus: null, filled: false, carry: 0, vehicles: [] };
    }
    this.rng = new Rng(this.state.rng);
  }

  get vehicles(): readonly Vehicle[] {
    return this.state.vehicles;
  }

  get ticks(): number {
    return this.state.ticks;
  }

  /** Simulated seconds so far. */
  get time(): number {
    return this.state.ticks * TICK;
  }

  serialize(): SimState {
    this.state.rng = this.rng.state;
    return structuredClone(this.state);
  }

  /** The area to keep traffic in, in cells. */
  setFocus(x: number, y: number, radius: number): void {
    const f = this.state.focus;
    // a jump (a new place, another level) refills the area from empty
    if (f && Math.hypot(f.x - x, f.y - y) > Math.max(f.radius, radius)) this.state.filled = false;
    this.state.focus = { x, y, radius };
  }

  /** Step the simulation by whole ticks for dt seconds of play; returns the ticks run. */
  advance(dt: number, maxTicks = 8): number {
    const st = this.state;
    st.carry += dt;
    let n = 0;
    while (st.carry >= TICK && n < maxTicks) {
      st.carry -= TICK;
      this.tick();
      n++;
    }
    if (n === maxTicks) st.carry = Math.min(st.carry, TICK);
    return n;
  }

  /** Fraction of a tick since the last one (for drawing between ticks). */
  get alpha(): number {
    return Math.min(1, this.state.carry / TICK);
  }

  tick(): void {
    this.state.ticks++;
    const dt = TICK;
    this.move(dt);
    this.despawn();
    this.spawn();
    this.state.rng = this.rng.state;
  }

  // ---- movement --------------------------------------------------------------

  private route(leg: Leg): Route {
    return this.net.routes[leg.route]!;
  }

  /** Cruising speed in cells per second. */
  private cruise(v: Vehicle): number {
    const mps = cruiseSpeed(v.kind, this.route(v.cur)) * v.pace;
    return (mps / this.scale.metersPerCell) * this.scale.timeScale;
  }

  /** A whole vehicle's length (cells): every car and the gaps between them. */
  consistLength(kind: VehicleKind): number {
    const k = KINDS[kind];
    return kindCells(this.scale, kind, k.length * k.cars + k.gap * (k.cars - 1));
  }

  private move(dt: number): void {
    const vs = this.state.vehicles;
    // the vehicle ahead on the same leg
    const byLeg = new Map<number, Vehicle[]>();
    for (const v of vs) {
      const key = v.cur.route * 2 + (v.cur.dir > 0 ? 1 : 0);
      let list = byLeg.get(key);
      if (!list) byLeg.set(key, (list = []));
      list.push(v);
    }
    const ahead = new Map<Vehicle, Vehicle>();
    for (const list of byLeg.values()) {
      list.sort((a, b) => a.s - b.s || a.id - b.id);
      for (let i = 0; i + 1 < list.length; i++) ahead.set(list[i]!, list[i + 1]!);
    }
    for (const v of vs) {
      if (v.dwell > 0) {
        v.dwell -= dt;
        v.speed = 0;
        if (v.dwell <= 0) this.turnBack(v);
        continue;
      }
      const cruise = this.cruise(v);
      let target = cruise;
      const lead = ahead.get(v);
      if (lead) {
        const gap = lead.s - this.consistLength(lead.kind) - v.s;
        const safe = cells(this.scale, 2) + this.consistLength(v.kind) * 0.15;
        if (gap < safe) target = 0;
        else if (gap < safe * 3) target = Math.min(cruise, lead.speed + (gap - safe) * 0.5);
      }
      const accel = cruise * ACCEL * dt;
      v.speed = target < v.speed ? Math.max(target, v.speed - accel * 3) : Math.min(target, v.speed + accel);
      v.s += v.speed * dt;
      for (let guard = 0; guard < 8; guard++) {
        const len = this.route(v.cur).length;
        if (v.s < len) break;
        if (!v.next) {
          v.s = len;
          v.speed = 0;
          v.dwell = KINDS[v.kind].dwell;
          break;
        }
        v.s -= len;
        v.trail.push(v.cur);
        if (v.trail.length > 6) v.trail.shift();
        v.cur = v.next;
        v.next = this.chooseNext(v.kind, v.cur);
      }
    }
  }

  /** The leg to take at the end of `leg`, or null at a dead end. */
  private chooseNext(kind: VehicleKind, leg: Leg): Leg | null {
    const r = this.route(leg);
    const node = leg.dir > 0 ? r.b : r.a;
    if (node < 0) return null;
    const usable = this.usable.get(kind)!;
    const inHeading = this.net.endHeading(r, leg.dir < 0) + (leg.dir < 0 ? Math.PI : 0);
    const cands: Leg[] = [];
    const weights: number[] = [];
    const rail = kind !== "car" && kind !== "bus";
    for (const id of this.net.nodeRoutes[node] ?? []) {
      if (!usable[id]) continue;
      const c = this.net.routes[id]!;
      const dirs: (1 | -1)[] = [];
      if (c.a === node) dirs.push(1);
      if (c.b === node) dirs.push(-1);
      for (const dir of dirs) {
        if (id === r.id && dir === -leg.dir) continue; // not straight back
        const out = this.net.endHeading(c, dir > 0) + (dir > 0 ? 0 : Math.PI);
        const cos = Math.cos(out - inHeading);
        if (rail && cos < 0.3) continue; // trains don't take sharp switches
        cands.push({ route: id, dir });
        weights.push(rail ? Math.pow(Math.max(0.01, cos), 6) : 0.35 + Math.max(0, cos) * 1.5);
      }
    }
    const i = this.rng.weighted(weights);
    return i < 0 ? null : cands[i]!;
  }

  /**
   * At a dead end the vehicle turns back: its tail becomes its head (a train
   * reverses out of a terminus), on the same legs in the other direction.
   */
  private turnBack(v: Vehicle): void {
    const legs = [...v.trail, v.cur];
    let back = this.consistLength(v.kind);
    // walk back from the head to the tail
    let k = legs.length - 1;
    let p = v.s; // distance along legs[k] from its start
    while (back > p && k > 0) {
      back -= p;
      k--;
      p = this.route(legs[k]!).length;
    }
    p = Math.max(0, p - back);
    const flip = (l: Leg): Leg => ({ route: l.route, dir: (l.dir > 0 ? -1 : 1) as 1 | -1 });
    v.cur = flip(legs[k]!);
    v.s = this.route(legs[k]!).length - p;
    v.trail = legs.slice(k + 1).reverse().map(flip);
    v.next = k > 0 ? flip(legs[k - 1]!) : this.chooseNext(v.kind, v.cur);
    v.dwell = 0;
    v.speed = 0;
  }

  // ---- spawning --------------------------------------------------------------

  private areaSpans(f: Focus) {
    const key = `${Math.round(f.x / 2)},${Math.round(f.y / 2)},${Math.round(f.radius)}`;
    if (this.area?.key === key) return this.area.spans;
    const all = this.net.spansNear(f.x, f.y, f.radius);
    const spans = new Map<VehicleKind, { spans: RouteSpan[]; weights: number[]; length: number }>();
    for (const k of this.kinds) {
      const usable = this.usable.get(k)!;
      const list = all.filter((s) => usable[s.route]);
      const weights = list.map((s) => s.s1 - s.s0);
      spans.set(k, { spans: list, weights, length: weights.reduce((a, b) => a + b, 0) });
    }
    this.area = { key, spans };
    return spans;
  }

  /** How many of a kind to keep around the focus. */
  target(kind: VehicleKind): number {
    const f = this.state.focus;
    if (!f) return 0;
    const a = this.areaSpans(f).get(kind);
    if (!a || a.length <= 0) return 0;
    const spec = KINDS[kind];
    // densities are per cell at 25 m cells; coarser levels pack more road per cell
    const perCell = spec.density * this.density * Math.pow(this.scale.metersPerCell / 25, 0.25);
    const want = a.length * perCell;
    // a little of a rare kind still shows one
    return Math.min(spec.max, want >= 0.35 ? Math.max(1, Math.round(want)) : 0);
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const v of this.state.vehicles) out[v.kind] = (out[v.kind] ?? 0) + 1;
    return out;
  }

  private despawn(): void {
    const f = this.state.focus;
    if (!f) return;
    const r = f.radius * 1.25;
    this.state.vehicles = this.state.vehicles.filter((v) => {
      const p = this.net.at(this.route(v.cur), this.routeS(v.cur, v.s));
      return Math.hypot(p.x - f.x, p.y - f.y) <= r;
    });
  }

  private spawn(): void {
    const f = this.state.focus;
    if (!f) return;
    const filling = !this.state.filled;
    const area = this.areaSpans(f);
    const have = this.counts();
    let budget = filling ? 400 : SPAWN_PER_TICK;
    let total = this.state.vehicles.length;
    for (const kind of this.kinds) {
      const want = this.target(kind);
      const a = area.get(kind);
      if (!a || !a.spans.length) continue;
      let n = have[kind] ?? 0;
      for (let tries = 0; n < want && budget > 0 && total < this.maxVehicles && tries < want * 4 + 4; tries++) {
        const i = this.rng.weighted(a.weights);
        const span = a.spans[i]!;
        const r = this.net.routes[span.route]!;
        const s = this.rng.range(span.s0, span.s1);
        const dir: 1 | -1 = this.rng.next() < 0.5 ? 1 : -1;
        const variant = this.rng.int(KINDS[kind].variants);
        const pace = this.rng.range(0.85, 1.1);
        const p = this.net.at(r, s);
        const d = Math.hypot(p.x - f.x, p.y - f.y);
        if (d > f.radius) continue;
        // once the area is full, new vehicles come in at its edge, out of sight
        if (!filling && d < f.radius * 0.8) continue;
        const ls = dir > 0 ? s : r.length - s;
        if (!this.clear(span.route, ls, dir, kind)) continue;
        const v: Vehicle = {
          id: this.state.nextId++,
          kind,
          variant,
          trail: [],
          cur: { route: span.route, dir },
          next: null,
          s: ls,
          speed: 0,
          pace,
          dwell: 0,
        };
        v.next = this.chooseNext(kind, v.cur);
        v.speed = this.cruise(v);
        this.state.vehicles.push(v);
        n++;
        total++;
        budget--;
      }
    }
    this.state.filled = true;
  }

  /** No vehicle on this leg within a vehicle's length or two of s. */
  private clear(route: number, s: number, dir: 1 | -1, kind: VehicleKind): boolean {
    const room = this.consistLength(kind) * 2 + cells(this.scale, 4);
    for (const v of this.state.vehicles)
      if (v.cur.route === route && v.cur.dir === dir && Math.abs(v.s - s) < room + this.consistLength(v.kind)) return false;
    return true;
  }

  // ---- where things are --------------------------------------------------------

  /** Distance along a route of a position s along a leg. */
  routeS(leg: Leg, s: number): number {
    return leg.dir > 0 ? s : this.route(leg).length - s;
  }

  /**
   * The point `offset` cells ahead of (or, negative, behind) a vehicle's head
   * along its legs; past its first or last leg it stays at that leg's end.
   */
  along(v: Vehicle, offset: number): { x: number; y: number; h: number } {
    let s = v.s + offset;
    if (s > this.route(v.cur).length && v.next) {
      s -= this.route(v.cur).length;
      return this.net.at(this.route(v.next), this.routeS(v.next, Math.min(s, this.route(v.next).length)));
    }
    let leg = v.cur;
    let k = v.trail.length;
    while (s < 0 && k > 0) {
      k--;
      leg = v.trail[k]!;
      s += this.route(leg).length;
    }
    return this.net.at(this.route(leg), this.routeS(leg, Math.max(0, s)));
  }

  /**
   * Every car of every vehicle: centre, height and heading, drawn `alpha` of
   * the way from the previous tick to the current one. A car faces along the
   * chord between its two ends, so it turns smoothly through a corner; it
   * keeps to the right of its route by its kind's lane offset.
   */
  poses(alpha = 1): Pose[] {
    const out: Pose[] = [];
    for (const v of this.state.vehicles) {
      const spec = KINDS[v.kind];
      const len = kindCells(this.scale, v.kind, spec.length);
      const gap = kindCells(this.scale, v.kind, spec.gap);
      const back = v.speed * (1 - alpha) * TICK;
      const r = this.route(v.cur);
      const lane = spec.lane ? Math.min(cells(this.scale, spec.lane), r.width > 0 ? r.width * 0.6 : Infinity) : 0;
      for (let part = 0; part < spec.cars; part++) {
        const c = -back - part * (len + gap) - len / 2;
        const f = this.along(v, c + len / 2);
        const b = this.along(v, c - len / 2);
        const m = this.along(v, c);
        let heading = Math.atan2(f.y - b.y, f.x - b.x);
        if (f.x === b.x && f.y === b.y) {
          const ahead = this.along(v, c + 0.05);
          heading = Math.atan2(ahead.y - m.y, ahead.x - m.x);
        }
        // to the right of travel (y grows south)
        const x = (f.x + b.x) / 2 - Math.sin(heading) * lane;
        const y = (f.y + b.y) / 2 + Math.cos(heading) * lane;
        out.push({ id: v.id, kind: v.kind, variant: v.variant, part, x, y, h: Math.max(m.h, (f.h + b.h) / 2), heading });
      }
    }
    return out;
  }
}
