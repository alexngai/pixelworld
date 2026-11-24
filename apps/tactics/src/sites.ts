/**
 * Where fights happen (D-153): each city's walking level, with places named in
 * it (the survey names its boards after them and ranks the best round each).
 * An operation is three blocks drawn from the city's surveyed boards (D-178,
 * docs/tactics/map-survey.md).
 */

/** A named place, with the board cell size that suits it: two world cells where buildings are big, one where they are small. */
export interface Site {
  name: string;
  lon: number;
  lat: number;
  /** World cells a board cell. */
  cell: number;
}

export interface City {
  name: string;
  /** The walking level's world package. */
  world: string;
  sites: Site[];
}

/** A surveyed board (apps/tactics/survey/boards.json, written by tools/survey-boards.mjs). */
export interface Block {
  name: string;
  /** The survey's character zone. */
  zone: number;
  x0: number;
  y0: number;
  /** World cells a board cell. */
  cell: number;
  /** The survey's score, with the ratings' (D-177, D-178). */
  score: number;
}

/** The blocks an operation holds. */
export const BLOCKS = 3;
/** How much likelier a board is than one scoring 0.05 less: e (the draw's temperature). */
const TEMPERATURE = 0.05;

const middle = (b: Block) => [b.x0 + 4 * b.cell, b.y0 + 4 * b.cell] as const;

/**
 * A board drawn for an operation (D-178): likelier the better it scores, never
 * on or by one already drawn, from a zone and of a name not yet drawn while
 * any such is left. Null when none is left. `skip` are boards tried and
 * given up on (no fight could be made on them).
 */
export function drawBlock(pool: readonly Block[], drawn: readonly Block[], random: () => number, skip: readonly Block[] = []): Block | null {
  const free = pool.filter((b) => !skip.includes(b) && drawn.every((d) => d !== b && Math.hypot(middle(b)[0] - middle(d)[0], middle(b)[1] - middle(d)[1]) >= 12 * Math.max(b.cell, d.cell)));
  const fresh = free.filter((b) => drawn.every((d) => d.zone !== b.zone && d.name !== b.name));
  const from = fresh.length ? fresh : free;
  if (!from.length) return null;
  const top = Math.max(...from.map((b) => b.score));
  const weights = from.map((b) => Math.exp((b.score - top) / TEMPERATURE));
  let r = random() * weights.reduce((p, q) => p + q, 0);
  for (let i = 0; i < from.length; i++) if ((r -= weights[i]!) < 0) return from[i]!;
  return from[from.length - 1]!;
}

/** An operation's blocks: drawn, then fought from the least to the best (the best last, a finale). */
export function drawOperation(pool: readonly Block[], random: () => number, n = BLOCKS): Block[] {
  const drawn: Block[] = [];
  while (drawn.length < n) {
    const b = drawBlock(pool, drawn, random);
    if (!b) break;
    drawn.push(b);
  }
  return drawn.sort((p, q) => p.score - q.score);
}

export const CITIES: City[] = [
  {
    name: "New York",
    world: "nyc-walk",
    sites: [
      { name: "the Financial District", lon: -74.0125, lat: 40.7055, cell: 2 },
      { name: "Midtown", lon: -73.9855, lat: 40.758, cell: 2 },
      { name: "SoHo", lon: -74.004, lat: 40.723, cell: 2 },
    ],
  },
  {
    name: "San Francisco",
    world: "sf-walk",
    sites: [
      { name: "North Beach", lon: -122.4075, lat: 37.7945, cell: 2 },
      { name: "Russian Hill", lon: -122.418, lat: 37.801, cell: 1 },
    ],
  },
  {
    name: "Kyoto",
    world: "kyoto-walk",
    sites: [
      { name: "Pontochō", lon: 135.7712, lat: 35.0047, cell: 1 },
      { name: "Gion", lon: 135.775, lat: 35.0037, cell: 1 },
      { name: "Shijō-Kawaramachi", lon: 135.769, lat: 35.0035, cell: 2 },
    ],
  },
  {
    name: "Hong Kong",
    world: "hongkong-walk",
    sites: [
      { name: "Mong Kok", lon: 114.17, lat: 22.319, cell: 2 },
      { name: "Tsim Sha Tsui", lon: 114.172, lat: 22.297, cell: 2 },
      { name: "Yau Ma Tei", lon: 114.17, lat: 22.308, cell: 1 },
    ],
  },
  { name: "Paris", world: "paris-walk", sites: [{ name: "Le Marais", lon: 2.358, lat: 48.859, cell: 2 }] },
  { name: "Tokyo", world: "tokyo-walk", sites: [{ name: "Harajuku", lon: 139.705, lat: 35.67, cell: 2 }] },
];
