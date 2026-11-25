import type { FrontSite } from "@pixelworlds/tactics";

/**
 * Where fights happen (D-153): each city's walking level, with places named in
 * it (the survey names its boards after them and ranks the best round each).
 * An operation is the city's front over its surveyed boards (D-178, D-179,
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
  /** A rooftop map's floor (steps, D-180): the roofs at it and above are played on, the street below is a chasm. */
  floor?: number;
  /** The survey's score, with the ratings' (D-177, D-178). */
  score: number;
}

/** The surveyed boards as the city's front takes them (D-179): each one's middle, name and score. */
export const sitesOf = (pool: readonly Block[]): FrontSite[] => pool.map((b) => ({ name: b.name, x: b.x0 + 4 * b.cell, y: b.y0 + 4 * b.cell, score: b.score }));

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
