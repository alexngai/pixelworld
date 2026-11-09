/**
 * The game's numbers (docs/decisions.md D-070), in the engine's units:
 * cells, height steps and seconds; speeds in cells per second.
 *
 * **Pace:** speeds are tuned to the screen, not to real metres. A warped
 * level (the Southwest's driving level: 100 m cells at the Strip and Hoover
 * Dam, 150 m at the canyon rim, 500 m in the open desert) compresses the
 * empty desert, so a car keeping a steady pace on screen covers real
 * distance fastest where there is least to see. Each level scales the speeds
 * below by its pace, from its nominal metres per cell: 1 on the Southwest's
 * driving (400 m) and flying (1,500 m) levels, down to a floor on finer
 * levels (San Francisco's 25 m driving level runs at 0.55).
 */

/** A level's pace: the speeds' factor from its nominal metres per cell (`ref`: where it is 1). */
export function pace(metersPerCell: number, ref: number, floor: number): number {
  return Math.max(floor, Math.min(1, Math.pow(metersPerCell / ref, 0.3)));
}

export const DRIVE_PACE = { ref: 400, floor: 0.55 };
export const FLY_PACE = { ref: 1500, floor: 0.5 };

/** Top speeds on roads by class (cells/s at pace 1). */
export const ROAD_SPEED: Record<string, number> = {
  motorway: 11,
  trunk: 9.5,
  primary: 8,
  secondary: 7,
  tertiary: 6.5,
  residential: 5.5,
  unclassified: 5.5,
  living_street: 4,
  service: 4,
  brick: 2.5,
};
/** A road class the table doesn't know. */
export const ROAD_SPEED_DEFAULT = 6;

/** Off-road top speed (cells/s at pace 1), times the surface's factor. */
export const OFFROAD_SPEED = 3.5;
export const SURFACE_FACTOR: Record<string, number> = {
  urban: 0.9,
  desert: 0.8,
  grass: 0.8,
  lawn: 0.7,
  farmland: 0.7,
  yard: 0.6,
  scrub: 0.6,
  sand: 0.5,
  woodland: 0.5,
  rock: 0.45,
  snow: 0.4,
  forest: 0.35,
  none: 0.5,
  water: 0,
};
export const SURFACE_FACTOR_DEFAULT = 0.6;

/** The car (speeds and accelerations at pace 1; they scale with it). */
export const CAR = {
  /** Full-throttle acceleration from rest (cells/s²), fading toward the top speed. */
  accel: 4.2,
  /** Braking (cells/s²). */
  brake: 12,
  /** Reverse: top speed and acceleration. */
  reverseSpeed: 2.2,
  reverseAccel: 3,
  /** Rolling resistance and drag: a constant and a part proportional to speed (per second). */
  roll: 0.4,
  drag: 0.12,
  /** Slowing to a surface's top speed when over it (cells/s²): leaving the road for sand. */
  overSpeedDecel: 7,
  /** Turn rate at full lock (rad/s), at low and at top speed (it falls linearly with speed up to `turnFadeSpeed`). */
  turnRate: 2.6,
  turnRateFast: 1.6,
  turnFadeSpeed: 11,
  /** Speed (cells/s) below which steering is weaker (a car turns as it rolls). */
  turnGripSpeed: 1.2,
  /** How quickly the wheel follows the keys (1/s). */
  steerRate: 7,
  /** Steepest grade drivable over the car's length (steps per cell); steeper is a cliff. */
  maxGrade: 2,
  /**
   * On a road: the drawn roads follow micro-terrain and the vertical
   * caricature, so they step more steeply than open ground may, and a
   * bridge's abutment can dip; a road is never a cliff unless it is this steep.
   */
  roadMaxGrade: 4.5,
  /** The most the ground may step under the car's middle in one move (steps), off-road and on a road. */
  step: 0.35,
  roadStep: 0.8,
  /** Climbing at the steepest drivable grade keeps this share of the top speed. */
  climbKeep: 0.6,
  /** Gravity along a slope (cells/s² per step/cell of grade). */
  gravity: 1.6,
  /** A bump sends the car back at this share of its speed. */
  bounce: 0.25,
  /** The drawn car in voxels, over a traffic car's at the level: a little larger, to read as the player's. */
  extraVoxels: { length: 2, width: 1, height: 0 },
  /** Its style asset and seed (the seed picks the body: a hatchback). */
  group: "vehicle.car.player",
  seed: 3,
};

/** Taking off from a road (cells/s and cells at pace 1). */
export const TAKEOFF = {
  /** At least this speed… */
  speed: 7,
  /** …on a road running straight ahead this far (within `straightAngle` of the car's heading). */
  straight: 8,
  straightAngle: (15 * Math.PI) / 180,
};

/** The plane (speeds at the flying level's pace; heights in steps). */
export const PLANE = {
  stallSpeed: 2.6,
  cruiseSpeed: 5,
  maxSpeed: 8,
  /** Speed change toward the throttle's (cells/s²). */
  accel: 1.6,
  /** Throttle change per second while a key is held. */
  throttleRate: 0.6,
  /** Steepest climb and dive (flight path angle, rad) and how fast the nose follows (rad/s). */
  maxClimb: (22 * Math.PI) / 180,
  maxDive: (28 * Math.PI) / 180,
  pitchRate: 1.4,
  /** Bank (rad), roll rate (rad/s) and the turn rate at full bank (rad/s). */
  maxBank: (40 * Math.PI) / 180,
  rollRate: 2.2,
  turnRate: 0.85,
  /** Height steps gained per cell flown along a climb of 45°. */
  stepsPerCell: Math.sqrt(6),
  /** Climbing costs speed and diving adds it (cells/s² at a 45° path). */
  climbCost: 3,
  /** Below the stall speed the nose drops (rad/s). */
  stallDrop: 0.8,
  /** The ceiling, above the world's highest ground (steps). */
  ceiling: 14,
  /** Clearance under which the plane touches the ground: a crash (steps). */
  crashClearance: 0.15,
  /** Landing: at most this high over the ground (steps) and this fast, within `roadReach` cells of a road. */
  landAgl: 1.2,
  landSpeed: 3.8,
  roadReach: 1.5,
  /** Seconds of low, slow flight over a road before the plane lands by itself. */
  landDwell: 0.6,
  /** After a take-off: height over the ground (steps) and climb (rad). */
  startAgl: 1.6,
  startClimb: (6 * Math.PI) / 180,
  /** The drawn plane in voxels (length, wingspan, height) at render scale 1. */
  voxels: { length: 20, width: 22, height: 7 },
  group: "vehicle.plane",
  seed: 1,
  /** The shadow rides this far over the ground (steps), so the terrain's own pixels don't hide it. */
  shadowLift: 0.06,
  /** A crash puts the plane back where it was this many seconds earlier, at least `resetAgl` up. */
  resetBack: 3,
  resetAgl: 2.5,
};

/** The camera: it looks ahead of the vehicle by `ahead` seconds of travel, at most `max` cells, and eases toward it. */
export const FOLLOW = { ahead: 0.35, max: 4, ease: 0.22 };

/** Gauge speed shown on the HUD: km/h per cell/s at the level's pace (a feel, not a measurement). */
export const GAUGE_KMH = 12;

/** Physics steps at most this long (s). */
export const MAX_STEP = 1 / 60;
