import type { LandmarkInfo } from "@pixelworld/engine";

/**
 * Place names for the HUD: the world's registry landmarks (named here for
 * people; the world never draws names), and a small gazetteer of towns and
 * sights along the game's two regions.
 */

export interface NamedPlace {
  name: string;
  lon: number;
  lat: number;
  /** Landmarks win over towns at the same distance. */
  landmark?: boolean;
}

/** Towns and sights (lon, lat), for "near …" on the HUD. */
export const GAZETTEER: readonly NamedPlace[] = [
  // the Southwest
  { name: "the Las Vegas Strip", lon: -115.1728, lat: 36.1147 },
  { name: "Downtown Las Vegas", lon: -115.1435, lat: 36.1699 },
  { name: "North Las Vegas", lon: -115.1175, lat: 36.1989 },
  { name: "Henderson", lon: -114.9817, lat: 36.0395 },
  { name: "Boulder City", lon: -114.832, lat: 35.9786 },
  { name: "Lake Mead", lon: -114.45, lat: 36.15 },
  { name: "Black Canyon", lon: -114.735, lat: 35.98 },
  { name: "Searchlight", lon: -114.9197, lat: 35.4653 },
  { name: "Laughlin", lon: -114.5714, lat: 35.1678 },
  { name: "Kingman", lon: -114.053, lat: 35.1894 },
  { name: "Seligman", lon: -112.8774, lat: 35.3255 },
  { name: "Williams", lon: -112.191, lat: 35.2495 },
  { name: "Flagstaff", lon: -111.6513, lat: 35.1983 },
  { name: "Valle", lon: -112.2007, lat: 35.6519 },
  { name: "Tusayan", lon: -112.126, lat: 35.9736 },
  { name: "Grand Canyon Village", lon: -112.1401, lat: 36.0544 },
  { name: "Mather Point", lon: -112.1076, lat: 36.0617 },
  { name: "the Grand Canyon", lon: -112.08, lat: 36.1 },
  { name: "the North Rim", lon: -112.052, lat: 36.199 },
  { name: "Desert View", lon: -111.8261, lat: 36.0441 },
  // San Francisco
  { name: "the Embarcadero", lon: -122.3937, lat: 37.7955 },
  { name: "Fisherman's Wharf", lon: -122.4177, lat: 37.808 },
  { name: "North Beach", lon: -122.4103, lat: 37.8061 },
  { name: "Chinatown", lon: -122.4058, lat: 37.7941 },
  { name: "Union Square", lon: -122.4075, lat: 37.788 },
  { name: "SoMa", lon: -122.4, lat: 37.778 },
  { name: "the Mission", lon: -122.4194, lat: 37.7599 },
  { name: "the Castro", lon: -122.435, lat: 37.7609 },
  { name: "Haight-Ashbury", lon: -122.4469, lat: 37.7692 },
  { name: "Golden Gate Park", lon: -122.4862, lat: 37.7694 },
  { name: "the Presidio", lon: -122.4662, lat: 37.7989 },
  { name: "the Marina", lon: -122.4368, lat: 37.8037 },
  { name: "Pacific Heights", lon: -122.4352, lat: 37.7925 },
  { name: "Nob Hill", lon: -122.4155, lat: 37.793 },
  { name: "Russian Hill", lon: -122.4195, lat: 37.8 },
  { name: "Twin Peaks", lon: -122.4477, lat: 37.7544 },
  { name: "the Sunset", lon: -122.4944, lat: 37.7531 },
  { name: "the Richmond", lon: -122.4836, lat: 37.78 },
  { name: "Ocean Beach", lon: -122.5108, lat: 37.7594 },
  { name: "Bernal Heights", lon: -122.4156, lat: 37.7389 },
  { name: "Dogpatch", lon: -122.3889, lat: 37.7609 },
  { name: "Treasure Island", lon: -122.3708, lat: 37.8235 },
  { name: "Sausalito", lon: -122.4853, lat: 37.8591 },
  { name: "Oakland", lon: -122.2711, lat: 37.8044 },
];

/** How the registry's ids read as names, where title case isn't right. */
const LANDMARK_NAMES: Record<string, string> = {
  "strat-tower": "the Strat",
  "welcome-sign": "the Welcome to Las Vegas sign",
  "eiffel-replica": "the Paris Las Vegas tower",
  "high-roller": "the High Roller",
  "hoover-dam": "Hoover Dam",
  "hoover-bypass-bridge": "the Hoover Dam Bypass bridge",
  "desert-view-watchtower": "the Desert View Watchtower",
  "golden-gate-bridge": "the Golden Gate Bridge",
  "bay-bridge-west": "the Bay Bridge",
  "sf-city-hall": "City Hall",
  "ferry-building": "the Ferry Building",
  "coit-tower": "Coit Tower",
  "transamerica-pyramid": "the Transamerica Pyramid",
  "salesforce-tower": "Salesforce Tower",
  "sutro-tower": "Sutro Tower",
  "palace-of-fine-arts": "the Palace of Fine Arts",
  "alcatraz-cellhouse": "Alcatraz",
  "alcatraz-lighthouse": "Alcatraz",
  "dragon-gate": "the Dragon Gate",
};

/** A landmark's name from its registry id. */
export function landmarkName(id: string): string {
  return LANDMARK_NAMES[id] ?? id.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Great-circle distance (km). */
export function distanceKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The world's landmarks as named places (through its geo grid). */
export function landmarkPlaces(marks: readonly LandmarkInfo[], cellToLonLat: (x: number, y: number) => [number, number] | null): NamedPlace[] {
  const out: NamedPlace[] = [];
  for (const l of marks) {
    const ll = cellToLonLat(l.x, l.y);
    if (ll) out.push({ name: landmarkName(l.id), lon: ll[0], lat: ll[1], landmark: true });
  }
  return out;
}

/**
 * The nearest named place to a lon/lat: a landmark within `landmarkKm`, else
 * the nearest place of all (null beyond `maxKm`).
 */
export function nearestPlace(
  lon: number,
  lat: number,
  places: readonly NamedPlace[],
  opts: { landmarkKm?: number; maxKm?: number } = {},
): { name: string; km: number } | null {
  let best: { name: string; km: number } | null = null;
  let bestMark: { name: string; km: number } | null = null;
  for (const p of places) {
    const km = distanceKm(lon, lat, p.lon, p.lat);
    if (p.landmark && km <= (opts.landmarkKm ?? 3) && (!bestMark || km < bestMark.km)) bestMark = { name: p.name, km };
    if (!best || km < best.km) best = { name: p.name, km };
  }
  if (bestMark) return bestMark;
  return best && best.km <= (opts.maxKm ?? 60) ? best : null;
}
