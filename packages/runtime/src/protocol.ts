import type { MicroLayers, Rotation, TerrainLayers } from "@pixelworld/grid";
import type { BakedImage, StyleParams } from "@pixelworld/bake";
import type { HeroPaint } from "./heroPaint";
import type { AssetCatalog, Box, ObjectInstance, ScatterRules } from "@pixelworld/generators";

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

export type ToWorker = InitMessage | BakeTileMessage | BakeSpriteMessage | BakeObjectsMessage;

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
  const out = Object.values(slice.layers).map((a: ArrayBufferView) => a.buffer as ArrayBuffer);
  if (slice.micro) out.push(slice.micro.corners.buffer as ArrayBuffer);
  return out;
}
