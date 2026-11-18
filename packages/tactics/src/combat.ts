import { CELL_TREES, CELL_WALL, CELL_WATER, boardCellAt, toWorld, type Board, type WorldQuery } from "@pixelworlds/engine";
import { objectInfo } from "./buildings";

/**
 * Turn-based combat on a board cut from a real city (D-150, D-151): the
 * rigs' squad against invaders who show what they will strike before they
 * strike.
 *
 * A round: the invaders have aimed (each one a direction, kept relative to
 * where it stands); the squad's rigs each move and act, in any order; then
 * each invader strikes in turn from wherever it now stands, so one pushed
 * round may strike another; then fire burns and evacuations end. Then the
 * invaders move and aim again. Everything is deterministic and plain data, so
 * a solver can search a turn and a server can run one.
 *
 * Buildings are structures with hit points and the people inside them (the
 * world's occupants, D-149), and roofs at their real heights (D-151): units
 * climb onto low ones and crawlers up any; one on a roof takes the strikes
 * meant for the building under it; a push off a roof is a fall; a shot from a
 * roof flies over lower ones; a building brought down drops what stood on it,
 * and a tall one topples along the line it was struck on, onto what stands
 * there. The squad wins a round by losing nobody. Water drowns what can't
 * fly; fire set on lawns and woods burns who stands there and the wooden
 * buildings beside it.
 */

/** Directions: north, east, south, west. */
export const DIRS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
export const DIR_NAMES = ["north", "east", "south", "west"] as const;

export const SQUAD = 0;
export const INVADERS = 1;

export interface Weapon {
  name: string;
  /**
   * `melee` strikes the next cell; `shot` the first thing along a line (over
   * roofs lower than the shooter); `lob` a cell 2+ away along a line, over
   * what lies between; `hoist` lifts the unit on the next cell onto a cell
   * within two (`Strike.to`); `evacuate` empties the next cell's building of
   * its people by the round's end.
   */
  kind: "melee" | "shot" | "lob" | "hoist" | "evacuate";
  damage: number;
  /** Melee and shots push what they strike on along the line; a lob pushes what stands round its target outward. */
  push: boolean;
  /** A lob's reach (cells). */
  range?: [number, number];
  /** Sets a burnable cell it strikes alight. */
  ignites?: boolean;
  /** Puts out fire on the cell it strikes. */
  douses?: boolean;
}

export interface Fighter {
  name: string;
  team: typeof SQUAD | typeof INVADERS;
  hp: number;
  move: number;
  /** The most it climbs between neighbouring cells (metres): rigs onto low roofs, crawlers up any wall. */
  climb: number;
  /** Crosses water, gaps and roofs, and isn't drowned or hurt by a fall. */
  flying?: boolean;
  /** Leaps from a roof across a street one cell wide to a roof about as high (two moves, D-157). */
  leaps?: boolean;
  /** Its weapons; an invader aims its first. */
  weapons: Weapon[];
}

export type FighterKind = "wrecker" | "pumper" | "crane" | "crawler" | "brute" | "flyer";

const EVACUATE: Weapon = { name: "evacuate", kind: "evacuate", damage: 0, push: false };

export const FIGHTERS: Readonly<Record<FighterKind, Fighter>> = {
  wrecker: { name: "Wrecker", team: SQUAD, leaps: true, hp: 3, move: 3, climb: 15, weapons: [{ name: "ram", kind: "melee", damage: 2, push: true }, EVACUATE] },
  pumper: { name: "Pumper", team: SQUAD, leaps: true, hp: 3, move: 3, climb: 15, weapons: [{ name: "water cannon", kind: "shot", damage: 1, push: true, douses: true }, EVACUATE] },
  crane: {
    name: "Crane",
    team: SQUAD,
    hp: 2,
    move: 3,
    climb: 15,
    weapons: [{ name: "drop", kind: "lob", damage: 1, push: true, range: [2, 4] }, { name: "hoist", kind: "hoist", damage: 0, push: false }, EVACUATE],
  },
  // tougher than a turn's strikes can bring down, mostly: the squad turns them, drowns them, drops them and puts them out of line
  crawler: { name: "Crawler", team: INVADERS, leaps: true, hp: 3, move: 3, climb: Infinity, weapons: [{ name: "bite", kind: "melee", damage: 1, push: false }] },
  brute: { name: "Brute", team: INVADERS, hp: 4, move: 2, climb: 4, weapons: [{ name: "slam", kind: "melee", damage: 2, push: true }] },
  flyer: { name: "Flyer", team: INVADERS, hp: 2, move: 4, climb: Infinity, flying: true, weapons: [{ name: "spit", kind: "shot", damage: 1, push: false, ignites: true }] },
};

/** How far a hoist sets a unit down from the crane (cells, along the streets). */
export const HOIST_REACH = 2;
/** The longest line a toppling building falls along (cells). */
export const TOPPLE_MAX = 4;

// ---------------------------------------------------------------- the arena

/** Arena cell flags. */
export const A_WATER = 1;
/** Lawn, woods, scrub: fire takes there. */
export const A_BURNS = 2;

/**
 * Fire (D-157): a cell burns for two rounds' ends (`Combat.fire` 1, then 2),
 * setting the burnable cells beside it alight at each, then burns out to ash
 * (`FIRE_ASH`), which doesn't burn again.
 */
export const FIRE_ASH = 3;
export const isBurning = (c: Pick<Combat, "fire">, k: number): boolean => c.fire[k] === 1 || c.fire[k] === 2;
/** Striking a unit from this far above it (metres) does a point more (D-157). */
export const HIGH_GROUND_M = 6;
/** How much higher or lower a roof a leap lands on may be (metres). */
export const LEAP_M = 6;

export interface Structure {
  /** The world object (`ObjectHit.index`), or −1. */
  object: number;
  name: string;
  hp: number;
  people: number;
  /** Fire beside it damages it each round. */
  flammable: boolean;
  /** Its cells. */
  cells: number[];
  /** How many cells it falls across when it topples (its height in cells, at most TOPPLE_MAX; 0 for one too low to topple). */
  topple: number;
}

/** What doesn't change in a fight: the ground, water, structures and roofs, row-major (`y · w + x`). */
export interface Arena {
  w: number;
  h: number;
  flags: Uint8Array;
  /** Ground height (steps). */
  height: Float32Array;
  /** Roof height (steps) on a structure's cells; the ground elsewhere. */
  roof: Float32Array;
  /** The structure on each cell, or −1. */
  struct: Int16Array;
  structures: Structure[];
  /** Metres up a step: what fighters climb and buildings stand in. */
  metersPerStep: number;
  /** The most a push carries a unit up (steps); the drop that hurts it, a point of damage each; how far up or down a melee strike reaches (steps). */
  climb: number;
  fall: number;
  reach: number;
}

/** Structure hit points by material strength (wood 1 … steel 4). */
const hpOf = (strength: number) => Math.max(1, Math.min(4, Math.round(strength)));

const BURNABLE = new Set(["forest", "woodland", "scrub", "grass", "lawn", "yard", "farmland"]);

/**
 * An arena from a board cut from the world (D-148): its water, its walled
 * cells as structures (each wall object one, with hit points by material,
 * its people (D-149), its roof's real height and how far it topples), its
 * burnable lawns and woods, and its heights.
 */
export function arenaFromBoard(
  b: Board,
  query: Pick<WorldQuery, "object">,
  surfaces: Record<string, string>,
  opts: { metersPerCell: number; climbMeters?: number; fallMeters?: number; reachMeters?: number },
): Arena {
  const n = b.w * b.h;
  const flags = new Uint8Array(n);
  const struct = new Int16Array(n).fill(-1);
  const roof = Float32Array.from(b.height);
  const structures: Structure[] = [];
  const ids = new Map<number, number>();
  const step = b.metersPerStep;
  for (let i = 0; i < n; i++) {
    if (b.flags[i]! & CELL_WATER) flags[i]! |= A_WATER;
    else if (b.flags[i]! & CELL_TREES || BURNABLE.has(surfaces[String(b.surface[i])] ?? "")) flags[i]! |= A_BURNS;
    if (!(b.flags[i]! & CELL_WALL)) continue;
    // the wall standing tallest on it
    let wall = -1;
    let top = -Infinity;
    for (const o of b.objects.get(i) ?? []) if (o.wall && o.top > top) [wall, top] = [o.index, o.top];
    let id = ids.get(wall);
    if (id === undefined) {
      const inst = wall >= 0 ? query.object(wall) : null;
      const info = inst ? objectInfo(inst, { metersPerCell: opts.metersPerCell }) : null;
      id = structures.length;
      ids.set(wall, id);
      structures.push({
        object: wall,
        name: inst?.g ?? "wall",
        hp: info ? hpOf(info.strength) : 2,
        people: info?.occupants ?? 0,
        flammable: (info?.flammability ?? 0) >= 0.6,
        cells: [],
        topple: 0,
      });
    }
    struct[i] = id;
    roof[i] = Math.max(b.height[i]!, top);
    structures[id]!.cells.push(i);
  }
  for (const s of structures) {
    // its height in board cells: a tower falls far, a house not at all
    const tall = Math.max(...s.cells.map((k) => roof[k]! - b.height[k]!)) * step / b.metersPerCell;
    s.topple = tall >= 1.5 ? Math.min(TOPPLE_MAX, Math.round(tall)) : 0;
  }
  return {
    w: b.w,
    h: b.h,
    flags,
    height: Float32Array.from(b.height),
    roof,
    struct,
    structures,
    metersPerStep: step,
    climb: Math.max(1, Math.round((opts.climbMeters ?? 4) / step)),
    fall: Math.max(1, Math.round((opts.fallMeters ?? 8) / step)),
    reach: Math.max(1, Math.round((opts.reachMeters ?? 6) / step)),
  };
}

// ---------------------------------------------------------------- a fight

/** An invader due to arrive: its kind and cell. */
export interface Arrival {
  kind: FighterKind;
  at: number;
}

/** A fight's state: the units (by their place in `roster`, which grows as invaders arrive), the structures' hit points and people, and the fires. */
export interface Combat {
  readonly arena: Arena;
  roster: FighterKind[];
  /**
   * Who arrives at the end of each round (`schedule[r]` at round r's end,
   * the first round 0), shown a round ahead: a unit standing on the cell
   * blocks the arrival and takes a point for it. Shared by clones.
   */
  readonly schedule: readonly (readonly Arrival[])[];
  /** Rounds ended so far. */
  round: number;
  /** Each unit's cell (kept after it falls), hit points (0: down), and aim: a direction, or −1; and a lob's reach. */
  pos: Int16Array;
  hp: Int8Array;
  aim: Int8Array;
  reach: Int8Array;
  /** The unit on each cell (on the ground, or on the roof of a building standing there), or −1. */
  occ: Int8Array;
  structHp: Int8Array;
  /** Structures being emptied this round, and those empty: hits on them cost no people. */
  evacuating: Uint8Array;
  evacuated: Uint8Array;
  fire: Uint8Array;
  /** Since the fight began: people lost, and structure hit points lost. */
  lost: number;
  razed: number;
}

/** An action's aim: a weapon (by its place in the fighter's), a direction, how far for a lob (1 otherwise), and where a hoist sets down. */
export interface Strike {
  weapon: number;
  dir: number;
  range: number;
  to?: number;
}

export type CombatEvent =
  | { t: "move"; unit: number; from: number; to: number }
  | { t: "strike"; unit: number; at: number; weapon: number }
  | { t: "push"; unit: number; from: number; to: number }
  | { t: "bump"; unit: number; at: number }
  | { t: "fall"; unit: number; drop: number }
  | { t: "damage"; unit: number; amount: number }
  | { t: "down"; unit: number; at: number; drowned: boolean }
  | { t: "structure"; id: number; amount: number; destroyed: boolean; people: number }
  | { t: "topple"; id: number; dir: number; cells: number[] }
  | { t: "crush"; at: number }
  | { t: "hoist"; unit: number; from: number; to: number }
  | { t: "evacuate"; id: number }
  | { t: "ignite"; at: number }
  | { t: "douse"; at: number }
  | { t: "burnout"; at: number }
  | { t: "arrive"; unit: number; at: number }
  | { t: "blocked"; unit: number; at: number };

type Log = CombatEvent[] | undefined;

export function newCombat(arena: Arena, units: readonly { kind: FighterKind; at: number }[], schedule: readonly (readonly Arrival[])[] = []): Combat {
  const n = arena.w * arena.h;
  const ns = arena.structures.length;
  const c: Combat = {
    arena,
    roster: units.map((u) => u.kind),
    schedule,
    round: 0,
    pos: Int16Array.from(units.map((u) => u.at)),
    hp: Int8Array.from(units.map((u) => FIGHTERS[u.kind].hp)),
    aim: new Int8Array(units.length).fill(-1),
    reach: new Int8Array(units.length).fill(1),
    occ: new Int8Array(n).fill(-1),
    structHp: Int8Array.from(arena.structures.map((s) => s.hp)),
    evacuating: new Uint8Array(ns),
    evacuated: new Uint8Array(ns),
    fire: new Uint8Array(n),
    lost: 0,
    razed: 0,
  };
  units.forEach((u, i) => {
    if (c.occ[u.at]! >= 0) throw new Error(`two units on cell ${u.at}`);
    c.occ[u.at] = i;
  });
  return c;
}

export function cloneCombat(c: Combat): Combat {
  return {
    arena: c.arena,
    roster: c.roster.slice(),
    schedule: c.schedule,
    round: c.round,
    pos: c.pos.slice(),
    hp: c.hp.slice(),
    aim: c.aim.slice(),
    reach: c.reach.slice(),
    occ: c.occ.slice(),
    structHp: c.structHp.slice(),
    evacuating: c.evacuating.slice(),
    evacuated: c.evacuated.slice(),
    fire: c.fire.slice(),
    lost: c.lost,
    razed: c.razed,
  };
}

export const teamOf = (c: Combat, u: number) => FIGHTERS[c.roster[u]!].team;

/** The invaders arriving at this round's end. */
export const arriving = (c: Combat): readonly Arrival[] => c.schedule[c.round] ?? [];

/** Add a unit to a fight (an arrival): the roster and each unit's arrays grow by one. */
export function addUnit(c: Combat, kind: FighterKind, at: number): number {
  const u = c.roster.length;
  const grow = <T extends Int8Array | Int16Array>(a: T, v: number): T => {
    const b = new (a.constructor as new (n: number) => T)(a.length + 1);
    b.set(a);
    b[a.length] = v;
    return b;
  };
  c.roster.push(kind);
  c.pos = grow(c.pos, at);
  c.hp = grow(c.hp, FIGHTERS[kind].hp);
  c.aim = grow(c.aim, -1);
  c.reach = grow(c.reach, 1);
  c.occ[at] = u;
  return u;
}
export const alive = (c: Combat, u: number) => c.hp[u]! > 0;

/** The cell a step from k in a direction, or −1 off the arena. */
export function step(a: Arena, k: number, dir: number, by = 1): number {
  const x = (k % a.w) + DIRS[dir]![0] * by;
  const y = Math.floor(k / a.w) + DIRS[dir]![1] * by;
  return x < 0 || y < 0 || x >= a.w || y >= a.h ? -1 : y * a.w + x;
}

/** The standing structure on a cell, or −1. */
export function structureAt(c: Combat, k: number): number {
  const s = c.arena.struct[k]!;
  return s >= 0 && c.structHp[s]! > 0 ? s : -1;
}

/** Where one stands on a cell (steps): a standing building's roof, else the ground (a fallen one's rubble). */
export function standAt(c: Combat, k: number): number {
  return structureAt(c, k) >= 0 ? c.arena.roof[k]! : c.arena.height[k]!;
}

/**
 * The cells of an arena its own buildings hide from one side of the city
 * view (D-169), as they stand: down each cell's view ray, from where a unit
 * there would stand toward the camera (`toward`: the diagonal the view looks
 * along, a world cell across each way rising two steps), the first cell of
 * another of its buildings whose roof is above the ray.
 */
export function hiddenFrom(b: Board, a: Arena, toward: readonly [number, number]): Uint8Array {
  const out = new Uint8Array(a.w * a.h);
  for (let k = 0; k < a.w * a.h; k++) {
    const p = toWorld(b, { x: (k % a.w) + 0.5, y: Math.floor(k / a.w) + 0.5 });
    const h = a.roof[k]!;
    for (let t = 0.25; ; t += 0.25) {
      const q = boardCellAt(b, p.x + t * toward[0], p.y + t * toward[1]);
      if (q < 0) break;
      if (a.struct[q]! >= 0 && a.struct[q] !== a.struct[k] && a.roof[q]! > h + 2 * t) {
        out[k] = 1;
        break;
      }
    }
  }
  return out;
}

/** Whether a unit could move from a cell onto a neighbour: no water for one that walks, and a climb within its reach. */
function enterable(c: Combat, u: number, from: number, k: number): boolean {
  const f = FIGHTERS[c.roster[u]!];
  if (f.flying) return true;
  if (c.arena.flags[k]! & A_WATER && structureAt(c, k) < 0) return false;
  return Math.abs(standAt(c, k) - standAt(c, from)) * c.arena.metersPerStep <= f.climb;
}

/**
 * The cells a unit can move to this turn (its own included): through its own
 * side's units, not the other's, ending on an empty cell; a step a move, a
 * leap from roof to roof across a street two (D-157).
 */
export function movesOf(c: Combat, u: number): number[] {
  const a = c.arena;
  const dist = new Int8Array(a.w * a.h).fill(-1);
  const start = c.pos[u]!;
  const team = teamOf(c, u);
  const f = FIGHTERS[c.roster[u]!];
  const queue = [start];
  dist[start] = 0;
  const seen = new Uint8Array(a.w * a.h);
  seen[start] = 1;
  const out: number[] = [start];
  const reach = (k: number, nk: number, cost: number) => {
    const nd = dist[k]! + cost;
    if (nd > f.move || (dist[nk]! >= 0 && dist[nk]! <= nd)) return;
    const o = c.occ[nk]!;
    if (o >= 0 && teamOf(c, o) !== team) return;
    dist[nk] = nd;
    queue.push(nk);
    if (o < 0 && !seen[nk]) {
      seen[nk] = 1;
      out.push(nk);
    }
  };
  for (let q = 0; q < queue.length; q++) {
    const k = queue[q]!;
    for (let d = 0; d < 4; d++) {
      const nk = step(a, k, d);
      if (nk >= 0 && enterable(c, u, k, nk)) reach(k, nk, 1);
      if (f.leaps && !f.flying) {
        const far = nk >= 0 ? step(a, nk, d) : -1;
        if (far >= 0 && leapable(c, k, nk, far)) reach(k, far, 2);
      }
    }
  }
  return out;
}

/** A leap from roof k over cell mid to roof far: a street between (lower than both), and the roofs within LEAP_M of each other. */
function leapable(c: Combat, k: number, mid: number, far: number): boolean {
  if (structureAt(c, k) < 0 || structureAt(c, far) < 0) return false;
  const hk = standAt(c, k);
  const hf = standAt(c, far);
  return standAt(c, mid) < Math.min(hk, hf) && Math.abs(hk - hf) * c.arena.metersPerStep <= LEAP_M;
}

/** Cells a hoist from a cell may set a unit down on: within HOIST_REACH along the streets, empty, and not the crane's own. */
export function hoistCells(c: Combat, from: number): number[] {
  const a = c.arena;
  const out: number[] = [];
  const x0 = from % a.w;
  const y0 = Math.floor(from / a.w);
  for (let y = Math.max(0, y0 - HOIST_REACH); y <= Math.min(a.h - 1, y0 + HOIST_REACH); y++)
    for (let x = Math.max(0, x0 - HOIST_REACH); x <= Math.min(a.w - 1, x0 + HOIST_REACH); x++) {
      const k = y * a.w + x;
      if (k !== from && Math.abs(x - x0) + Math.abs(y - y0) <= HOIST_REACH && c.occ[k]! < 0) out.push(k);
    }
  return out;
}

/** A unit's strikes from where it stands, every weapon's (those that land on the arena; a hoist's for each cell it may set down on). */
export function strikesOf(c: Combat, u: number): Strike[] {
  const f = FIGHTERS[c.roster[u]!];
  const from = c.pos[u]!;
  const out: Strike[] = [];
  f.weapons.forEach((w, weapon) => {
    for (let dir = 0; dir < 4; dir++) {
      if (w.kind === "lob") {
        for (let r = w.range![0]; r <= w.range![1]; r++) if (step(c.arena, from, dir, r) >= 0) out.push({ weapon, dir, range: r });
        continue;
      }
      const t = step(c.arena, from, dir);
      if (t < 0) continue;
      if (w.kind === "hoist") {
        if (c.occ[t]! >= 0) for (const to of hoistCells(c, from)) out.push({ weapon, dir, range: 1, to });
      } else if (w.kind !== "evacuate" || (structureAt(c, t) >= 0 && !c.evacuated[structureAt(c, t)] && !c.evacuating[structureAt(c, t)])) {
        out.push({ weapon, dir, range: 1 });
      }
    }
  });
  return out;
}

/** The first thing along a line from a cell that a shot from a height stops at: a unit, or a building taller than the shooter. −1 for none. */
export function shotStop(c: Combat, from: number, dir: number, height: number): number {
  for (let k = step(c.arena, from, dir); k >= 0; k = step(c.arena, k, dir)) {
    if (c.occ[k]! >= 0) return k;
    if (structureAt(c, k) >= 0 && c.arena.roof[k]! > height) return k;
  }
  return -1;
}

/** Where a unit's strike lands from where it stands now: its target cell, or −1 (a shot that meets nothing). */
export function strikeCell(c: Combat, u: number, s: Strike): number {
  const w = FIGHTERS[c.roster[u]!].weapons[s.weapon]!;
  const from = c.pos[u]!;
  return w.kind === "shot" ? shotStop(c, from, s.dir, standAt(c, from)) : step(c.arena, from, s.dir, w.kind === "lob" ? s.range : 1);
}

/** An invader's aimed strike. */
export const aimOf = (c: Combat, u: number): Strike => ({ weapon: 0, dir: c.aim[u]!, range: c.reach[u]! });

export function moveUnit(c: Combat, u: number, to: number, log?: Log): void {
  const from = c.pos[u]!;
  if (from === to) return;
  c.occ[from] = -1;
  c.occ[to] = u;
  c.pos[u] = to;
  log?.push({ t: "move", unit: u, from, to });
}

function hurt(c: Combat, u: number, amount: number, log: Log, drowned = false): void {
  if (c.hp[u]! <= 0 || amount <= 0) return;
  c.hp[u] = Math.max(0, c.hp[u]! - amount);
  log?.push({ t: "damage", unit: u, amount });
  if (c.hp[u]! > 0) return;
  c.occ[c.pos[u]!] = -1;
  log?.push({ t: "down", unit: u, at: c.pos[u]!, drowned });
}

/** A unit drops from one height to a lower one: a point of damage each `fall` steps (fliers glide down). */
function drop(c: Combat, u: number, from: number, to: number, log: Log): void {
  const d = from - to;
  if (FIGHTERS[c.roster[u]!].flying || d < c.arena.fall) return;
  log?.push({ t: "fall", unit: u, drop: d });
  hurt(c, u, Math.floor(d / c.arena.fall), log);
}

/**
 * Damage a structure (from a direction, at one of its cells): its people
 * lost by its share (none once evacuated). Brought down, what stood on its
 * roof falls to the ground, and a tall one topples along the direction it
 * was struck in, crushing what stands on the cells it falls across.
 */
function hurtStructure(c: Combat, id: number, amount: number, dir: number, at: number, log: Log): void {
  const hp = c.structHp[id]!;
  if (hp <= 0) return;
  const lost = Math.min(amount, hp);
  const s = c.arena.structures[id]!;
  c.structHp[id] = hp - lost;
  c.razed += lost;
  const people = c.evacuated[id] ? 0 : (s.people * lost) / s.hp;
  c.lost += people;
  const destroyed = hp - lost <= 0;
  log?.push({ t: "structure", id, amount: lost, destroyed, people });
  if (!destroyed) return;
  const a = c.arena;
  for (const k of s.cells) {
    const u = c.occ[k]!;
    if (u >= 0) drop(c, u, a.roof[k]!, a.height[k]!, log);
  }
  if (dir < 0 || !s.topple) return;
  const cells: number[] = [];
  for (let i = 1, k = step(a, at, dir); k >= 0 && cells.length < s.topple; i++, k = step(a, at, dir, i)) if (a.struct[k] !== id) cells.push(k);
  log?.push({ t: "topple", id, dir, cells });
  for (const k of cells) {
    log?.push({ t: "crush", at: k });
    const u = c.occ[k]!;
    if (u >= 0) hurt(c, u, 2, log);
    const sid = structureAt(c, k);
    if (sid >= 0) hurtStructure(c, sid, 1, dir, k, log); // and it may topple on in turn
  }
}

/** Push what stands on a cell one along a direction: it bumps into a unit or a wall too high to be pushed up (both hurt), drops off a height, or into water. */
function push(c: Combat, k: number, dir: number, log: Log): void {
  const u = c.occ[k]!;
  if (u < 0) return;
  const a = c.arena;
  const to = step(a, k, dir);
  if (to < 0) return; // the arena's edge holds
  const other = c.occ[to]!;
  const flying = FIGHTERS[c.roster[u]!].flying;
  const from = standAt(c, k);
  const onto = standAt(c, to);
  if (other >= 0 || (!flying && onto - from > a.climb)) {
    log?.push({ t: "bump", unit: u, at: to });
    hurt(c, u, 1, log);
    if (other >= 0) hurt(c, other, 1, log);
    else {
      const sid = structureAt(c, to);
      if (sid >= 0) hurtStructure(c, sid, 1, dir, to, log);
    }
    return;
  }
  c.occ[k] = -1;
  c.occ[to] = u;
  c.pos[u] = to;
  log?.push({ t: "push", unit: u, from: k, to });
  if (flying) return;
  if (a.flags[to]! & A_WATER && structureAt(c, to) < 0) return hurt(c, u, c.hp[u]!, log, true);
  drop(c, u, from, onto, log);
  if (isBurning(c, to)) hurt(c, u, 1, log);
}

/** A unit strikes from where it stands. */
export function strike(c: Combat, u: number, s: Strike, log?: Log): void {
  if (c.hp[u]! <= 0) return;
  const a = c.arena;
  const w = FIGHTERS[c.roster[u]!].weapons[s.weapon]!;
  const from = c.pos[u]!;
  const k = strikeCell(c, u, s);
  if (k < 0) return;
  log?.push({ t: "strike", unit: u, at: k, weapon: s.weapon });
  if (w.kind === "evacuate") {
    const sid = structureAt(c, k);
    if (sid >= 0 && !c.evacuated[sid]) {
      c.evacuating[sid] = 1;
      log?.push({ t: "evacuate", id: sid });
    }
    return;
  }
  if (w.kind === "hoist") {
    const v = c.occ[k]!;
    const to = s.to ?? -1;
    if (v < 0 || to < 0 || c.occ[to]! >= 0) return;
    c.occ[k] = -1;
    c.occ[to] = v;
    c.pos[v] = to;
    log?.push({ t: "hoist", unit: v, from: k, to });
    if (!FIGHTERS[c.roster[v]!].flying && a.flags[to]! & A_WATER && structureAt(c, to) < 0) hurt(c, v, c.hp[v]!, log, true);
    else if (isBurning(c, to)) hurt(c, v, 1, log);
    return;
  }
  if (w.douses && isBurning(c, k)) {
    c.fire[k] = 0;
    log?.push({ t: "douse", at: k });
  }
  const v = c.occ[k]!;
  // a melee strike reaches a unit only so far up or down: past that, it strikes the wall of the building under it
  const reaches = v >= 0 && (w.kind !== "melee" || Math.abs(standAt(c, k) - standAt(c, from)) <= a.reach);
  if (reaches) {
    // from high ground, a point more
    const above = w.damage > 0 && (standAt(c, from) - standAt(c, k)) * a.metersPerStep >= HIGH_GROUND_M;
    hurt(c, v, w.damage + (above ? 1 : 0), log);
    if (w.kind !== "lob" && w.push && c.hp[v]! > 0) push(c, k, s.dir, log);
  } else {
    const sid = structureAt(c, k);
    if (sid >= 0) hurtStructure(c, sid, w.damage, s.dir, k, log);
  }
  if (w.kind === "lob" && w.push)
    for (let d = 0; d < 4; d++) {
      const nk = step(a, k, d);
      if (nk >= 0 && c.occ[nk]! >= 0) push(c, nk, d, log);
    }
  if (w.ignites && a.flags[k]! & A_BURNS && structureAt(c, k) < 0 && c.fire[k] === 0) {
    c.fire[k] = 1;
    log?.push({ t: "ignite", at: k });
  }
}

/** A rig's turn: it moves, then acts (or doesn't). */
export function act(c: Combat, u: number, dest: number, s: Strike | null, log?: Log): void {
  moveUnit(c, u, dest, log);
  if (s) strike(c, u, s, log);
}

/** The invaders strike as they aimed, in order, each from where it stands now. */
export function resolveInvaders(c: Combat, log?: Log): void {
  for (let u = 0; u < c.roster.length; u++) if (teamOf(c, u) === INVADERS && c.hp[u]! > 0 && c.aim[u]! >= 0) strike(c, u, aimOf(c, u), log);
}

/**
 * The round's end: fire burns who stands in it and the wooden buildings
 * beside it; buildings being evacuated are empty; the round's invaders
 * arrive, but where a unit stands, which takes a point for blocking it.
 */
export function endRound(c: Combat, log?: Log): void {
  const a = c.arena;
  const burnt = new Set<number>();
  const lit = new Set<number>();
  for (let k = 0; k < c.fire.length; k++) {
    if (!isBurning(c, k)) continue;
    const u = c.occ[k]!;
    if (u >= 0) hurt(c, u, 1, log);
    for (let d = 0; d < 4; d++) {
      const nk = step(a, k, d);
      const sid = structureAt(c, nk);
      if (sid >= 0 && a.structures[sid]!.flammable && !burnt.has(sid)) {
        burnt.add(sid);
        hurtStructure(c, sid, 1, -1, -1, log);
      }
      // the fire spreads to the burnable ground beside it (D-157)
      if (nk >= 0 && sid < 0 && a.flags[nk]! & A_BURNS && c.fire[nk] === 0) lit.add(nk);
    }
  }
  for (let k = 0; k < c.fire.length; k++)
    if (isBurning(c, k) && ++c.fire[k]! === FIRE_ASH) log?.push({ t: "burnout", at: k });
  for (const k of lit) {
    c.fire[k] = 1;
    log?.push({ t: "ignite", at: k });
  }
  for (let s = 0; s < c.evacuating.length; s++)
    if (c.evacuating[s]) {
      c.evacuated[s] = 1;
      c.evacuating[s] = 0;
    }
  for (const { kind, at } of arriving(c)) {
    const u = c.occ[at]!;
    if (u >= 0) {
      log?.push({ t: "blocked", unit: u, at });
      hurt(c, u, 1, log);
    } else if (structureAt(c, at) < 0) {
      const v = addUnit(c, kind, at); // not inside the log's push: with no log, `?.` would skip it
      log?.push({ t: "arrive", unit: v, at });
    }
  }
  c.round++;
}

// ---------------------------------------------------------------- the invaders

/**
 * What an invader's strike would do right now, to it: buildings hit most (10
 * a hit), a rig's damage (6 a point), its own side's (−10 a point).
 */
function aimValue(c: Combat, u: number, s: Strike): number {
  const n = cloneCombat(c);
  strike(n, u, s);
  let value = 10 * (n.razed - c.razed);
  for (let v = 0; v < c.roster.length; v++) if (v !== u) value += (c.hp[v]! - n.hp[v]!) * (teamOf(c, v) === SQUAD ? 6 : -10);
  return value;
}

/**
 * The invaders move and aim, in order: each where its strike would do the
 * most (a building over a rig, never its own side), nearer moves first; one
 * with nothing worth striking heads for the nearest building and doesn't aim.
 */
export function planInvaders(c: Combat): void {
  const a = c.arena;
  for (let u = 0; u < c.roster.length; u++) {
    if (teamOf(c, u) !== INVADERS || c.hp[u]! <= 0) continue;
    const from = c.pos[u]!;
    let best: { dest: number; s: Strike | null; value: number } = { dest: from, s: null, value: 0 };
    for (const dest of movesOf(c, u)) {
      if (isBurning(c, dest)) continue;
      moveUnit(c, u, dest);
      for (const s of strikesOf(c, u)) {
        // a little for staying put, and a stable jitter so ties don't all go north
        const value = aimValue(c, u, s) - 0.01 * manhattan(a, from, dest) + ((dest * 31 + s.dir * 7) % 13) / 1000;
        if (value > best.value) best = { dest, s, value };
      }
      moveUnit(c, u, from);
    }
    if (!best.s) {
      // nothing to strike: toward the nearest standing building
      let near = Infinity;
      for (const dest of movesOf(c, u))
        for (let k = 0; k < a.struct.length; k++)
          if (structureAt(c, k) >= 0 && manhattan(a, dest, k) < near) [near, best.dest] = [manhattan(a, dest, k), dest];
    }
    moveUnit(c, u, best.dest);
    c.aim[u] = best.s ? best.s.dir : -1;
    c.reach[u] = best.s ? best.s.range : 1;
  }
}

function manhattan(a: Arena, p: number, q: number): number {
  return Math.abs((p % a.w) - (q % a.w)) + Math.abs(Math.floor(p / a.w) - Math.floor(q / a.w));
}

// ---------------------------------------------------------------- outcomes

export interface Outcome {
  /** People lost, and structure hit points lost (empty buildings' too). */
  lost: number;
  razed: number;
  /** Rigs down, and their hit points lost. */
  rigsDown: number;
  rigDamage: number;
  /** Invaders down, and their hit points lost. */
  kills: number;
  invaderDamage: number;
  /** Nobody lost, and no rig down. */
  perfect: boolean;
  score: number;
}

/** People lost below this count as none (shares of a building's people are fractions). */
export const NOBODY = 1e-6;

/** How a fight went from one state to a later one. */
export function outcome(from: Combat, to: Combat): Outcome {
  let rigsDown = 0;
  let rigDamage = 0;
  let kills = 0;
  let invaderDamage = 0;
  for (let u = 0; u < from.roster.length; u++) {
    const lost = from.hp[u]! - to.hp[u]!;
    const down = from.hp[u]! > 0 && to.hp[u]! <= 0 ? 1 : 0;
    if (teamOf(from, u) === SQUAD) {
      rigsDown += down;
      rigDamage += lost;
    } else {
      kills += down;
      invaderDamage += lost;
    }
  }
  const razed = to.razed - from.razed;
  const lost = to.lost - from.lost;
  return {
    lost,
    razed,
    rigsDown,
    rigDamage,
    kills,
    invaderDamage,
    perfect: lost <= NOBODY && rigsDown === 0,
    score: -10 * lost - 100 * razed - 400 * rigsDown - 20 * rigDamage + 60 * kills + 8 * invaderDamage,
  };
}

/** A state's hash (positions, hit points, structures, evacuations, fires): two lanes of FNV-1a, as one whole number below 2^49 (room for flags above it). */
export function hashCombat(c: Combat): number {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const mix = (v: number) => {
    h1 = Math.imul(h1 ^ (v & 0xffff), 0x01000193);
    h2 = Math.imul(h2 ^ (v & 0xffff), 0x5bd1e995) ^ (h2 >>> 13);
  };
  mix(c.round + 60000);
  for (const v of c.pos) mix(v);
  for (const v of c.hp) mix(v + 7);
  for (const v of c.structHp) mix(v + 31);
  for (let s = 0; s < c.evacuating.length; s++) if (c.evacuating[s] || c.evacuated[s]) mix(s * 4 + c.evacuating[s]! * 2 + c.evacuated[s]! + 8191);
  for (let k = 0; k < c.fire.length; k++) if (c.fire[k]) mix(k * 4 + c.fire[k]! + 4099);
  return (h1 >>> 0) * 131072 + ((h2 >>> 0) & 0x1ffff);
}
