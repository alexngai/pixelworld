import type { BakedImage } from "@pixelworld/bake";
import type { Box, PluginDescriptor } from "@pixelworld/generators";
import type { Rotation } from "@pixelworld/grid";
import type { FogField, FogFrame, GpuImage, SpriteInstance } from "@pixelworld/runtime";
import type { Palette, StylePack } from "@pixelworld/style";
import type { WorldManifest } from "@pixelworld/world-format";

/**
 * The engine's public types (docs/library.md §3.2–3.3). Units, unless said
 * otherwise: positions in world cells (x east, y south), heights in height
 * steps, screen positions in internal (render) pixels before the zoom.
 */

export type { Box, PluginDescriptor, Rotation, BakedImage, StylePack, Palette, WorldManifest };

/** A baked sprite on the GPU (from `LayerContext.bakeSprite`); opaque to layers. */
export type Sprite = GpuImage;

/** A sprite drawn this frame: its origin's screen position (render px, whole pixels) and depth. */
export type SpriteDraw = SpriteInstance;

// ---------------------------------------------------------------- the view

/** Where a style pack comes from: the pack itself (JSON), or a resolver given the id the world names. */
export type StyleSource = object | ((id: string) => object | Promise<object>);

/** Somewhere to keep baked tiles between visits (the default is IndexedDB). */
export interface TileStore {
  get(key: string): Promise<BakedImage | null>;
  put(key: string, image: BakedImage): Promise<void>;
  /** Completed writes, for stats. */
  readonly writes?: number;
}

export interface CameraOptions {
  /** Focus in cells (default the world's start); `h` in steps (default the surface there). */
  x?: number;
  y?: number;
  h?: number;
  /** View rotation, 0–3 quarter turns (default 0). */
  rotation?: number;
  /** Integer upscale of the baked pixels; default "auto": about one internal pixel per 640 canvas pixels. */
  zoom?: number | "auto";
}

export interface WorldViewOptions {
  /** The canvas to draw into (WebGL2). */
  canvas: HTMLCanvasElement;
  /** Base URL of a world package (a directory with `manifest.json`). */
  worldUrl: string;
  /** The style pack (JSON), or a resolver for the id in the world's manifest. */
  style: StyleSource;
  /**
   * The canvas's drawing size in device pixels. Default: follow its size on
   * the page (CSS pixels × devicePixelRatio).
   */
  size?: { width: number; height: number };
  /** Render units per cell; default the world's (`manifest.render.scale`). */
  renderScale?: number;
  /** Keep baked tiles: true for IndexedDB (default), false for none, or your own store. */
  cache?: boolean | TileStore;
  /** Draw the world's placed objects (default true). */
  objects?: boolean;
  /** Decorative scatter where the level asks for it (default true). */
  scatter?: boolean;
  /** Stamp painted-over hero landmarks into tiles (default true). */
  heroes?: boolean;
  /** Start with the night palette where the style has one (default "day"). */
  palette?: "day" | "night";
  camera?: CameraOptions;
  /** Runtime layers, initialized in order; a layer with nothing to show in this world is left out. */
  layers?: Layer[];
  /** The interaction mode; attached before the first frame. */
  controller?: Controller;
  /** Keep every tile bake's timings (`WorldView.tileBakes`), for benchmarks. */
  recordBakes?: boolean;
  /** Bake errors (default: console.error). */
  onError?: (message: string) => void;
  /**
   * Plugins with generators the world's style uses (D-071), such as the city
   * pack pixelworld-city-sf's `cityPlugin`: loaded in the bake worker and on
   * the main thread before the first bake. Or a function given the plugins the
   * style pack names (its `plugins`) that returns the ones to load. A plugin the
   * style names but the view doesn't load is warned about.
   */
  plugins?: PluginDescriptor[] | ((names: string[]) => PluginDescriptor[]);
}

/** What the view knows about its world (read-only). */
export interface WorldInfo {
  readonly url: string;
  readonly manifest: WorldManifest;
  /** The style pack in use, validated (object surfaces merged in where objects are drawn). */
  readonly style: StylePack;
  /** The day palette (ramp ids by name, 256 RGBA entries). */
  readonly palette: Palette;
  readonly renderScale: number;
  readonly cellsX: number;
  readonly cellsY: number;
  /** Lowest and highest corner heights (steps). */
  readonly heightRange: [number, number];
  /** The lowest drawn height (steps): the world-edge skirts, a little under the lowest corner. */
  readonly floor: number;
  /** Whether the world has a geo grid (lon/lat queries answer). */
  readonly hasGeo: boolean;
  /** Placed objects drawn (0 without objects). */
  readonly objectCount: number;
  /** The scale level's name (D-046); the package's levels are in `manifest.levels`. */
  readonly level: string | null;
}

/** The camera: a focus point in cells, a rotation and an integer zoom. */
export interface ViewCamera {
  /** Focus point (cells, steps). */
  readonly x: number;
  readonly y: number;
  readonly h: number;
  /** Quarter turns, 0–3. */
  rotation: Rotation;
  /** Integer upscale; setting it fixes the zoom (no longer "auto"). */
  zoom: number;
  readonly autoZoom: boolean;
  /** The internal (pre-zoom) view size in pixels. */
  readonly internalWidth: number;
  readonly internalHeight: number;
  /** Move the focus (cells, steps), without loading anything. */
  setFocus(x: number, y: number, h: number): void;
  /**
   * Centre on a place: a cell, or a lon/lat (worlds with a geo grid). Loads
   * the terrain there; the height defaults to the surface. False when the
   * place is outside the world.
   */
  lookAt(target: { x: number; y: number; h?: number } | { lon: number; lat: number; h?: number }): Promise<boolean>;
  /** Pan by internal pixels, keeping the focus height. */
  pan(dx: number, dy: number): void;
  rotate(delta: 1 | -1): void;
  /** The unit grid direction of a screen direction in this rotation. */
  screenDirToGrid(dx: number, dy: number): [number, number];
}

export interface ViewStats {
  renderer: string;
  bakeMode: "worker" | "inline";
  tilesBaked: number;
  tilesFromCache: number;
  tilesPerRotation: number;
  chunksLoaded: number;
  chunksTotal: number;
  gpuTiles: number;
  gpuMB: number;
  avgMeshMs: number;
  avgBakeMs: number;
  maxTileMs: number;
  fps: number;
  /** Main-thread time of the last drawn frame: screen passes and compositor submission. */
  renderMs: number;
  cache: "indexeddb" | "custom" | "off";
  cacheWrites: number;
}

/** One tile bake's timings (`recordBakes`). */
export interface TileBake {
  rotation: number;
  tx: number;
  ty: number;
  /** Preparing the tile's geometry (micro-terrain fields, object meshes) in the bake worker. */
  meshMs: number;
  /** Drawing it on the GPU, waiting for the pixels (shadow map, AO, colour, depth). */
  bakeMs: number;
  vertices: number;
}

/** Called after every animation frame. */
export interface FrameEvent {
  now: number;
  dt: number;
  /** Whether the frame was drawn (the loop redraws only when something changed). */
  drawn: boolean;
}

/** A view's state for determinism: the camera and every layer's own state. */
export interface ViewState {
  camera: { x: number; y: number; h: number; rotation: Rotation; zoom: number };
  layers: Record<string, unknown>;
}

export interface WorldView extends ControllerView {
  readonly layers: LayerRegistry;
  readonly controllers: ControllerHost;
  /** "day" or "night" (where the style has a night palette). */
  palette: "day" | "night";
  readonly hasNight: boolean;
  /** Resolves once a frame is drawn with every visible tile and sprite and nothing is left to bake. */
  ready(): Promise<void>;
  /** Something changed that the engine can't see: redraw, and make `ready()` wait for it. */
  invalidate(): void;
  /** Set the drawing size (device pixels); with `size` omitted the view follows the canvas instead. */
  resize(width: number, height: number): void;
  stats(): ViewStats;
  /** Every tile bake so far with its timings (only with `recordBakes`). */
  tileBakes(): TileBake[];
  /** Redraw the last frame n times, waiting for the GPU each time: mean milliseconds per frame. */
  timeFrames(n: number): number;
  /** Bake a placed object (and its parts, by id) alone on its terrain in all four rotations: the hero tool (D-053). */
  bakeObject(id: string): Promise<((BakedImage & { rotation: Rotation }) | null)[]>;
  onFrame(listener: (e: FrameEvent) => void): () => void;
  serialize(): ViewState;
  restore(state: ViewState): void;
  /** Stop the frame loop and let go of the GPU and the bake worker. */
  destroy(): void;
}

// ---------------------------------------------------------------- queries

export interface SurfaceInfo {
  /** Surface class id and name (manifest `surfaces`). */
  id: number;
  name: string;
  /** Water surface height (steps), or null where the cell is dry. */
  waterLevel: number | null;
}

export interface RoadInfo {
  /** Road class id and name (manifest `roadClasses`). */
  classId: number;
  class: string | null;
  /** Drawn width in cells: the way's real width (D-050), else the style's for its class. */
  width: number;
  /** Neighbours the road connects to, as grid steps (dx, dy) in −1..1. */
  connections: [number, number][];
  /** Lanes (M3.5): count (0 = not counted), one-way, divided carriageway. */
  lanes: number;
  oneWay: boolean;
  divided: boolean;
}

export interface PickResult {
  /** The point on the drawn ground (cells, steps). */
  x: number;
  y: number;
  h: number;
  /** The cell. */
  cellX: number;
  cellY: number;
}

/** Gameplay queries over the loaded world. Positions are cells; a query where nothing is loaded answers null. */
export interface WorldQuery {
  /** Height of the drawn ground (steps): micro-terrain or cell corners, as the mesh draws it. */
  heightAt(x: number, y: number): number | null;
  surfaceAt(x: number, y: number): SurfaceInfo | null;
  /** The road through a cell, or null for none. */
  roadAt(x: number, y: number): RoadInfo | null;
  /** The ground under a canvas point (CSS pixels from the canvas's top-left). */
  pick(screenX: number, screenY: number): PickResult | null;
  /** Cell position of a lon/lat (worlds with a geo grid; null outside). */
  lonLatToCell(lon: number, lat: number): [number, number] | null;
  cellToLonLat(x: number, y: number): [number, number] | null;
  /** Real elevation in metres at a drawn height (default the ground), undoing the vertical caricature. */
  elevationAt(x: number, y: number, h?: number): number | null;
  /** Real metres per cell around a place (warped worlds vary). */
  metersPerCellAt(x: number, y: number): number;
  /** Load the terrain under a rectangle of cells, so queries answer there. */
  ensure(x0: number, y0: number, x1: number, y1: number): Promise<void>;
}

// ---------------------------------------------------------------- entities

/**
 * An entity's model, baked per heading. Boxes are in render units (cells at
 * render scale 1; z in steps), facing +x and standing on z = 0. A group
 * names a style asset (`vehicle.car`) drawn by its generator with a seed,
 * at the object voxel scale (D-010); `size` is in voxels.
 */
export type EntityModel =
  | { boxes: Box[]; key?: string }
  | {
      group: string;
      seed: number;
      size?: { length: number; width: number; height: number };
      variant?: number;
      part?: number;
    };

export interface EntitySpec {
  model: EntityModel;
  x: number;
  y: number;
  /** Height (steps); default the ground there. */
  h?: number;
  /** Facing (radians; x east, y south). */
  heading?: number;
  /** Headings baked around the circle (default 16). */
  headings?: number;
  /** Raise the sprite this many steps above `h`. */
  lift?: number;
  /** Draw a dithered silhouette where the world hides it (default false). */
  silhouette?: boolean;
  visible?: boolean;
}

export interface Entity {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly h: number;
  heading: number;
  visible: boolean;
  silhouette: boolean;
  /** Move (cells, steps); the height defaults to the ground there, or stays where it isn't loaded. */
  moveTo(x: number, y: number, h?: number): void;
  remove(): void;
}

export interface EntityList {
  add(spec: EntitySpec): Entity;
  remove(entity: Entity): void;
  list(): readonly Entity[];
}

// ---------------------------------------------------------------- layers

/** The frame as layers see it. */
export interface FrameInfo {
  rotation: Rotation;
  /** Camera focus (cells, steps). */
  focus: { x: number; y: number; h: number };
  zoom: number;
  /** The view in render px: whole-pixel top-left and the internal size. */
  view: { left: number; top: number; width: number; height: number };
  night: boolean;
  renderScale: number;
  /** Screen position (render px) and depth of a point (cells, steps) in this rotation. */
  project(x: number, y: number, h: number): { sx: number; sy: number; depth: number };
}

/** A pass over the drawn frame before the palette. Fog's (D-063) is the one kind today. */
export type ScreenPass = { type: "fog"; field: FogField; frame: FogFrame };

/** What a layer gets when it joins a view. */
export interface LayerContext {
  readonly view: WorldView;
  /** Bake boxes (render units) into a sprite, queued with the tile bakes; null if the bake failed. */
  bakeSprite(rotation: Rotation, boxes: Box[]): Promise<Sprite | null>;
  releaseSprite(sprite: Sprite): void;
  /** The frame as the camera stands now. */
  frame(): FrameInfo;
  /** Something the layer draws changed: redraw, and make `ready()` wait for it. */
  invalidate(): void;
}

/** A part of a layer that switches on and off on its own (traffic's road, rail, ferry). */
export interface Sublayer {
  readonly id: string;
  readonly label: string;
}

/**
 * A runtime layer (docs/library.md §3.3): something drawn over the baked
 * world without being baked into it, such as traffic or fog.
 */
export interface Layer {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  setEnabled(on: boolean): void;
  readonly sublayers?: readonly Sublayer[];
  isSublayerEnabled?(id: string): boolean;
  setSublayerEnabled?(id: string, on: boolean): void;
  /** Join a view. False when the layer has nothing in this world; it is then left out. */
  init(ctx: LayerContext): boolean | Promise<boolean>;
  /** Advance by a frame's time (seconds), while enabled; true when the frame needs redrawing. */
  update?(dt: number, frame: FrameInfo): boolean;
  /** Depth-tested sprites for a frame being drawn; `complete` is false while some are still baking. */
  sprites?(frame: FrameInfo): { list: SpriteDraw[]; complete: boolean };
  /** A pass over the frame being drawn, or null for none. */
  screenPass?(frame: FrameInfo): ScreenPass | null;
  /** The layer's whole state as plain JSON, and back (determinism). */
  serialize?(): unknown;
  restore?(state: unknown): void;
  dispose?(): void;
}

export interface LayerRegistry {
  list(): readonly Layer[];
  get(id: string): Layer | undefined;
  /** Initialize and add a layer; false (and not added) when it has nothing in this world. */
  add(layer: Layer): Promise<boolean>;
  remove(id: string): void;
  /** Switch a layer (or one of its sublayers) on or off. */
  enable(id: string, on?: boolean, sublayer?: string): void;
}

// ---------------------------------------------------------------- controllers

export interface KeyInput {
  key: string;
  preventDefault?(): void;
}

export interface PointerInput {
  clientX: number;
  clientY: number;
  pointerId?: number;
}

/** The part of the view a controller works with (tests can fake it). */
export interface ControllerView {
  readonly canvas: HTMLCanvasElement;
  readonly world: WorldInfo;
  readonly camera: ViewCamera;
  readonly entities: EntityList;
  readonly query: WorldQuery;
  /** Device pixels per CSS pixel of the canvas, as the view sized it. */
  readonly pixelRatio: number;
}

/**
 * An interaction mode (docs/library.md §3.3): input in, entity and camera
 * movement out. The app forwards key and pointer events to it, or the
 * controller listens on an element it is given (`listenTo`).
 */
export interface Controller {
  readonly id: string;
  attach(view: ControllerView): void | Promise<void>;
  detach?(): void;
  /** Each frame, before layers update (seconds). */
  update?(dt: number): void;
  /** True when the key was the controller's. */
  keyDown?(e: KeyInput): boolean;
  keyUp?(e: KeyInput): void;
  pointerDown?(e: PointerInput): void;
  pointerMove?(e: PointerInput): void;
  pointerUp?(e: PointerInput): void;
  /** The window lost focus: let go of held keys. */
  blur?(): void;
}

export interface ControllerHost {
  readonly current: Controller | null;
  /** Detach the current controller and attach this one (null: none). */
  use(controller: Controller | null): Promise<void>;
}
