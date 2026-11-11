import type { MicroLayers, Rotation, TerrainLayers } from "@pixelworlds/grid";
import type { BakedImage, StyleParams } from "@pixelworlds/bake";
import type { HeroPaint } from "./heroPaint";
import type { AssetCatalog, Box, ModelFailure, ObjectInstance, ScatterRules } from "@pixelworlds/generators";

/** Messages between the main thread and the bake worker. */

export interface InitMessage {
  type: "init";
  style: StyleParams;
  tileSize: number;
  margin: number;
  /** Height (steps) of world-edge skirts. */
  floor: number;
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
  /** The tile's cells plus a context margin, clipped to the world. */
  slice: TerrainSlice;
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

export type ToWorker = InitMessage | BakeTileMessage | BakeSpriteMessage | BakeObjectsMessage | LoadPluginsMessage;

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

/** Typed arrays of a slice, for transferring to the worker without copying. */
export function sliceTransferables(slice: TerrainSlice): Transferable[] {
  const out = Object.values(slice.layers).map((a: ArrayBufferView) => a.buffer as ArrayBuffer);
  if (slice.micro) out.push(slice.micro.corners.buffer as ArrayBuffer);
  return out;
}
