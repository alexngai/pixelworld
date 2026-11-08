import type { Route } from "./routes";

/**
 * Vehicle kinds of ambient traffic (D-060): real sizes and speeds, which
 * routes each uses, and how many to keep around the view.
 */
export type VehicleKind = "car" | "bus" | "cablecar" | "streetcar" | "lightrail" | "train" | "ferry";

export const VEHICLE_KINDS: readonly VehicleKind[] = ["car", "bus", "cablecar", "streetcar", "lightrail", "train", "ferry"];

export interface KindSpec {
  /** One car of the vehicle, metres. */
  length: number;
  width: number;
  height: number;
  /** Cars in a consist (a train's locomotive and wagons), and the gap between them (m). */
  cars: number;
  gap: number;
  /** Cruising speed (m/s); roads set their own for cars and buses. */
  speed: number;
  /** Vehicles per cell of usable route length around the view. */
  density: number;
  /** At most this many around the view. */
  max: number;
  /** Paint variants (models.ts). */
  variants: number;
  /** Seconds standing at the end of a line before going back. */
  dwell: number;
  /** Distance (m) from the route's line to the vehicle's centre, to its right. */
  lane: number;
}

export const KINDS: Record<VehicleKind, KindSpec> = {
  car: { length: 4.6, width: 1.9, height: 1.5, cars: 1, gap: 0, speed: 12, density: 0.25, max: 150, variants: 8, dwell: 0.5, lane: 1.9 },
  bus: { length: 12, width: 2.6, height: 3.1, cars: 1, gap: 0, speed: 10, density: 0.012, max: 12, variants: 2, dwell: 1, lane: 1.9 },
  cablecar: { length: 8.5, width: 2.4, height: 3.2, cars: 1, gap: 0, speed: 4.2, density: 0.06, max: 10, variants: 2, dwell: 6, lane: 1.6 },
  streetcar: { length: 15, width: 2.6, height: 3.3, cars: 1, gap: 0, speed: 8, density: 0.04, max: 8, variants: 4, dwell: 4, lane: 1.6 },
  lightrail: { length: 23, width: 2.7, height: 3.4, cars: 2, gap: 0.6, speed: 11, density: 0.02, max: 6, variants: 2, dwell: 4, lane: 1.8 },
  train: { length: 20, width: 3, height: 4, cars: 5, gap: 1, speed: 18, density: 0.008, max: 3, variants: 2, dwell: 6, lane: 0 },
  ferry: { length: 40, width: 10, height: 6, cars: 1, gap: 0, speed: 9, density: 0.02, max: 4, variants: 2, dwell: 8, lane: 0 },
};

/** Typical speeds (m/s) by road class. */
const ROAD_SPEED: Record<string, number> = {
  motorway: 28,
  trunk: 22,
  primary: 15,
  secondary: 13,
  tertiary: 12,
  residential: 9,
  unclassified: 9,
  living_street: 5,
  service: 5,
};

/** Road classes buses run on. */
const BUS_CLASSES = new Set(["trunk", "primary", "secondary", "tertiary"]);

export function roadSpeed(cls: string): number {
  return ROAD_SPEED[cls] ?? 10;
}

/** Whether a vehicle of this kind drives along this route. */
export function usesRoute(kind: VehicleKind, r: Route): boolean {
  switch (kind) {
    case "car":
      return r.net === "road";
    case "bus":
      return r.net === "road" && BUS_CLASSES.has(r.cls);
    case "ferry":
      return r.net === "ferry";
    default:
      return r.net === "rail" && r.kind === kind;
  }
}

/** A vehicle's cruising speed on a route (m/s), before its own variation. */
export function cruiseSpeed(kind: VehicleKind, r: Route): number {
  if (kind === "car") return roadSpeed(r.cls);
  if (kind === "bus") return Math.min(roadSpeed(r.cls), 13) * 0.85;
  return KINDS[kind].speed;
}

/**
 * How a scale level shows vehicles. Walking levels move them at real speed;
 * driving and flying levels compress distances, so vehicles go faster than
 * real in cells to look busy at their pace (the rover crosses a cell in a
 * third of a second). Vehicles are drawn at least `minCarCells` long, and every
 * kind scales by the same factor, so a bus stays longer than a car. A level may
 * cap that enlargement (`maxScale`, the manifest's `depiction.vehicleScale`): on
 * a flying level a car 0.55 cells long would be 55 m, longer than a bridge's
 * deck is wide, so there vehicles are drawn at most a few times their size.
 */
export interface LevelScale {
  metersPerCell: number;
  /** Real seconds per second of play. */
  timeScale: number;
  /** Drawn size over real size. */
  sizeScale: number;
  /** Heights drawn this much taller again, like the level's buildings (D-047). */
  heightStretch: number;
}

export function levelScale(
  metersPerCell: number,
  level?: string,
  opts: { minCarCells?: number; maxScale?: number; heightStretch?: number } = {},
): LevelScale {
  const timeScale = level === "walk" ? 1 : Math.max(1, Math.pow(metersPerCell / 10, 0.75));
  const legible = ((opts.minCarCells ?? 0.55) * metersPerCell) / KINDS.car.length;
  const sizeScale = Math.max(1, Math.min(opts.maxScale ?? Infinity, legible));
  return { metersPerCell, timeScale, sizeScale, heightStretch: opts.heightStretch ?? 1 };
}

/** Real metres to drawn cells at a level, at the car's enlargement. */
export function cells(scale: LevelScale, metres: number): number {
  return (metres / scale.metersPerCell) * scale.sizeScale;
}

/**
 * Real metres to drawn cells for one kind. Long vehicles are enlarged less
 * than a car (by the square root of their length ratio), so a car stays
 * legible while a train or a ferry doesn't fill the street: a bus is still
 * longer than a car, a wagon longer than a bus.
 */
export function kindCells(scale: LevelScale, kind: VehicleKind, metres: number): number {
  const f = Math.max(1, scale.sizeScale * Math.sqrt(KINDS.car.length / KINDS[kind].length));
  return (metres / scale.metersPerCell) * f;
}
