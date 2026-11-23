import { EVACUATE, FIGHTERS, type FighterKind, type Loadout, type Weapon } from "./combat";

/**
 * Squads, weapons and upgrades (D-172), after Into the Breach: the preset
 * squads a run is played with (three rigs, each with the weapons in its two
 * slots, and every rig able to evacuate), the weapons a depot sells for a
 * slot, and each weapon's upgrades, a core powering each. A run keeps its
 * weapons as ids and the upgrades powered; `armed` and `loadoutOf` make the
 * rules' weapons of them.
 */

export interface Upgrade {
  name: string;
  apply: (w: Weapon) => Weapon;
}

export interface WeaponDef {
  weapon: Weapon;
  /** What it does, in a few words. */
  about: string;
  /** Its price in a depot (reputation). */
  cost: number;
  upgrades: readonly Upgrade[];
}

const HARDER: Upgrade = { name: "+1 damage", apply: (w) => ({ ...w, damage: w.damage + 1 }) };
const FURTHER: Upgrade = { name: "+1 reach", apply: (w) => ({ ...w, range: [w.range![0], w.range![1] + 1] }) };
const SHOVES: Upgrade = { name: "pushes", apply: (w) => ({ ...w, push: true }) };

export const WEAPONS = {
  ram: { weapon: FIGHTERS.wrecker.weapons[0]!, about: "Strikes the next cell and pushes what's there on.", cost: 2, upgrades: [HARDER] },
  waterCannon: { weapon: FIGHTERS.pumper.weapons[0]!, about: "Shoots the first thing along a line, pushes it on, puts out fire.", cost: 2, upgrades: [HARDER] },
  drop: { weapon: FIGHTERS.crane.weapons[0]!, about: "Drops a load on a cell along a line, over what's between; what stands round it is pushed out.", cost: 3, upgrades: [HARDER, FURTHER] },
  hoist: { weapon: FIGHTERS.crane.weapons[1]!, about: "Lifts the unit on the next cell and sets it down within two.", cost: 3, upgrades: [] },
  blade: { weapon: FIGHTERS.dozer.weapons[0]!, about: "Shoves the next cell's unit on, a light blow.", cost: 2, upgrades: [HARDER] },
  deluge: { weapon: FIGHTERS.ladder.weapons[0]!, about: "Pours water on a cell from above, puts out fire; what stands round it is pushed out.", cost: 3, upgrades: [HARDER, FURTHER] },
  foam: { weapon: { name: "foam cannon", kind: "shot", damage: 0, push: true, douses: true }, about: "Pushes the first thing along a line on and puts out fire, harming nothing.", cost: 2, upgrades: [HARDER] },
  pileDriver: { weapon: { name: "pile driver", kind: "melee", damage: 3, push: false }, about: "A heavy blow to the next cell; it pushes nothing.", cost: 3, upgrades: [HARDER] },
  wreckingBall: { weapon: { name: "wrecking ball", kind: "lob", damage: 2, push: false, range: [2, 3] }, about: "Swings onto a cell along a line, over what's between.", cost: 3, upgrades: [SHOVES, FURTHER] },
  flare: { weapon: { name: "flare", kind: "shot", damage: 1, push: false, ignites: true }, about: "Shoots the first thing along a line and sets lawns and woods there alight.", cost: 2, upgrades: [HARDER] },
} satisfies Record<string, WeaponDef>;

export type WeaponId = keyof typeof WEAPONS;
export const WEAPON_IDS = Object.keys(WEAPONS) as WeaponId[];

/** A weapon as a run holds it: which, and the upgrades powered (their places in its `upgrades`). */
export interface Armed {
  id: WeaponId;
  ups: number[];
}

export interface SquadRig {
  kind: FighterKind;
  /** Two slots; an empty one a depot's weapon can fill. */
  slots: [WeaponId | null, WeaponId | null];
}

export interface Squad {
  id: string;
  name: string;
  about: string;
  rigs: readonly SquadRig[];
  /** What unlocks it: blocks held over every run, or operations held to the last block. None: open from the start. */
  unlock?: { blocksHeld?: number; operationsHeld?: number };
}

export const SQUADS: readonly Squad[] = [
  {
    id: "demolition",
    name: "Demolition Crew",
    about: "Ram, wash and drop: the crew that came first.",
    rigs: [
      { kind: "wrecker", slots: ["ram", null] },
      { kind: "pumper", slots: ["waterCannon", null] },
      { kind: "crane", slots: ["drop", "hoist"] },
    ],
  },
  {
    id: "brigade",
    name: "Fire Brigade",
    about: "Foam from the street, water from above, a blade to shove: they move invaders more than they hurt them.",
    rigs: [
      { kind: "pumper", slots: ["foam", null] },
      { kind: "ladder", slots: ["deluge", null] },
      { kind: "dozer", slots: ["blade", null] },
    ],
    unlock: { blocksHeld: 3 },
  },
  {
    id: "heavy",
    name: "Heavy Works",
    about: "Heavy blows that leave invaders where they stand, and a crane to put them where they're wanted.",
    rigs: [
      { kind: "wrecker", slots: ["pileDriver", null] },
      { kind: "crane", slots: ["wreckingBall", "hoist"] },
      { kind: "dozer", slots: ["blade", null] },
    ],
    unlock: { operationsHeld: 1 },
  },
];

/** A weapon with its powered upgrades applied. */
export function armed(a: Armed): Weapon {
  const def: WeaponDef = WEAPONS[a.id];
  return a.ups.reduce((w, i) => def.upgrades[i]?.apply(w) ?? w, def.weapon);
}

/** A rig as the rules take it: its kind, its slots' weapons in order, then evacuate. */
export function loadoutOf(kind: FighterKind, slots: readonly (Armed | null)[]): Loadout {
  return { kind, arms: [...slots.flatMap((s) => (s ? [armed(s)] : [])), EVACUATE] };
}
