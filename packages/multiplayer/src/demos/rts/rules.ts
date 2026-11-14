import { landmarkName } from "@pixelworlds/game/src/places";
import {
  CELL_ROAD,
  CELL_TREES,
  CELL_WALL,
  CELL_WATER,
  canStep as cellsCanStep,
  cellIndex,
  findPath as cellsFindPath,
  lineClear as cellsLineClear,
  cellAt,
  nearestWalkable,
  readCells,
  setRemoved,
  viewshed,
  type CellPoint,
  type Cells,
  type PathOptions,
  type WorldEdits,
  type WorldQuery,
} from "pixelworld/engine";

/**
 * Fogfront's rules, the same on the server (game.ts, server.ts) and in the
 * page (client.ts): D-121. Two guilds, the Kiln and the Tide, race for glim
 * on the Presidio's meadows (San Francisco's driving level, 25 m cells):
 * runners carry it from seeps to their hearth, a lodge trains wardens, and a
 * side whose hearth falls loses. The map is a grid of cells read once from
 * the world's queries (`buildGrid`, on the engine's cells, D-125): water,
 * the level's buildings and the match's block; a step to a neighbour climbs
 * at most `MAX_CLIMB`; roads are quicker and woods slower (and can't be
 * built on). Paths are the engine's A* on those cells (`findPath`). The level's buildings have hit points: wardens knock
 * them down, the world's edits take them out of every page's view, and their
 * cells open (D-124).
 */

/** The driving level the match is on. */
export const RTS_WORLD = "/sf/";
/** The play area (cells of the level): the Presidio, from Baker Beach's bluffs to Crissy Field. */
export const MAP = { x0: 118, y0: 140, w: 144, h: 110 };
/** The server's fixed step (s): orders, movement and fights. */
export const TICK = 1 / 20;
/** A snapshot every this many ticks (10 a second). */
export const SNAPSHOT_EVERY = 2;
/** How far behind the page draws the units (s): two snapshots. */
export const DELAY = 0.2;

export const TEAMS = ["kiln", "tide"] as const;
export type Team = (typeof TEAMS)[number];
export const TEAM_NAMES: Record<Team, string> = { kiln: "the Kiln", tide: "the Tide" };

export type UnitKind = "runner" | "warden";
export type BuildingKind = "hearth" | "lodge";

export interface UnitRule {
  hp: number;
  /** Cells a second, off roads. */
  speed: number;
  cost: number;
  /** Seconds to train. */
  time: number;
  /** Cells it sees. */
  sight: number;
  /** Damage a blow, blows a second apart (`cooldown`), within `range` cells (0: doesn't fight). */
  damage: number;
  cooldown: number;
  range: number;
}

export const UNITS: Record<UnitKind, UnitRule> = {
  runner: { hp: 40, speed: 2.2, cost: 50, time: 6, sight: 6, damage: 0, cooldown: 0, range: 0 },
  warden: { hp: 80, speed: 1.8, cost: 80, time: 9, sight: 7, damage: 9, cooldown: 1, range: 1.4 },
};

export interface BuildingRule {
  /** Cells a side (square). */
  size: number;
  hp: number;
  cost: number;
  /** Seconds to raise. */
  time: number;
  sight: number;
  trains: UnitKind;
}

export const BUILDINGS: Record<BuildingKind, BuildingRule> = {
  hearth: { size: 3, hp: 1000, cost: 0, time: 0, sight: 8, trains: "runner" },
  lodge: { size: 2, hp: 400, cost: 120, time: 15, sight: 6, trains: "warden" },
};

/** Each side starts with its hearth, this much glim and these runners. */
export const START = { glim: 150, runners: 3 };
/** A runner carries `carry` glim, mined in `seconds` within `reach` cells of a seep; it drops it within `reach` of its hearth. */
export const GATHER = { carry: 10, seconds: 2, reach: 1.3 };
/** Glim in a seep. */
export const SEEP_GLIM = 800;
/** Units go this much as quick in woods (trees on the cell). */
export const WOODS_SPEED = 0.6;
/** On roads, by the level's road class (D-125): the bigger the road, the quicker; a class not here goes at `residential`'s. */
export const ROAD_PACE: Record<string, number> = { motorway: 1.7, trunk: 1.7, primary: 1.6, secondary: 1.5, tertiary: 1.5, residential: 1.4, unclassified: 1.3, living_street: 1.2 };
/** Off roads, by the level's surface: sand and scrub are slow going; a surface not here goes at 1. */
export const SURFACE_PACE: Record<string, number> = { sand: 0.7, snow: 0.6, desert: 0.8, scrub: 0.85, rock: 0.85, farmland: 0.9 };
/** The quickest going anywhere (A*'s guess may not be more than the way is). */
export const ROAD_SPEED = Math.max(...Object.values(ROAD_PACE));
/** Most a step to a neighbouring cell may climb (height steps): the bluffs and steep banks are walls. */
export const MAX_CLIMB = 1.5;
/** Most a building's footprint may rise across it (steps). */
export const MAX_RISE = 1;
/** A building goes up within this many cells of the middle of one of its side's own. */
export const BUILD_RANGE = 12;
/** Trainings a building holds at once. */
export const QUEUE = 5;
/** Units a page may order at once. */
export const MAX_ORDER = 200;
/** The match: waiting for a second side (a page alone gets the bot after `wait` s, or at once with `vs: "bot"`), play, `ended` s of the result, and the next. */
export const MATCH = { wait: 20, ended: 15, seconds: 1200 };
export type MatchPhase = "waiting" | "playing" | "ended";

/** Where each side starts (its hearth's top-left cell), and the seeps (cells): three by each hearth and two between. */
export const LAYOUT = {
  hearths: { kiln: [125, 236], tide: [200, 180] } as Record<Team, [number, number]>,
  seeps: [
    // the Kiln's, on Baker Beach
    [130, 233],
    [122, 241],
    [128, 242],
    // the Tide's, on Crissy Field
    [195, 177],
    [206, 178],
    [198, 185],
    // between, in clearings of the woods
    [160, 197],
    [187, 207],
  ] as [number, number][],
};

// ---------------------------------------------------------------- messages

/** Who a page is: its name, and whether it wants the bot now rather than wait for a second player. */
export interface RtsJoin {
  name: string;
  vs: "any" | "bot";
}

/** A page's orders (`TickClient.command`), checked on the server. Units are ids of the page's own. */
export type RtsCommand =
  | { t: "move"; u: number[]; x: number; y: number; attack?: boolean }
  | { t: "attack"; u: number[]; target: number }
  | { t: "gather"; u: number[]; seep: number }
  | { t: "stop"; u: number[] }
  | { t: "build"; kind: BuildingKind; x: number; y: number }
  | { t: "train"; b: number }
  /** Knock down one of the level's buildings (its object, `Structure.obj`). */
  | { t: "raze"; u: number[]; obj: number }
  /** Go into one of the level's buildings, and bring a side's units out of one (D-125). */
  | { t: "enter"; u: number[]; obj: number }
  | { t: "leave"; obj: number };

/** A unit as a page sees it: positions in cells to 0.01, its goal for its own side. */
export interface UnitNet {
  i: number;
  k: UnitKind;
  s: Team;
  x: number;
  y: number;
  /** Heading (rad, to 0.01). */
  d: number;
  hp: number;
  /** Carrying glim (runners). */
  c?: 1;
  /** Fighting now. */
  f?: 1;
  /** Where it is going (its own side's only). */
  g?: [number, number];
  /** Inside one of the level's buildings (its object; its own side's only: the other doesn't see it). */
  in?: number;
}

export interface BuildingNet {
  i: number;
  k: BuildingKind;
  s: Team;
  /** Top-left cell. */
  x: number;
  y: number;
  hp: number;
  /** Raised so far, 0–1 (1: standing). */
  b: number;
  /** Trainings waiting (its own side's only), and the first's progress 0–1. */
  q?: number;
  p?: number;
}

export interface SeepNet {
  i: number;
  x: number;
  y: number;
  left: number;
}

/** One player's own snapshot: what its side sees (the fog of war), its glim. */
export interface RtsSnap {
  side: Team;
  glim: number;
  units: UnitNet[];
  buildings: BuildingNet[];
  seeps: SeepNet[];
  /** The level's buildings it sees knocked about, still standing: [object, hit points]. */
  hurt?: [number, number][];
}

export interface PlayerNet {
  id: string;
  name: string;
  side: Team;
  bot?: true;
}

/** What every page shares: the match and who plays. */
export interface RtsWorldNet {
  match: { phase: MatchPhase; until: number | null; winner: Team | null };
  players: PlayerNet[];
  /** The level's buildings knocked down this match (objects, as they fell): every page takes them out of its world (D-124). */
  razed: number[];
  /** The landmarks to hold, and who holds them (D-125): famous, so no fog hides them. */
  marks: MarkNet[];
}

/** A landmark held: who holds it, and who is taking it and how far (0–1). */
export interface MarkNet {
  id: string;
  name: string;
  x: number;
  y: number;
  owner: Team | null;
  taker: Team | null;
  p: number;
}

/** Events, at server time; each to the pages whose side sees it. */
export type RtsEvent =
  /** A blow; `obj`: `to` is one of the level's buildings (its object). */
  | { kind: "hit"; by: number; to: number; obj?: 1; x: number; y: number }
  | { kind: "die"; id: number; x: number; y: number }
  | { kind: "refused"; why: string }
  | { kind: "phase"; phase: MatchPhase; winner: Team | null }
  /** A side took a landmark (D-125). */
  | { kind: "taken"; id: string; name: string; side: Team };

/** What the lobby lists. */
export interface RtsInfo {
  phase: MatchPhase;
  open: boolean;
}

// ---------------------------------------------------------------- the map's cells

/** The engine's cell flags (D-125), by the game's names. */
export const WATER = CELL_WATER;
/** One of the level's buildings, walls or landmarks: a wall. */
export const OBJECT = CELL_WALL;
export const ROAD = CELL_ROAD;
/** Trees: slow going, and no building on them. */
export const WOODS = CELL_TREES;

/** One of the level's buildings in the play area (D-124): wardens can knock it down. */
export interface Structure {
  /** The level's object (`ObjectHit.index`): the edit that takes it out of the world names it. */
  obj: number;
  /** The middle of the cells it walls, and its top (steps). */
  x: number;
  y: number;
  top: number;
  /** The grid cells it walls. */
  cells: number[];
  /** Hit points, from the cells it covers and its height (`structureHp`). */
  hp: number;
}

/** A level building's hit points: more for each cell it walls and each height step it rises. */
export const structureHp = (cells: number, height: number): number => Math.min(1000, Math.round((50 + 40 * cells + 60 * Math.max(0, height)) / 10) * 10);

/**
 * The play area's cells, read once from the world (the engine's `Cells`,
 * D-125: flags, heights, tops, what stands on each), with the match's own
 * buildings on them and the level's buildings wardens can knock down.
 */
export interface MapGrid extends Cells {
  /** The match's building on a cell (its id), 0 for none: changes as they go up and fall. */
  building: Int32Array;
  /** The level's buildings, by object (D-124). */
  structures?: Map<number, Structure>;
  /** The level's landmarks reaching into the play area, as objectives (D-125). */
  objectives?: Objective[];
  /** How quick going is on each cell over open ground's, from its road's class or its surface and its trees (D-125); without it, roads 1.4. */
  pace?: Float32Array;
}

/** The level's objects wardens can knock down: buildings (not landmarks, walls or bridges). */
const isBuilding = (group: string) => group === "building" || group.startsWith("building.");

/** Read the play area's cells from a world's queries (the terrain and objects there loaded: `query.ensure`). */
export function buildGrid(query: Pick<WorldQuery, "heightAt" | "surfaceAt" | "roadAt" | "objectsAt">, map = MAP): MapGrid {
  const structures = new Map<number, Structure>();
  const heights = new Map<number, number>();
  const landmarks = new Map<string, number[]>();
  const cells = readCells(query, map, {
    onObject: (o, i) => {
      if (o.id) landmarks.set(o.id, [...(landmarks.get(o.id) ?? []), i]);
      if (!isBuilding(o.group)) return;
      let s = structures.get(o.index);
      if (!s) {
        structures.set(o.index, (s = { obj: o.index, x: 0, y: 0, top: o.top ?? 0, cells: [], hp: 0 }));
        heights.set(o.index, o.top !== null && o.base !== null ? o.top - o.base : 0);
      }
      s.cells.push(i);
      s.x += map.x0 + (i % map.w) + 0.5;
      s.y += map.y0 + Math.floor(i / map.w) + 0.5;
    },
  });
  for (const s of structures.values()) {
    s.x /= s.cells.length;
    s.y /= s.cells.length;
    s.hp = structureHp(s.cells.length, heights.get(s.obj)!);
  }
  // the going on each cell: its road's class, else its surface; trees slow either
  const pace = new Float32Array(cells.flags.length);
  for (let i = 0; i < pace.length; i++) {
    const x = map.x0 + (i % map.w) + 0.5;
    const y = map.y0 + Math.floor(i / map.w) + 0.5;
    const road = cells.flags[i]! & ROAD ? query.roadAt(x, y) : null;
    const base = road ? (ROAD_PACE[road.class ?? ""] ?? ROAD_PACE.residential!) : (SURFACE_PACE[query.surfaceAt(x, y)?.name ?? ""] ?? 1);
    pace[i] = base * (cells.flags[i]! & WOODS && !road ? WOODS_SPEED : 1);
  }
  const g: MapGrid = { ...cells, building: new Int32Array(cells.flags.length), structures, pace };
  // each landmark reaching in: the cell units can get to nearest its part nearest the middle of the area (a bridge's shore end)
  const mx = map.x0 + map.w / 2;
  const my = map.y0 + map.h / 2;
  const [hx, hy] = LAYOUT.hearths.kiln;
  const reach = reachable(g, hx - 1, hy + 1);
  g.objectives = [...landmarks].flatMap(([id, list]) => {
    const at = (i: number) => ({ x: map.x0 + (i % map.w), y: map.y0 + Math.floor(i / map.w) });
    const part = list.map(at).reduce((a, b) => (Math.hypot(a.x - mx, a.y - my) <= Math.hypot(b.x - mx, b.y - my) ? a : b));
    const spot = nearestOpen(g, part.x, part.y, 15, (x, y) => reach[cellIndex(g, x, y)] === 1);
    return spot ? [{ id, name: landmarkName(id), x: spot.x + 0.5, y: spot.y + 0.5 }] : [];
  });
  return g;
}

/**
 * One of the level's buildings has fallen (`razed` has it, D-124): the cells
 * it walled open, those nothing else standing walls, and their tops drop.
 */
export function razeCells(g: MapGrid, obj: number, razed: ReadonlySet<number>): void {
  setRemoved(g, (o) => razed.has(o), [obj]);
}

/**
 * A page's side of the fallen buildings (D-124): the match's list
 * (`RtsWorldNet.razed`) put into the world's edits, so the view bakes them
 * away and the queries agree, and into the page's own cells. A list that
 * doesn't go on from the last (a new match) puts everything back first.
 */
export class Razed {
  private applied: number[] = [];

  constructor(
    private readonly edits: Pick<WorldEdits, "remove" | "restore">,
    private readonly grid: MapGrid,
  ) {}

  /** The match's list now: the buildings that fell since the last. */
  sync(razed: readonly number[]): number[] {
    if (this.applied.length > razed.length || this.applied.some((o, i) => razed[i] !== o)) {
      this.edits.restore();
      setRemoved(this.grid, () => false);
      this.applied = [];
    }
    const fresh = razed.slice(this.applied.length);
    if (!fresh.length) return [];
    this.applied = [...razed];
    this.edits.remove(fresh);
    const all = new Set(razed);
    setRemoved(this.grid, (o) => all.has(o), fresh);
    return fresh;
  }
}

export { cellIndex };

/** The cells a unit can walk to from a cell (1 each), steps and corners as paths take them. */
export function reachable(g: MapGrid, cx: number, cy: number): Uint8Array {
  const seen = new Uint8Array(g.flags.length);
  const start = cellIndex(g, cx, cy);
  if (start < 0 || !passable(g, cx, cy)) return seen;
  seen[start] = 1;
  const queue = [start];
  while (queue.length) {
    const i = queue.pop()!;
    const x = (i % g.w) + g.x0;
    const y = Math.floor(i / g.w) + g.y0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || !canStep(g, x, y, x + dx, y + dy)) continue;
        if (dx && dy && !(passable(g, x + dx, y) && passable(g, x, y + dy))) continue;
        const j = cellIndex(g, x + dx, y + dy);
        if (!seen[j]) {
          seen[j] = 1;
          queue.push(j);
        }
      }
  }
  return seen;
}

/** Whether a unit may stand on a cell: in the area, not water, no wall or match building. */
export function passable(g: MapGrid, cx: number, cy: number): boolean {
  const i = cellIndex(g, cx, cy);
  return i >= 0 && (g.flags[i]! & (WATER | OBJECT)) === 0 && g.building[i] === 0;
}

/** How quick going is on a cell, over open ground's: by its road or surface (`pace`), else roads quicker and woods slower. */
const paceOf = (g: MapGrid, i: number) => (i < 0 ? 1 : g.pace ? g.pace[i]! : g.flags[i]! & ROAD ? ROAD_PACE.residential! : g.flags[i]! & WOODS ? WOODS_SPEED : 1);

/** How quick going is at a point (`paceOf` its cell). */
export const paceAt = (g: MapGrid, x: number, y: number): number => paceOf(g, cellIndex(g, Math.floor(x), Math.floor(y)));

/** The ground under a point (steps): the cell's, between cells' middles. */
export function groundAt(g: MapGrid, x: number, y: number): number {
  const i = cellIndex(g, Math.floor(x), Math.floor(y));
  return i < 0 ? 0 : g.height[i]!;
}

// ---------------------------------------------------------------- paths

export type Point = CellPoint;

const pathOptions = new WeakMap<MapGrid, PathOptions>();
/** The match's walking for the engine's paths: walls, water and the match's buildings shut, roads quicker, woods slower, `MAX_CLIMB`. */
function walking(g: MapGrid): PathOptions {
  let o = pathOptions.get(g);
  if (!o) {
    const shut = WATER | OBJECT;
    o = { cost: (i) => (g.flags[i]! & shut || g.building[i] ? Infinity : 1 / paceOf(g, i)), minCost: 1 / ROAD_SPEED, maxClimb: MAX_CLIMB };
    pathOptions.set(g, o);
  }
  return o;
}

/** Whether a unit may step from one cell to a neighbour: both passable, and not too steep. */
export const canStep = (g: MapGrid, ax: number, ay: number, bx: number, by: number): boolean => cellsCanStep(g, ax, ay, bx, by, walking(g));

/**
 * A path from a point to a goal over the cells (the engine's A*, D-125: eight
 * ways, no corner cut, roads quicker, woods slower), straightened where a
 * straight line is clear and no slower; the reachable cell nearest a goal
 * that can't be reached.
 */
export const findPath = (g: MapGrid, from: Point, to: Point): Point[] => cellsFindPath(g, from, to, walking(g));

/** Whether a unit can walk a straight line: every cell on it open, and no step too steep. */
export const lineClear = (g: MapGrid, a: Point, b: Point): boolean => cellsLineClear(g, a, b, walking(g));

/** The open cell nearest a cell, within `radius` rings; null if none. */
export const nearestOpen = (g: MapGrid, cx: number, cy: number, radius: number, ok: (x: number, y: number) => boolean = () => true): Point | null =>
  nearestWalkable(g, cx, cy, radius, walking(g), ok);

// ---------------------------------------------------------------- seeing (D-125)

/** Sight from the level's geography: what stands in the way, the high ground, woods, the fog. */
export const SIGHT = {
  /** A unit's eye over its ground, and what an eye looks at over a cell's ground (steps). */
  eye: 1.2,
  look: 0.8,
  /** A unit standing in woods is seen only this near (cells). */
  woods: 2,
  /** Fog takes up to this share of sight away, at its thickest (where the eye or what it looks at stands in it). */
  fog: 0.6,
  /** Each step an eye stands over the ground around it adds this much sight (cells), up to `highMost`. */
  highPerStep: 0.75,
  highMost: 3,
  /** Sides' sight is worked out again every this many ticks, the fog over the cells every `fogEvery`. */
  every: 5,
  fogEvery: 40,
};
/**
 * Garrisons (D-125): units in one of the level's buildings are hidden from
 * the other side and watch from its roof, `sight` cells further. It holds
 * `perCell` a cell it covers, at most `most`, of one side. Units in one
 * that falls come out with `fall` damage.
 */
export const GARRISON = { perCell: 2, most: 8, sight: 2, fall: 15, reach: 1 };
/** How many a level building holds. */
export const holds = (s: Pick<Structure, "cells">): number => Math.min(GARRISON.most, s.cells.length * GARRISON.perCell);
/**
 * Landmarks as objectives (D-125): a side whose units alone stand within
 * `radius` of one for `hold` seconds takes it; it pays `income` glim a
 * second and gives an eye `eye` steps over it seeing `sight` cells.
 * Contested, it stands still; left alone, the taking fades.
 */
export const OBJECTIVE = { radius: 3, hold: 10, income: 0.5, eye: 4, sight: 9 };

/** A landmark to hold: its registry id, its name, and the open cell to stand at by it. */
export interface Objective {
  id: string;
  name: string;
  x: number;
  y: number;
}

/** A blow struck from a step or more above its target lands this much harder. */
export const HIGH_GROUND_DAMAGE = 1.3;
/** How high each building's eye stands over its ground (steps): from its roof. */
export const BUILDING_EYE: Record<BuildingKind, number> = { hearth: 6, lodge: 4 };

/** One of a side's eyes: a unit, or a building. */
export interface Eye {
  x: number;
  y: number;
  /** Over its ground (steps). */
  up: number;
  radius: number;
}

/** How much higher a point stands than the ground three cells round it (steps, at least 0). */
export function rise(g: MapGrid, x: number, y: number): number {
  let sum = 0;
  let n = 0;
  for (let k = 0; k < 8; k++) {
    const i = cellAt(g, x + 3 * Math.cos((k * Math.PI) / 4), y + 3 * Math.sin((k * Math.PI) / 4));
    if (i < 0) continue;
    sum += g.height[i]!;
    n++;
  }
  return n ? Math.max(0, groundAt(g, x, y) - sum / n) : 0;
}

/** The fog over each cell (0–1), at what an eye looks at there: from the world's fog and its clock (`fogSampler`). */
export function fogCells(g: MapGrid, at: (x: number, y: number, h: number) => number, out: Float32Array = new Float32Array(g.flags.length)): Float32Array {
  for (let i = 0; i < out.length; i++) out[i] = at(g.x0 + (i % g.w) + 0.5, g.y0 + Math.floor(i / g.w) + 0.5, g.height[i]! + SIGHT.look);
  return out;
}

/**
 * What a side sees (D-125): each cell's distance to the nearest of its eyes
 * that sees it, Infinity where none does. Lines of sight run over the
 * ground, the level's buildings and the woods' canopies (the engine's
 * viewshed); an eye on high ground sees further; fog where the eye or the
 * cell stands shortens it.
 */
export function sideSight(g: MapGrid, eyes: readonly Eye[], fog: Float32Array | null, out: Float32Array = new Float32Array(g.flags.length)): Float32Array {
  out.fill(Infinity);
  for (const e of eyes) {
    const radius = e.radius + Math.min(SIGHT.highMost, rise(g, e.x, e.y) * SIGHT.highPerStep);
    const at = cellAt(g, e.x, e.y);
    const own = fog && at >= 0 ? fog[at]! : 0;
    viewshed(g, { x: e.x, y: e.y, h: groundAt(g, e.x, e.y) + e.up }, radius, out, {
      targetHeight: SIGHT.look,
      reach: fog ? (i, d) => d <= radius * (1 - SIGHT.fog * Math.max(own, fog[i]!)) : undefined,
    });
  }
  return out;
}

/** Whether a side's sight takes in a unit standing at a point: its cell seen, and from near enough if it stands in woods. */
export function seesUnit(g: MapGrid, sight: Float32Array, x: number, y: number): boolean {
  const i = cellAt(g, x, y);
  if (i < 0) return false;
  const d = sight[i]!;
  return g.flags[i]! & WOODS ? d <= SIGHT.woods : d < Infinity;
}

/** Whether a side's sight takes in any cell within `pad` cells of a point (a building, an event). */
export function seesArea(g: MapGrid, sight: Float32Array, x: number, y: number, pad = 0): boolean {
  const r = Math.ceil(pad);
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const i = cellAt(g, x + dx, y + dy);
      if (i >= 0 && sight[i]! < Infinity) return true;
    }
  return false;
}

// ---------------------------------------------------------------- placing a building

/** What stands where a building would go: the side's buildings (to be near one), and units and seeps (to keep clear of). */
export interface Placing {
  own: { x: number; y: number; size: number }[];
  units: Point[];
  seeps: Point[];
}

/**
 * Why a building can't go up with its top-left at a cell, or null when it
 * can: the whole footprint in the area, on dry, level ground (`MAX_RISE`)
 * with nothing on it (no object, woods, building, unit or seep, and a cell
 * clear around seeps), within `BUILD_RANGE` of one of the side's buildings.
 */
export function placementError(g: MapGrid, kind: BuildingKind, x: number, y: number, at: Placing): string | null {
  const size = BUILDINGS[kind].size;
  let lo = Infinity;
  let hi = -Infinity;
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++) {
      const i = cellIndex(g, x + dx, y + dy);
      if (i < 0) return "outside the field";
      if (g.flags[i]! & WATER) return "water";
      if (g.flags[i]! & OBJECT) return "something stands there";
      if (g.flags[i]! & WOODS) return "woods";
      if (g.building[i]) return "a building stands there";
      lo = Math.min(lo, g.height[i]!);
      hi = Math.max(hi, g.height[i]!);
    }
  if (hi - lo > MAX_RISE) return "the ground isn't level";
  const inside = (p: Point, margin: number) => p.x >= x - margin && p.y >= y - margin && p.x < x + size + margin && p.y < y + size + margin;
  if (at.units.some((u) => inside(u, 0))) return "units stand there";
  if (at.seeps.some((s) => inside(s, 1))) return "too near a seep";
  const mid = { x: x + size / 2, y: y + size / 2 };
  if (!at.own.some((b) => Math.hypot(b.x + b.size / 2 - mid.x, b.y + b.size / 2 - mid.y) <= BUILD_RANGE)) return "too far from your buildings";
  return null;
}

/** How far a point is from a footprint (cells; 0 inside it): `size` cells a side from its top-left. */
export function distToBuilding(p: Point, b: { x: number; y: number; size: number }): number {
  const size = b.size;
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + size));
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + size));
  return Math.hypot(dx, dy);
}
