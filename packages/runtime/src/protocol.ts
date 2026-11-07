import type { Rotation, TerrainLayers } from "@pixelworld/grid";
import type { BakedImage, StyleParams } from "@pixelworld/bake";
import type { AssetCatalog, Box, ObjectInstance } from "@pixelworld/generators";

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
  /** Placed objects for the whole world (experiment worlds are small). */
  objects?: WorldObjects;
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
}

/** A block of terrain cut from the world, with its world-space origin. */
export interface TerrainSlice {
  x0: number;
  y0: number;
  width: number;
  height: number;
  layers: TerrainLayers;
}

export interface BakeTileMessage {
  type: "bakeTile";
  id: number;
  rotation: Rotation;
  tx: number;
  ty: number;
  /** The tile's cells plus a context margin, clipped to the world. */
  slice: TerrainSlice;
}

export interface BakeSpriteMessage {
  type: "bakeSprite";
  id: number;
  rotation: Rotation;
  boxes: Box[];
}

export type ToWorker = InitMessage | BakeTileMessage | BakeSpriteMessage;

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

export type FromWorker = BakedMessage | ReadyMessage | ErrorMessage;

/** Typed arrays of a slice, for transferring to the worker without copying. */
export function sliceTransferables(slice: TerrainSlice): Transferable[] {
  return Object.values(slice.layers).map((a: ArrayBufferView) => a.buffer as ArrayBuffer);
}
