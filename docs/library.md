# pixelworld as a library (proposal, for discussion)

**Status:** a draft for the M4 pass, its first steps built: the engine is out of the app (§7, as built), and generators come from a public registry that plugins add to (§8). pixelworld is fully open source. This document proposes how it becomes a set of published packages that other projects can use:
- as a **world and asset generator**: real places in, pixel-art worlds, tiles, sprites and models out;
- as an **engine** to build games and other interaction modes on.

M4's gameplay (the car, the plane, building mode) would be built on that public API, as its first users.

## 1. Who would use it

| User | Wants | Uses |
|---|---|---|
| **World makers** | a pixel-art map of their city or region | a region spec and the pipeline CLI; a style pack; publish the package |
| **Game developers (web)** | a world to play in: driving, flying, exploring, city building, a map viewer | the engine: a world view in their page, their own controls, entities and rules |
| **Game developers (other engines)** | tiles, sprites and models for Godot, Unity, Phaser and the like | an export CLI: tile atlases, sprite sheets, voxel models, the world's data as JSON |
| **Artists and modders** | their own look, buildings and landmarks | style packs, generators, landmark depictions, paint-overs |
| **Data contributors** | their city's open data in the map | source adapters and facts sources (like DataSF's assessor roll) |

## 2. What exists today

- **TypeScript packages:** `grid`, `world-format`, `style`, `generators`, `bake`, `runtime` and `sim` are already separate. But they are private, export TypeScript source, and have no build step.
- **The web app:** until the engine extraction (§7), `apps/web/src/main.ts` (about 940 lines) held the engine's assembly and the reference app's behaviour together:
  - world loading and level switching
  - the tile cache
  - the rover and its keys
  - the HUD and the layer panel
  - traffic and fog setup
  - the frame loop
  - the debug API

  It is now a client of `@pixelworld/engine` (about 430 lines: URL parameters, HUD, layer panel, levels, debug API).
- **The pipeline (Python):** one package with a CLI (`pixelworld build|routes|heroes|serve|plugins`) and a Python API (`pixelworld_pipeline.build(spec)`). Region specs select sources by name.
  - **Plugins:** terrain and land-cover sources and facts sources are found by name through entry points ([plugins.md](plugins.md)).
  - **San Francisco's facts (DataSF)** are a separate package, the city pack `pixelworld-city-sf` in `pipeline/plugins/`.
  - **Still built in:** stages, and the Overture, canopy, lidar and transit sources.
- **Generator plugins (TypeScript):** the generator registry is public, and plugins add generators to it, in the bake worker and on the main thread (§8, [plugins.md](plugins.md) §9). San Francisco's facades, towers and Chinatown are the city pack's browser half, the package `pixelworld-city-sf` in `packages/city-sf`.
- **Contracts:** the world format is specified in prose (docs/world-format.md) with codecs on both sides; style packs are JSON without a schema.
- **Licences:** MIT OR Apache-2.0 for the code, CC BY 4.0 for the style packs, ODbL for the world packages (§6, D2).

## 3. Target shape

### 3.1 Packages

| Package | Contents | Today |
|---|---|---|
| `@pixelworld/format` | the world package spec (manifest, chunks, objects, routes, optional layers); codecs; JSON Schemas; version policy | `world-format` |
| `@pixelworld/grid` | projection, rotations, cells, heights | `grid` |
| `@pixelworld/style` | the style pack schema, loader, palettes, night and atmosphere | `style` |
| `@pixelworld/generators` | the voxel model API, the generator registry and plugin API, built-in generators (terrain, trees, buildings, landmarks, vehicles) | `generators` |
| `@pixelworld/bake` | the WebGL2 tile and sprite baker (worker) | `bake` |
| `@pixelworld/engine` | world view: streaming, camera, compositor, layers, entities, controllers, queries | `engine` (built, §7) over `runtime` |
| `@pixelworld/traffic` | ambient traffic as a layer plugin (deterministic sim) | `sim`, with its layer (`trafficLayer`, §7) |
| `@pixelworld/style-desert-southwest`, `@pixelworld/style-bay-area` | style packs as data packages | `worlds/_styles/*` |
| `pixelworld-pipeline` (PyPI) | the pipeline: CLI and a Python API, stages, source adapters, plugins | `pipeline/` |
| `pixelworld-city-sf` (PyPI) | San Francisco's city pack, pipeline half: DataSF facts | `pipeline/plugins/pixelworld-city-sf/` |
| `pixelworld-city-sf` (npm) | San Francisco's city pack, browser half: its generators (facades, towers, Chinatown) as a plugin | `packages/city-sf` (§8) |
| `@pixelworld/viewer` (app) | the reference viewer: rover, HUD, layer panel, level switching | `apps/web` |
| `@pixelworld/editor` (app) | the warp editor | `apps/editor` |

An umbrella package `pixelworld` could re-export the browser packages for people who want one dependency (decision D3).

### 3.2 The engine API, sketched

As built (§7); the names in the first sketch that changed are noted.

```ts
import { createWorldView } from "@pixelworld/engine";
import { trafficLayer } from "@pixelworld/sim";          // @pixelworld/traffic once packaged
import bayArea from "@pixelworld/style-bay-area";

const view = await createWorldView({
  canvas,
  worldUrl: "https://example.org/worlds/sf/",   // a world package (sketched as `world`)
  style: bayArea,
  layers: [trafficLayer({ density: 1 })],
});

await view.camera.lookAt({ lon: -122.4194, lat: 37.7749 });
view.camera.rotation = 1;                       // sketched as view.setRotation(1)
view.layers.enable("traffic", false);           // or view.layers.get("traffic")?.setEnabled(false)

// a game adds its own entities and controllers
const car = view.entities.add({ model: { group: "vehicle.car", seed: 7, size }, x: 120.5, y: 88.2 });
await view.controllers.use(myCarController(car)); // owns input; moves the car and the camera

// queries for gameplay
view.query.heightAt(x, y);         // drawn ground height
view.query.roadAt(x, y);           // class, width, connections, lanes
view.query.pick(screenX, screenY); // the ground and cell under the pointer
```

The engine owns streaming, baking, compositing and the frame loop. It owns no input, rules or UI.

### 3.3 Extension points

| Extension | Interface | Registered by | Examples today |
|---|---|---|---|
| **Source adapters** (pipeline) | **built for rasters:** a `RasterSource` of role `terrain` or `landcover` lists the GeoTIFFs for a box (or fills a grid itself); the pipeline reprojects, resamples and caches | Python entry points (`pixelworld.sources`), selected by `sources.dem.kind` and `sources.landcover.kind` ([plugins.md](plugins.md)) | built in: 3DEP (terrain), WorldCover (land cover). Overture, canopy, lidar and transit aren't adapters yet |
| **Facts sources** (pipeline) | **built:** `factory(region, options)`, then facts per building by projected point: year, storeys, units, use, class code, neighbourhood, roof | entry points (`pixelworld.facts`), selected by `objects.typology.facts` | `datasf`, in the city pack `pixelworld-city-sf` |
| **3D city models** (pipeline) | footprints, heights and roof shapes from CityJSON or CityGML | entry points | none yet (M5's tier-1 regions) |
| **Stage hooks** (pipeline) | code run at named points of a build | entry points (`pixelworld.stages`), reserved | none yet |
| **Generators** | **built:** `(ctx) => VoxelModel` for a semantic group | `registerGenerators(record, { source })`, or a plugin (`definePlugin`) loaded with `createWorldView({ plugins })` in the bake worker and on the main thread ([plugins.md](plugins.md) §9); a style pack maps groups to them and names the plugins it needs | built in: buildings, landmarks, trees, vehicles; San Francisco's facades, towers and Chinatown in the city pack `pixelworld-city-sf` |
| **Style packs** | palette ramps, surfaces, materials, assets, night, atmosphere | data packages validated by a JSON Schema | desert-southwest, bay-area |
| **Package layers** | an optional file in the world package, written by its own pipeline command | format registry; pipeline command | `routes` (traffic) |
| **Runtime layers** | `update(dt)`, `sprites(view)`, an optional screen pass, enable/disable, `serialize()` | `view.layers.add(...)` | traffic, fog |
| **Entities** | a model (generator, seed, size) or boxes, baked per heading, depth-tested | `view.entities` | the rover, vehicles |
| **Controllers** (interaction modes) | input → entity and camera movement, using queries | `view.controllers.use(...)` | the rover (today); car, plane, builder (M4) |
| **Edits** | a delta layer over chunks and objects; affected tiles re-baked | `view.edits` | none yet (M4 building mode) |

### 3.4 The asset generation tool

A headless export, so the content works outside our engine:
- `pixelworld export tiles <world> --zoom 1,2,3 --rotations 0-3`: tile atlases with an index (positions and depth), and the palette as a LUT.
- `pixelworld export sprites --style bay-area --group vehicle.car --seeds 1-24 --headings 16`: sprite sheets.
- `pixelworld export models --group building.rowhouse.victorian --seeds 1-50 --format vox|gltf`: voxel models for other engines.
- `pixelworld export data <world>`: roads, routes, objects and heights as JSON or GeoJSON, for engines that build their own scenes.

Baking needs WebGL2. Headless export runs the same baker in headless Chromium, as `tools/hero-bake.mjs` already does for heroes, so the output is pixel-identical to the browser's.

### 3.5 Publishing

- **npm:**
  - ESM packages built to `dist/` with type declarations;
  - `exports` maps;
  - the bake worker shipped as a module worker resolved with `new URL(..., import.meta.url)`, which works in Vite, webpack and plain ESM;
  - semver per package with changesets, released from CI.
- **PyPI:** `pixelworld-pipeline`, with extras for heavy sources (`[lidar]`, `[cityjson]`), and city packs as their own distributions (`pixelworld-city-sf`).
- **The world format:** versioned on its own. The manifest carries the format version; readers accept older minor versions; conformance tests run both codecs over the same files.
- **Prebuilt worlds:** the San Francisco and Southwest packages as data releases (ODbL), with their attribution manifests.
- **Docs:**
  - an API reference (TypeDoc, pdoc);
  - guides: "Build your city", "Write a generator", "Make a style pack", "Embed in a game", "Export for Godot";
  - runnable examples: a minimal viewer, a driving demo, a sandbox builder, a static map export.

### 3.6 Licences (fully open source)

| What | Proposed licence | Why |
|---|---|---|
| Code (TypeScript, Python) | Apache-2.0 (or MIT) | permissive; Apache adds a patent grant |
| Style packs, palettes, paint-overs | CC-BY-4.0 (or CC0) | art assets; attribution |
| World packages | ODbL 1.0 | they are derived databases of OSM and Overture (data-sources.md §6); other inputs are compatible (public domain, CC-BY, PDDL) |
| Images rendered from worlds | "produced works" under the ODbL: attribution only | renders, screenshots and exported tiles credit the sources |

## 4. The refactors this needs

1. **Engine out of the app (done, §7):** split `apps/web/main.ts` into `createWorldView` (engine) and the viewer app (rover, HUD, keys, panel, URL parameters). The `__pixelworld` debug API stays in the app, built on the engine's public API.
2. **Layer interface (done):** traffic and fog become plugins implementing it. The layer panel lists whatever layers a view has.
3. **Controller interface (done):** the rover becomes the first controller. Queries (`heightAt`, `roadAt`, `pick`) become public.
4. **Entities (done for the rover):** today's sprite paths (the rover, vehicles) unify into one entity API that bakes models per heading. Traffic still bakes its own vehicle sprites, in one rotation for all four (§7).
5. **Generator registry (done, §8):** made public (`registerGenerators`, `listGenerators`, plugins). San Francisco's facades, towers and Chinatown moved to the city pack's plugin package, `pixelworld-city-sf`.
6. **Style schema:** a JSON Schema for style packs, and validation with useful errors. Packs become data packages.
7. **Pipeline plugins:** source and facts adapters behind entry points. DataSF moves out as a plugin. A Python API (`pixelworld.build(spec)`) sits beside the CLI.
   - **Done:** the registry, facts sources, terrain and land-cover sources, DataSF as the city pack `pixelworld-city-sf`, and `pixelworld_pipeline.build(spec)` ([plugins.md](plugins.md)).
   - **Not yet:** Overture, canopy, lidar and transit as adapters; 3D city models; stage hooks.
8. **Builds and releases:** package builds, `exports`, changesets, and CI release jobs for npm and PyPI.
9. **Export CLI:** generalized from the hero bake tool.
10. **Docs and examples:** the guides above, and an examples workspace that uses only the published packages.

## 5. M4, reframed

M4's features are built as controllers and plugins on the public API, which proves it:
- **The car controller:** on the road network and slopes, with collisions against occupied cells and traffic. It joins the traffic simulation's routes at junctions.
- **The plane controller:** on the flying level, with a drop shadow and terrain collision. Take-off and landing move between levels.
- **Occlusion silhouettes** for any entity a controller follows.
- **Building mode:** a controller plus the edits delta layer, with local re-bake.
- **Water palette cycling.**

**New exit criteria:**
- **An example game outside this repo's apps,** using only published packages, runs the Vegas → Hoover Dam → Grand Canyon drive and a canyon flight at 60 fps on desktop.
- **The export CLI** produces a tile atlas and a vehicle sprite sheet that load in a minimal Godot or Phaser example.

## 6. Decisions

- **D1, the primary consumer, decided: the engine first.** M4 is an example client of the engine: a game with flying and driving, built only on the public API. The export CLI follows.
- **D2, licences, decided:**
  - **Code:** MIT OR Apache-2.0, as Rust and Bevy do. Users pick either. Contributors grant both, including Apache's patent licence, which ends for anyone who sues over patents in the work.
  - **Style packs and art:** CC-BY-4.0.
  - **World packages:** ODbL 1.0.
- **D3, packaging, decided:**
  - **npm:** one package, `pixelworld`, with subpath exports (`pixelworld/engine`, `pixelworld/format`, `pixelworld/generators`, `pixelworld/traffic`, …). Everything browser-side builds to about 260 KB of JavaScript (89 KB gzipped), with both style packs and every generator, plus a 145 KB bake worker.
  - **Content:** city packs and style packs ship as separate packages anyone can publish.
  - **PyPI:** `pixelworld-pipeline`, matching its import name `pixelworld_pipeline`; `pixelworlds` is an unrelated project.
  - **Before 1.0:** check the project name against the game *Pixel Worlds* for trademarks.
- **D4, region-specific code, decided: plugins.** San Francisco's facades, towers, Chinatown and DataSF become the first city pack, the template for others. Built: DataSF (D-068) and the generators (D-071).
- **D5, the renderer, decided: our compositor; WebGPU later.** Other engines are served by the export path.
  - **A Rust renderer:** not now.
    - **Where tile time goes:** in the software benchmark, most of a walking-level tile's bake time is CPU mesh building in JavaScript (voxel models, greedy meshing, building assembly), not GPU work. A Rust renderer wouldn't speed that up; Rust compiled to WebAssembly for those CPU paths would.
    - **Order:**
      1. Measure on real GPUs (`pnpm bench`).
      2. Spread meshing over more workers.
      3. If it still dominates, move meshing and generators into a Rust crate compiled to WebAssembly behind the same TypeScript API.
    - **A native Rust renderer** (wgpu, Bevy or Godot plugins) can come later, reading the same world format.
- **D6, prebuilt worlds, decided: wait until the world format is declared stable (1.0).**

## 7. As built: the engine (M4, step 1)

The engine is out of the app (refactors 1–4 of §4). `apps/web` is now a client of it, and `examples/minimal-viewer` (about 45 lines of app code) uses nothing else. Frames are pixel-identical to before: the e2e goldens are unchanged, and the benchmark's driving case bakes the same 17 tiles from the same chunks into the same tile memory, in the same time within its noise.

### 7.1 Packages

- **`@pixelworld/engine`** (`packages/engine`, one index, `src/index.ts`): `createWorldView`, `roverController`, `fogLayer`, `listenTo` and the types. It is built on `@pixelworld/runtime` (chunk store, bake service and worker, tile cache, compositor, camera, fog fields), which stays internal: nothing in the engine's public types needs a runtime import.
- **`@pixelworld/sim`**: the traffic simulation and its layer, `trafficLayer`. It imports the engine's types only, so the engine knows nothing of traffic. It becomes `pixelworld/traffic` when packaged.
- **`apps/web`**: the reference viewer.
- **`examples/minimal-viewer`**: `pnpm example:minimal` (port 5180).

### 7.2 The view

```ts
createWorldView(opts: WorldViewOptions): Promise<WorldView>

interface WorldViewOptions {
  canvas: HTMLCanvasElement;
  worldUrl: string;                                   // a world package
  style: object | ((id: string) => object | Promise<object>); // a pack, or a resolver for the id the manifest names
  size?: { width: number; height: number };           // device px; default: follow the canvas on the page
  renderScale?: number;                               // default the package's
  cache?: boolean | TileStore;                        // IndexedDB by default
  objects?: boolean; scatter?: boolean; heroes?: boolean;
  palette?: "day" | "night";
  camera?: { x?: number; y?: number; h?: number; rotation?: number; zoom?: number | "auto" };
  layers?: Layer[];
  controller?: Controller;
  recordBakes?: boolean;                              // tile timings for the bench
  onError?: (message: string) => void;
  plugins?: PluginDescriptor[] | ((names: string[]) => PluginDescriptor[]); // generator plugins (§8)
}

interface WorldView {
  canvas; world: WorldInfo; camera: ViewCamera; query: WorldQuery;
  entities: EntityList; layers: LayerRegistry; controllers: ControllerHost; pixelRatio: number;
  palette: "day" | "night"; hasNight: boolean;
  ready(): Promise<void>; invalidate(): void; resize(width, height): void;
  stats(): ViewStats; tileBakes(): TileBake[]; timeFrames(n): number;
  bakeObject(id): Promise<((BakedImage & { rotation }) | null)[]>; // the hero tool's bake
  onFrame(listener): () => void;
  serialize(): ViewState; restore(state: ViewState): void;         // camera + every layer's state
  destroy(): void;
}

interface ViewCamera {
  x; y; h;                       // focus, cells and steps
  rotation: Rotation; zoom: number; autoZoom: boolean; internalWidth; internalHeight;
  setFocus(x, y, h): void;
  lookAt({ x, y, h? } | { lon, lat, h? }): Promise<boolean>;
  pan(dx, dy): void; rotate(±1): void; screenDirToGrid(dx, dy): [number, number];
}
```

- **Start-up:** load the package, style and bake worker; size the canvas; put the camera on the world's start; attach the controller (the rover puts the camera on itself); apply `camera` (a missing coordinate keeps where the controller put it); initialize the layers in order; then start the loop. No frame is drawn before the view is set up, so no tile is baked in the wrong place.
- **The loop** is the app's, unchanged: controller update, entity sprite requests, layer updates, tiles wanted nearest first, and a redraw only when something changed. `ready()` resolves once a frame is drawn with every visible tile and sprite and nothing is left to bake.
- **Redraws:** a change through the public API (camera, entities, layers, palette) redraws and makes `ready()` wait. Setting the focus to where it already is doesn't, so a controller that follows something every frame leaves the loop idle.

### 7.3 Layers

```ts
interface Layer {
  id; label; enabled; setEnabled(on): void;
  sublayers?: { id; label }[]; isSublayerEnabled?(id); setSublayerEnabled?(id, on);
  init(ctx: LayerContext): boolean | Promise<boolean>;      // false: nothing in this world, left out
  update?(dt, frame: FrameInfo): boolean;                    // while enabled; true: redraw
  sprites?(frame): { list: SpriteDraw[]; complete: boolean };
  screenPass?(frame): ScreenPass | null;                     // fog's, today the one kind
  serialize?(): unknown; restore?(state): void; dispose?(): void;
}
interface LayerContext { view; bakeSprite(rotation, boxes): Promise<Sprite | null>; releaseSprite(s); frame(): FrameInfo; invalidate(): void }
interface FrameInfo { rotation; focus: { x, y, h }; zoom; view: { left, top, width, height }; night; renderScale; project(x, y, h) }
view.layers: list(), get(id), add(layer), remove(id), enable(id, on?, sublayer?)
```

- **Order:** layers' sprites are drawn in the order the layers were added, then the entities'. A frame takes the first screen pass any layer offers.
- **`fogLayer({ enabled, time, paused })`** (engine): the style's atmosphere (D-063); left out where the style has no fog over the world and level.
- **`trafficLayer({ seed, density, enabled, paused, time, sublayers, routes })`** (sim): D-060; left out without routes. Sublayers road, rail and ferry. Its state is the simulation's JSON with its switches.

### 7.4 Entities

```ts
view.entities.add({
  model: { boxes: Box[]; key?: string } | { group: string; seed: number; size?; variant?; part? },
  x, y, h?,                 // cells, steps (default the ground)
  heading?, headings?,      // radians; baked headings (16)
  lift?, silhouette?, visible?,
}): Entity                  // x, y, h, heading, visible, silhouette, moveTo(x, y, h?), remove()
```

- **Baking:** lazily, per view rotation and heading, shared by every entity with the same model. Heading 0 bakes the model as given, so the rover's sprite is the same as before.
- **Hidden entities** are baked too, so showing one is instant, but they don't hold up `ready()`.
- **Group models** are style assets drawn by their generator at the object voxel scale. Vehicle generators need `size`.
- **Traffic keeps its own sprites:** it bakes each heading once, in rotation 0, for all four rotations (D-060). Entities bake per rotation, which keeps the rover pixel-identical. Folding traffic into entities, with the rotation-0 trick as an option, is left for later.

### 7.5 Controllers

```ts
interface Controller {
  id; attach(view: ControllerView): void | Promise<void>; detach?();
  update?(dt); keyDown?(e): boolean; keyUp?(e); pointerDown?(e); pointerMove?(e); pointerUp?(); blur?();
}
interface ControllerView { canvas; world; camera; entities; query; pixelRatio }   // a test can fake it
view.controllers.use(controller | null)                     // one at a time
listenTo(controller, { keys?: EventTarget; pointer?: EventTarget }): () => void
roverController({ start?: { x?, y? } | { lon, lat }, follow?, visible?, listen? }): RoverController
```

- **Input:** the app forwards events (the viewer does, since it keeps T, L, V, G, I, H and Esc), or the controller listens on targets it is given (`listen`, as the example does).
- **The rover controller:** the rover entity, `follow`, `noclip` and `place(x, y)`. Its keys are as before: arrows drive, WASD and drags pan, Q/E rotate, 1–6 zoom, F follows, N is no-clip.

### 7.6 Queries

```ts
view.query.heightAt(x, y)             // the drawn ground (steps), as the rover rides it
view.query.surfaceAt(x, y)            // { id, name, waterLevel }
view.query.roadAt(x, y)               // { classId, class, width, connections, lanes, oneWay, divided }
view.query.pick(screenX, screenY)     // { x, y, h, cellX, cellY } under a canvas point (CSS px)
view.query.lonLatToCell(lon, lat); view.query.cellToLonLat(x, y)   // through the geo grid (D-048)
view.query.elevationAt(x, y, h?); view.query.metersPerCellAt(x, y); view.query.ensure(x0, y0, x1, y1)
```

- **Null where nothing is loaded:** `ensure` loads the terrain under a rectangle.
- **Road width:** the way's real width (D-050), else the style's for its class, as drawn.
- **`pick`** follows the view ray down through the loaded ground and water and refines the hit by bisection. It works before anything is drawn and reads nothing back from the GPU. Objects aren't picked: building tops would come from the depth the tiles write.

### 7.7 What moved where

| From | To |
|---|---|
| `apps/web/src/main.ts`: loading the package, style, palette, heroes and the bake worker's init; the tile cache key | `packages/engine/src/world.ts` |
| the tiles in view and their height estimates | `engine/src/tiles.ts` |
| the GPU tile budget, the frame loop, `ready()`, stats, frame timing, the hero bake | `engine/src/view.ts` |
| the camera in cells | `engine/src/camera.ts`, over the runtime's camera |
| the rover, its keys and drags | `engine/src/rover.ts` |
| `apps/web/src/fog.ts` | `engine/src/fog.ts` |
| `apps/web/src/traffic.ts` | `packages/sim/src/layer.ts` |
| URL parameters, HUD, layer panel, sources, help, levels, `__pixelworld` | still `apps/web/src/main.ts` |

### 7.8 Not yet

- **Edits** (`view.edits`), the export CLI (§3.4) and packaging (§3.5: builds, `exports` maps, the `pixelworld` umbrella). The workspace packages are still private TypeScript sources.
- **Screen passes:** fog's is the one kind. A general pass (a layer's own shader) comes when a second layer needs one.
- **`pick`** ignores objects.
- **Traffic sprites** aren't entities yet (§7.4).
- **Level switching** still reloads the viewer's page. A view could switch in place with `destroy()` and a new `createWorldView`.

## 8. As built: generator plugins (M4)

Refactor 5 of §4 and the browser half of D4: generators are found by name in a public registry, and a city's own generators come from a plugin. San Francisco's renders pixel for pixel as before, from the city pack. The details, and how to write and ship one, are in [plugins.md](plugins.md) §9 (D-071).

### 8.1 The registry

`@pixelworld/generators`: `registerGenerators(record, { source, replace })`, `registerGenerator`, `hasGenerator`, `getGenerator`, `listGenerators` and `unregisterGenerators`. It starts with the built-ins (`builtins.ts`: everything every region uses) and holds what plugins add, one registry per realm (the main thread, each bake worker). A style asking for a generator that isn't registered fails that model's bake with a `MissingGeneratorError` naming the generator, the group and, for this repository's plugins, the plugin to load.

### 8.2 Plugins

```ts
// the plugin's worker module (pixelworld-city-sf/src/worker.ts)
export default definePlugin({ name: "pixelworld-city-sf", register: (api) => api.registerGenerators(sfGenerators()) });

// a page
import { cityPlugin } from "pixelworld-city-sf";            // { name, url }: the worker module's URL
const view = await createWorldView({ canvas, worldUrl: "/sf/", style: bayArea, plugins: [cityPlugin] });
```

- **The bake worker** gets `loadPlugins` (names and module URLs) before `init`, imports each, registers it, and answers `pluginsLoaded`; messages meanwhile wait. `definePlugin` announces the plugin to the realm, so it is found even when a bundler drops the module's exports (Vite does for worker bundles) or bundles its own copy of the generators package.
- **The main thread** registers each plugin too (entity models, the inline baker), from the descriptor's `plugin` or by importing its URL. Without a view: `register()` from the pack, or `registerPlugin(plugin)`.
- **Style packs** name the plugins they need: `"plugins": ["pixelworld-city-sf"]` in the bay-area pack. `plugins` may be a function given those names, as the viewer passes; a named plugin that isn't loaded is a warning.
- **The tile cache key** includes the plugins (name and `version`); without plugins it is unchanged.

### 8.3 What moved where

| From (`packages/generators`) | To |
|---|---|
| the generator table in `assets.ts` (`GENERATORS`, `LANDMARK_GENERATORS`, `damProfile`) | `builtins.ts`, read by the registry (`registry.ts`) on first use |
| `facades.ts` (`rowhouse`, its stucco rows, `block`), `towers.ts` (`decoTower`, `sfTower`), `chinatown.ts` (`gate`, `lanterns`), and their tests | `packages/city-sf` (`pixelworld-city-sf`) |

- **Stayed in core:** terrain, trees, rocks, city blocks, the generic building, dams, signs, the landmark kit's generic landmarks (bridges, halls, towers, the windmill, the lighthouse…), the rail props (`cableCar`, `streetcar`: generic vehicles the pipeline stands along any tram line, as the traffic models are) and the vehicle models.
- **The Southwest** names only built-in generators (a test checks), so its worlds need no plugin.
- **Bundles:** the city pack's worker module is 28 KB on its own (its generators and the voxel model class); the viewer's main bundle no longer carries San Francisco's generators, and the bake worker's carries only the built-ins.
