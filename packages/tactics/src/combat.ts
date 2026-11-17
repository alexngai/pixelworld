import { CELL_TREES, CELL_WALL, CELL_WATER, type Board, type WorldQuery } from "@pixelworlds/engine";
import { objectInfo } from "./buildings";

/**
 * Turn-based combat on a board cut from a real city (D-150): the rigs'
 * squad against invaders who show what they will strike before they strike.
 *
 * A round: the invaders have aimed (each one a direction, kept relative to
 * where it stands); the squad's rigs each move and strike, in any order;
 * then each invader strikes in turn from wherever it now stands, so one
 * pushed round may strike another; then fire burns. Then the invaders move
 * and aim again. Everything is deterministic and plain data, so a solver can
 * search a turn and a server can run one.
 *
 * Buildings are structures with hit points and the people inside them (the
 * world's occupants, D-149): the squad wins a round by losing none. Water
 * drowns what can't fly; a drop off high ground hurts; fire set on lawns and
 * woods burns who stands there and the wooden buildings beside it.
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
  /** `melee` strikes the next cell; `shot` the first thing along a line; `lob` a cell 2+ away along a line, over what lies between. */
  kind: "melee" | "shot" | "lob";
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
  /** Crosses water and drops, and isn't drowned. */
  flying?: boolean;
  weapon: Weapon;
}

export type FighterKind = "wrecker" | "pumper" | "crane" | "crawler" | "brute" | "flyer";

export const FIGHTERS: Readonly<Record<FighterKind, Fighter>> = {
  wrecker: { name: "Wrecker", team: SQUAD, hp: 3, move: 3, weapon: { name: "ram", kind: "melee", damage: 2, push: true } },
  pumper: { name: "Pumper", team: SQUAD, hp: 3, move: 3, weapon: { name: "water cannon", kind: "shot", damage: 1, push: true, douses: true } },
  crane: { name: "Crane", team: SQUAD, hp: 2, move: 3, weapon: { name: "drop", kind: "lob", damage: 1, push: true, range: [2, 4] } },
  // tougher than a turn's strikes can bring down, mostly: the squad turns them, drowns them, and puts them out of line
  crawler: { name: "Crawler", team: INVADERS, hp: 3, move: 3, weapon: { name: "bite", kind: "melee", damage: 1, push: false } },
  brute: { name: "Brute", team: INVADERS, hp: 4, move: 2, weapon: { name: "slam", kind: "melee", damage: 2, push: true } },
  flyer: { name: "Flyer", team: INVADERS, hp: 2, move: 4, flying: true, weapon: { name: "spit", kind: "shot", damage: 1, push: false, ignites: true } },
};

// ---------------------------------------------------------------- the arena

/** Arena cell flags. */
export const A_WATER = 1;
/** Lawn, woods, scrub: fire takes there. */
export const A_BURNS = 2;

export interface Structure {
  /** The world object (`ObjectHit.index`), or −1. */
  object: number;
  name: string;
  hp: number;
  people: number;
  /** Fire beside it damages it each round. */
  flammable: boolean;
}

/** What doesn't change in a fight: the ground, water and structures, row-major (`y · w + x`). */
export interface Arena {
  w: number;
  h: number;
  flags: Uint8Array;
  /** Ground height (steps). */
  height: Float32Array;
  /** The structure on each cell, or −1. */
  struct: Int16Array;
  structures: Structure[];
  /** The most a unit climbs between cells, and the drop that hurts it, a point of damage each (steps). */
  climb: number;
  fall: number;
}

/** Structure hit points by material strength (wood 1 … steel 4). */
const hpOf = (strength: number) => Math.max(1, Math.min(4, Math.round(strength)));

const BURNABLE = new Set(["forest", "woodland", "scrub", "grass", "lawn", "yard", "farmland"]);

/**
 * An arena from a board cut from the world (D-148): its water, its walled
 * cells as structures (each wall object one, with hit points by material
 * and its people, D-149), its burnable lawns and woods, and its heights.
 */
export function arenaFromBoard(
  b: Board,
  query: Pick<WorldQuery, "object">,
  surfaces: Record<string, string>,
  opts: { metersPerCell: number; climbMeters?: number; fallMeters?: number },
): Arena {
  const n = b.w * b.h;
  const flags = new Uint8Array(n);
  const struct = new Int16Array(n).fill(-1);
  const structures: Structure[] = [];
  const ids = new Map<number, number>();
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
      });
    }
    struct[i] = id;
  }
  const step = b.metersPerStep;
  return {
    w: b.w,
    h: b.h,
    flags,
    height: Float32Array.from(b.height),
    struct,
    structures,
    climb: Math.max(1, Math.round((opts.climbMeters ?? 4) / step)),
    fall: Math.max(1, Math.round((opts.fallMeters ?? 8) / step)),
  };
}

// ---------------------------------------------------------------- a fight

/** A fight's state: the units (by their place in `roster`), the structures' hit points and the fires. */
export interface Combat {
  readonly arena: Arena;
  readonly roster: readonly FighterKind[];
  /** Each unit's cell (kept after it falls), hit points (0: down), and aim: a direction, or −1; and a lob's reach. */
  pos: Int16Array;
  hp: Int8Array;
  aim: Int8Array;
  reach: Int8Array;
  /** The unit on each cell, or −1. */
  occ: Int8Array;
  structHp: Int8Array;
  fire: Uint8Array;
  /** Since the fight began: people lost, and structure hit points lost. */
  lost: number;
  razed: number;
}

/** A strike: its direction, and how far for a lob (1 otherwise). */
export interface Strike {
  dir: number;
  range: number;
}

export type CombatEvent =
  | { t: "move"; unit: number; from: number; to: number }
  | { t: "strike"; unit: number; at: number }
  | { t: "push"; unit: number; from: number; to: number }
  | { t: "bump"; unit: number; at: number }
  | { t: "damage"; unit: number; amount: number }
  | { t: "down"; unit: number; at: number; drowned: boolean }
  | { t: "structure"; id: number; amount: number; destroyed: boolean; people: number }
  | { t: "ignite"; at: number }
  | { t: "douse"; at: number };

type Log = CombatEvent[] | undefined;

export function newCombat(arena: Arena, units: readonly { kind: FighterKind; at: number }[]): Combat {
  const n = arena.w * arena.h;
  const c: Combat = {
    arena,
    roster: units.map((u) => u.kind),
    pos: Int16Array.from(units.map((u) => u.at)),
    hp: Int8Array.from(units.map((u) => FIGHTERS[u.kind].hp)),
    aim: new Int8Array(units.length).fill(-1),
    reach: new Int8Array(units.length).fill(1),
    occ: new Int8Array(n).fill(-1),
    structHp: Int8Array.from(arena.structures.map((s) => s.hp)),
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
    roster: c.roster,
    pos: c.pos.slice(),
    hp: c.hp.slice(),
    aim: c.aim.slice(),
    reach: c.reach.slice(),
    occ: c.occ.slice(),
    structHp: c.structHp.slice(),
    fire: c.fire.slice(),
    lost: c.lost,
    razed: c.razed,
  };
}

export const teamOf = (c: Combat, u: number) => FIGHTERS[c.roster[u]!].team;
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

/** Whether a unit could stand on a cell (nothing standing there, no water for one that walks), and climb into it from `from`. */
function enterable(c: Combat, u: number, from: number, k: number): boolean {
  if (structureAt(c, k) >= 0) return false;
  if (FIGHTERS[c.roster[u]!].flying) return true;
  const a = c.arena;
  return !(a.flags[k]! & A_WATER) && Math.abs(a.height[k]! - a.height[from]!) <= a.climb;
}

/** The cells a unit can move to this turn (its own included): through its own side's units, not the other's, ending on an empty cell. */
export function movesOf(c: Combat, u: number): number[] {
  const a = c.arena;
  const n = a.w * a.h;
  const dist = new Int8Array(n).fill(-1);
  const start = c.pos[u]!;
  const team = teamOf(c, u);
  const move = FIGHTERS[c.roster[u]!].move;
  const queue = [start];
  dist[start] = 0;
  const out: number[] = [start];
  for (let q = 0; q < queue.length; q++) {
    const k = queue[q]!;
    if (dist[k]! >= move) continue;
    for (let d = 0; d < 4; d++) {
      const nk = step(a, k, d);
      if (nk < 0 || dist[nk]! >= 0 || !enterable(c, u, k, nk)) continue;
      const o = c.occ[nk]!;
      if (o >= 0 && teamOf(c, o) !== team) continue;
      dist[nk] = dist[k]! + 1;
      queue.push(nk);
      if (o < 0) out.push(nk);
    }
  }
  return out;
}

/** A unit's strikes from where it stands (those that land on the arena). */
export function strikesOf(c: Combat, u: number): Strike[] {
  const w = FIGHTERS[c.roster[u]!].weapon;
  const out: Strike[] = [];
  for (let d = 0; d < 4; d++) {
    if (w.kind !== "lob") {
      if (step(c.arena, c.pos[u]!, d) >= 0) out.push({ dir: d, range: 1 });
      continue;
    }
    for (let r = w.range![0]; r <= w.range![1]; r++) if (step(c.arena, c.pos[u]!, d, r) >= 0) out.push({ dir: d, range: r });
  }
  return out;
}

/** The first unit or standing structure along a line from a cell, or −1. */
export function firstHit(c: Combat, from: number, dir: number): number {
  for (let k = step(c.arena, from, dir); k >= 0; k = step(c.arena, k, dir)) if (c.occ[k]! >= 0 || structureAt(c, k) >= 0) return k;
  return -1;
}

/** Where a unit's strike lands from where it stands now: its target cell, or −1 (a shot that meets nothing). */
export function strikeCell(c: Combat, u: number, s: Strike): number {
  const w = FIGHTERS[c.roster[u]!].weapon;
  const from = c.pos[u]!;
  return w.kind === "shot" ? firstHit(c, from, s.dir) : step(c.arena, from, s.dir, s.range);
}

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

function hurtStructure(c: Combat, id: number, amount: number, log: Log): void {
  const hp = c.structHp[id]!;
  if (hp <= 0) return;
  const lost = Math.min(amount, hp);
  const s = c.arena.structures[id]!;
  c.structHp[id] = hp - lost;
  c.razed += lost;
  const people = (s.people * lost) / s.hp;
  c.lost += people;
  log?.push({ t: "structure", id, amount: lost, destroyed: hp - lost <= 0, people });
}

/** Push what stands on a cell one along a direction: it bumps into what is there (both hurt), off a drop, or into water. */
function push(c: Combat, k: number, dir: number, log: Log): void {
  const u = c.occ[k]!;
  if (u < 0) return;
  const a = c.arena;
  const to = step(a, k, dir);
  if (to < 0) return; // the arena's edge holds
  const sid = structureAt(c, to);
  const other = c.occ[to]!;
  const flying = FIGHTERS[c.roster[u]!].flying;
  if (sid >= 0 || other >= 0 || (!flying && a.height[to]! - a.height[k]! > a.climb)) {
    log?.push({ t: "bump", unit: u, at: to });
    hurt(c, u, 1, log);
    if (sid >= 0) hurtStructure(c, sid, 1, log);
    if (other >= 0) hurt(c, other, 1, log);
    return;
  }
  c.occ[k] = -1;
  c.occ[to] = u;
  c.pos[u] = to;
  log?.push({ t: "push", unit: u, from: k, to });
  if (flying) return;
  if (a.flags[to]! & A_WATER) return hurt(c, u, c.hp[u]!, log, true);
  const drop = a.height[k]! - a.height[to]!;
  if (drop >= a.fall) hurt(c, u, Math.floor(drop / a.fall), log);
  if (c.fire[to]) hurt(c, u, 1, log);
}

/** Strike a cell: the unit there takes the damage (and is pushed on), else the structure. */
function hit(c: Combat, k: number, damage: number, pushDir: number, log: Log): void {
  const u = c.occ[k]!;
  if (u >= 0) {
    hurt(c, u, damage, log);
    if (pushDir >= 0 && c.hp[u]! > 0) push(c, k, pushDir, log);
    return;
  }
  const sid = structureAt(c, k);
  if (sid >= 0) hurtStructure(c, sid, damage, log);
}

/** A unit strikes from where it stands. */
export function strike(c: Combat, u: number, s: Strike, log?: Log): void {
  if (c.hp[u]! <= 0) return;
  const w = FIGHTERS[c.roster[u]!].weapon;
  const k = strikeCell(c, u, s);
  if (k < 0) return;
  log?.push({ t: "strike", unit: u, at: k });
  if (w.douses && c.fire[k]) {
    c.fire[k] = 0;
    log?.push({ t: "douse", at: k });
  }
  hit(c, k, w.damage, w.kind !== "lob" && w.push ? s.dir : -1, log);
  if (w.kind === "lob" && w.push)
    for (let d = 0; d < 4; d++) {
      const nk = step(c.arena, k, d);
      if (nk >= 0 && c.occ[nk]! >= 0) push(c, nk, d, log);
    }
  if (w.ignites && c.arena.flags[k]! & A_BURNS && structureAt(c, k) < 0 && !c.fire[k]) {
    c.fire[k] = 1;
    log?.push({ t: "ignite", at: k });
  }
}

/** A rig's turn: it moves, then strikes (or doesn't). */
export function act(c: Combat, u: number, dest: number, s: Strike | null, log?: Log): void {
  moveUnit(c, u, dest, log);
  if (s) strike(c, u, s, log);
}

/** The invaders strike as they aimed, in order, each from where it stands now. */
export function resolveInvaders(c: Combat, log?: Log): void {
  for (let u = 0; u < c.roster.length; u++)
    if (teamOf(c, u) === INVADERS && c.hp[u]! > 0 && c.aim[u]! >= 0) strike(c, u, { dir: c.aim[u]!, range: c.reach[u]! }, log);
}

/** The round's end: fire burns who stands in it, and the wooden buildings beside it. */
export function endRound(c: Combat, log?: Log): void {
  const a = c.arena;
  const burnt = new Set<number>();
  for (let k = 0; k < c.fire.length; k++) {
    if (!c.fire[k]) continue;
    const u = c.occ[k]!;
    if (u >= 0) hurt(c, u, 1, log);
    for (let d = 0; d < 4; d++) {
      const sid = structureAt(c, step(a, k, d));
      if (sid >= 0 && a.structures[sid]!.flammable && !burnt.has(sid)) {
        burnt.add(sid);
        hurtStructure(c, sid, 1, log);
      }
    }
  }
}

// ---------------------------------------------------------------- the invaders

/** What a strike landing on a cell is worth to an invader: a building most, a rig, never one of its own. */
function worth(c: Combat, k: number): number {
  if (k < 0) return 0;
  if (structureAt(c, k) >= 0) return 10;
  const u = c.occ[k]!;
  if (u < 0) return 0;
  return teamOf(c, u) === SQUAD ? 6 : -10;
}

/**
 * The invaders move and aim, in order: each where its strike would land on
 * the most (a building over a rig, never one of its own), nearer moves first;
 * one with nothing worth striking heads for the nearest building and doesn't aim.
 */
export function planInvaders(c: Combat): void {
  const a = c.arena;
  for (let u = 0; u < c.roster.length; u++) {
    if (teamOf(c, u) !== INVADERS || c.hp[u]! <= 0) continue;
    const from = c.pos[u]!;
    let best: { dest: number; s: Strike | null; value: number } = { dest: from, s: null, value: 0 };
    for (const dest of movesOf(c, u)) {
      if (c.fire[dest]) continue;
      moveUnit(c, u, dest);
      for (const s of strikesOf(c, u)) {
        // a little for staying put, and a stable jitter so ties don't all go north
        const value = worth(c, strikeCell(c, u, s)) - 0.01 * manhattan(a, from, dest) + (((dest * 31 + s.dir * 7) % 13) / 1000);
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
  /** People lost, and structure hit points lost. */
  lost: number;
  razed: number;
  /** Rigs down, and their hit points lost. */
  rigsDown: number;
  rigDamage: number;
  /** Invaders down, and their hit points lost. */
  kills: number;
  invaderDamage: number;
  /** No building touched and no rig down. */
  perfect: boolean;
  score: number;
}

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
    perfect: razed === 0 && rigsDown === 0,
    score: -1000 * razed - lost / 100 - 400 * rigsDown - 20 * rigDamage + 60 * kills + 8 * invaderDamage,
  };
}

/** A state's hash (positions, hit points, structures, fires): two lanes of FNV-1a, as one whole number below 2^49 (room for flags above it). */
export function hashCombat(c: Combat): number {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const mix = (v: number) => {
    h1 = Math.imul(h1 ^ (v & 0xffff), 0x01000193);
    h2 = Math.imul(h2 ^ (v & 0xffff), 0x5bd1e995) ^ (h2 >>> 13);
  };
  for (const v of c.pos) mix(v);
  for (const v of c.hp) mix(v + 7);
  for (const v of c.structHp) mix(v + 31);
  for (let k = 0; k < c.fire.length; k++) if (c.fire[k]) mix(k + 4099);
  return (h1 >>> 0) * 131072 + ((h2 >>> 0) & 0x1ffff);
}
