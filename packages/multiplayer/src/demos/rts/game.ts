import {
  BUILDINGS,
  GATHER,
  LAYOUT,
  MAX_ORDER,
  QUEUE,
  SEEP_GLIM,
  START,
  TEAMS,
  UNITS,
  cellIndex,
  distToBuilding,
  findPath,
  nearestOpen,
  paceAt,
  passable,
  placementError,
  type BuildingKind,
  type BuildingNet,
  type MapGrid,
  type Point,
  type RtsCommand,
  type RtsSnap,
  type Team,
  type UnitKind,
  type UnitNet,
} from "./rules";

/**
 * Fogfront's match (D-121), with no network in it: the server's room
 * (server.ts) steps it and gives each side what it sees; tests step it
 * directly. Units take orders (move, attack-move, attack, gather, stop),
 * walk A* paths over the map's cells, fight what they're told to or what
 * comes into sight, and carry glim; buildings go up and train units; a side
 * whose hearth falls loses.
 */

export type Order = { k: "idle" } | { k: "move"; x: number; y: number; attack: boolean } | { k: "attack"; target: number } | { k: "gather"; seep: number };

export interface Unit {
  id: number;
  kind: UnitKind;
  team: Team;
  x: number;
  y: number;
  /** Heading (rad). */
  hd: number;
  hp: number;
  order: Order;
  /** What it is fighting now: its order's target, or one it took on in sight; and one it found it can't reach, not taken on again. */
  target: number | null;
  skip: number | null;
  /** Seconds until its next blow. */
  cooldown: number;
  path: Point[];
  /** Where its path leads, and seconds until it may look for a new one. */
  pathTo: Point | null;
  repath: number;
  /** Glim carried, and seconds mined so far. */
  carry: number;
  mined: number;
}

export interface Building {
  id: number;
  kind: BuildingKind;
  /** Cells a side. */
  size: number;
  team: Team;
  /** Top-left cell. */
  x: number;
  y: number;
  hp: number;
  /** Raised so far, 0–1. */
  built: number;
  queue: UnitKind[];
  /** Seconds into the first training. */
  progress: number;
}

export interface Seep {
  id: number;
  x: number;
  y: number;
  left: number;
}

/** What happened in a step, for the room to tell the pages that see it. */
export type GameEvent = { kind: "hit"; by: number; to: number; x: number; y: number } | { kind: "die"; id: number; team: Team; x: number; y: number };

/**
 * Paths found a tick at most: a page re-sending orders for many units can't
 * stall the server (an A* over the map is 1–2 ms).
 */
// ponytail: first come first served; a queue by waiting time if units starve
const SEARCHES = 16;

const other = (t: Team): Team => (t === "kiln" ? "tide" : "kiln");
const mid = (b: Building): Point => ({ x: b.x + b.size / 2, y: b.y + b.size / 2 });
const r2 = (v: number) => Math.round(v * 100) / 100;

export class RtsGame {
  /** Seconds of play. */
  time = 0;
  readonly units = new Map<number, Unit>();
  readonly buildings = new Map<number, Building>();
  readonly seeps = new Map<number, Seep>();
  readonly glim: Record<Team, number> = { kiln: 0, tide: 0 };
  winner: Team | null = null;
  /** What happened since the room last took them. */
  events: GameEvent[] = [];
  private nextId = 1;
  /** Each side's enemies in sight now (units and buildings), and the enemy buildings it has ever seen. */
  private readonly sight: Record<Team, Set<number>> = { kiln: new Set(), tide: new Set() };
  private readonly known: Record<Team, Set<number>> = { kiln: new Set(), tide: new Set() };
  /** Paths found this tick (`walk`). */
  private searches = 0;
  /** Each side's view, built once a step at most. */
  private readonly views = new Map<Team, { time: number; snap: RtsSnap }>();

  constructor(
    readonly grid: MapGrid,
    readonly layout = LAYOUT,
  ) {
    this.reset();
  }

  /** A new match: each side's hearth, runners and glim, and full seeps. */
  reset(): void {
    this.grid.building.fill(0);
    this.units.clear();
    this.buildings.clear();
    this.seeps.clear();
    this.events = [];
    this.views.clear();
    this.time = 0;
    this.winner = null;
    for (const [x, y] of this.layout.seeps) {
      const id = this.nextId++;
      this.seeps.set(id, { id, x: x + 0.5, y: y + 0.5, left: SEEP_GLIM });
    }
    for (const team of TEAMS) {
      this.glim[team] = START.glim;
      this.sight[team].clear();
      this.known[team].clear();
      const [x, y] = this.layout.hearths[team];
      const hearth = this.raise(team, "hearth", x, y, 1);
      for (let n = 0; n < START.runners; n++) this.spawn(hearth, "runner");
    }
    // each side knows where the other's hearth stands
    for (const b of this.buildings.values()) this.known[other(b.team)].add(b.id);
    this.see();
  }

  // ---------------------------------------------------------------- orders

  /** A side's order (untrusted): carried out, or why not. */
  order(team: Team, c: RtsCommand): string | null {
    if (this.winner) return "the match is over";
    if (c.t === "build") {
      const rule = BUILDINGS[c.kind];
      if (c.kind !== "lodge") return "only lodges are built";
      if (this.glim[team] < rule.cost) return `a lodge takes ${rule.cost} glim`;
      const why = placementError(this.grid, c.kind, c.x, c.y, this.placing(team));
      if (why) return why;
      this.glim[team] -= rule.cost;
      this.raise(team, c.kind, c.x, c.y, 0);
      return null;
    }
    if (c.t === "train") {
      const b = this.buildings.get(c.b);
      if (!b || b.team !== team) return "not your building";
      if (b.built < 1) return "it isn't finished";
      const kind = BUILDINGS[b.kind].trains;
      if (b.queue.length >= QUEUE) return "its queue is full";
      if (this.glim[team] < UNITS[kind].cost) return `a ${kind} takes ${UNITS[kind].cost} glim`;
      this.glim[team] -= UNITS[kind].cost;
      b.queue.push(kind);
      return null;
    }
    const units = [...new Set(c.u)].slice(0, MAX_ORDER).flatMap((id) => {
      const u = this.units.get(id);
      return u && u.team === team ? [u] : [];
    });
    if (!units.length) return "no units of yours";
    if (c.t === "stop") for (const u of units) this.give(u, { k: "idle" });
    else if (c.t === "move") {
      // spread out around the point, a cell apart, each on an open cell
      const side = Math.ceil(Math.sqrt(units.length));
      units.forEach((u, n) => {
        const ox = ((n % side) - (side - 1) / 2) * 0.8;
        const oy = (Math.floor(n / side) - (side - 1) / 2) * 0.8;
        let x = c.x + ox;
        let y = c.y + oy;
        if (!passable(this.grid, Math.floor(x), Math.floor(y))) [x, y] = [c.x, c.y];
        this.give(u, { k: "move", x, y, attack: c.attack === true });
      });
    } else if (c.t === "attack") {
      if (!this.isEnemy(team, c.target)) return "nothing of theirs you can see there";
      const fighters = units.filter((u) => UNITS[u.kind].damage > 0);
      if (!fighters.length) return "runners don't fight";
      for (const u of fighters) this.give(u, { k: "attack", target: c.target });
    } else {
      const seep = this.seeps.get(c.seep);
      if (!seep || seep.left <= 0) return "that seep is dry";
      const runners = units.filter((u) => u.kind === "runner");
      if (!runners.length) return "only runners gather";
      for (const u of runners) this.give(u, { k: "gather", seep: c.seep });
    }
    return null;
  }

  private give(u: Unit, order: Order): void {
    u.order = order;
    u.target = order.k === "attack" ? order.target : null;
    u.skip = null;
    u.path = [];
    u.pathTo = null;
    u.repath = 0;
  }

  /** What a side's building has to keep clear of, and be near. */
  placing(team: Team): Parameters<typeof placementError>[4] {
    return {
      own: [...this.buildings.values()].filter((b) => b.team === team),
      units: [...this.units.values()],
      seeps: [...this.seeps.values()].filter((s) => s.left > 0),
    };
  }

  private isEnemy(team: Team, id: number): boolean {
    const t = this.units.get(id) ?? this.buildings.get(id);
    return !!t && t.hp > 0 && t.team !== team && this.canSee(team, id);
  }

  /** Whether a side sees one of the other's units or buildings now (buildings: once seen, still known). */
  canSee(team: Team, id: number): boolean {
    return this.sight[team].has(id) || (this.buildings.has(id) && this.known[team].has(id));
  }

  // ---------------------------------------------------------------- a step

  step(dt: number): void {
    if (this.winner) return;
    this.time += dt;
    this.searches = 0;
    for (const b of [...this.buildings.values()]) this.work(b, dt);
    this.see();
    for (const u of this.units.values()) this.think(u, dt);
    this.separate();
    for (const u of [...this.units.values()])
      if (u.hp <= 0) {
        this.units.delete(u.id);
        this.events.push({ kind: "die", id: u.id, team: u.team, x: u.x, y: u.y });
      }
    for (const b of [...this.buildings.values()])
      if (b.hp <= 0) {
        this.fall(b);
        if (b.kind === "hearth" && !this.winner) this.winner = other(b.team);
      }
  }

  /** A building goes up, or trains. */
  private work(b: Building, dt: number): void {
    const rule = BUILDINGS[b.kind];
    if (b.built < 1) {
      const add = Math.min(1 - b.built, dt / rule.time);
      b.built += add;
      b.hp = Math.min(rule.hp, b.hp + add * rule.hp * 0.9);
      if (b.built > 1 - 1e-9) b.built = 1;
      return;
    }
    const kind = b.queue[0];
    if (!kind) return;
    b.progress += dt;
    if (b.progress < UNITS[kind].time) return;
    if (!this.spawn(b, kind)) return; // nowhere to stand yet: it waits
    b.progress = 0;
    b.queue.shift();
  }

  /** Who sees what: each side's units and buildings, within their sight. */
  private see(): void {
    // ponytail: every pair, each step; a grid of who stands where if sides field hundreds
    for (const team of TEAMS) {
      const sight = this.sight[team];
      sight.clear();
      for (const u of this.units.values()) if (u.team !== team && this.seesPoint(team, u)) sight.add(u.id);
      for (const b of this.buildings.values())
        if (b.team !== team && this.seesPoint(team, mid(b), b.size / 2)) {
          sight.add(b.id);
          this.known[team].add(b.id);
        }
    }
  }

  private think(u: Unit, dt: number): void {
    if (u.hp <= 0) return; // fell this tick
    const rule = UNITS[u.kind];
    u.cooldown = Math.max(0, u.cooldown - dt);
    u.repath = Math.max(0, u.repath - dt);
    if (rule.damage > 0) {
      const o = u.order;
      if (o.k === "attack") {
        if (!this.isEnemy(u.team, o.target)) this.give(u, { k: "idle" });
      } else if (o.k === "idle" || (o.k === "move" && o.attack)) {
        // keep to a foe still in sight, else take on the nearest
        if (u.target !== null && !(this.isEnemy(u.team, u.target) && this.distTo(u, u.target) <= rule.sight)) u.target = null;
        u.target ??= this.nearestFoe(u);
      }
      if (u.target !== null) return this.fight(u, u.target, dt);
    }
    const o = u.order;
    if (o.k === "move") {
      if (this.walk(u, o, dt)) this.give(u, { k: "idle" });
    } else if (o.k === "gather") this.gather(u, o.seep, dt);
  }

  private fight(u: Unit, id: number, dt: number): void {
    const rule = UNITS[u.kind];
    const b = this.buildings.get(id);
    const t = b ?? this.units.get(id)!;
    const at = b ? mid(b) : (t as Unit);
    if (this.distTo(u, id) > rule.range) {
      // at the end of a path found to where it is, and still out of reach: it can't be got at (across water, walled in)
      if (this.walk(u, at, dt, true) && u.pathTo && Math.hypot(u.pathTo.x - at.x, u.pathTo.y - at.y) <= 1) {
        if (u.order.k === "attack") this.give(u, { k: "idle" });
        else [u.target, u.skip] = [null, id];
      }
      return;
    }
    u.hd = Math.atan2(at.y - u.y, at.x - u.x);
    if (u.cooldown > 0) return;
    u.cooldown = rule.cooldown;
    t.hp -= rule.damage;
    this.events.push({ kind: "hit", by: u.id, to: id, x: at.x, y: at.y });
  }

  private gather(u: Unit, seepId: number, dt: number): void {
    let seep = this.seeps.get(seepId);
    if (u.carry < GATHER.carry && (!seep || seep.left <= 0)) {
      // dry: the nearest seep with glim left
      seep = [...this.seeps.values()].filter((s) => s.left > 0).sort((a, b) => Math.hypot(a.x - u.x, a.y - u.y) - Math.hypot(b.x - u.x, b.y - u.y))[0];
      if (!seep) return this.give(u, { k: "idle" });
      u.order = { k: "gather", seep: seep.id };
    }
    if (u.carry >= GATHER.carry || (u.carry > 0 && !seep)) {
      const home = this.nearestOwn(u, "hearth");
      if (!home) return this.give(u, { k: "idle" });
      if (distToBuilding(u, home) > GATHER.reach) {
        if (this.walk(u, mid(home), dt)) this.give(u, { k: "idle" }); // as near as it gets, and not there: shut out
        return;
      }
      this.glim[u.team] += u.carry;
      u.carry = 0;
      u.path = [];
      u.pathTo = null;
      return;
    }
    if (Math.hypot(seep!.x - u.x, seep!.y - u.y) > GATHER.reach) {
      if (this.walk(u, seep!, dt)) this.give(u, { k: "idle" }); // the seep is walled in
      return;
    }
    u.mined += dt;
    if (u.mined < GATHER.seconds) return;
    u.mined = 0;
    const take = Math.min(GATHER.carry, seep!.left);
    seep!.left -= take;
    u.carry = take;
    u.path = [];
    u.pathTo = null;
  }

  /**
   * A step along a path to a goal, found again when the goal moved (a chase,
   * at most twice a second) or the way is shut (a building went up on it).
   * True once it is there, or as near as it can get. At most `SEARCHES`
   * paths are found a tick; a unit past them waits for the next.
   */
  private walk(u: Unit, goal: Point, dt: number, chasing = false): boolean {
    const moved = !u.pathTo || Math.hypot(u.pathTo.x - goal.x, u.pathTo.y - goal.y) > (chasing ? 1 : 0.01);
    if (moved && u.repath <= 0) {
      if (this.searches >= SEARCHES) return false;
      this.searches++;
      u.path = findPath(this.grid, u, goal);
      u.pathTo = { x: goal.x, y: goal.y };
      u.repath = chasing ? 0.5 : 0;
    }
    let left = UNITS[u.kind].speed * paceAt(this.grid, u.x, u.y) * dt;
    while (left > 0 && u.path.length) {
      const p = u.path[0]!;
      const d = Math.hypot(p.x - u.x, p.y - u.y);
      if (d > 1e-6) u.hd = Math.atan2(p.y - u.y, p.x - u.x);
      const f = Math.min(1, left / Math.max(d, 1e-9));
      const nx = u.x + (p.x - u.x) * f;
      const ny = u.y + (p.y - u.y) * f;
      if (!passable(this.grid, Math.floor(nx), Math.floor(ny)) && passable(this.grid, Math.floor(u.x), Math.floor(u.y))) {
        u.pathTo = null; // shut: a new path next step
        u.repath = 0;
        return false;
      }
      u.x = nx;
      u.y = ny;
      left -= d;
      if (f >= 1) u.path.shift();
    }
    return !u.path.length;
  }

  /** Units standing on one another step apart, where there is room. */
  private separate(): void {
    // ponytail: every pair; a grid of who stands where past a few hundred units
    const us = [...this.units.values()];
    for (let i = 0; i < us.length; i++)
      for (let j = i + 1; j < us.length; j++) {
        const a = us[i]!;
        const b = us[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d >= 0.45) continue;
        if (d < 1e-6) [dx, dy] = [Math.cos(a.id), Math.sin(a.id)]; // on the same spot: apart some way
        const push = (0.45 - d) / 4 / (d < 1e-6 ? 1 : d);
        this.nudge(a, -dx * push, -dy * push);
        this.nudge(b, dx * push, dy * push);
      }
  }

  private nudge(u: Unit, dx: number, dy: number): void {
    if (passable(this.grid, Math.floor(u.x + dx), Math.floor(u.y + dy))) {
      u.x += dx;
      u.y += dy;
    }
  }

  // ---------------------------------------------------------------- what's where

  private distTo(u: Point, id: number): number {
    const t = this.units.get(id);
    if (t) return Math.hypot(t.x - u.x, t.y - u.y);
    const b = this.buildings.get(id);
    return b ? distToBuilding(u, b) : Infinity;
  }

  /** The nearest foe within its sight: units before buildings. */
  private nearestFoe(u: Unit): number | null {
    const sight = UNITS[u.kind].sight;
    let best: number | null = null;
    let bestD = Infinity;
    for (const buildings of [false, true]) {
      for (const id of this.sight[u.team]) {
        if (this.buildings.has(id) !== buildings || id === u.skip) continue;
        const d = this.distTo(u, id);
        if (d <= sight && d < bestD) [best, bestD] = [id, d];
      }
      if (best !== null) return best;
    }
    return null;
  }

  private nearestOwn(p: Point & { team: Team }, kind: BuildingKind): Building | null {
    let best: Building | null = null;
    for (const b of this.buildings.values())
      if (b.team === p.team && b.kind === kind && b.built >= 1 && (!best || distToBuilding(p, b) < distToBuilding(p, best))) best = b;
    return best;
  }

  // ---------------------------------------------------------------- coming and going

  private raise(team: Team, kind: BuildingKind, x: number, y: number, built: number): Building {
    const rule = BUILDINGS[kind];
    const b: Building = { id: this.nextId++, kind, size: rule.size, team, x, y, hp: built >= 1 ? rule.hp : rule.hp * 0.1, built, queue: [], progress: 0 };
    this.buildings.set(b.id, b);
    this.mark(b, b.id);
    return b;
  }

  private fall(b: Building): void {
    this.buildings.delete(b.id);
    this.mark(b, 0);
    for (const t of TEAMS) this.known[t].delete(b.id);
    const m = mid(b);
    this.events.push({ kind: "die", id: b.id, team: b.team, x: m.x, y: m.y });
  }

  private mark(b: Building, id: number): void {
    const size = b.size;
    for (let dy = 0; dy < size; dy++)
      for (let dx = 0; dx < size; dx++) {
        const i = cellIndex(this.grid, b.x + dx, b.y + dy);
        if (i >= 0) this.grid.building[i] = id;
      }
  }

  /** A unit out of a building, on an open cell beside it (fewest standing there); null when it is shut in. */
  private spawn(b: Building, kind: UnitKind): Unit | null {
    const size = b.size;
    const m = mid(b);
    const cell = nearestOpen(this.grid, Math.floor(m.x), Math.floor(m.y), size + 2, (x, y) => ![...this.units.values()].some((u) => Math.floor(u.x) === x && Math.floor(u.y) === y));
    const at = cell ?? nearestOpen(this.grid, Math.floor(m.x), Math.floor(m.y), size + 2);
    if (!at) return null;
    const u: Unit = {
      id: this.nextId++,
      kind,
      team: b.team,
      x: at.x + 0.5,
      y: at.y + 0.5,
      hd: Math.atan2(at.y + 0.5 - m.y, at.x + 0.5 - m.x),
      hp: UNITS[kind].hp,
      order: { k: "idle" },
      target: null,
      skip: null,
      cooldown: 0,
      path: [],
      pathTo: null,
      repath: 0,
      carry: 0,
      mined: 0,
    };
    this.units.set(u.id, u);
    // a new runner goes to the nearest seep with glim
    if (kind === "runner") {
      const seep = [...this.seeps.values()].filter((s) => s.left > 0).sort((a, c) => Math.hypot(a.x - u.x, a.y - u.y) - Math.hypot(c.x - u.x, c.y - u.y))[0];
      if (seep) u.order = { k: "gather", seep: seep.id };
    }
    return u;
  }

  // ---------------------------------------------------------------- what a side sees

  /** A side's snapshot: its own, the other's in sight (units) or known (buildings), the seeps; built once a step. */
  view(team: Team): RtsSnap {
    const cached = this.views.get(team);
    if (cached?.time === this.time) return cached.snap;
    const units: UnitNet[] = [];
    for (const u of this.units.values()) {
      const own = u.team === team;
      if (!own && !this.sight[team].has(u.id)) continue;
      const goal = u.order.k === "move" ? u.order : u.pathTo && u.path.length ? u.pathTo : null;
      units.push({
        i: u.id,
        k: u.kind,
        s: u.team,
        x: r2(u.x),
        y: r2(u.y),
        d: r2(u.hd),
        hp: Math.ceil(u.hp),
        ...(u.carry > 0 ? { c: 1 as const } : {}),
        ...(u.target !== null ? { f: 1 as const } : {}),
        ...(own && goal ? { g: [r2(goal.x), r2(goal.y)] as [number, number] } : {}),
      });
    }
    const buildings: BuildingNet[] = [];
    for (const b of this.buildings.values()) {
      const own = b.team === team;
      if (!own && !this.canSee(team, b.id)) continue;
      buildings.push({
        i: b.id,
        k: b.kind,
        s: b.team,
        x: b.x,
        y: b.y,
        hp: Math.ceil(b.hp),
        b: r2(b.built),
        ...(own && b.queue.length ? { q: b.queue.length, p: r2(b.progress / UNITS[b.queue[0]!].time) } : {}),
      });
    }
    const seeps = [...this.seeps.values()].map((s) => ({ i: s.id, x: s.x, y: s.y, left: s.left }));
    const snap: RtsSnap = { side: team, glim: this.glim[team], units, buildings, seeps };
    this.views.set(team, { time: this.time, snap });
    return snap;
  }

  /** Whether a side sees a point (`pad` cells round it): within sight of one of its units or buildings. */
  seesPoint(team: Team, p: Point, pad = 0): boolean {
    for (const u of this.units.values()) if (u.team === team && Math.hypot(u.x - p.x, u.y - p.y) <= UNITS[u.kind].sight + pad) return true;
    for (const b of this.buildings.values()) if (b.team === team && distToBuilding(p, b) <= BUILDINGS[b.kind].sight + pad) return true;
    return false;
  }
}

/** A command from a page, checked for its shape (its sense is the game's `order`). */
export function parseCommand(data: unknown): RtsCommand | null {
  const c = data as Record<string, unknown> | null;
  if (!c || typeof c !== "object") return null;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const int = (v: unknown) => Number.isInteger(v);
  const ids = (v: unknown) => (Array.isArray(v) && v.length <= MAX_ORDER && v.every(int) ? (v as number[]) : null);
  switch (c.t) {
    case "move": {
      const u = ids(c.u);
      return u && num(c.x) && num(c.y) ? { t: "move", u, x: c.x as number, y: c.y as number, attack: c.attack === true } : null;
    }
    case "attack": {
      const u = ids(c.u);
      return u && int(c.target) ? { t: "attack", u, target: c.target as number } : null;
    }
    case "gather": {
      const u = ids(c.u);
      return u && int(c.seep) ? { t: "gather", u, seep: c.seep as number } : null;
    }
    case "stop": {
      const u = ids(c.u);
      return u ? { t: "stop", u } : null;
    }
    case "build":
      return (c.kind === "lodge" || c.kind === "hearth") && int(c.x) && int(c.y) ? { t: "build", kind: c.kind, x: c.x as number, y: c.y as number } : null;
    case "train":
      return int(c.b) ? { t: "train", b: c.b as number } : null;
    default:
      return null;
  }
}
