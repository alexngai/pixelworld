import type { Box, EntityModel } from "@pixelworlds/engine";

/**
 * Voxel models for tactics units and effects (D-149), as boxes an entity or
 * a layer bakes into sprites: the emergency rigs, the invaders, and fire,
 * smoke, rubble, water and blasts. They need nothing from a style pack but
 * its palette: each colour role takes the first ramp the city's style has
 * from a list of likely ones (New York's `sign-red`, Kyoto's `vermilion`).
 *
 * Models are drawn in voxels: 16 across a cell, 8 up a step (so a voxel looks
 * cubic), facing +x, centred on the origin, standing on z = 0. `scale` fits
 * one to a board cell: 1 on a board of world cells, 0.5 on half cells.
 */

export type Role =
  | "red"
  | "yellow"
  | "steel"
  | "dark"
  | "glass"
  | "white"
  | "alien"
  | "alienDark"
  | "glow"
  | "fire"
  | "flame"
  | "smoke"
  | "rubble"
  | "rubbleDark"
  | "water";

const CANDIDATES: Record<Role, string[]> = {
  red: ["sign-red", "awning-red", "vermilion", "neon-red", "chinatown-red", "marker"],
  yellow: ["taxi", "paint-yellow", "neon-yellow", "paint-butter", "tower-gold", "gold"],
  steel: ["bridge-steel", "steel", "steel-grey", "zinc", "concrete", "iron"],
  dark: ["iron", "asphalt", "pole", "rust", "bark"],
  glass: ["glass", "curtain-glass", "lit-cool"],
  white: ["paint-white", "sign-white", "tower-white", "marking", "plaster"],
  alien: ["verdigris", "jade", "jr-green", "wallace-green", "copper-green", "sign-green", "neon-green", "moss", "leaf"],
  alienDark: ["iron", "bark", "asphalt", "pole"],
  glow: ["neon-pink", "neon-cyan", "paint-lavender", "neon-green", "lit-cool", "marker"],
  fire: ["marker", "ferry-orange", "bridge-orange", "neon-red", "vermilion", "awning-red", "sign-red"],
  flame: ["taxi", "neon-yellow", "paint-yellow", "chochin", "paint-butter", "tower-gold", "gold"],
  smoke: ["concrete", "shotcrete", "stone-grey", "mortar", "steel", "iron"],
  rubble: ["concrete", "brownstone", "brick", "granite", "gravel", "stone", "limestone"],
  rubbleDark: ["iron", "asphalt", "bark", "grime"],
  water: ["water"],
};

/** Each role's ramp id in a palette (`view.world.palette.rampIds`): its first candidate the palette has, else ramp 0. */
export function rampsFor(rampIds: ReadonlyMap<string, number>): Record<Role, number> {
  const out = {} as Record<Role, number>;
  for (const role of Object.keys(CANDIDATES) as Role[]) {
    const name = CANDIDATES[role].find((n) => rampIds.has(n));
    out[role] = name !== undefined ? rampIds.get(name)! : 0;
  }
  return out;
}

export interface ModelOptions {
  /** Size relative to a world cell (a board's `cell`; default 1). */
  scale?: number;
  /** The world's render scale (`view.world.renderScale`; default 1). */
  renderScale?: number;
  /** Seed for what varies (rubble's pile, fire's flames). */
  seed?: number;
  /** Animation frame (fire, smoke): 0, 1, 2… */
  frame?: number;
}

type Vox = [x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, role: Role];

/** Voxel boxes to render-unit boxes. */
function toBoxes(vox: readonly Vox[], ramps: Record<Role, number>, o: ModelOptions): Box[] {
  const k = (o.scale ?? 1) * (o.renderScale ?? 1);
  const h = k / 16;
  const v = k / 8;
  return vox.map(([x0, y0, z0, x1, y1, z1, role]) => ({ x0: x0 * h, y0: y0 * h, z0: z0 * v, x1: x1 * h, y1: y1 * h, z1: z1 * v, ramp: ramps[role] }));
}

/** Cubes of size s along a line from a to b (voxels). */
function line(a: [number, number, number], b: [number, number, number], s: number, role: Role): Vox[] {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / (s * 0.75)));
  const out: Vox[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = a[0] + (b[0] - a[0]) * t;
    const y = a[1] + (b[1] - a[1]) * t;
    const z = a[2] + (b[2] - a[2]) * t;
    out.push([x - s / 2, y - s / 2, z - s / 2, x + s / 2, y + s / 2, z + s / 2, role]);
  }
  return out;
}

/** Four wheels under a chassis 14 long and 7 wide. */
const wheels = (): Vox[] =>
  [-5, 4].flatMap((x) => [-3.8, 2.6].map((y): Vox => [x, y, 0, x + 2.6, y + 1.2, 2.4, "dark"]));

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- units

const UNITS = {
  /** A pumper: a fire engine with a water cannon on its back. */
  pumper: (): Vox[] => [
    ...wheels(),
    [-7, -3.5, 1.5, 7, 3.5, 3, "dark"],
    [-7, -3.5, 3, 3, 3.5, 8, "red"],
    [3, -3.5, 3, 7, 3.5, 9, "red"],
    [6.6, -3, 6, 7.1, 3, 8.5, "glass"],
    [-7.1, -3.6, 5, 3, 3.6, 5.7, "white"],
    [4, -2, 9, 6, 2, 9.7, "fire"],
    [-4, -1.2, 8, -1, 1.2, 9.6, "steel"],
    ...line([-1.5, 0, 9.2], [4.5, 0, 11], 1.2, "steel"),
    [-7, -3.8, 8, 2, -3.2, 8.6, "steel"], // a ladder along the side
  ],
  /** A crane: a truck crane, its boom raised and a hook hanging. */
  crane: (): Vox[] => [
    ...wheels(),
    [-7, -3.5, 1.5, 7, 3.5, 3, "dark"],
    [-7, -3.5, 3, 7, 3.5, 4.5, "yellow"],
    [3, -3.5, 4.5, 6.5, -0.5, 9, "yellow"],
    [6.2, -3.2, 6.5, 6.6, -0.8, 8.5, "glass"],
    [-5, -2.2, 4.5, 1, 2.2, 7.5, "yellow"],
    [-7, -2, 4.5, -5, 2, 7, "dark"], // counterweight
    ...line([-2, 0, 8], [10, 0, 26], 1.6, "yellow"),
    [9.8, -0.2, 14, 10.2, 0.2, 25, "dark"],
    [9.2, -0.8, 12, 10.8, 0.8, 14, "steel"],
  ],
  /** A wrecker: an excavator on tracks with a demolition claw. */
  wrecker: (): Vox[] => [
    [-7, -4, 0, 7, -2, 2.6, "dark"],
    [-7, 2, 0, 7, 4, 2.6, "dark"],
    [-5, -2.8, 2.6, 3, 2.8, 6.5, "yellow"],
    [-7, -2.8, 2.6, -5, 2.8, 5.5, "dark"],
    [0.5, 0, 6.5, 4, 2.8, 11, "yellow"],
    [3.6, 0.3, 8, 4.1, 2.5, 10.5, "glass"],
    ...line([2, -1.2, 7], [8, -1.2, 15], 1.4, "yellow"),
    ...line([8, -1.2, 15], [11, -1.2, 6], 1.2, "yellow"),
    [9.5, -2.8, 2, 12.5, 0.4, 6, "steel"],
  ],
  /** A drone: four rotors over a body with a camera, hovering. */
  drone: (): Vox[] => [
    [-2, -2, 12, 2, 2, 14, "white"],
    [1.8, -0.8, 11.2, 2.6, 0.8, 12.4, "glass"],
    ...[-1, 1].flatMap((sx) =>
      [-1, 1].flatMap((sy): Vox[] => [
        ...line([0, 0, 13.5], [sx * 5, sy * 5, 14], 0.8, "steel"),
        [sx * 5 - 2, sy * 5 - 2, 14.2, sx * 5 + 2, sy * 5 + 2, 14.6, "dark"],
      ]),
    ),
    [-0.5, -0.5, 14, 0.5, 0.5, 15.5, "red"],
  ],
  /** A crawler: a six-legged invader, low and quick. */
  crawler: (): Vox[] => [
    [-6, -2.5, 2.5, -1, 2.5, 6, "alien"],
    [-1.5, -2, 3, 3, 2, 6.5, "alien"],
    [2.5, -1.8, 3.5, 6, 1.8, 6, "alienDark"],
    [5.6, -1.4, 5, 6.3, -0.6, 5.8, "glow"],
    [5.6, 0.6, 5, 6.3, 1.4, 5.8, "glow"],
    [-5, -1, 6, -2, 1, 7.5, "glow"],
    ...[-4, -0.5, 2.5].flatMap((x) => [-1, 1].flatMap((s) => [...line([x, s * 2, 4.5], [x + 1, s * 5, 5.5], 0.9, "alienDark"), ...line([x + 1, s * 5, 5.5], [x + 1.5, s * 6.5, 0.5], 0.9, "alienDark")])),
  ],
  /** A brute: a hulking invader that walks on its knuckles and wrecks what it reaches. */
  brute: (): Vox[] => [
    [-3, -3.5, 0, -0.5, -1, 8, "alienDark"],
    [-3, 1, 0, -0.5, 3.5, 8, "alienDark"],
    [-4.5, -4.5, 8, 2.5, 4.5, 20, "alien"],
    [1, -3, 16, 5, 3, 21, "alien"],
    [4.6, -2, 18, 5.2, -0.8, 19.2, "glow"],
    [4.6, 0.8, 18, 5.2, 2, 19.2, "glow"],
    ...[-1, 1].flatMap((s) => [...line([1, s * 5.5, 18], [4, s * 6, 9], 2.2, "alien"), [3, s * 6 - 1.6, 0, 6, s * 6 + 1.6, 9, "alienDark"] as Vox]),
    ...[-3, -0.5, 2].map((x): Vox => [x, -0.8, 20, x + 1.4, 0.8, 23, "glow"]),
  ],
  /** A flyer: a manta-winged invader gliding over the rooftops. */
  flyer: (): Vox[] => {
    const out: Vox[] = [];
    for (let i = 0; i < 6; i++) out.push([-4 + i * 0.6, -(7 - i), 14 + (i % 2) * 0.3, 3 - i * 0.4, 7 - i, 15, "alien"]);
    out.push([-2, -2, 13.5, 5, 2, 16, "alienDark"], [4.6, -1.2, 14.5, 5.4, 1.2, 15.5, "glow"], [-1, -1, 16, 1, 1, 16.8, "glow"]);
    out.push(...line([-3, 0, 14.8], [-11, 0, 13.6], 0.9, "alienDark"));
    return out;
  },
} as const;

export type UnitKind = keyof typeof UNITS;
export const UNIT_KINDS = Object.keys(UNITS) as UnitKind[];

/** A unit's boxes (render units), facing +x. */
export function unitBoxes(kind: UnitKind, ramps: Record<Role, number>, o: ModelOptions = {}): Box[] {
  return toBoxes(UNITS[kind](), ramps, o);
}

// ---------------------------------------------------------------- effects

const FX = {
  /** Flames filling a cell: red at the base, yellow at the tips, leaping by frame. */
  fire: (rand: () => number, frame: number): Vox[] => {
    const out: Vox[] = [];
    const flick = mulberry(frame * 7919 + 1);
    for (let i = 0; i < 9; i++) {
      const x = -6 + rand() * 11;
      const y = -6 + rand() * 11;
      const w = 2 + rand() * 2;
      const tall = 4 + rand() * 6 + flick() * 5;
      out.push([x, y, 0, x + w, y + w, tall * 0.6, "fire"]);
      out.push([x + w * 0.2, y + w * 0.2, tall * 0.6, x + w * 0.8, y + w * 0.8, tall, "flame"]);
      if (flick() > 0.5) out.push([x + w * 0.35, y + w * 0.35, tall + 1 + flick() * 2, x + w * 0.65, y + w * 0.65, tall + 2 + flick() * 2, "flame"]);
    }
    return out;
  },
  /** Smoke puffs climbing over a fire, drifting by frame. */
  smoke: (rand: () => number, frame: number): Vox[] => {
    const out: Vox[] = [];
    for (let i = 0; i < 5; i++) {
      const rise = ((i * 6 + frame * 2) % 30) + 12;
      const s = 1.5 + rise / 14;
      const x = -2 + rand() * 4 + rise / 5; // drifting downwind
      const y = -2 + rand() * 4;
      out.push([x - s / 2, y - s / 2, rise, x + s / 2, y + s / 2, rise + s * 0.8, "smoke"]);
    }
    return out;
  },
  /** A heap of broken masonry and steel where a building stood. */
  rubble: (rand: () => number): Vox[] => {
    const out: Vox[] = [];
    for (let i = 0; i < 22; i++) {
      const x = -7 + rand() * 12;
      const y = -7 + rand() * 12;
      const d = Math.hypot(x + 1, y + 1) / 9; // higher in the middle
      const w = 1.5 + rand() * 3;
      const z = Math.max(0, (1 - d) * 5 * rand());
      out.push([x, y, 0, x + w, y + w * (0.6 + rand()), z + 1 + rand() * 2.5, rand() < 0.75 ? "rubble" : "rubbleDark"]);
    }
    for (let i = 0; i < 3; i++) out.push(...line([-5 + rand() * 10, -5 + rand() * 10, 0.5], [-5 + rand() * 10, -5 + rand() * 10, 3 + rand() * 4], 0.6, "dark"));
    return out;
  },
  /** A jet of water from the origin forward (+x) across a cell and down. */
  jet: (rand: () => number, frame: number): Vox[] => {
    const out: Vox[] = [];
    for (let i = 0; i <= 16; i++) {
      const x = i;
      const z = 10 + i * 0.6 - (i * i) / 22;
      const s = 1 + i / 12 + (rand() - 0.5) * 0.4;
      out.push([x - s / 2, -s / 2, z - s / 2, x + s / 2, s / 2, z + s / 2, (i + frame) % 3 === 0 ? "white" : "water"]);
    }
    return out;
  },
  /** A blast: a fireball and flying debris. */
  blast: (rand: () => number, frame: number): Vox[] => {
    const out: Vox[] = [];
    const r = 4 + frame * 2;
    for (let i = 0; i < 14; i++) {
      const a = rand() * Math.PI * 2;
      const e = rand() * Math.PI * 0.5;
      const d = r * (0.4 + rand() * 0.6);
      const x = Math.cos(a) * Math.cos(e) * d;
      const y = Math.sin(a) * Math.cos(e) * d;
      const z = 3 + Math.sin(e) * d;
      const s = 2 + rand() * 2.5;
      out.push([x - s / 2, y - s / 2, z - s / 2, x + s / 2, y + s / 2, z + s / 2, i % 3 === 0 ? "flame" : i % 3 === 1 ? "fire" : "smoke"]);
    }
    return out;
  },
} as const;

export type FxKind = keyof typeof FX;
export const FX_KINDS = Object.keys(FX) as FxKind[];

/** An effect's boxes (render units). */
export function fxBoxes(kind: FxKind, ramps: Record<Role, number>, o: ModelOptions = {}): Box[] {
  return toBoxes(FX[kind](mulberry(o.seed ?? 1), o.frame ?? 0), ramps, o);
}

/** An entity model for a unit or effect, keyed so entities with the same model share their sprites. */
export function entityModel(kind: UnitKind | FxKind, ramps: Record<Role, number>, o: ModelOptions = {}): EntityModel {
  const boxes = kind in UNITS ? unitBoxes(kind as UnitKind, ramps, o) : fxBoxes(kind as FxKind, ramps, o);
  const key = `tactics:${kind}:${o.scale ?? 1}:${o.renderScale ?? 1}:${o.seed ?? 1}:${o.frame ?? 0}:${Object.values(ramps).join(",")}`;
  return { boxes, key };
}
