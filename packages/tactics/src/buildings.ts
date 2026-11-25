import type { ObjectInstance } from "@pixelworlds/engine";

/**
 * Occupants and materials of a world's placed objects (D-149): how many
 * people a building holds and what it is built of, from what the objects
 * file says about it (its group's typology, footprint, storeys, real
 * height, year and facade). Estimates, for gameplay: a brownstone burns
 * where a glass tower doesn't, and a tower holds hundreds where a house holds
 * a family.
 */

export type Material = "wood" | "brick" | "stone" | "concrete" | "steel" | "glass" | "earth" | "vegetation" | "metal";
export type Use = "residential" | "commercial" | "office" | "industrial" | "civic" | "religious" | "parking" | "none";

export interface ObjectInfo {
  /** Building or not (trees and props: no storeys, no one inside). */
  building: boolean;
  material: Material;
  use: Use;
  storeys: number;
  /** Real height (metres). */
  heightMeters: number;
  /** Floor area of one storey (m²): the footprint less its courtyards. */
  footprintM2: number;
  /** People inside at a busy hour: storeys × usable area ÷ area per person for its use. */
  occupants: number;
  /** How readily it catches and spreads fire (0–1). */
  flammability: number;
  /** How much it takes to bring down (relative: wood 1, steel 4). */
  strength: number;
  /** Year built, where the data says. */
  year: number | null;
}

/** A material's behaviour. */
export interface MaterialProps {
  flammability: number;
  strength: number;
}

export const MATERIALS: Record<Material, MaterialProps> = {
  vegetation: { flammability: 1, strength: 0.5 },
  wood: { flammability: 0.85, strength: 1 },
  brick: { flammability: 0.4, strength: 2 }, // masonry walls round timber floors
  stone: { flammability: 0.25, strength: 3 },
  earth: { flammability: 0.05, strength: 2 }, // Kyoto's kura: storehouses plastered against fire
  concrete: { flammability: 0.1, strength: 4 },
  steel: { flammability: 0.15, strength: 4 },
  glass: { flammability: 0.15, strength: 3 }, // a curtain wall on a steel frame
  metal: { flammability: 0, strength: 2 },
};

/** Gross floor area per person (m²) by use, at a busy hour. */
export const AREA_PER_PERSON: Record<Use, number> = {
  residential: 40,
  commercial: 20,
  office: 15,
  industrial: 50,
  civic: 25,
  religious: 15,
  parking: 400,
  none: Infinity,
};

/** What a group is: rules by group, the most specific (longest) prefix winning. A material or use left out is worked out from year and height. */
export type GroupRules = Record<string, { material?: Material; use?: Use; storeyMeters?: number }>;

export const GROUP_RULES: GroupRules = {
  tree: { material: "vegetation", use: "none" },
  prop: { material: "metal", use: "none" },
  landmark: { material: "stone", use: "civic" },
  "landmark.bridge": { material: "steel", use: "none" },
  "landmark.torii": { material: "wood", use: "none" },
  "landmark.pagoda": { material: "wood", use: "religious" },
  "landmark.gate": { material: "wood", use: "none" },
  "landmark.temple": { material: "wood", use: "religious" },
  "landmark.tower.lattice": { material: "steel", use: "none" },
  building: { use: "residential" },
  "building.residential": { use: "residential" },
  "building.house": { material: "wood", use: "residential" },
  "building.commercial": { use: "commercial" },
  "building.commercial.historic": { material: "stone", use: "commercial" },
  "building.industrial": { material: "brick", use: "industrial" },
  "building.parking": { material: "concrete", use: "parking" },
  "building.pier": { material: "steel", use: "industrial" },
  "building.civic": { material: "stone", use: "civic" },
  "building.temple": { material: "wood", use: "religious" },
  "building.shrine": { material: "wood", use: "religious" },
  "building.tower": { material: "steel", use: "office", storeyMeters: 4 },
  "building.tower.deco": { material: "stone", use: "office", storeyMeters: 4 },
  "building.tower.glass": { material: "glass", use: "office", storeyMeters: 4 },
  "building.tower.slab": { material: "concrete", use: "office", storeyMeters: 4 },
  "building.tower.postmodern": { material: "steel", use: "office", storeyMeters: 4 },
  "building.tower.hotel": { material: "concrete", use: "residential", storeyMeters: 3.5 },
  "building.tower.residential": { material: "concrete", use: "residential", storeyMeters: 3 },
  "building.office": { material: "concrete", use: "office" },
  // New York
  "building.brownstone": { material: "brick", use: "residential" },
  "building.tenement": { material: "brick", use: "residential" },
  "building.apartment.prewar": { material: "brick", use: "residential" },
  "building.loft.castiron": { material: "brick", use: "commercial", storeyMeters: 4.5 },
  // San Francisco
  "building.rowhouse": { material: "wood", use: "residential" },
  "building.apartment.bay": { material: "wood", use: "residential" },
  "building.apartment.modern": { material: "concrete", use: "residential" },
  "building.chinatown": { material: "brick", use: "commercial" },
  // Paris
  "building.haussmann": { material: "stone", use: "residential" },
  "building.faubourg": { material: "stone", use: "residential" },
  "building.hbm": { material: "brick", use: "residential" },
  "building.modern": { material: "concrete", use: "residential" },
  "building.palace": { material: "stone", use: "civic", storeyMeters: 5 },
  // Kyoto and Tokyo
  "building.machiya": { material: "wood", use: "residential" },
  "building.house.gabled": { material: "wood", use: "residential" },
  "building.kura": { material: "earth", use: "industrial" },
  "building.midrise": { material: "concrete", use: "residential" },
  "building.kodate": { material: "wood", use: "residential" },
  "building.mansion": { material: "concrete", use: "residential" },
  "building.shophouse": { material: "wood", use: "commercial" },
  "building.zakkyo": { material: "concrete", use: "commercial" },
  // Hong Kong
  "building.tonglau": { material: "concrete", use: "residential" },
  "building.estate": { material: "concrete", use: "residential", storeyMeters: 2.8 },
  "building.composite": { material: "concrete", use: "commercial" },
  "building.podium": { material: "concrete", use: "commercial" },
  "building.village": { material: "concrete", use: "residential" },
};

/** Overture facade materials, where the data names one, over the group's. */
const FACADE: Record<string, Material> = {
  glass: "glass",
  brick: "brick",
  stone: "stone",
  wood: "wood",
  concrete: "concrete",
  metal: "steel",
  plaster: "concrete",
};

function rule(group: string, rules: GroupRules): GroupRules[string] {
  for (let g = group; g; g = g.includes(".") ? g.slice(0, g.lastIndexOf(".")) : "") {
    const r = rules[g];
    if (r) return r;
  }
  return {};
}

/** The area of a ring (cells²). */
function ringArea(ring: readonly (readonly [number, number])[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j]![0] + ring[i]![0]) * (ring[j]![1] - ring[i]![1]);
  return Math.abs(a / 2);
}

export interface ObjectInfoOptions {
  /** The world's metres per cell (an instance's own `m` wins). */
  metersPerCell: number;
  /** Rules for groups (default GROUP_RULES); merge your own over them. */
  rules?: GroupRules;
}

/** What an object holds and is built of (`WorldQuery.object(index)` gives the instance). */
export function objectInfo(o: Readonly<ObjectInstance>, opts: ObjectInfoOptions): ObjectInfo {
  const r = rule(o.g, opts.rules ?? GROUP_RULES);
  const building = o.g.startsWith("building") || (o.g.startsWith("landmark") && r.use !== "none" && !!o.fp?.length);
  const m = o.m ?? opts.metersPerCell;
  const footprintM2 = o.fp?.length ? Math.max(0, ringArea(o.fp) - (o.fh ?? []).reduce((s, h) => s + ringArea(h), 0)) * m * m : 0;
  const storeyMeters = r.storeyMeters ?? 3.3;
  const heightMeters = o.hm ?? (o.fl ? o.fl * storeyMeters : building ? storeyMeters : 0);
  const storeys = building ? Math.max(1, o.fl ?? Math.round(heightMeters / storeyMeters)) : 0;
  const year = o.yr ?? null;
  // left to the data: tall is a steel frame, old is masonry, the rest concrete
  const guessed: Material = heightMeters > 45 ? "steel" : year !== null && year < 1930 ? "brick" : "concrete";
  const material: Material = (o.fm && FACADE[o.fm]) || r.material || (building ? guessed : "metal");
  const use: Use = r.use ?? (building ? "residential" : "none");
  const usable = 0.8; // walls, stairs and shafts take the rest
  const occupants = building ? Math.round((storeys * footprintM2 * usable) / AREA_PER_PERSON[use]) : 0;
  return { building, material, use, storeys, heightMeters, footprintM2, occupants, ...MATERIALS[material], year };
}
