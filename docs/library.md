# pixelworld as a library (proposal, for discussion)

**Status:** a draft for the M4 pass. pixelworld is fully open source. This document proposes how it becomes a set of published packages that other projects can use:
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
- **The web app:** `apps/web/src/main.ts` (about 940 lines) holds the engine's assembly and the reference app's behaviour together:
  - world loading and level switching
  - the tile cache
  - the rover and its keys
  - the HUD and the layer panel
  - traffic and fog setup
  - the frame loop
  - the debug API
- **The pipeline (Python):** one package with a CLI (`pixelworld build|routes|heroes|serve`). Region specs select sources by name; sources, stages and San Francisco's facts (DataSF) are modules in the same package.
- **Contracts:** the world format is specified in prose (docs/world-format.md) with codecs on both sides; style packs are JSON without a schema.
- **No licence file yet.**

## 3. Target shape

### 3.1 Packages

| Package | Contents | Today |
|---|---|---|
| `@pixelworld/format` | the world package spec (manifest, chunks, objects, routes, optional layers); codecs; JSON Schemas; version policy | `world-format` |
| `@pixelworld/grid` | projection, rotations, cells, heights | `grid` |
| `@pixelworld/style` | the style pack schema, loader, palettes, night and atmosphere | `style` |
| `@pixelworld/generators` | the voxel model API, the generator registry, built-in generators (terrain, trees, buildings, landmarks, vehicles) | `generators` |
| `@pixelworld/bake` | the WebGL2 tile and sprite baker (worker) | `bake` |
| `@pixelworld/engine` | world view: streaming, camera, compositor, layers, entities, controllers, queries | `runtime` + most of `apps/web/main.ts` |
| `@pixelworld/traffic` | ambient traffic as a layer plugin (deterministic sim) | `sim` + `apps/web/traffic.ts` |
| `@pixelworld/style-desert-southwest`, `@pixelworld/style-bay-area` | style packs as data packages | `worlds/_styles/*` |
| `pixelworld` (PyPI) | the pipeline: CLI and a Python API, stages, source adapters, plugins | `pipeline/` |
| `@pixelworld/viewer` (app) | the reference viewer: rover, HUD, layer panel, level switching | `apps/web` |
| `@pixelworld/editor` (app) | the warp editor | `apps/editor` |

An umbrella package `pixelworld` could re-export the browser packages for people who want one dependency (decision D3).

### 3.2 The engine API, sketched

```ts
import { createWorldView } from "@pixelworld/engine";
import { trafficLayer } from "@pixelworld/traffic";
import bayArea from "@pixelworld/style-bay-area";

const view = await createWorldView({
  canvas,
  world: "https://example.org/worlds/sf/",   // a world package
  style: bayArea,
  layers: [trafficLayer({ density: 1 })],
});

view.camera.lookAt({ lon: -122.4194, lat: 37.7749 });
view.setRotation(1);
view.layers.get("traffic")?.setEnabled(false);

// a game adds its own entities and controllers
const car = view.entities.add({ model: { generator: "car", seed: 7 }, x: 120.5, y: 88.2 });
view.controllers.use(myCarController(car));   // owns input; moves the car and the camera

// queries for gameplay
view.query.heightAt(x, y);       // drawn surface height
view.query.roadAt(x, y);         // class, width, connections
view.query.pick(screenX, screenY); // cell under the pointer
```

The engine owns streaming, baking, compositing and the frame loop. It owns no input, rules or UI.

### 3.3 Extension points

| Extension | Interface | Registered by | Examples today |
|---|---|---|---|
| **Source adapters** (pipeline) | fetch and cache one kind of data for a box; return rasters or features in a common shape | Python entry points (`pixelworld.sources`), selected by name in the region spec | 3DEP, WorldCover, Overture, canopy, transit |
| **Facts sources** (pipeline) | per-building facts (year, storeys, use, neighbourhood) by location | entry points (`pixelworld.facts`) | DataSF |
| **3D city models** (pipeline) | footprints, heights and roof shapes from CityJSON or CityGML | entry points | none yet (M5's tier-1 regions) |
| **Generators** | `(ctx) => VoxelModel` for a semantic group | `registerGenerator(name, fn)`; a style pack maps groups to them | buildings, facades, towers, landmarks, trees, vehicles |
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
- **PyPI:** `pixelworld`, with extras for heavy sources (`[lidar]`, `[cityjson]`).
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

1. **Engine out of the app:** split `apps/web/main.ts` into `createWorldView` (engine) and the viewer app (rover, HUD, keys, panel, URL parameters). The `__pixelworld` debug API stays in the app, built on the engine's public API.
2. **Layer interface:** traffic and fog become plugins implementing it. The layer panel lists whatever layers a view has.
3. **Controller interface:** the rover becomes the first controller. Queries (`heightAt`, `roadAt`, `pick`) become public.
4. **Entities:** today's sprite paths (the rover, vehicles) unify into one entity API that bakes models per heading.
5. **Generator registry:** made public (`registerGenerator`). Region-specific generators (San Francisco's facades, towers and Chinatown) move to a plugin package, or stay built in with clear names.
6. **Style schema:** a JSON Schema for style packs, and validation with useful errors. Packs become data packages.
7. **Pipeline plugins:** source and facts adapters behind entry points. DataSF moves out as a plugin. A Python API (`pixelworld.build(spec)`) sits beside the CLI.
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

## 6. Decisions to discuss

- **D1, the primary consumer first:** web game developers embedding the engine, or other engines consuming exported assets? Both are in scope; the order sets M4's first steps. *Proposal:* the engine first (M4's gameplay needs it), with the export CLI shortly after.
- **D2, code licence:** Apache-2.0 or MIT? *Proposal:* Apache-2.0.
- **D3, packaging:** many scoped packages, one umbrella package with subpath exports, or both? *Proposal:* scoped packages plus a thin umbrella.
- **D4, region-specific code:** San Francisco's facades, towers, Chinatown and DataSF become plugins, or stay built in? *Proposal:* plugins, as the template for a city pack (style pack, generators and facts source together).
- **D5, the renderer:** WebGL2 only (WebGPU later), or also an adapter that hands baked tiles to Three.js, Pixi or Phaser? *Proposal:* our compositor only for now; the export path covers other engines.
- **D6, prebuilt worlds:** publish the San Francisco and Southwest packages as ODbL data releases now, or wait until the format is declared stable (1.0)?
