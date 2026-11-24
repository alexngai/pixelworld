import { INVADERS, SQUAD, cloneCombat, endRound, moveUnit, movesOf, outcome, planInvaders, resolveInvaders, strike, strikesOf, teamOf, type Combat } from "./combat";
import type { Action } from "./solver";

/**
 * A fight replayed (D-186): its start and each turn's rig actions as the page
 * took them (a move, then a strike or none), run through the rules with the
 * invaders' turns between, as the fight on the page runs them. A co-op room
 * takes a squad's fight as it replays, not as the page says it went.
 */

export interface Replayed {
  /** Nobody lost and no rig down, the squad standing at the end. */
  held: boolean;
  /** People lost. */
  lost: number;
  roundsHeld: number;
  /** Rounds fought. */
  rounds: number;
  squadDown: boolean;
}

/**
 * A fight run action by action (D-186, D-187): a rig's action taken only if
 * the rules allow it then, and the invaders' turn and the round's end run as
 * the fight on the page runs them. A replay drives one through a recorded
 * fight; a joint fight's room drives one as the squads act.
 */
export class FightRun {
  readonly c: Combat;
  roundsHeld = 0;
  /** Rigs that have acted this turn. */
  readonly acted = new Set<number>();
  /** Each turn's actions taken so far. */
  readonly turns: Action[][] = [[]];
  /** The fight's result, once it's over. */
  result: Replayed | null = null;

  constructor(
    readonly start: Combat,
    readonly rounds: number,
  ) {
    this.c = cloneCombat(start);
  }

  /** A rig's action (a move, then a strike or none), if the rules allow it now: false, and nothing changed, when not. */
  act(a: Action): boolean {
    const c = this.c;
    const u = a.unit;
    if (this.result || !Number.isInteger(u) || u < 0 || u >= c.roster.length || teamOf(c, u) !== SQUAD || c.hp[u]! <= 0 || this.acted.has(u)) return false;
    const from = c.pos[u]!;
    if (a.dest !== from && !movesOf(c, u).includes(a.dest)) return false;
    const s = a.strike;
    if (s) {
      // the strike checked from where the move leaves it, on a copy, so a refused one changes nothing
      const d = cloneCombat(c);
      if (a.dest !== from) moveUnit(d, u, a.dest);
      if (!strikesOf(d, u).some((x) => x.weapon === s.weapon && x.dir === s.dir && x.range === s.range && (x.to ?? -1) === (s.to ?? -1))) return false;
    }
    if (a.dest !== from) moveUnit(c, u, a.dest);
    if (s) strike(c, u, s);
    this.acted.add(u);
    this.turns[this.turns.length - 1]!.push(a);
    return true;
  }

  /** The invaders' turn and the round's end: the result when the fight is over, else null (the invaders move and aim again). */
  endTurn(): Replayed | null {
    const c = this.c;
    if (this.result) return this.result;
    const before = cloneCombat(c);
    resolveInvaders(c);
    endRound(c);
    if (outcome(before, c).perfect) this.roundsHeld++;
    const invaders = c.roster.some((_, u) => teamOf(c, u) === INVADERS && c.hp[u]! > 0) || c.schedule.slice(c.round).some((r) => r.length);
    const squad = c.roster.some((_, u) => teamOf(c, u) === SQUAD && c.hp[u]! > 0);
    if (!invaders || !squad || c.round >= this.rounds) {
      const o = outcome(this.start, c);
      return (this.result = { held: squad && o.lost <= 0.5 && o.rigsDown === 0, lost: o.lost, roundsHeld: this.roundsHeld, rounds: c.round, squadDown: !squad });
    }
    planInvaders(c);
    this.acted.clear();
    this.turns.push([]);
    return null;
  }
}

/**
 * The fight from `start` with these turns, to the end (`rounds` rounds, or
 * every invader or every rig down): null when an action isn't one the rules
 * allow then, or the turns end before the fight does.
 */
export function replayFight(start: Combat, turns: readonly (readonly Action[])[], rounds: number): Replayed | null {
  const run = new FightRun(start, rounds);
  for (const turn of turns) {
    for (const a of turn) if (!run.act(a)) return null;
    const r = run.endTurn();
    if (r) return r;
  }
  return null;
}

const TYPED = { Uint8Array, Int8Array, Int16Array, Float32Array } as const;

/** A value as JSON can carry it: its typed arrays (a combat's) tagged plain arrays. */
export function toWire(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_, x: unknown) => (ArrayBuffer.isView(x) ? { $t: x.constructor.name, v: Array.from(x as Uint8Array) } : x)));
}

/** `toWire` undone: tagged arrays typed again (only the kinds a combat has). */
export function fromWire<T>(v: unknown): T {
  return JSON.parse(JSON.stringify(v), (_, x: unknown) => {
    const o = x as { $t?: string; v?: unknown } | null;
    if (!o || typeof o !== "object" || typeof o.$t !== "string" || !Array.isArray(o.v)) return x;
    const T = TYPED[o.$t as keyof typeof TYPED];
    return T ? new T(o.v as number[]) : x;
  }) as T;
}
