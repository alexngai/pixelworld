# pixelworld as a library (proposal, for discussion)

**Status:** a draft for the M4 pass, its first steps built: the engine is out of the app (§7, as built), generators come from a public registry that plugins add to (§8), and the npm package `pixelworld` builds, packs and is checked in CI, unpublished (§3.5, [npm.md](npm.md)). pixelworld is fully open source. This document proposes how it becomes a set of published packages that other projects can use:
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

- **TypeScript packages:** `grid`, `world-format`, `style`, `generators`, `bake`, `runtime`, `engine` and `sim` are already separate. They are private, export TypeScript source, and have no build step; the npm package `pixelworld` bundles them (§3.5, [npm.md](npm.md)).
- **The web app:** until the engine extraction (§7), `apps/web/src/main.ts` (about 940 lines) held the engine's assembly and the reference app's behaviour together:
  - world loading and level switching
  - the tile cache
  - the rover and its keys
  - the HUD and the layer panel
  - traffic and fog setup
  - the frame loop
  - the debug API

  It is now a client of `@pixelworlds/engine` (about 430 lines: URL parameters, HUD, layer panel, levels, debug API).
- **The pipeline (Python):** one package with a CLI (`pixelworld build|routes|heroes|serve|plugins`) and a Python API (`pixelworld_pipeline.build(spec)`). Region specs select sources by name.
  - **Sources:** every external data source has a role (terrain, land cover, features, facts, canopy, heights, importance) and is chosen by name in the spec (`sources:`). Installed packages add sources through the `pixelworld.sources` entry points ([plugins.md](plugins.md)).
  - **City sources:** DataSF, PLUTO, APUR, PLATEAU and the IGN and GSI terrain sources are built in (D-110); they were city packs before.
  - **Still built in:** the stages. Overture, the canopy map, lidar and Wikidata are sources like the rest, which a spec can swap (D-110).
- **Generator plugins (TypeScript):** the generator registry is public, and plugins add generators to it, in the bake worker and on the main thread (§8, [plugins.md](plugins.md) §9). San Francisco's facades, towers and Chinatown are the city pack's browser half, the package `@pixelworlds/city-sf` in `packages/city-sf`.
- **Contracts:** the world format is specified in prose (docs/world-format.md) with codecs on both sides; style packs are JSON checked against a JSON Schema (`packages/style/schema/`, D-075).
- **Licences:** MIT OR Apache-2.0 for the code, CC BY 4.0 for the style packs, ODbL for the world packages (§6, D2).

## 3. Target shape

### 3.1 Packages

| Package | Contents | Today |
|---|---|---|
| `@pixelworlds/format` | the world package spec (manifest, chunks, objects, routes, optional layers); codecs; JSON Schemas; version policy | `world-format` |
| `@pixelworlds/grid` | projection, rotations, cells, heights | `grid` |
| `@pixelworlds/style` | the style pack schema, loader, palettes, night and atmosphere | `style` |
| `@pixelworlds/generators` | the voxel model API, the generator registry and plugin API, built-in generators (terrain, trees, buildings, landmarks, vehicles) | `generators` |
| `@pixelworlds/bake` | the WebGL2 tile and sprite baker (worker) | `bake` |
| `@pixelworlds/engine` | world view: streaming, camera, compositor, layers, entities, controllers, queries | `engine` (built, §7) over `runtime` |
| `@pixelworlds/traffic` | ambient traffic as a layer plugin (deterministic sim) | `sim`, with its layer (`trafficLayer`, §7) |
| `@pixelworlds/style-desert-southwest`, `@pixelworlds/style-bay-area` | style packs as data packages | `worlds/_styles/*` |
| `pixelworld-pipeline` (PyPI) | the pipeline: CLI and a Python API, stages, every built-in source (the city facts and terrain sources too), plugins | `pipeline/` |
| `@pixelworlds/city-sf` (npm) | San Francisco's city pack, browser half: its generators (facades, towers, Chinatown) as a plugin | `packages/city-sf` (§8) |
| `@pixelworlds/viewer` (app) | the reference viewer: rover, HUD, layer panel, level switching | `apps/web` |
| `@pixelworlds/editor` (app) | the warp editor | `apps/editor` |

D3 settled this as one npm package, `pixelworld`, with an entry point per browser package (`pixelworld/engine`, `pixelworld/traffic`, …), built (§3.5); style packs and city packs are separate packages.

### 3.2 The engine API, sketched

As built (§7); the names in the first sketch that changed are noted.

```ts
import { createWorldView } from "@pixelworlds/engine";
import { trafficLayer } from "@pixelworlds/sim";          // @pixelworlds/traffic once packaged
import bayArea from "@pixelworlds/style-bay-area";

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
| **Facts sources** (pipeline) | **built:** `factory(region, options)`, then facts per building by projected point: year, storeys, units, use, class code, neighbourhood, roof | entry points (`pixelworld.sources`), selected by `sources.facts` | `datasf`, `pluto`, `apur`, `plateau`, built in |
| **3D city models** (pipeline) | footprints, heights and roof shapes from CityJSON or CityGML | entry points | none yet (M5's tier-1 regions) |
| **Stage hooks** (pipeline) | code run at named points of a build | entry points (`pixelworld.stages`), reserved | none yet |
| **Generators** | **built:** `(ctx) => VoxelModel` for a semantic group | `registerGenerators(record, { source })`, or a plugin (`definePlugin`) loaded with `createWorldView({ plugins })` in the bake worker and on the main thread ([plugins.md](plugins.md) §9); a style pack maps groups to them and names the plugins it needs | built in: buildings, landmarks, trees, vehicles; San Francisco's facades, towers and Chinatown in the city pack `@pixelworlds/city-sf` |
| **Style packs** | palette ramps, surfaces, materials, assets, night, atmosphere | JSON files checked against a JSON Schema (D-075), named by world manifests; `extends` for variants. Not yet published as data packages | desert-southwest, bay-area |
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

- **npm, as built:** one package, `pixelworld` (D3), in `packages/pixelworld`. How to use it: [npm.md](npm.md).
  - **Entry points:** `pixelworld/engine`, `/traffic` (`@pixelworlds/sim`), `/format` (`@pixelworlds/world-format`), `/grid`, `/style` and `/generators`. Each has ESM, declarations and source maps. `pixelworld/bake.worker.js` is exported for copying the worker, and `pixelworld/style-pack.v1.schema.json` for editors (D-075).
  - **Workspace and tarball:** the package's `src/` re-exports the private workspace packages, which stay TypeScript sources without a build. In the workspace its `exports` point at `src/`, so the dev flow is unchanged; `publishConfig.exports` points the packed manifest at `dist/` (pnpm applies it, so publishing is with pnpm).
  - **The build (tsup over esbuild):** one ESM build of all six entry points with code splitting, so entry points share their common code and module state (one generator registry); the private packages bundled in, so the package has no dependencies; their declarations bundled per entry point, with shared declaration chunks. Not minified: consumers' bundlers minify. tsup was chosen over Vite's library mode (which rewrites `new URL(…)` into an expression bundlers can't follow) and over `tsc` (no bundling, and the private packages would have to be published).
  - **The bake worker:** a second build, one self-contained file, `dist/bake.worker.js`, in the same directory as the engine's chunk. The engine creates it with a literal `new Worker(new URL("./bake.worker.js", import.meta.url), { type: "module" })`: the build rewrites only the source's `./bake.worker.ts`, and checks the literal survived. Its syntax and names are minified, not its whitespace: esbuild drops comments with whitespace, and a dynamic `import(url)` (plugins) needs `/* webpackIgnore: true */`, or webpack turns it into a context module of `dist/` (tried: a warning, an extra chunk, and a failing import); the build fails on a dynamic import without it. Vite (dev and build), webpack 5 and plain ESM resolve it without configuration. Browsers start workers only from the page's origin, so for a CDN or other setups `createWorldView({ workerUrl })` loads it from elsewhere (a copy, or a `blob:` URL that imports it).
  - **Side effects:** only the worker's (`"sideEffects"`), so subpaths tree-shake.
  - **Sizes** (`pnpm package:size`, size-limit; gzipped, as a consumer bundles it): `createWorldView` 75 KB, with traffic 84 KB, all six entry points 96 KB (D3 estimated 89 KB; it grew with D-072, D-073 and D-075); `parseManifest` and `decodeChunk` 3 KB; `project` from `pixelworld/grid` 0.2 KB. The worker, as a bundler minifies it, is 129 KB, 46 KB gzipped (D3: 145 KB); as shipped, 196 KB, 61 KB gzipped. The tarball is about 600 KB, 2.2 MB unpacked, most of it source maps.
  - **Checks:** `pnpm package:check` (the tarball's files, manifest, exports, the worker literal, licences and size budgets), `pnpm package:size` (size-limit budgets) and `pnpm package:consumers` (Vite dev and build, webpack 5, plain ESM and a CDN, each from the tarball in headless Chromium, checking the worker baked). CI runs all three on every push.
  - **Versions:** changesets, for `pixelworld` only (the private packages aren't versioned). Releases are made by hand with `pnpm publish` ([npm.md §9](npm.md#9-releases)); CI holds no tokens.
- **PyPI:** one distribution, `pixelworld-pipeline`, the city packs' sources included (D-110); extras for heavy sources (`[lidar]`, `[cityjson]`) may come. It builds with `uv build` and is released by hand ([npm.md §9](npm.md#9-releases)); extras and a release job are later work.
- **The world format:** versioned on its own. The manifest carries the format version; readers accept older minor versions; conformance tests run both codecs over the same files.
- **Prebuilt worlds:** the San Francisco and Southwest packages as data releases (ODbL), with their attribution manifests.
- **Docs:**
  - an API reference (TypeDoc, pdoc). Built for the npm package: `pnpm docs:api` writes TypeDoc's reference of the six entry points to `docs/api/` (git-ignored);
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
5. **Generator registry (done, §8):** made public (`registerGenerators`, `listGenerators`, plugins). San Francisco's facades, towers and Chinatown moved to the city pack's plugin package, `@pixelworlds/city-sf`.
6. **Style schema:** a JSON Schema for style packs, and validation with useful errors. Packs become data packages.
   - **Done (D-075):** the schema (versioned, exported for editors), validation with paths and "did you mean", generator names checked when a view starts, `extends`.
   - **Not yet:** packs as data packages.
7. **Pipeline plugins:** source and facts adapters behind entry points. DataSF moves out as a plugin. A Python API (`pixelworld.build(spec)`) sits beside the CLI.
   - **Done:** the registry, facts sources, terrain and land-cover sources, DataSF as a city pack (merged back into the pipeline in D-110), and `pixelworld_pipeline.build(spec)` ([plugins.md](plugins.md)).
   - **Not yet:** Overture, canopy, lidar and transit as adapters; 3D city models; stage hooks.
8. **Builds and releases:** package builds, `exports`, changesets, and CI release jobs for npm and PyPI.
   - **Done for npm (§3.5):** the `pixelworld` package and the city packs, their builds, `exports`, changesets, a CI job that builds, packs and checks them on every push, and a release workflow that publishes them through npm trusted publishing (D-105).
   - **Not yet:** the style packs as packages, PyPI extras and a PyPI job.
9. **Export CLI:** generalized from the hero bake tool.
10. **Docs and examples:** the guides above, and an examples workspace that uses only the published packages.

## 5. M4, reframed

M4's features are built as controllers and plugins on the public API, which proves it:
- **The car controller:** on the road network and slopes, with collisions against occupied cells and traffic. It joins the traffic simulation's routes at junctions.
- **The plane controller:** on the flying level, with a drop shadow and terrain collision. Take-off and landing move between levels.
- **Occlusion silhouettes** for any entity a controller follows.
- **Building mode:** a controller plus the edits delta layer, with local re-bake.
- **Water palette cycling.**

**Built (M4, step 2):** the car and plane controllers, take-off and landing without a reload, and occlusion silhouettes, in the example game `apps/game` (§7.10, D-070). Joining traffic's routes at junctions is left: the car drives free on the drawn roads.

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
  - **npm names:** the package is the unscoped `pixelworld`. The `@pixelworlds` organization holds the city packs published from this repository (`@pixelworlds/city-sf`) and scopes the workspace's private packages (`@pixelworlds/engine`, `@pixelworlds/sim` and the rest), which are never published under those names. `@pixelworld` was taken.
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

- **`@pixelworlds/engine`** (`packages/engine`, one index, `src/index.ts`): `createWorldView`, `roverController`, `fogLayer`, `listenTo` and the types. It is built on `@pixelworlds/runtime` (chunk store, bake service and worker, tile cache, compositor, camera, fog fields), which stays internal: nothing in the engine's public types needs a runtime import.
- **`@pixelworlds/sim`**: the traffic simulation and its layer, `trafficLayer`. It imports the engine's types only, so the engine knows nothing of traffic. It becomes `pixelworld/traffic` when packaged.
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
  startTiles?: boolean | string | URL;               // the first view baked ahead (tools/prebake.mjs): true for start-tiles.bin in the package; default none
  objects?: boolean; scatter?: boolean; heroes?: boolean;
  palette?: "day" | "night";
  camera?: { x?: number; y?: number; h?: number; rotation?: number; zoom?: number | "auto" };
  layers?: Layer[];
  controller?: Controller;
  recordBakes?: boolean;                              // tile timings for the bench
  onError?: (message: string) => void;
  bakeWorkers?: number;                               // default the cores less one, at most 4
  workerUrl?: string | URL;                           // the bake worker from elsewhere (§3.5); default beside the engine
  plugins?: PluginDescriptor[] | ((names: string[]) => PluginDescriptor[]); // generator plugins (§8)
  replace?: WorldView;                                // take over from a view on the same canvas (M4, §7.9)
  lookAhead?: number;                                 // seconds of camera motion to bake ahead of (1.5; 0 off)
}

interface WorldView {
  canvas; world: WorldInfo; camera: ViewCamera; query: WorldQuery;
  entities: EntityList; layers: LayerRegistry; controllers: ControllerHost; pixelRatio: number;
  palette: "day" | "night"; hasNight: boolean;
  ready(): Promise<void>; invalidate(): void; resize(width, height): void;
  started: boolean; time: number; paused: boolean; timeScale: number; // game time (D-073)
  isDrawn(x, y): boolean; prefetch(x, y, radius?): Promise<void>;      // baking ahead (D-073)
  stats(): ViewStats; tileBakes(): TileBake[]; timeFrames(n): number;
  bakeObject(id): Promise<((BakedImage & { rotation }) | null)[]>; // the hero tool's bake
  onFrame(listener: (e: FrameEvent) => void): () => void;          // FrameEvent: the FrameClock, now, drawn
  serialize(): ViewState; restore(state: ViewState): void;         // camera, every layer's state, the controller's
  destroy(): void;
}

interface FrameClock { dt; realDt; time; started; paused }  // what controllers, layers and onFrame get

interface ViewCamera {
  x; y; h;                       // focus, cells and steps
  rotation: Rotation; zoom: number; autoZoom: boolean; internalWidth; internalHeight;
  setFocus(x, y, h): void;
  lookAt({ x, y, h? } | { lon, lat, h? }): Promise<boolean>;
  pan(dx, dy): void; rotate(±1): void; screenDirToGrid(dx, dy): [number, number];
  project(x, y, h?): { x, y, onScreen } | null;  // world → canvas CSS px, the inverse of query.pick (D-073)
}
```

- **Start-up:** load the package, style and bake worker; size the canvas; put the camera on the world's start; attach the controller (the rover puts the camera on itself); apply `camera` (a missing coordinate keeps where the controller put it); initialize the layers in order; then start the loop. No frame is drawn before the view is set up, so no tile is baked in the wrong place.
- **The loop** is the app's, unchanged: controller update, entity sprite requests, layer updates, tiles wanted, and a redraw only when something changed. It runs from the start, before `ready()`. `ready()` resolves once a frame is drawn with every visible tile and sprite and nothing in or around the view is left to bake (tiles baked ahead aren't waited for).
- **Game time (D-073):** the `dt` controllers, layers and `onFrame` listeners get is game seconds: the wall-clock time since the last frame (at most 0.1 s) × `timeScale`, and 0 until the view's first complete frame (`started`) and while it is `paused`. Their updates still run every frame, so a controller can keep the camera on something, and the `FrameClock` they get as well carries `realDt` (wall-clock), `time` (game seconds since the start), `started` and `paused`. A game that moves things by `dt` can't run ahead of the first frame, nor during a pause, and traffic, fog and entities stop with it; a game that also waits for its whole first view awaits `ready()`.
- **World → canvas:** `camera.project(x, y, h?)` is where a place is drawn, in CSS pixels from the canvas's top-left (`(render px − the view's origin) × zoom / pixelRatio`), with `onScreen`; without a height, on the ground (null where it isn't loaded). `pick(project(…))` is the place again: HUD labels, off-screen arrows, click targets.
- **Baking ahead (D-073):** each frame wants the visible tiles nearest first, then the tiles a view `lookAhead` seconds along the camera's motion would show (its velocity, eased over a quarter second; faster than 30 cells/s is a jump, not motion), then `prefetch` requests, then the ring around the view. `prefetch(x, y, radius?)` bakes the tiles within a radius (cells), or those a view centred there would show, and resolves once they are baked in the current rotation (or when the view is destroyed). `isDrawn(x, y)` says whether the ground under a place is baked, `stats().tilesPending` how many wanted tiles aren't.
- **Nothing over the void:** a sprite isn't drawn where the ground under it isn't baked yet: entities skip themselves, and layers get `frame.isDrawn(x, y)` (traffic skips such vehicles, still baking their sprites). A sprite whose bake failed is left out instead of holding up `ready()`.
- **Redraws:** a change through the public API (camera, entities, layers, palette) redraws and makes `ready()` wait. Setting the focus to where it already is doesn't, so a controller that follows something every frame leaves the loop idle.
- **Tile cache (D-072):** baked tiles are kept in IndexedDB (`cache`, on by default, in the dev servers too), keyed by the package, the style pack, the bake code's identity and the plugins. The identity (`BAKE_CODE`) is a hash of the code that bakes: the baker and its shaders, the built-in generators and the bake pipeline, set by the npm build and, in the apps, by `tools/bake-code.mjs`'s Vite plugin. A plugin counts by its name, `version` and code (its generators' source and its module's). An edit to any of that bakes afresh after a reload; an edit elsewhere (camera, compositor, app) keeps the cache. A build without the identity keeps no tiles.
- **Failures (D-072):** a model whose generator is missing, throws or returns no model is drawn as a small checkered marker in the pack's `marker` ramp, and the rest of its tile bakes. `onError` gets one message per generator and cause, naming the group, place, seed and footprint and, for a missing generator, the plugin it comes with; `stats().modelsFailed` counts the models. A tile with markers isn't kept in the cache. Loading errors (manifest, chunks, objects, routes, geo grid, heroes) are `WorldFetchError`s that name the URL and what was expected there: "not a world package: /foo/manifest.json returned an HTML page (expected a world manifest); check worldUrl (…)".

### 7.3 Layers

```ts
interface Layer {
  id; label; enabled; setEnabled(on): void;
  sublayers?: { id; label }[]; isSublayerEnabled?(id); setSublayerEnabled?(id, on);
  init(ctx: LayerContext): boolean | Promise<boolean>;      // false: nothing in this world, left out
  update?(dt, frame: FrameInfo, clock: FrameClock): boolean; // every frame while enabled, dt game time; true: redraw
  sprites?(frame): { list: SpriteDraw[]; complete: boolean };
  screenPass?(frame): ScreenPass | null;                     // fog's, today the one kind
  serialize?(): unknown; restore?(state): void; dispose?(): void; // dispose: the layer leaves its view
}
interface LayerContext { view; bakeSprite(rotation, boxes): Promise<Sprite | null>; releaseSprite(s); frame(): FrameInfo; invalidate(): void }
interface FrameInfo { rotation; focus: { x, y, h }; zoom; view: { left, top, width, height }; night; renderScale; project(x, y, h); isDrawn(x, y) }
view.layers: list(), get(id), add(layer), remove(id), enable(id, on?, sublayer?)
```

- **Order:** layers' sprites are drawn in the order the layers were added, then the entities'. A frame takes the first screen pass any layer offers.
- **One view at a time (D-073):** a layer may move to another view, as at a level switch. Adding it to a view takes it out of the view it is in (calling its `dispose`) before `init` with the new view's context, so the old view stops drawing it and destroying the old view later leaves it alone. `dispose` drops what belongs to the view (its sprites; bakes still in flight, which resolve null once that view is destroyed); `init` starts that state afresh. Traffic's layer keeps its switches and, until `init`, its simulation (`serialize` after leaving a view works); `init` starts a new simulation on the new world's routes (or the `routes` it was built with), and `restore` puts a saved one back.
- **`fogLayer({ enabled, time, paused })`** (engine): the style's atmosphere (D-063); left out where the style has no fog over the world and level.
- **`trafficLayer({ seed, density, enabled, paused, time, sublayers, routes })`** (sim): D-060; left out without routes. Sublayers road, rail and ferry. Its state is the simulation's JSON with its switches.

### 7.4 Entities

```ts
view.entities.add({
  model: { boxes: Box[]; key?: string } | { group: string; seed: number; size?; variant?; part? },
  x, y, h?,                 // cells, steps (default the ground)
  heading?, headings?,      // radians; baked headings (16)
  lift?, silhouette?, visible?,
  reveal?: { margin?, density? },  // see through what stands in front of it (D-079)
}): Entity                  // x, y, h, heading, visible, silhouette, reveal, moveTo(x, y, h?), remove()
```

- **Reveal** (D-079): for a player among tall buildings. Within `margin` render px of the entity's sprite (default 24), the world's pixels in front of it are dithered away (`density`, 0–1, default 0.75) over a second bake of the tiles around it with their buildings and landmarks left out (they still cast their shadows). The first visible entity with `reveal` counts; a view with none bakes nothing extra. The example game turns it on for its car and plane; the viewer doesn't.

- **Baking:** lazily, per view rotation and heading, shared by every entity with the same model. Heading 0 bakes the model as given, so the rover's sprite is the same as before.
- **Hidden entities** are baked too, so showing one is instant, but they don't hold up `ready()`. Nor does an entity whose ground isn't baked yet: it isn't drawn until its tile is (§7.2).
- **Group models** are style assets drawn by their generator at the object voxel scale. Vehicle generators need `size`.
- **Traffic keeps its own sprites:** it bakes each heading once, in rotation 0, for all four rotations (D-060). Entities bake per rotation, which keeps the rover pixel-identical. Folding traffic into entities, with the rotation-0 trick as an option, is left for later.

### 7.5 Controllers

```ts
interface Controller {
  id; attach(view: ControllerView): void | Promise<void>; detach?();
  update?(dt, clock: FrameClock);                           // every frame from the start; dt game time (§7.2)
  serialize?(): unknown; restore?(state): void;             // kept in view.serialize() under its id (D-073)
  keyDown?(e): boolean; keyUp?(e); pointerDown?(e); pointerMove?(e); pointerUp?(); blur?();
}
interface ControllerView { canvas; world; camera; entities; query; pixelRatio }   // a test can fake it
view.controllers.use(controller | null)                     // one at a time
listenTo(controller, { keys?: EventTarget; pointer?: EventTarget }): () => void
roverController({ start?: { x?, y? } | { lon, lat }, follow?, visible?, listen? }): RoverController
```

- **Input:** the app forwards events (the viewer does, since it keeps T, L, V, G, I, H and Esc), or the controller listens on targets it is given (`listen`, as the example does).
- **One view at a time (D-073):** a controller may move to another view with its state, as the player's does at a level switch. Using it in a view detaches it from the view it is in first, so the old view neither updates it nor detaches it again when it is destroyed.
- **Saved state:** `view.serialize()` keeps the controller's `serialize()` under its id (`ViewState.controller`), and `restore` hands it back to a controller with the same id, after the camera.
- **The rover controller:** the rover entity, `follow`, `noclip`, `place(x, y)`, and `serialize`/`restore` (its place and switches). Its keys are as before: arrows drive, WASD and drags pan, Q/E rotate, 1–6 zoom, F follows, N is no-clip.

### 7.6 Queries

```ts
view.query.heightAt(x, y)             // the drawn ground (steps), as the rover rides it
view.query.surfaceAt(x, y)            // { id, name, waterLevel }
view.query.roadAt(x, y)               // { classId, class, width, connections, lanes, oneWay, divided }
view.query.pick(screenX, screenY)     // { x, y, h, cellX, cellY } under a canvas point (CSS px)
view.query.lonLatToCell(lon, lat); view.query.cellToLonLat(x, y)   // through the geo grid (D-048)
view.query.elevationAt(x, y, h?); view.query.metersPerCellAt(x, y); view.query.ensure(x0, y0, x1, y1)
view.query.objectsAt(x, y)            // placed objects standing there: { group, id, x, y, bounds, footprint, base, top }[]
view.query.landmarks()                // registry landmarks, one per id: { id, group, x, y, parts }[]
```

- **Null where nothing is loaded:** `ensure` loads the terrain under a rectangle.
- **Road width:** the way's real width (D-050), else the style's for its class, as drawn.
- **`pick`** follows the view ray down through the loaded ground and water and refines the hit by bisection. It works before anything is drawn and reads nothing back from the GPU. Objects aren't picked: building tops would come from the depth the tiles write.
- **Occupancy (`objectsAt`, M4):** the objects the style draws, indexed in 8-cell buckets on first use. A footprint occupies its polygon (edges included). A registry landmark drawn from its anchor (City Hall, Coit Tower, the Strat) occupies where its model stands, in plan: the voxel columns of the model the bake generates for it (seed, height, quarter turns), worked out the first time a query comes within 16 cells (D-073); City Hall's wings now block, 5.6 × 7.9 cells, where its anchor's cell did. Where the model can't be generated on the page, and for any other object without a footprint (a tree, a prop), it is the anchor's cell. `base` is where it is built (its lowest footprint corner, or its own base); `top` is estimated as the bake draws it: a crest where it has one (dams, bridge decks), else `base + 2 · hm · stretch / m` (its real height at the object voxel scale, D-010, and the level's height stretch, D-047), or null where the world gives no height (trees, props, city blocks). Empty with `objects: false`. The game blocks its car on buildings and landmarks other than bridges, and crashes its plane into a tower's top.
- **Landmarks (`landmarks`, M4):** one entry per registry id at the middle of its parts' anchors, named by its largest part's group. Names are for people and stay in the registry (D-051); the game names them for its HUD.

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

- **Edits** (`view.edits`) and the export CLI (§3.4). Packaging is built (§3.5): the workspace packages stay private TypeScript sources, and `pixelworld` bundles them for npm.
- **Screen passes:** fog's is the one kind. A general pass (a layer's own shader) comes when a second layer needs one.
- **`pick`** ignores objects.
- **Traffic sprites** aren't entities yet (§7.4).
- **Level switching** still reloads the viewer's page; the game switches in place (§7.9). The viewer could do the same with `replace`.

### 7.9 Replacing a view on one canvas (M4)

Each scale level is its own world package (D-046), so moving between levels means a new view. A view built with `replace: oldView` on the same canvas takes over without a flash:

```ts
const next = await createWorldView({ canvas, worldUrl: flyingLevel, style, controller: plane, replace: view });
await next.ready();   // the old view kept the canvas until here, and is now destroyed
```

- **While it loads and bakes,** the old view keeps drawing (and its controller keeps running). The new view runs its loop (controller, layers, tile and sprite requests) but draws nothing, and its game time doesn't start (`dt` is 0) until it takes over.
- **Reusing layers and controllers:** a layer or controller passed to the new view moves to it when the new view is created (§7.3, §7.5): the old view stops drawing that layer and updating that controller (whose detach usually takes its entities with it), and destroying the old view leaves them alone. Sprite bakes the old view had in flight resolve null when it is destroyed, so nothing waits on them (D-073). For a switch where the old level stays whole until the new one shows, give the new view its own instances and carry their state over (`serialize`/`restore`), as the game does.
- **On its first complete frame** (every visible tile and sprite baked), it destroys the old view and draws, in the same animation frame. `ready()` resolves after that frame.
- **The canvas:** both views share its WebGL2 context; each compositor binds what it uses on every frame. A view resizes its canvas only when the size changes (assigning a canvas's size clears it, even to the size it has), so the new view's start-up doesn't blank the old view's frame.
- **`destroy()`** is idempotent; destroying a view still waiting to take over leaves the old view drawing (its owner keeps it, say after a failed load). It now also lets go of entity sprites and the compositor's own GPU objects (programs, frame targets, palette, fog pass), so swapping levels many times doesn't leak them. Traffic's layer releases its vehicle sprites when it leaves a view (`dispose`).
- **Cost:** two views' tiles are on the GPU for a moment (each within its own 192 MB budget), and two bake workers run while the new level bakes.

### 7.10 The example game (`apps/game`, M4)

`@pixelworlds/game` is M4's example client (D-070): a car on the driving levels, a plane on the flying levels, and take-off and landing between them, built only on `@pixelworlds/engine`, `@pixelworlds/sim` and the style packs (no runtime or engine internals). `pnpm --filter @pixelworlds/game dev` (port 5252).

- **Controllers:** `CarController` and `PlaneController` implement `Controller`: they own their entities (the style's `vehicle.car.player`, and `vehicle.plane` with its shadow, `part` 1), step pure physics (`car.ts`, `plane.ts`) against the world as the queries read it, and drive the camera. A script steps them with a fixed dt through `step(dt, input)` while `paused`.
- **What it reads:** `heightAt`, `surfaceAt` and `roadAt` for speeds and slopes; `objectsAt` for buildings and towers; traffic's `vehiclesNear` for collisions; the routes (`loadRoutes`, `RouteNetwork`) for the roads' graded surfaces and bridge decks, the autopilot's road plans and the minimap; `lonLatToCell`/`cellToLonLat` to carry a place and a heading between levels; `landmarks()` for place names.
- **Engine additions it needed:** `query.objectsAt` and `query.landmarks` (§7.6), `createWorldView({ replace })` (§7.9), and traffic's `vehiclesNear`. Everything else was already public.
- **Game time and labels (D-073):** P pauses the view's game time (`view.paused`): the vehicle, traffic and fog hold still together, and a level change keeps it. The HUD names the landmarks in view over them, placed with `camera.project` where `isDrawn`.
- **Also in `@pixelworlds/sim`:** `TrafficLayer.vehiclesNear(x, y, radius)` returns the shown vehicles' cars near a place with their size in plan (`modelSize`), for collisions; a switched-off layer or hidden sublayer has none.

## 8. As built: generator plugins (M4)

Refactor 5 of §4 and the browser half of D4: generators are found by name in a public registry, and a city's own generators come from a plugin. San Francisco's renders pixel for pixel as before, from the city pack. The details, and how to write and ship one, are in [plugins.md](plugins.md) §9 (D-071); the pack is packaged for npm as D-074 describes.

### 8.1 The registry

`@pixelworlds/generators`: `registerGenerators(record, { source, replace })`, `registerGenerator`, `hasGenerator`, `getGenerator`, `listGenerators` and `unregisterGenerators`. It starts with the built-ins (`builtins.ts`: everything every region uses) and holds what plugins add, one registry per realm (the main thread, each bake worker). A style asking for a generator that isn't registered fails that model's bake with a `MissingGeneratorError` naming the generator, the group and, for this repository's plugins, the plugin to load. A view checks every asset's generator once its plugins are registered, and doesn't start while one is missing, unless a plugin the style names wasn't loaded (D-075).

### 8.2 Plugins

```ts
// the plugin's worker module (packages/city-sf/src/worker.ts)
export default definePlugin({ name: "@pixelworlds/city-sf", register: (api) => api.registerGenerators(sfGenerators()) });

// a page
import { cityPlugin } from "@pixelworlds/city-sf";          // { name, url, version }: the worker module's URL
const view = await createWorldView({ canvas, worldUrl: "/sf/", style: bayArea, plugins: [cityPlugin] });
```

- **The bake worker** gets `loadPlugins` (names and module URLs) before `init`, imports each, registers it, and answers `pluginsLoaded`; messages meanwhile wait. `definePlugin` announces the plugin to the realm, so it is found even when a bundler drops the module's exports (Vite does for worker bundles) or bundles its own copy of the generators package.
- **The main thread** registers each plugin too (entity models, the inline baker), from the descriptor's `plugin` or by importing its URL. Without a view: `register()` from the pack, or `registerPlugin(plugin)`.
- **Style packs** name the plugins they need: `"plugins": ["@pixelworlds/city-sf"]` in the bay-area pack. `plugins` may be a function given those names, as the viewer passes; a named plugin that isn't loaded is a warning.
- **Packaged (D-074):** `@pixelworlds/city-sf` builds and packs like `pixelworld`: `dist/index.js` with types and `pixelworld` as a peer, the descriptor on `new URL("./worker.js", import.meta.url)`, and a self-contained `dist/worker.js`. The workspace keeps source exports. CI checks the tarball and draws San Francisco with both tarballs in Vite, webpack 5 and plain ESM. The viewer's city packs are listed in `apps/web/src/plugins.ts` ([plugins.md §9.7](plugins.md#97-the-viewers-city-packs)).
- **The tile cache key** includes the plugins: name, `version` and code (D-072); without plugins it has no plugin part.

### 8.3 What moved where

| From (`packages/generators`) | To |
|---|---|
| the generator table in `assets.ts` (`GENERATORS`, `LANDMARK_GENERATORS`, `damProfile`) | `builtins.ts`, read by the registry (`registry.ts`) on first use |
| `facades.ts` (`rowhouse`, its stucco rows, `block`), `towers.ts` (`decoTower`, `sfTower`), `chinatown.ts` (`gate`, `lanterns`), and their tests | `packages/city-sf` (`@pixelworlds/city-sf`) |

- **Stayed in core:** terrain, trees, rocks, city blocks, the generic building, dams, signs, the landmark kit's generic landmarks (bridges, halls, towers, the windmill, the lighthouse…), the rail props (`cableCar`, `streetcar`: generic vehicles the pipeline stands along any tram line, as the traffic models are) and the vehicle models.
- **The Southwest** names only built-in generators (a test checks), so its worlds need no plugin.
- **Bundles:** the city pack's worker module is 28 KB on its own (its generators and the voxel model class); the viewer's main bundle no longer carries San Francisco's generators, and the bake worker's carries only the built-ins.
