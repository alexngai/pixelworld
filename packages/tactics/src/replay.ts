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
 * The fight from `start` with these turns, to the end (`rounds` rounds, or
 * every invader or every rig down): null when an action isn't one the rules
 * allow then, or the turns end before the fight does.
 */
export function replayFight(start: Combat, turns: readonly (readonly Action[])[], rounds: number): Replayed | null {
  const c = cloneCombat(start);
  let roundsHeld = 0;
  for (const turn of turns) {
    const acted = new Set<number>();
    for (const a of turn) {
      const u = a.unit;
      if (!Number.isInteger(u) || u < 0 || u >= c.roster.length || teamOf(c, u) !== SQUAD || c.hp[u]! <= 0 || acted.has(u)) return null;
      if (a.dest !== c.pos[u]) {
        if (!movesOf(c, u).includes(a.dest)) return null;
        moveUnit(c, u, a.dest);
      }
      const s = a.strike;
      if (s) {
        if (!strikesOf(c, u).some((x) => x.weapon === s.weapon && x.dir === s.dir && x.range === s.range && (x.to ?? -1) === (s.to ?? -1))) return null;
        strike(c, u, s);
      }
      acted.add(u);
    }
    const before = cloneCombat(c);
    resolveInvaders(c);
    endRound(c);
    if (outcome(before, c).perfect) roundsHeld++;
    const invaders = c.roster.some((_, u) => teamOf(c, u) === INVADERS && c.hp[u]! > 0) || c.schedule.slice(c.round).some((r) => r.length);
    const squad = c.roster.some((_, u) => teamOf(c, u) === SQUAD && c.hp[u]! > 0);
    if (!invaders || !squad || c.round >= rounds) {
      const o = outcome(start, c);
      return { held: squad && o.lost <= 0.5 && o.rigsDown === 0, lost: o.lost, roundsHeld, rounds: c.round, squadDown: !squad };
    }
    planInvaders(c);
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
