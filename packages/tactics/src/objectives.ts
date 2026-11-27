import { A_BURNS, FIGHTERS, SQUAD, structureAt, teamOf, type Combat } from "./combat";

/**
 * Bonus objectives (D-199, after Into the Breach): on top of holding the
 * block, a fight may ask for one or two things more, each paying reputation.
 * Holding already keeps every occupied building whole (a hit on one costs its
 * people), so the bonuses ask for what holding doesn't. Each is judged from
 * the fight's states alone, so the co-op room's replay (D-186) can judge it
 * as the page does.
 */
export type Objective =
  /** No fire burning when the fight ends. */
  | { kind: "fires" }
  /** That building emptied by the end (a tower the invaders might bring down). */
  | { kind: "evacuate"; structure: number }
  /** No rig loses a hit point. */
  | { kind: "unhurt" }
  /** No building loses a hit point, empty ones too. */
  | { kind: "property" }
  /** Every invader down, those still to arrive too. */
  | { kind: "rout" };

/** Reputation each bonus objective met pays, on top of holding the block. */
export const BONUS_REPUTATION = 2;

/** Where an objective stands: met, failed, or still open while the fight goes on. */
export type ObjectiveState = "met" | "failed" | "open";

/** A building's name as the fight shows it. */
export const structureName = (c: Combat, id: number): string => c.arena.structures[id]!.name.replace(/^building\./, "").replace(/\./g, " ");

/** What an objective asks, in words. */
export function objectiveText(o: Objective, c: Combat): string {
  switch (o.kind) {
    case "fires":
      return "No fire left burning";
    case "evacuate": {
      const name = structureName(c, o.structure);
      return `Evacuate the ${name}${/\btower\b/.test(name) ? "" : " tower"}`;
    }
    case "unhurt":
      return "No rig damaged";
    case "property":
      return "No building damaged";
    case "rout":
      return "Every invader down";
  }
}

const burning = (c: Combat) => c.fire.some((f) => f > 0);
const squadHurt = (start: Combat, now: Combat) => now.roster.some((_, u) => teamOf(now, u) === SQUAD && now.hp[u]! < start.hp[u]!);
const invadersLeft = (c: Combat) => c.roster.some((_, u) => teamOf(c, u) !== SQUAD && c.hp[u]! > 0) || c.schedule.slice(c.round).some((r) => r.length > 0);

/**
 * Where an objective stands from the fight's start to now; `over` once the
 * fight has ended (an open one is then failed).
 */
export function objectiveState(o: Objective, start: Combat, now: Combat, over: boolean): ObjectiveState {
  let state: ObjectiveState;
  switch (o.kind) {
    case "fires":
      state = over ? (burning(now) ? "failed" : "met") : "open";
      break;
    case "evacuate":
      state = now.evacuated[o.structure] ? "met" : now.structHp[o.structure]! <= 0 ? "failed" : "open";
      break;
    case "unhurt":
      state = squadHurt(start, now) ? "failed" : over ? "met" : "open";
      break;
    case "property":
      state = now.razed > start.razed ? "failed" : over ? "met" : "open";
      break;
    case "rout":
      state = invadersLeft(now) ? "open" : "met";
      break;
  }
  return over && state === "open" ? "failed" : state;
}

/** Whether a fight that ended in `end` met an objective. */
export const objectiveMet = (o: Objective, start: Combat, end: Combat): boolean => objectiveState(o, start, end, true) === "met";

/**
 * The objectives a fight could ask for, the board's own first (its fires,
 * its towers), then those any fight can: each still to be checked as
 * reachable along with holding the block.
 */
export function objectiveCandidates(c: Combat): Objective[] {
  const a = c.arena;
  const out: Objective[] = [];
  // fire: ground that burns, and something that sets it alight (or a fire burning already)
  let burnable = 0;
  for (let k = 0; k < a.w * a.h; k++) if (a.flags[k]! & A_BURNS && structureAt(c, k) < 0) burnable++;
  const igniter = [...c.roster, ...c.schedule.flat().map((r) => r.kind)].some((kind) => FIGHTERS[kind].weapons.some((w) => w.ignites));
  if (burning(c) || (burnable >= 3 && igniter)) out.push({ kind: "fires" });
  // a tower full of people that could come down: the fullest
  let tower = -1;
  a.structures.forEach((s, id) => {
    if (s.topple > 0 && s.people >= 10 && c.structHp[id]! > 0 && !c.evacuated[id] && (tower < 0 || s.people > a.structures[tower]!.people)) tower = id;
  });
  if (tower >= 0) out.push({ kind: "evacuate", structure: tower });
  out.push({ kind: "unhurt" }, { kind: "property" }, { kind: "rout" });
  return out;
}
