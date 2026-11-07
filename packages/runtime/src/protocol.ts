import type { Rotation } from "@pixelworld/grid";
import type { BakedImage, StyleParams } from "@pixelworld/bake";
import type { Box } from "@pixelworld/generators";

/** Messages between the main thread and the bake worker. */

export interface InitMessage {
  type: "init";
  cellsX: number;
  cellsY: number;
  base: Int16Array;
  slope: Uint8Array;
  surface: Uint8Array;
  water: Int16Array;
  style: StyleParams;
  tileSize: number;
  margin: number;
  floor: number;
}

export interface BakeTileMessage {
  type: "bakeTile";
  id: number;
  rotation: Rotation;
  tx: number;
  ty: number;
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
