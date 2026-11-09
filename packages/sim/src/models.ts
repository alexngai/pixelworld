import type { Box } from "@pixelworlds/generators";
import { KINDS, kindCells, type LevelScale, type VehicleKind } from "./catalog";

/**
 * Generic vehicle models as boxes (no names or logos), sized from the
 * catalog at a level's scale. A model faces +x and is centred on the origin,
 * x and y in cells and z in height steps; `heading` turns the whole model.
 * Colours are palette ramps, looked up by name with fallbacks so any style
 * pack can draw them.
 */

/** One height step is 1/√6 cell (architecture §3.4). */
const STEP_CELLS = 1 / Math.sqrt(6);

/** Ramp id of the first name the palette has (else ramp 0). */
export type RampLookup = (names: readonly string[]) => number;

const PAINT = {
  car: [
    ["marker"],
    ["paint-white", "concrete", "stucco"],
    ["paint-sky", "glass"],
    ["paint-slate", "iron", "asphalt"],
    ["paint-butter", "tower-gold", "ochre"],
    ["concrete", "urban"],
    ["paint-sage", "conifer", "pine"],
    ["roof-slate", "asphalt", "basalt"],
  ],
  bus: [
    ["paint-white", "concrete"],
    ["paint-butter", "tower-gold", "ochre"],
  ],
  cablecar: [
    ["chinatown-red", "marker"],
    ["bridge-orange", "marker"],
  ],
  streetcar: [
    ["paint-butter", "tower-gold", "ochre"],
    ["paint-mint", "jade", "scrub"],
    ["paint-sky", "glass"],
    ["chinatown-red", "marker"],
  ],
  lightrail: [
    ["concrete", "paint-white"],
    ["paint-white", "concrete"],
  ],
  train: [
    ["paint-slate", "iron", "asphalt"],
    ["marker", "roof-tile"],
  ],
  ferry: [
    ["paint-white", "concrete", "stucco"],
    ["paint-cream", "stucco", "concrete"],
  ],
} satisfies Record<VehicleKind, string[][]>;

const GLASS = ["glass", "roof-slate", "asphalt"];
const DARK = ["asphalt", "roof-slate", "iron", "basalt"];
const CREAM = ["paint-cream", "stucco", "sand", "concrete"];
const ROOF = ["roof-slate", "roof-flat", "concrete", "urban"];
const WAGON = [["roof-tile", "bark", "ochre"], ["concrete", "urban", "paint-white"]];

export interface ModelSize {
  /** Cells. */
  length: number;
  width: number;
  /** Steps. */
  height: number;
}

export function modelSize(kind: VehicleKind, scale: LevelScale): ModelSize {
  const k = KINDS[kind];
  return {
    length: kindCells(scale, kind, k.length),
    width: kindCells(scale, kind, k.width),
    height: (kindCells(scale, kind, k.height) / STEP_CELLS) * scale.heightStretch,
  };
}

/** Object voxels per cell and per height step at render scale 1 (2×1 px tops, 1 px tall). */
const VOXELS_PER_CELL = 16;
const VOXELS_PER_STEP = 8;

/**
 * A vehicle's size in object voxels for its voxel model (D-064). Its length is
 * the simulation's (`kindCells`: long kinds enlarged less than a car). Width
 * and height are enlarged like a car's, but at most 1.6 times as much as the
 * length, so a bus is as wide as a car and a ferry keeps its proportions.
 */
export function vehicleVoxels(
  kind: VehicleKind,
  scale: LevelScale,
  renderScale = 1,
): { length: number; width: number; height: number } {
  const k = KINDS[kind];
  const along = kindCells(scale, kind, k.length) / (k.length / scale.metersPerCell);
  const across = Math.max(1, Math.min(scale.sizeScale, along * 1.6));
  const cells = (m: number) => (m / scale.metersPerCell) * across;
  return {
    length: Math.max(2, Math.round(kindCells(scale, kind, k.length) * VOXELS_PER_CELL * renderScale)),
    width: Math.max(1, Math.round(cells(k.width) * VOXELS_PER_CELL * renderScale)),
    height: Math.max(2, Math.round((cells(k.height) / STEP_CELLS) * scale.heightStretch * VOXELS_PER_STEP * renderScale)),
  };
}

/**
 * The boxes of one car of a vehicle: `part` 0 is a consist's head (a train's
 * locomotive), later parts its wagons.
 */
export function vehicleBoxes(
  kind: VehicleKind,
  variant: number,
  part: number,
  heading: number,
  scale: LevelScale,
  ramp: RampLookup,
): Box[] {
  const { length: L, width: W, height: H } = modelSize(kind, scale);
  const paints = PAINT[kind];
  const paint = ramp(paints[variant % paints.length]!);
  const out: Box[] = [];
  /** A box by fractions: x along (−½…½ of L), y across (−½…½ of W), z up (0…1 of H). */
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r: number) =>
    out.push({ x0: x0 * L, x1: x1 * L, y0: y0 * W, y1: y1 * W, z0: z0 * H, z1: z1 * H, ramp: r, rot: heading });
  const glass = ramp(GLASS);
  const dark = ramp(DARK);
  switch (kind) {
    case "car":
      box(-0.5, 0.5, -0.5, 0.5, 0.08, 0.55, paint);
      box(-0.3, 0.15, -0.44, 0.44, 0.55, 0.9, glass);
      box(-0.28, 0.12, -0.42, 0.42, 0.9, 1, paint);
      box(-0.42, 0.42, -0.47, 0.47, 0, 0.1, dark);
      break;
    case "bus":
      box(-0.5, 0.5, -0.5, 0.5, 0.06, 0.45, paint);
      box(-0.49, 0.5, -0.49, 0.49, 0.45, 0.82, glass);
      box(-0.5, 0.5, -0.5, 0.5, 0.82, 1, ramp(["paint-white", "concrete"]));
      box(-0.45, 0.45, -0.46, 0.46, 0, 0.08, dark);
      break;
    case "cablecar": {
      // a closed saloon in the middle, open benches at both ends, running boards
      const cream = ramp(CREAM);
      box(-0.24, 0.24, -0.5, 0.5, 0.12, 0.5, paint);
      box(-0.24, 0.24, -0.48, 0.48, 0.5, 0.86, glass);
      for (const [a, b] of [[-0.5, -0.24], [0.24, 0.5]] as const) {
        box(a, b, -0.5, 0.5, 0.12, 0.32, paint); // the open ends' floor and benches
        box(a, b, -0.18, 0.18, 0.32, 0.48, cream);
        for (const y of [-0.5, 0.38]) box(a < 0 ? a : b - 0.05, a < 0 ? a + 0.05 : b, y, y + 0.12, 0.32, 0.86, cream);
      }
      box(-0.53, 0.53, -0.54, 0.54, 0.86, 1, ramp(ROOF));
      for (const y of [-0.62, 0.5]) box(-0.46, 0.46, y, y + 0.12, 0.1, 0.18, dark); // running boards
      box(-0.4, 0.4, -0.4, 0.4, 0, 0.12, dark);
      break;
    }
    case "streetcar":
    case "lightrail": {
      box(-0.5, 0.5, -0.5, 0.5, 0.1, 0.5, paint);
      box(-0.49, 0.49, -0.48, 0.48, 0.5, 0.84, glass);
      box(-0.5, 0.5, -0.5, 0.5, 0.84, 0.95, kind === "streetcar" ? ramp(CREAM) : paint);
      if (part === 0) box(-0.06, 0.06, -0.2, 0.2, 0.95, 1.12, dark); // pantograph
      box(-0.42, 0.42, -0.42, 0.42, 0, 0.1, dark);
      break;
    }
    case "train": {
      box(-0.46, 0.46, -0.42, 0.42, 0, 0.14, dark); // bogies
      if (part === 0) {
        box(-0.5, 0.28, -0.4, 0.4, 0.14, 0.78, paint); // the hood
        box(0.28, 0.5, -0.5, 0.5, 0.14, 0.62, paint); // the cab
        box(0.29, 0.5, -0.48, 0.48, 0.62, 0.92, glass);
        box(0.27, 0.5, -0.5, 0.5, 0.92, 1, paint);
      } else if (variant % 2 === 0) {
        box(-0.5, 0.5, -0.5, 0.5, 0.14, 1, ramp(WAGON[part % 2]!)); // freight wagons
      } else {
        box(-0.5, 0.5, -0.5, 0.5, 0.14, 0.55, ramp(WAGON[1]!)); // passenger coaches
        box(-0.49, 0.49, -0.48, 0.48, 0.55, 0.85, glass);
        box(-0.5, 0.5, -0.5, 0.5, 0.85, 1, ramp(WAGON[1]!));
      }
      break;
    }
    case "ferry": {
      const hull = ramp(["paint-slate", "iron", "asphalt"]);
      box(-0.5, 0.3, -0.5, 0.5, 0, 0.3, hull); // hull, stepping in to the bow
      box(0.3, 0.42, -0.36, 0.36, 0, 0.3, hull);
      box(0.42, 0.5, -0.18, 0.18, 0, 0.3, hull);
      box(-0.38, 0.22, -0.42, 0.42, 0.3, 0.46, paint);
      box(-0.37, 0.21, -0.41, 0.41, 0.46, 0.6, glass);
      box(-0.38, 0.22, -0.42, 0.42, 0.6, 0.66, paint);
      box(-0.24, 0.1, -0.3, 0.3, 0.66, 0.84, paint); // upper deck house
      box(0.0, 0.1, -0.2, 0.2, 0.84, 1, glass); // wheelhouse
      break;
    }
  }
  return out;
}
