import { INVADERS, SQUAD, act, actionsOf, cloneCombat, endRound, greedyTurn, outcome, planInvaders, resolveInvaders, teamOf, type Action, type Combat, type CombatEvent, type Puzzle } from "@pixelworlds/tactics";

/**
 * The map survey's simulation (D-181, docs/tactics/map-survey.md): a board's
 * puzzle played through its rounds by several bots, so what comes up isn't
 * one strategy's habit, and measured. The optimal bot plays the solver's line
 * (the puzzle's, which holds the fight); the greedy plays each rig's best
 * action alone (`greedyTurn`); the environmental, the same with the city's
 * damage counted double; the random, any action.
 */

/** The kinds of event in a fight: the city's (`CITY_KINDS`), and the squad's own (lifting an invader, blocking an arrival). */
export type Kind = "drown" | "fall" | "bump" | "topple" | "crush" | "fire" | "turn" | "block" | "douse" | "hoist";
/** The kinds a board's features make: variety counts these. */
export const CITY_KINDS: readonly Kind[] = ["drown", "fall", "bump", "topple", "crush", "fire", "turn", "douse"];

export interface Played {
  events: CombatEvent[];
  /** The fight held: nobody lost, no rig down. */
  held: boolean;
  score: number;
  end: Combat;
}

export interface Simulation {
  /** Kinds that came up in any bot's fight. */
  kinds: Kind[];
  /** Each bot's fight held, and its outcome's score. */
  bots: Record<"optimal" | "greedy" | "environmental" | "random", { held: boolean; score: number }>;
  /** Perfect first turns after which the fight can still be held (the puzzle's). */
  room: number;
  /** The share of the invaders' damage the city did (drowning, falls, bumps, crushes, fire, each other), in the optimal and environmental fights. */
  environment: number;
  terms: { variety: number; depth: number; room: number; environment: number };
  /** The terms' weighted sum (`SIM_WEIGHTS`). */
  score: number;
}

export const SIM_WEIGHTS = { variety: 0.3, depth: 0.3, room: 0.2, environment: 0.2 } as const;

type Bot = (c: Combat, round: number) => Action[];

/** A fight played from the puzzle's position to its last round. */
export function playFight(p: Puzzle, bot: Bot): Played {
  const start = p.combat;
  const c = cloneCombat(start);
  const events: CombatEvent[] = [];
  const rounds = p.fight?.rounds ?? 1;
  for (let r = 0; r < rounds; r++) {
    for (const a of bot(c, r)) act(c, a.unit, a.dest, a.strike, events);
    resolveInvaders(c, events);
    endRound(c, events);
    if (r < rounds - 1) planInvaders(c);
  }
  const o = outcome(start, c);
  return { events, held: o.perfect, score: o.score, end: c };
}

/**
 * Each invader damage point the city did, and each the squad's weapons did:
 * a damage straight after a rig's strike is the weapon's; any other (after a
 * bump, a fall, a crush, an invader's strike, in fire or water) the city's.
 */
export function damageShares(events: readonly CombatEvent[], invader: (u: number) => boolean): { city: number; weapons: number } {
  let city = 0;
  let weapons = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const before = events[i - 1];
    if (e.t === "down" && e.drowned && invader(e.unit) && before?.t !== "damage") city++;
    if (e.t !== "damage" || !invader(e.unit)) continue;
    if (before?.t === "strike" && !invader(before.unit)) weapons += e.amount;
    else city += e.amount;
  }
  return { city, weapons };
}

/** The kinds of event in a fight's log. */
export function kindsOf(events: readonly CombatEvent[], invader: (u: number) => boolean): Set<Kind> {
  const out = new Set<Kind>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const before = events[i - 1];
    if (e.t === "down" && e.drowned && invader(e.unit)) out.add("drown");
    if (e.t === "fall" && invader(e.unit)) out.add("fall");
    if (e.t === "bump" && invader(e.unit)) out.add("bump");
    if (e.t === "topple") out.add("topple");
    if (e.t === "damage" && before?.t === "crush" && invader(e.unit)) out.add("crush");
    if (e.t === "ignite") out.add("fire");
    if (e.t === "damage" && before?.t === "strike" && invader(before.unit) && invader(e.unit)) out.add("turn");
    if (e.t === "blocked") out.add("block");
    if (e.t === "douse") out.add("douse");
    if (e.t === "hoist" && invader(e.unit)) out.add("hoist");
  }
  return out;
}

/** The number of ways to hold a fight, as a term: one is a pure puzzle (a half), two to eight right, past it too many (none by 64). */
export const roomTerm = (n: number): number => (n <= 1 ? 0.5 : n <= 8 ? 1 : Math.max(0, 1 - Math.log2(n / 8) / 3));

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

/** Each rig in turn takes the action that plays out best alone, the city's damage to the invaders counted double. */
function environmentalTurn(start: Combat): Action[] {
  let c = cloneCombat(start);
  const plan: Action[] = [];
  const invader = (u: number) => teamOf(start, u) === INVADERS;
  for (let u = 0; u < c.roster.length; u++) {
    if (teamOf(c, u) !== SQUAD || c.hp[u]! <= 0) continue;
    let best: { a: Action; next: Combat; value: number } | null = null;
    for (const a of actionsOf(c, u, "all")) {
      const n = cloneCombat(c);
      const log: CombatEvent[] = [];
      act(n, a.unit, a.dest, a.strike, log);
      const end = cloneCombat(n);
      resolveInvaders(end, log);
      endRound(end, log);
      const value = outcome(start, end).score + 8 * damageShares(log, invader).city;
      if (!best || value > best.value) best = { a, next: n, value };
    }
    if (!best) continue;
    plan.push(best.a);
    c = best.next;
  }
  return plan;
}

/** A puzzle played by every bot, and measured. */
export function simulate(p: Puzzle, seed = 1): Simulation {
  const line = p.fight?.line ?? [p.solution.plan];
  const random = mulberry(seed);
  const randomTurn: Bot = (c) => {
    const plan: Action[] = [];
    const n = cloneCombat(c);
    for (let u = 0; u < n.roster.length; u++) {
      if (teamOf(n, u) !== SQUAD || n.hp[u]! <= 0) continue;
      const all = actionsOf(n, u, "all");
      const a = all[Math.floor(random() * all.length)];
      if (!a) continue;
      act(n, a.unit, a.dest, a.strike);
      plan.push(a);
    }
    return plan;
  };
  const fights = {
    optimal: playFight(p, (_, r) => line[r] ?? []),
    greedy: playFight(p, (c) => greedyTurn(c).plan),
    environmental: playFight(p, environmentalTurn),
    random: playFight(p, randomTurn),
  };
  const kinds = new Set<Kind>();
  for (const f of Object.values(fights)) {
    const invader = (u: number) => teamOf(f.end, u) === INVADERS;
    for (const k of kindsOf(f.events, invader)) kinds.add(k);
  }
  let city = 0;
  let weapons = 0;
  for (const f of [fights.optimal, fights.environmental]) {
    const d = damageShares(f.events, (u) => teamOf(f.end, u) === INVADERS);
    city += d.city;
    weapons += d.weapons;
  }
  const room = p.fight?.safeFirstTurns ?? 1;
  const environment = city + weapons ? city / (city + weapons) : 0;
  const terms = {
    variety: Math.min(1, [...kinds].filter((k) => CITY_KINDS.includes(k)).length / 5),
    // if greedy holds the fight too, the board is too easy
    depth: fights.greedy.held ? 0 : Math.min(1, Math.max(0, (fights.optimal.score - fights.greedy.score) / 500)),
    room: roomTerm(room),
    environment,
  };
  return {
    kinds: [...kinds].sort(),
    bots: Object.fromEntries(Object.entries(fights).map(([k, f]) => [k, { held: f.held, score: f.score }])) as Simulation["bots"],
    room,
    environment,
    terms,
    score: SIM_WEIGHTS.variety * terms.variety + SIM_WEIGHTS.depth * terms.depth + SIM_WEIGHTS.room * terms.room + SIM_WEIGHTS.environment * terms.environment,
  };
}
