/**
 * Where fights happen (D-153): each city's walking level, and the blocks in
 * it that make a board (enough buildings, enough open ground), with the
 * board's cell size: two world cells where buildings are big, one where
 * they are small. An operation is a city's sites, fought in order.
 */

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
