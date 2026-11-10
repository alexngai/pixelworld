import type { WorldManifest } from "@pixelworlds/engine";

/**
 * Moving between scale levels (D-046, D-048): each level is its own world
 * package with its own grid, so a place and a heading cross over as
 * lon/lat, through each package's geo grid.
 */

/** The level of a world package named `name` ("fly", "drive"), as a package URL beside this one; null without it. */
export function levelUrl(worldUrl: string, manifest: WorldManifest, name: string, base = "http://localhost/"): string | null {
  const level = manifest.levels?.find((l) => l.name === name);
  if (!level) return null;
  const here = new URL(worldUrl.endsWith("/") ? worldUrl : worldUrl + "/", base);
  return new URL(`../${level.world}/`, here).pathname;
}

/** The label of a world's level (its manifest's list), or its name. */
export function levelLabel(manifest: WorldManifest): string {
  const name = manifest.level ?? "";
  return manifest.levels?.find((l) => l.name === name)?.label ?? (name || manifest.name);
}

interface Geo {
  cellToLonLat(x: number, y: number): [number, number] | null;
  lonLatToCell(lon: number, lat: number): [number, number] | null;
}

/** A place and a heading in one level, as lon/lat and a lon/lat a step ahead. */
export interface GeoPose {
  lon: number;
  lat: number;
  /** A point one cell ahead along the heading, in the source level. */
  aheadLon: number;
  aheadLat: number;
}

export function poseToGeo(geo: Geo, x: number, y: number, heading: number): GeoPose | null {
  const here = geo.cellToLonLat(x, y);
  const ahead = geo.cellToLonLat(x + Math.cos(heading), y + Math.sin(heading));
  if (!here || !ahead) return null;
  return { lon: here[0], lat: here[1], aheadLon: ahead[0], aheadLat: ahead[1] };
}

/** A pose from another level in this one's cells: the place, and the heading toward the point ahead. */
export function geoToPose(geo: Geo, pose: GeoPose): { x: number; y: number; heading: number } | null {
  const here = geo.lonLatToCell(pose.lon, pose.lat);
  if (!here) return null;
  const ahead = geo.lonLatToCell(pose.aheadLon, pose.aheadLat);
  const heading = ahead ? Math.atan2(ahead[1] - here[1], ahead[0] - here[0]) : 0;
  return { x: here[0], y: here[1], heading };
}

/** Where a world's game starts by default: a place on a road, and where it heads. */
export interface StartPoint {
  name: string;
  lon: number;
  lat: number;
  /** Head along the road toward here. */
  toward: { lon: number; lat: number };
}

/** The default starts of the two regions, by package id (any of their levels). */
export const STARTS: Record<string, StartPoint> = {
  // on Las Vegas Boulevard at the Strip, heading south (toward the Welcome sign) on the way to Hoover Dam
  southwest: { name: "Las Vegas Boulevard", lon: -115.1729, lat: 36.112, toward: { lon: -115.1728, lat: 36.082 } },
  // on the Embarcadero by the Ferry Building, heading north toward Fisherman's Wharf
  sf: { name: "the Embarcadero", lon: -122.3937, lat: 37.7955, toward: { lon: -122.4177, lat: 37.808 } },
};

/** The default start for a world package (by its id, or the region it is a level of). */
export function startFor(manifest: WorldManifest): StartPoint | null {
  const id = manifest.id;
  if (STARTS[id]) return STARTS[id]!;
  const region = Object.keys(STARTS).find((k) => id.startsWith(k + "-") || manifest.levels?.some((l) => l.world === k));
  return region ? STARTS[region]! : null;
}
