import { setRemoved } from "pixelworld/engine";
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
  razeCells,
  type BuildingKind,
  type BuildingNet,
  type MapGrid,
  type Point,
  type RtsCommand,
  type RtsSnap,
  type Structure,
  type Team,
  type UnitKind,
  type UnitNet,
  type Watch,
  BUILDING_EYE,
  HIGH_GROUND_DAMAGE,
  SIGHT,
  fogCells,
  groundAt,
  seesArea,
  seesUnit,
  sideSight,
  type Eye,
  GARRISON,
  holds,
  OBJECTIVE,
  type MarkNet,
  type Objective,
  DAY,
  isNight,
  roofEye,
} from "./rules";

/**
 * Fogfront's match (D-121), with no network in it: the server's room
 * (server.ts) steps it and gives each side what it sees; tests step it
 * directly. Units take orders (move, attack-move, attack, gather, stop),
 * walk A* paths over the map's cells, fight what they're told to or what
 * comes into sight, and carry glim; buildings go up and train units; a side
 * whose hearth falls loses. Wardens knock down the level's buildings; one
 * that falls opens its cells, and is in `razed` for every page (D-124).
 */

export type Order =
  | { k: "idle" }
  | { k: "move"; x: number; y: number; attack: boolean }
  | { k: "attack"; target: number }
  | { k: "gather"; seep: number }
  | { k: "raze"; obj: number }
  | { k: "enter"; obj: number };

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
  /** The level's building it is in (its object), or null (D-125), and where it went in. */
  inside: number | null;
  door: Point | null;
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

/** What happened in a step, for the room to tell the pages that see it (`obj`: a blow to one of the level's buildings). */
export type GameEvent =
  | { kind: "hit"; by: number; to: number; obj?: 1; x: number; y: number }
  | { kind: "die"; id: number; team: Team; x: number; y: number }
  | { kind: "taken"; id: string; name: string; side: Team };

/** A landmark held (D-125): who holds it, who is taking it, and for how long so far. */
export interface Mark extends Objective {
  owner: Team | null;
  taker: Team | null;
  hold: number;
}

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
  /** The level's buildings standing, with their hit points now (by object). */
  readonly structures = new Map<number, Structure>();
  /** The level's buildings knocked down this match, as they fell. */
  razed: number[] = [];
  /** The landmarks to hold (D-125), and each side's glim from them not yet whole. */
  marks: Mark[] = [];
  private earned: Record<Team, number> = { kiln: 0, tide: 0 };
  private nextId = 1;
  /** Each side's enemies in sight now (units and buildings), and the enemy buildings it has ever seen. */
  private readonly sight: Record<Team, Set<number>> = { kiln: new Set(), tide: new Set() };
  /** What each side sees, cell by cell (`sideSight`), worked out every `SIGHT.every` ticks; the fog over the cells. */
  readonly sees: Record<Team, Float32Array>;
  private fog: Float32Array | null = null;
  private fogNight = false;
  private ticks = 0;
  /** The world's fog now, at a point and a height, by night or day (the room gives it its clock), or null where there is none. */
  fogAt: ((x: number, y: number, h: number, night: boolean) => number) | null = null;

  /** Whether it is night in the match now (D-125). */
  get night(): boolean {
    return isNight(this.time);
  }
  private readonly known: Record<Team, Set<number>> = { kiln: new Set(), tide: new Set() };
  /** Paths found this tick (`walk`). */
  private searches = 0;
  /** Each side's view (and everything, for spectators), built once a step at most. */
  private readonly views = new Map<Watch, { time: number; snap: RtsSnap }>();

  constructor(
    readonly grid: MapGrid,
    readonly layout = LAYOUT,
  ) {
    this.sees = { kiln: new Float32Array(grid.flags.length), tide: new Float32Array(grid.flags.length) };
    this.reset();
  }

  /** A new match: each side's hearth, runners and glim, full seeps, and the level's buildings all standing. */
  reset(): void {
    this.grid.building.fill(0);
    setRemoved(this.grid, () => false); // the level's buildings all standing again
    this.razed = [];
    this.marks = (this.grid.objectives ?? []).map((o) => ({ ...o, owner: null, taker: null, hold: 0 }));
    this.earned = { kiln: 0, tide: 0 };
    this.structures.clear();
    for (const s of this.grid.structures?.values() ?? []) this.structures.set(s.obj, { ...s });
    this.units.clear();
    this.buildings.clear();
    this.seeps.clear();
    this.events = [];
    this.views.clear();
    this.time = 0;
    this.ticks = 0;
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
    if (c.t === "leave") {
      const s = this.structures.get(c.obj);
      const mine = this.garrison(c.obj).filter((u) => u.team === team);
      if (!s || !mine.length) return "none of yours in there";
      for (const u of mine) this.out(u, s);
      return null;
    }
    const units = [...new Set(c.u)].slice(0, MAX_ORDER).flatMap((id) => {
      const u = this.units.get(id);
      return u && u.team === team ? [u] : [];
    });
    if (!units.length) return "no units of yours";
    if (c.t === "stop") for (const u of units) this.give(u, { k: "idle" });
    else if (c.t === "enter") {
      const s = this.structures.get(c.obj);
      if (!s) return "nothing there to go into";
      // only its own already inside count here: whether the other side holds it shows on arrival, not from across the map
      const ours = this.garrison(c.obj).filter((u) => u.team === team);
      const outside = units.filter((u) => u.inside === null);
      if (ours.length + outside.length > holds(s)) return `it holds ${holds(s)}`;
      for (const u of outside) this.give(u, { k: "enter", obj: c.obj });
    } else if (c.t === "raze") {
      if (!this.structures.has(c.obj)) return "nothing there to knock down";
      const fighters = units.filter((u) => UNITS[u.kind].damage > 0);
      if (!fighters.length) return "runners don't knock buildings down";
      for (const u of fighters) this.give(u, { k: "raze", obj: c.obj });
    }
    else if (c.t === "move") {
      // spread out around the point, a cell apart, each on an open cell
      const side = Math.ceil(Math.sqrt(units.length));
      units.forEach((u, n) => {
        const ox = ((n % side) - (side - 1) / 2) * 0.8;
        const oy = (Math.floor(n / side) - (side - 1) / 2) * 0.8;
        const g = this.grid;
        let x = Math.min(g.x0 + g.w - 0.5, Math.max(g.x0 + 0.5, c.x + ox));
        let y = Math.min(g.y0 + g.h - 0.5, Math.max(g.y0 + 0.5, c.y + oy));
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
    this.topple();
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
    this.hold(dt);
  }

  /** The level's buildings knocked down this step fall: their cells open, and those inside come out of the rubble, hurt (before the dead are taken away). */
  private topple(): void {
    for (const s of [...this.structures.values()])
      if (s.hp <= 0) {
        this.structures.delete(s.obj);
        this.razed.push(s.obj);
        razeCells(this.grid, s.obj, new Set(this.razed));
        for (const u of this.garrison(s.obj)) {
          this.out(u, s);
          u.hp -= GARRISON.fall;
        }
      }
  }

  /** The landmarks: taken by a side alone near one long enough, paying who holds them. */
  private hold(dt: number): void {
    for (const m of this.marks) {
      const near = new Set<Team>();
      for (const u of this.units.values()) if (u.inside === null && Math.hypot(u.x - m.x, u.y - m.y) <= OBJECTIVE.radius) near.add(u.team);
      const [only] = near;
      if (near.size === 1 && only !== m.owner) {
        if (m.taker !== only) [m.taker, m.hold] = [only!, 0];
        m.hold += dt;
        if (m.hold >= OBJECTIVE.hold) {
          [m.owner, m.taker, m.hold] = [only!, null, 0];
          this.events.push({ kind: "taken", id: m.id, name: m.name, side: only! });
        }
      } else if ((near.size === 0 || (near.size === 1 && only === m.owner)) && m.taker) {
        m.hold = Math.max(0, m.hold - dt / 2);
        if (m.hold === 0) m.taker = null;
      }
      if (m.owner) this.earned[m.owner] += OBJECTIVE.income * dt;
    }
    for (const t of TEAMS) {
      const whole = Math.floor(this.earned[t]);
      this.glim[t] += whole;
      this.earned[t] -= whole;
    }
  }

  /** The landmarks as the pages see them. */
  marksNet(): MarkNet[] {
    return this.marks.map((m) => ({ id: m.id, name: m.name, x: m.x, y: m.y, owner: m.owner, taker: m.taker, p: Math.round((m.hold / OBJECTIVE.hold) * 100) / 100 }));
  }

  /** The units in one of the level's buildings. */
  garrison(obj: number): Unit[] {
    return [...this.units.values()].filter((u) => u.inside === obj);
  }

  /**
   * A unit out of a building, where it went in (its door), or the open cell
   * nearest that: not the middle, which may be a courtyard shut in by the
   * building's own walls.
   */
  private out(u: Unit, s: Structure): void {
    const door = u.door ?? this.nearestWall(u, s);
    const at = passable(this.grid, Math.floor(door.x), Math.floor(door.y)) ? { x: Math.floor(door.x), y: Math.floor(door.y) } : nearestOpen(this.grid, Math.floor(door.x), Math.floor(door.y), 8);
    u.inside = null;
    u.door = null;
    if (at) [u.x, u.y] = [at.x + 0.5, at.y + 0.5];
    this.give(u, { k: "idle" });
  }

  /** Into a level building, once at one of its walls; given up where a path gets no nearer, or it's full or the other side's. */
  private enter(u: Unit, s: Structure, dt: number): void {
    const near = this.nearestWall(u, s);
    if (near.d > GARRISON.reach) {
      if (this.walk(u, near, dt) && this.nearestWall(u, s).d > GARRISON.reach) this.give(u, { k: "idle" });
      return;
    }
    const theirs = this.garrison(s.obj);
    if (theirs.length >= holds(s) || theirs.some((o) => o.team !== u.team)) return this.give(u, { k: "idle" });
    this.give(u, { k: "idle" });
    u.inside = s.obj;
    u.door = { x: u.x, y: u.y };
    [u.x, u.y] = [s.x, s.y];
    u.target = null;
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
    const tick = this.ticks++;
    const fogAt = this.fogAt;
    const night = this.night;
    // the fog every few seconds, and at once when night falls or day breaks
    if (fogAt && (tick % SIGHT.fogEvery === 0 || night !== this.fogNight)) {
      this.fog = fogCells(this.grid, (x, y, h) => fogAt(x, y, h, night), this.fog ?? undefined);
      this.fogNight = night;
    }
    if (!this.fogAt) this.fog = null;
    if (tick % SIGHT.every === 0) for (const team of TEAMS) sideSight(this.grid, this.eyes(team), this.fog, this.sees[team]);
    for (const team of TEAMS) {
      const sight = this.sight[team];
      const field = this.sees[team];
      sight.clear();
      for (const u of this.units.values()) if (u.team !== team && u.inside === null && seesUnit(this.grid, field, u.x, u.y)) sight.add(u.id);
      for (const b of this.buildings.values())
        if (b.team !== team && seesArea(this.grid, field, b.x + b.size / 2, b.y + b.size / 2, b.size / 2)) {
          sight.add(b.id);
          this.known[team].add(b.id);
        }
    }
  }

  /** A side's eyes: its units', and its buildings' from their roofs. */
  eyes(team: Team): Eye[] {
    const out: Eye[] = [];
    const dark = this.night ? DAY.sight : 1;
    for (const u of this.units.values()) {
      if (u.team !== team) continue;
      const s = u.inside === null ? undefined : this.structures.get(u.inside);
      // from a building's roof: higher, and further
      if (s) out.push(roofEye(this.grid, s, (UNITS[u.kind].sight + GARRISON.sight) * dark));
      else out.push({ x: u.x, y: u.y, up: SIGHT.eye, radius: UNITS[u.kind].sight * dark });
    }
    for (const b of this.buildings.values()) if (b.team === team) out.push({ ...mid(b), up: BUILDING_EYE[b.kind] * Math.max(0.3, b.built), radius: BUILDINGS[b.kind].sight });
    for (const m of this.marks) if (m.owner === team) out.push({ x: m.x, y: m.y, up: OBJECTIVE.eye, radius: OBJECTIVE.sight });
    return out;
  }

  private think(u: Unit, dt: number): void {
    if (u.hp <= 0) return; // fell this tick
    if (u.inside !== null) return; // keeping watch
    if (u.order.k === "enter") {
      const s = this.structures.get(u.order.obj);
      return s ? this.enter(u, s, dt) : this.give(u, { k: "idle" });
    }
    const rule = UNITS[u.kind];
    u.cooldown = Math.max(0, u.cooldown - dt);
    u.repath = Math.max(0, u.repath - dt);
    if (rule.damage > 0) {
      const o = u.order;
      if (o.k === "raze") {
        const s = this.structures.get(o.obj);
        if (s) return this.raze(u, s, dt);
        this.give(u, { k: "idle" }); // it fell
      } else if (o.k === "attack") {
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
    t.hp -= rule.damage * this.edge(u, at);
    this.events.push({ kind: "hit", by: u.id, to: id, x: at.x, y: at.y });
  }

  /**
   * A blow at one of the level's buildings, once within reach of a cell it
   * walls: it walks to the walled cell nearest it (not the middle, which may
   * be an open courtyard), and gives up where a path gets no nearer.
   */
  private raze(u: Unit, s: Structure, dt: number): void {
    const rule = UNITS[u.kind];
    const near = this.nearestWall(u, s);
    if (near.d > rule.range) {
      if (this.walk(u, near, dt) && this.nearestWall(u, s).d > rule.range) this.give(u, { k: "idle" });
      return;
    }
    u.hd = Math.atan2(s.y - u.y, s.x - u.x);
    if (u.cooldown > 0) return;
    u.cooldown = rule.cooldown;
    s.hp -= rule.damage;
    this.events.push({ kind: "hit", by: u.id, to: s.obj, obj: 1, x: s.x, y: s.y });
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
    const us = [...this.units.values()].filter((u) => u.inside === null);
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

  /** The cell a level building walls nearest a point: its middle, and how far the point is from the cell. */
  private nearestWall(p: Point, s: Structure): Point & { d: number } {
    let best = { x: s.x, y: s.y, d: Infinity };
    for (const i of s.cells) {
      const cell = { x: (i % this.grid.w) + this.grid.x0, y: Math.floor(i / this.grid.w) + this.grid.y0, size: 1 };
      const d = distToBuilding(p, cell);
      if (d < best.d) best = { x: cell.x + 0.5, y: cell.y + 0.5, d };
    }
    return best;
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
      inside: null,
      door: null,
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

  /**
   * A side's snapshot: its own, the other's in sight (units) or known
   * (buildings), the seeps; or, for spectators watching everything (`all`,
   * D-127), every unit and building as its own side sees it. Built once a step.
   */
  view(watch: Watch): RtsSnap {
    const cached = this.views.get(watch);
    if (cached?.time === this.time) return cached.snap;
    const team = watch === "all" ? null : watch;
    const units: UnitNet[] = [];
    for (const u of this.units.values()) {
      const own = !team || u.team === team;
      if (!own && !this.sight[team!].has(u.id)) continue;
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
        ...(u.inside !== null ? { in: u.inside } : {}),
      });
    }
    const buildings: BuildingNet[] = [];
    for (const b of this.buildings.values()) {
      const own = !team || b.team === team;
      if (!own && !this.canSee(team!, b.id)) continue;
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
    // the level's buildings it sees knocked about
    const hurt: [number, number][] = [];
    for (const s of this.structures.values())
      if (s.hp < this.grid.structures!.get(s.obj)!.hp && (!team || this.seesPoint(team, s, Math.sqrt(s.cells.length)))) hurt.push([s.obj, Math.ceil(s.hp)]);
    const glim = team ? { glim: this.glim[team] } : { glim: 0, glims: { ...this.glim } };
    const snap: RtsSnap = { side: watch, ...glim, units, buildings, seeps, ...(hurt.length ? { hurt } : {}) };
    this.views.set(watch, { time: this.time, snap });
    return snap;
  }

  /** A blow's weight from where it is struck: harder from a step or more above (D-125). */
  private edge(u: Point, at: Point): number {
    return groundAt(this.grid, u.x, u.y) >= groundAt(this.grid, at.x, at.y) + 1 ? HIGH_GROUND_DAMAGE : 1;
  }

  /** Whether a side sees a point (`pad` cells round it): within sight of one of its units or buildings. */
  seesPoint(team: Team, p: Point, pad = 0): boolean {
    return seesArea(this.grid, this.sees[team], p.x, p.y, pad);
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
    case "raze": {
      const u = ids(c.u);
      return u && int(c.obj) ? { t: "raze", u, obj: c.obj as number } : null;
    }
    case "enter": {
      const u = ids(c.u);
      return u && int(c.obj) ? { t: "enter", u, obj: c.obj as number } : null;
    }
    case "leave":
      return int(c.obj) ? { t: "leave", obj: c.obj as number } : null;
    default:
      return null;
  }
}
