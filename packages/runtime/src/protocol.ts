import type { MicroLayers, Rotation, TerrainLayers } from "@pixelworlds/grid";
import type { BakedImage, Projection, StyleParams } from "@pixelworlds/bake";
import type { HeroPaint } from "./heroPaint";
import { BIG_FOOTPRINT_CELLS, footprintBounds, type AssetCatalog, type Box, type ModelFailure, type ObjectInstance, type ScatterRules } from "@pixelworlds/generators";

/** Messages between the main thread and the bake worker. */

export interface InitMessage {
  type: "init";
  style: StyleParams;
  tileSize: number;
  margin: number;
  /** Height (steps) of world-edge skirts. */
  floor: number;
  /** The package's micro-terrain sinks under its water, drawn as planes (manifest micro.shores, D-094). */
  shores?: boolean;
  worldWidth: number;
  worldHeight: number;
  /** Render units per world cell (manifest render.scale); 1 if absent. */
  renderScale?: number;
  /** Tile scenes (meshes) to keep for a tile's other rotations and bare variant (default 6). */
  meshScenes?: number;
  /** Placed objects for the whole world (experiment worlds are small). */
  objects?: WorldObjects;
  /** Painted-over hero landmarks (M3, D-053), stamped into every tile bake. */
  heroes?: HeroPaint[];
}

export interface WorldObjects {
  instances: ObjectInstance[];
  catalog: AssetCatalog;
  /** Ramp name → palette ramp id. */
  rampIds: [string, number][];
  metersPerCell: number;
  /** Building and landmark height multiplier. */
  heightStretch: number;
  /** Generated variants per group for repeated objects. */
  variants: number;
  /** Decorative scatter by surface (M3), when the world asks for it. */
  scatter?: ScatterRules;
}

/** A block of terrain cut from the world, with its world-space origin. */
export interface TerrainSlice {
  x0: number;
  y0: number;
  width: number;
  height: number;
  layers: TerrainLayers;
  /** Micro-terrain of the same cells, if the world has it. */
  micro?: MicroLayers | null;
}

export interface BakeTileMessage {
  type: "bakeTile";
  id: number;
  rotation: Rotation;
  tx: number;
  ty: number;
  /** Leave the placed objects out of the image (they still cast shadows): the ground behind them. */
  bare?: boolean;
  /** The ground alone: no placed objects built at all, nothing kept (shown while the whole tile bakes). */
  ground?: boolean;
  /** The tile's cells plus a context margin, clipped to the world. */
  slice: TerrainSlice;
  /**
   * Placed objects taken out of the world (indices into the init's
   * instances, D-124), left out of the tile: its kept scene is meshed again
   * when they differ from the ones it was meshed without.
   */
  removed?: number[];
  /**
   * The terrain edits the slice holds (`ChunkStore.editsIn`, D-147): its
   * kept scene is meshed again when they differ from those it was meshed with.
   */
  cells?: string;
}

export interface BakeSpriteMessage {
  type: "bakeSprite";
  id: number;
  rotation: Rotation;
  boxes: Box[];
}

/** Bake object instances alone (a hero landmark, offline), on the slice's terrain heights. */
export interface BakeObjectsMessage {
  type: "bakeObjects";
  id: number;
  rotation: Rotation;
  instances: ObjectInstance[];
  slice: TerrainSlice;
}

/**
 * Bake a rectangle of the world in another projection (D-155: from above),
 * once, nothing kept: its cells, on a slice with a margin of context that
 * casts shadows into it, with its placed objects but those removed.
 */
export interface BakeAreaMessage {
  type: "bakeArea";
  id: number;
  owned: { x0: number; y0: number; x1: number; y1: number };
  slice: TerrainSlice;
  removed?: number[];
  projection: Projection;
  shadows: boolean;
}

/** A plugin for the bake worker to import (docs/plugins.md §9): an absolute module URL. */
export interface PluginRef {
  name: string;
  url: string;
}

/**
 * Import plugins and register them in the worker before its first bake (D-071).
 * Messages that arrive meanwhile wait; the worker answers `pluginsLoaded`, or
 * an `error` with this id.
 */
export interface LoadPluginsMessage {
  type: "loadPlugins";
  id: number;
  plugins: PluginRef[];
}

export type ToWorker = InitMessage | BakeTileMessage | BakeSpriteMessage | BakeObjectsMessage | BakeAreaMessage | LoadPluginsMessage;

export interface BakeStats {
  meshMs: number;
  bakeMs: number;
  vertices: number;
  shadowMapSize: [number, number];
}

export interface BakedMessage {
  type: "baked";
  id: number;
  image: BakedImage | null;
  stats: BakeStats;
  /** Models that failed to generate, drawn as missing-model markers (D-072); absent when none did. */
  failures?: ModelFailure[];
}

export interface ReadyMessage {
  type: "ready";
  renderer: string;
}

export interface ErrorMessage {
  type: "error";
  id?: number;
  message: string;
}

/** The plugins a worker registered, and the generators each added. */
export interface PluginsLoadedMessage {
  type: "pluginsLoaded";
  id: number;
  plugins: { name: string; generators: string[] }[];
}

export type FromWorker = BakedMessage | ReadyMessage | ErrorMessage | PluginsLoadedMessage;

/**
 * Whether a tile's bake builds an object, its slice the cells [x0, x1) ×
 * [y0, y1): its anchor in the slice, or a big footprint (a bridge) reaching
 * into it. The tiles an edit to the object touches are the ones this holds for.
 */
export function objectInSlice(o: ObjectInstance, x0: number, y0: number, x1: number, y1: number): boolean {
  if (o.x >= x0 && o.y >= y0 && o.x < x1 && o.y < y1) return true;
  if (!o.fp) return false;
  const [bx0, by0, bx1, by1] = footprintBounds(o.fp);
  return bx1 - bx0 > BIG_FOOTPRINT_CELLS / 2 || by1 - by0 > BIG_FOOTPRINT_CELLS / 2 ? bx1 >= x0 && by1 >= y0 && bx0 < x1 && by0 < y1 : false;
}

/** Typed arrays of a slice, for transferring to the worker without copying. */
export function sliceTransferables(slice: TerrainSlice): Transferable[] {
  const out = Object.values(slice.layers).map((a: ArrayBufferView) => a.buffer as ArrayBuffer);
  if (slice.micro) out.push(slice.micro.corners.buffer as ArrayBuffer);
  return out;
}
