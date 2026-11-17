import {
  A_WATER,
  DIR_NAMES,
  FIGHTERS,
  INVADERS,
  NOBODY,
  SQUAD,
  act,
  arriving,
  cloneCombat,
  endRound,
  hashCombat,
  isBurning,
  movesOf,
  newCombat,
  outcome,
  planInvaders,
  resolveInvaders,
  shotStop,
  standAt,
  step,
  strikeCell,
  strikesOf,
  structureAt,
  teamOf,
  type Arena,
  type Combat,
  type CombatEvent,
  type FighterKind,
  type Outcome,
  type Strike,
} from "./combat";

/**
 * Solving a turn, and making puzzles of them (D-150). A turn is a search
 * like a chess problem's, with nobody to answer: the invaders' strikes are
 * already set, so every order of the rigs' moves and strikes leads to one
 * outcome. `solveTurn` searches them depth first, each state met once (a
 * transposition table keyed by the state and which rigs have acted), and
 * finds the turns that lose nobody. `generatePuzzle` places a squad and
 * invaders on an arena until a position is solvable, isn't solved by playing
 * each rig's best move in turn, and has few winning turns among many.
 */

/** One rig's action: where it moves, and its strike (or none). */
export interface Action {
  unit: number;
  dest: number;
  strike: Strike | null;
}

export interface Solution {
  plan: Action[];
  outcome: Outcome;
}

export interface SolveOptions {
  /**
   * `perfect` (default) looks only for turns that lose nobody: it leaves out
   * every action that hurts a building at once, and moves without a strike
   * only to where standing can matter (in an invader's way, beside one, or a
   * step aside). `best` searches those moves too, without leaving any out.
   */
  mode?: "perfect" | "best";
  /** States to search at most (default 200,000): past it the search stops, `complete` false. */
  maxNodes?: number;
  /** Perfect turns to keep (default 8). */
  keep?: number;
  /** Rigs that have already acted this turn (by unit). */
  acted?: readonly number[];
  /**
   * Try evacuating the towers that would topple (default false): it changes
   * nothing this round, but empty, a tower can be brought down on invaders
   * in a later one. `solveFight` asks for it before the last round.
   */
  evacuate?: boolean;
}

export interface SolveResult {
  best: Solution | null;
  perfect: Solution[];
  /** Distinct states searched, distinct end states, and those that lose nobody. */
  nodes: number;
  leaves: number;
  perfectLeaves: number;
  /** The fewest strikes a perfect turn takes. */
  minStrikes: number;
  complete: boolean;
}

/** Cells where a rig's standing can matter without its striking: in an invader's way, beside an invader, or a step from where it is. */
function mattering(c: Combat, rig: number): Uint8Array {
  const a = c.arena;
  const m = new Uint8Array(a.w * a.h);
  const mark = (k: number) => k >= 0 && (m[k] = 1);
  for (let u = 0; u < c.roster.length; u++) {
    if (teamOf(c, u) !== INVADERS || c.hp[u]! <= 0) continue;
    for (let d = 0; d < 4; d++) mark(step(a, c.pos[u]!, d));
    if (c.aim[u]! < 0) continue;
    const w = FIGHTERS[c.roster[u]!].weapons[0]!;
    if (w.kind === "shot") {
      const end = shotStop(c, c.pos[u]!, c.aim[u]!, standAt(c, c.pos[u]!));
      for (let k = step(a, c.pos[u]!, c.aim[u]!); k >= 0; k = step(a, k, c.aim[u]!)) {
        mark(k);
        if (k === end) break;
      }
    } else {
      const t = step(a, c.pos[u]!, c.aim[u]!, c.reach[u]!);
      mark(t);
      if (w.kind === "lob") for (let d = 0; d < 4; d++) mark(step(a, t, d));
    }
  }
  for (const { at } of arriving(c)) mark(at); // standing there blocks an arrival
  mark(c.pos[rig]!);
  for (let d = 0; d < 4; d++) mark(step(a, c.pos[rig]!, d));
  return m;
}

/**
 * Whether a strike from where the unit stands can change this round: it
 * touches a unit, a structure, a fire to put out, or a unit round a lob's
 * target; a hoist sets its unit down where it can matter (`where`: in the
 * way, beside an invader), on water or on a roof. An evacuation never does
 * (it empties a building only by the round's end): with `evacuate`, one of a
 * tower that would topple is tried, for the rounds after.
 */
function touches(c: Combat, u: number, s: Strike, where: Uint8Array | null, evacuate = false): boolean {
  const w = FIGHTERS[c.roster[u]!].weapons[s.weapon]!;
  if (w.kind === "evacuate") {
    const sid = evacuate ? structureAt(c, strikeCell(c, u, s)) : -1;
    return sid >= 0 && c.arena.structures[sid]!.topple > 0;
  }
  if (w.kind === "hoist") return !where || where[s.to!] === 1 || !!(c.arena.flags[s.to!]! & A_WATER) || c.arena.struct[s.to!]! >= 0;
  const k = strikeCell(c, u, s);
  if (k < 0) return false;
  if (c.occ[k]! >= 0 || structureAt(c, k) >= 0 || isBurning(c, k)) return true;
  if (w.kind !== "lob" || !w.push) return false;
  for (let d = 0; d < 4; d++) {
    const nk = step(c.arena, k, d);
    if (nk >= 0 && c.occ[nk]! >= 0) return true;
  }
  return false;
}

/** A rig's actions worth trying: every move with each strike that touches something, and moves without a strike (where they can matter, in `perfect` mode). */
export function actionsOf(c: Combat, rig: number, mode: "perfect" | "best" | "all" = "all", evacuate = false): Action[] {
  const from = c.pos[rig]!;
  const where = mode === "perfect" ? mattering(c, rig) : null;
  const out: Action[] = [];
  for (const dest of movesOf(c, rig)) {
    c.occ[from] = -1;
    c.occ[dest] = rig;
    c.pos[rig] = dest;
    for (const s of strikesOf(c, rig)) if (mode === "all" || touches(c, rig, s, where, evacuate)) out.push({ unit: rig, dest, strike: s });
    if (!where || where[dest]) out.push({ unit: rig, dest, strike: null });
    c.occ[dest] = -1;
    c.occ[from] = rig;
    c.pos[rig] = from;
  }
  return out;
}

/** The round played out from a state: the invaders strike, and fire burns. */
export function playOut(c: Combat): Combat {
  const r = cloneCombat(c);
  resolveInvaders(r);
  endRound(r);
  return r;
}

/** Search a turn for the plans that lose nobody (and the best plan found). */
export function solveTurn(start: Combat, opts: SolveOptions = {}): SolveResult {
  const mode = opts.mode ?? "perfect";
  const maxNodes = opts.maxNodes ?? 200_000;
  const keep = opts.keep ?? 8;
  const rigs: number[] = [];
  for (let u = 0; u < start.roster.length; u++) if (teamOf(start, u) === SQUAD && start.hp[u]! > 0 && !opts.acted?.includes(u)) rigs.push(u);
  const all = (1 << rigs.length) - 1;
  const seen = new Set<number>();
  const res: SolveResult = { best: null, perfect: [], nodes: 0, leaves: 0, perfectLeaves: 0, minStrikes: Infinity, complete: true };

  const leaf = (c: Combat, plan: Action[], strikes: number) => {
    res.leaves++;
    const o = outcome(start, playOut(c));
    if (o.perfect) {
      res.perfectLeaves++;
      res.minStrikes = Math.min(res.minStrikes, strikes);
      if (res.perfect.length < keep) res.perfect.push({ plan, outcome: o });
    }
    if (!res.best || o.score > res.best.outcome.score) res.best = { plan, outcome: o };
  };

  const dfs = (c: Combat, acted: number, plan: Action[], strikes: number) => {
    if (res.nodes >= maxNodes) return void (res.complete = false);
    const key = hashCombat(c) * 16 + acted;
    if (seen.has(key)) return;
    seen.add(key);
    res.nodes++;
    if (acted === all) return leaf(c, plan, strikes);
    for (let i = 0; i < rigs.length; i++) {
      if (acted & (1 << i)) continue;
      for (const a of actionsOf(c, rigs[i]!, mode, opts.evacuate)) {
        const n = cloneCombat(c);
        act(n, a.unit, a.dest, a.strike);
        // people lost, or a rig down, is never undone: no perfect turn goes on from it
        if (mode === "perfect" && (n.lost > c.lost + NOBODY || rigDown(c, n))) continue;
        dfs(n, acted | (1 << i), [...plan, a], strikes + (a.strike ? 1 : 0));
        if (res.nodes >= maxNodes) return void (res.complete = false);
      }
    }
  };
  dfs(start, 0, [], 0);
  return res;
}

function rigDown(before: Combat, after: Combat): boolean {
  for (let u = 0; u < before.roster.length; u++) if (teamOf(before, u) === SQUAD && before.hp[u]! > 0 && after.hp[u]! <= 0) return true;
  return false;
}

/**
 * A naive player's turn: each rig in turn takes the action that plays out
 * best on its own (the others standing still), over every move and strike.
 * A puzzle this solves is too easy.
 */
export function greedyTurn(start: Combat): Solution {
  let c = cloneCombat(start);
  const plan: Action[] = [];
  for (let u = 0; u < c.roster.length; u++) {
    if (teamOf(c, u) !== SQUAD || c.hp[u]! <= 0) continue;
    let best: { a: Action; next: Combat; score: number } | null = null;
    for (const a of actionsOf(c, u, "all")) {
      const n = cloneCombat(c);
      act(n, a.unit, a.dest, a.strike);
      const score = outcome(start, playOut(n)).score;
      if (!best || score > best.score) best = { a, next: n, score };
    }
    if (!best) continue;
    plan.push(best.a);
    c = best.next;
  }
  return { plan, outcome: outcome(start, playOut(c)) };
}

// ---------------------------------------------------------------- a fight

export interface FightOptions {
  /** Rounds to hold, this one included. */
  rounds: number;
  /** Turn-search states to spend in all (default 400,000): past it the search stops, `complete` false. */
  maxNodes?: number;
  /** Rigs that have already acted this round. */
  acted?: readonly number[];
  /** Check every perfect first turn (up to 256) for whether the fight can still be held after it, not only until one can (default false). */
  count?: boolean;
  /**
   * Try evacuating towers before the last round, to bring one down on the
   * invaders later (default false). It multiplies the turns searched, and on
   * the real boards measured it never made a lost fight winnable.
   */
  evacuate?: boolean;
}

export interface FightResult {
  /** Every round held without losing anybody (or the invaders all down before the last). */
  winnable: boolean;
  /** A turn for each round that holds the fight (the first: this round's). */
  line: Action[][];
  /**
   * Perfect first turns decided, and of those, the ones after which the fight
   * can still be held (with `count`, every one checked; else up to the first
   * that can). A turn whose search ran out isn't decided: it is neither.
   */
  firstTurns: number;
  safeFirstTurns: number;
  nodes: number;
  /** False where a search ran out of states, or a round had more perfect turns than it kept: `winnable` false may then be wrong. */
  complete: boolean;
}

/** Invaders standing, or still to arrive. */
const invadersLeft = (c: Combat) => c.roster.some((_, u) => teamOf(c, u) === INVADERS && c.hp[u]! > 0) || c.schedule.slice(c.round).some((r) => r.length > 0);

/**
 * Search a fight over its rounds (D-152): every perfect turn of this round,
 * the invaders' strikes, their next aims (deterministic: the fight is a
 * puzzle with nobody to answer), and so on, depth first, the turns that hurt
 * the invaders most tried first, and each state surely lost not searched
 * again. A turn that loses nobody now may still lose the fight.
 */
export function solveFight(start: Combat, opts: FightOptions): FightResult {
  const max = opts.maxNodes ?? 400_000;
  const res: FightResult = { winnable: false, line: [], firstTurns: 0, safeFirstTurns: 0, nodes: 0, complete: true };
  /** States from which every turn was searched and each lost the fight. */
  const lost = new Set<number>();
  /** Searches that couldn't finish (out of states, or more perfect turns than kept): a loss found while it grows isn't sure. */
  let unsure = 0;

  /** This round's perfect turns, the hardest on the invaders first. */
  const turns = (c: Combat, roundsLeft: number, acted?: readonly number[]) => {
    const t = solveTurn(c, { keep: 256, maxNodes: Math.max(1, Math.min(100_000, max - res.nodes)), evacuate: !!opts.evacuate && roundsLeft > 1, ...(acted ? { acted } : {}) });
    res.nodes += t.nodes;
    if (!t.complete || t.perfect.length < t.perfectLeaves) unsure++;
    return t.perfect.sort((p, q) => q.outcome.kills - p.outcome.kills || q.outcome.invaderDamage - p.outcome.invaderDamage || p.outcome.rigDamage - q.outcome.rigDamage);
  };
  /** The round played on from a turn: the invaders strike, fire burns, they aim again. */
  const after = (c: Combat, plan: readonly Action[]) => {
    const n = cloneCombat(c);
    for (const a of plan) act(n, a.unit, a.dest, a.strike);
    resolveInvaders(n);
    endRound(n);
    if (invadersLeft(n)) planInvaders(n);
    return n;
  };
  /** A line that holds the rest of the fight from a state at the start of a round, or null. */
  const hold = (c: Combat, roundsLeft: number): Action[][] | null => {
    if (!invadersLeft(c) || roundsLeft <= 0) return [];
    const key = hashCombat(c) * 8 + Math.min(roundsLeft, 7);
    if (lost.has(key)) return null;
    if (res.nodes >= max) {
      unsure++;
      return null;
    }
    const mark = unsure;
    for (const t of turns(c, roundsLeft)) {
      const rest = hold(after(c, t.plan), roundsLeft - 1);
      if (rest) return [t.plan, ...rest];
    }
    if (unsure === mark) lost.add(key); // every turn searched to the end, and each lost
    return null;
  };

  for (const t of turns(start, opts.rounds, opts.acted)) {
    if (res.nodes >= max) {
      unsure++;
      break;
    }
    const mark = unsure;
    const rest = hold(after(start, t.plan), opts.rounds - 1);
    if (rest) {
      res.firstTurns++;
      res.safeFirstTurns++;
      if (!res.winnable) {
        res.winnable = true;
        res.line = [t.plan, ...rest];
      }
      if (!opts.count) break;
    } else if (unsure === mark) res.firstTurns++; // surely a trap
  }
  res.complete = unsure === 0;
  return res;
}

/** How a plan's round plays out. */
function outcomeOf(c: Combat, plan: readonly Action[]): Outcome {
  const d = cloneCombat(c);
  for (const a of plan) act(d, a.unit, a.dest, a.strike);
  return outcome(c, playOut(d));
}

/** A plan in words, cells as (column, row). */
export function describePlan(start: Combat, plan: readonly Action[]): string[] {
  const c = cloneCombat(start);
  const w = c.arena.w;
  const at = (k: number) => `(${k % w}, ${Math.floor(k / w)})`;
  return plan.map((a) => {
    const f = FIGHTERS[c.roster[a.unit]!];
    const move = a.dest === c.pos[a.unit] ? "stays" : `moves to ${at(a.dest)}`;
    act(c, a.unit, a.dest, null);
    const s = a.strike;
    let what = "";
    if (s) {
      const w = f.weapons[s.weapon]!;
      const k = strikeCell(c, a.unit, s);
      if (w.kind === "hoist") what = `, hoists the ${FIGHTERS[c.roster[c.occ[k]!]!].name} ${DIR_NAMES[s.dir]} of it to ${at(s.to!)}`;
      else if (w.kind === "evacuate") what = `, evacuates ${c.arena.structures[c.arena.struct[k]!]!.name.replace("building.", "")} ${DIR_NAMES[s.dir]} of it`;
      else what = `, ${w.name} ${DIR_NAMES[s.dir]}${w.kind === "lob" ? ` ${s.range}` : ""} at ${at(k)}`;
      act(c, a.unit, a.dest, s);
    }
    return `${f.name} ${move}${what}`;
  });
}

// ---------------------------------------------------------------- what a turn takes

/**
 * What a turn does that makes it a puzzle: `drown` an invader pushed into
 * water; `turn` invaders striking their own; `redirect` an invader pushed off
 * its line so its strike lands on nothing that matters; `bump` an invader
 * hurt by being pushed into something; `fall` an invader dropped off a
 * height; `crush` an invader under a toppling building; `block` a rig taking
 * a strike meant for a building (from a roof, say); `douse` a fire put out;
 * `kill` an invader brought down.
 */
export type Mechanic = "drown" | "turn" | "redirect" | "fall" | "crush" | "bump" | "block" | "douse" | "kill";

/** The mechanics a plan uses, played out with its round. */
export function mechanicsOf(start: Combat, plan: readonly Action[]): Mechanic[] {
  const c = cloneCombat(start);
  const mine: CombatEvent[] = [];
  for (const a of plan) act(c, a.unit, a.dest, a.strike, mine);
  const theirs: CombatEvent[] = [];
  const end = cloneCombat(c);
  resolveInvaders(end, theirs);
  const out = new Set<Mechanic>();
  const invader = (u: number) => teamOf(start, u) === INVADERS;
  let crushing = false;
  for (const e of [...mine, ...theirs]) {
    if (e.t === "fall" && invader(e.unit)) out.add("fall");
    if (e.t === "damage" && crushing && invader(e.unit)) out.add("crush");
    crushing = e.t === "crush" || (crushing && e.t === "damage");
  }
  for (const e of mine) {
    if (e.t === "down" && invader(e.unit)) out.add(e.drowned ? "drown" : "kill");
    if (e.t === "bump" && invader(e.unit)) out.add("bump");
    if (e.t === "douse") out.add("douse");
  }
  for (const e of theirs) {
    if (e.t === "damage" && invader(e.unit)) out.add("turn");
    if (e.t === "damage" && !invader(e.unit)) out.add("block");
  }
  // pushed off a line that struck something that mattered, onto one that doesn't
  const harmful = (x: Combat, u: number) => {
    const k = strikeCell(x, u, { weapon: 0, dir: x.aim[u]!, range: x.reach[u]! });
    return k >= 0 && (structureAt(x, k) >= 0 || (x.occ[k]! >= 0 && teamOf(x, x.occ[k]!) === SQUAD));
  };
  for (let u = 0; u < start.roster.length; u++)
    if (invader(u) && start.aim[u]! >= 0 && c.hp[u]! > 0 && c.pos[u] !== start.pos[u] && harmful(start, u) && !harmful(c, u)) out.add("redirect");
  return [...out];
}

/** What each mechanic adds to a puzzle's difficulty (bits): turning invaders on the city is the art; killing them is the least of it. */
const CLEVER: Record<Mechanic, number> = { drown: 2, turn: 2, redirect: 2, fall: 2, crush: 2, bump: 1, block: 1, douse: 1, kill: 0 };

// ---------------------------------------------------------------- puzzles

export interface Puzzle {
  /** The position: the invaders have aimed; the squad is to play. */
  combat: Combat;
  /** A turn that loses nobody (with `rounds`, one after which the whole fight can be held), and what it takes. */
  solution: Solution;
  mechanics: Mechanic[];
  /**
   * With `rounds`: a turn for each round that holds the fight, and of the
   * perfect first turns, how many keep it winnable (the rest are traps).
   */
  fight?: { rounds: number; line: Action[][]; firstTurns: number; safeFirstTurns: number };
  /**
   * How hard (bits): log2 of how many end states the search met for each
   * that loses nobody, 1.5 for each strike beyond one a perfect turn needs,
   * more for the mechanics its solution uses (`CLEVER`), and with `rounds`
   * twice log2 of perfect first turns for each that doesn't lose the fight.
   */
  difficulty: number;
  stats: { nodes: number; leaves: number; perfectLeaves: number; minStrikes: number; attempts: number; ms: number };
}

export interface PuzzleOptions {
  squad?: FighterKind[];
  /** The invaders' kinds, or how many to pick (default 2–3). */
  invaders?: FighterKind[] | number;
  seed?: number;
  /** Positions to try at most (default 60), and milliseconds (default 4000). */
  attempts?: number;
  timeMs?: number;
  /** Stop at the first puzzle this hard (bits; default 12). */
  target?: number;
  /** Take only puzzles whose solution does more than kill (`Mechanic`; default true), unless none is found. */
  clever?: boolean;
  /** States each solve may search (default 60,000). */
  maxNodes?: number;
  /** Called after each position tried. */
  onProgress?: (tried: number, best: number | null) => void;
  /**
   * Rounds the whole fight must be winnable over (default 1: the first turn
   * only). Over more, a position is kept only if some perfect first turn
   * leads to every round held, and its traps count toward its difficulty.
   */
  rounds?: number;
  /** States each fight check may search (default 200,000). */
  fightNodes?: number;
  /** Invaders arriving at the end of each round but the last, when there are several (default 1). */
  arrivals?: number;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Open cells: no standing structure, and no water for what walks. */
function openCells(a: Arena): number[] {
  const out: number[] = [];
  for (let k = 0; k < a.w * a.h; k++) if (a.struct[k]! < 0 && !(a.flags[k]! & A_WATER)) out.push(k);
  return out;
}

/** Try one position: the squad round a cell, invaders near it and near buildings, and those arriving later; null where it is no puzzle. */
function position(a: Arena, rand: () => number, squad: FighterKind[], invaders: FighterKind[], arrivals: FighterKind[][] = []): Combat | null {
  const open = openCells(a);
  if (open.length < squad.length + invaders.length + 4) return null;
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const cheb = (p: number, q: number) => Math.max(Math.abs((p % a.w) - (q % a.w)), Math.abs(Math.floor(p / a.w) - Math.floor(q / a.w)));
  const nearBuilding = (k: number) => {
    for (let d = 0; d < 4; d++) {
      const nk = step(a, k, d);
      if (nk >= 0 && a.struct[nk]! >= 0) return true;
    }
    return false;
  };
  const centre = pick(open);
  const used = new Set<number>();
  const units: { kind: FighterKind; at: number }[] = [];
  for (const kind of squad) {
    const near = open.filter((k) => !used.has(k) && cheb(k, centre) <= 2);
    if (!near.length) return null;
    const at = pick(near);
    used.add(at);
    units.push({ kind, at });
  }
  const roofs: number[] = [];
  for (let k = 0; k < a.w * a.h; k++) if (a.struct[k]! >= 0) roofs.push(k);
  for (const kind of invaders) {
    // a crawler or a flyer starts on a roof now and then
    const climbs = FIGHTERS[kind].climb === Infinity && roofs.length && rand() < 0.35;
    const ok = (climbs ? roofs : open).filter((k) => !used.has(k) && cheb(k, centre) <= 5 && units.every((u) => cheb(u.at, k) >= 2));
    if (!ok.length) return null;
    const close = ok.filter(nearBuilding);
    const at = pick(close.length && rand() < 0.8 ? close : ok);
    used.add(at);
    units.push({ kind, at });
  }
  // arrivals: on open ground near the fight, away from everyone, one cell each
  const schedule = arrivals.map((kinds) =>
    kinds.flatMap((kind) => {
      const ok = open.filter((k) => !used.has(k) && cheb(k, centre) <= 5 && units.every((u) => cheb(u.at, k) >= 2));
      if (!ok.length) return [];
      const at = pick(ok);
      used.add(at);
      return [{ kind, at }];
    }),
  );
  const c = newCombat(a, units, schedule);
  planInvaders(c);
  // a threat worth a puzzle: left alone, the round costs two buildings' worth, and every invader aims
  for (let u = 0; u < c.roster.length; u++) if (teamOf(c, u) === INVADERS && c.aim[u]! < 0) return null;
  return playOut(c).razed - c.razed >= 2 ? c : null;
}

/**
 * Make a puzzle on an arena: positions are tried until one is solvable,
 * isn't solved by the greedy player, and is `target` bits hard; or, when
 * time or attempts run out, the hardest solvable one found (null if none).
 */
export async function generatePuzzle(a: Arena, opts: PuzzleOptions = {}): Promise<Puzzle | null> {
  const rand = mulberry(opts.seed ?? 1);
  const squad = opts.squad ?? ["wrecker", "pumper", "crane"];
  const kinds: FighterKind[] = ["crawler", "brute", "flyer"];
  const t0 = performance.now();
  const target = opts.target ?? 12;
  const wantClever = opts.clever ?? true;
  let best: Puzzle | null = null;
  let tried = 0;
  for (; tried < (opts.attempts ?? 60) && performance.now() - t0 < (opts.timeMs ?? 4000); tried++) {
    const invaders = Array.isArray(opts.invaders)
      ? opts.invaders
      : Array.from({ length: opts.invaders ?? 2 + Math.floor(rand() * 2) }, () => kinds[Math.floor(rand() * kinds.length)]!);
    const rounds = opts.rounds ?? 1;
    const arrivals = Array.from({ length: rounds - 1 }, () => Array.from({ length: opts.arrivals ?? 1 }, () => kinds[Math.floor(rand() * kinds.length)]!));
    const c = position(a, rand, squad, invaders, arrivals);
    if (c) {
      const res = solveTurn(c, { maxNodes: opts.maxNodes ?? 60_000, keep: 1 });
      const f = res.perfect.length && rounds > 1 ? solveFight(c, { rounds, count: true, maxNodes: opts.fightNodes ?? 200_000 }) : null;
      if (res.perfect.length && !greedyTurn(c).outcome.perfect && (!f || f.winnable)) {
        const solution = f ? { plan: f.line[0]!, outcome: outcomeOf(c, f.line[0]!) } : res.perfect[0]!;
        const mechanics = mechanicsOf(c, solution.plan);
        const clever = mechanics.reduce((n, m) => n + CLEVER[m], 0);
        const traps = f ? 2 * Math.log2(f.firstTurns / f.safeFirstTurns) : 0;
        const difficulty = Math.log2(res.leaves / res.perfectLeaves) + 1.5 * Math.max(0, res.minStrikes - 1) + clever + traps;
        // a clever puzzle over a plain one, whatever their bits
        const rank = (p: Puzzle | null) => (p ? (wantClever && p.mechanics.some((m) => CLEVER[m] > 0) ? 100 : 0) + p.difficulty : -Infinity);
        if (rank({ difficulty, mechanics } as Puzzle) > rank(best)) {
          const { nodes, leaves, perfectLeaves, minStrikes } = res;
          best = { combat: c, solution, mechanics, difficulty, stats: { nodes, leaves, perfectLeaves, minStrikes, attempts: tried + 1, ms: 0 } };
          if (f) best.fight = { rounds, line: f.line, firstTurns: f.firstTurns, safeFirstTurns: f.safeFirstTurns };
        }
      }
    }
    opts.onProgress?.(tried + 1, best?.difficulty ?? null);
    if (best && best.difficulty >= target && (!wantClever || best.mechanics.some((m) => CLEVER[m] > 0))) break;
    await new Promise((r) => setTimeout(r, 0)); // let the page draw
  }
  if (best) best.stats.ms = performance.now() - t0;
  return best;
}
