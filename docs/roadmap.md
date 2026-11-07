# Roadmap

Status: living document. Milestones are ordered and each has exit criteria. The technology tracks show how each part of the stack grows across milestones. Architecture details are in [architecture.md](architecture.md).

## 1. Technology choices

| Area | Choice | Notes |
|---|---|---|
| Client language | TypeScript (strict) | Shared by player app, editor and offline baker. |
| Monorepo / build | pnpm workspaces + Vite | |
| Bake renderer | Raw WebGL2 with the integer projection in the vertex shader (D-019) | WebGL2 is the baseline because it runs headless in CI via SwiftShader. Three.js is reserved for the later live 3D mode. |
| Runtime compositor | Small custom WebGL2 renderer | Draws indexed + depth quads, applies the palette LUT, upscales by integer factors. |
| Background baking | Web workers with OffscreenCanvas + WebGL2 | |
| Client cache | Memory, plus IndexedDB / OPFS | Keyed by chunk hash + rotation + style version. |
| Gameplay physics | Custom grid-aware kinematics | Rapier gets evaluated if and when full 3D mode needs it. |
| Geo pipeline | Python 3.12+, managed with uv | numpy, rasterio/GDAL, pyproj, shapely 2, geopandas, pyosmium, DuckDB (spatial) for Overture GeoParquet, PDAL/laspy for lidar, cjio/lxml for CityJSON/CityGML, scipy.sparse for the warp solver. |
| Editor ↔ pipeline | Local FastAPI server | Wraps pipeline stages for interactive re-solve and re-export. |
| Offline baking | Playwright + headless Chromium (`tools/bake-cli`) | Same bake code as the client. |
| Art tools | Aseprite (indexed palettes, paint-over), MagicaVoxel (`.vox` hero assets) | |
| Tests | Vitest, pytest, Playwright golden images | |
| Hosting | Static files on a CDN | Possibly one archive read with HTTP range requests. |

## 2. Milestones

### M0: Grid and bake slice — done

**Goal:** prove the look and the grid on one hardcoded piece of the Grand Canyon, before investing in data.

- Monorepo scaffold, CI (lint, typecheck, tests).
- `packages/grid`: projection constants, 4 rotations, cell model (RCT-style base height + slope + cliffs).
- DEM fixture: a small excerpt, about 128×128 cells, committed with attribution, converted to cells by a throwaway script.
- `packages/generators`: terrain mesh with top, slope and cliff faces, plus elevation-band strata materials.
- `packages/bake`: raster passes, palette composite, outline and cleanup passes, indexed + depth output, run in a worker.
- `packages/runtime`: compositor, pixel-snapped camera, integer zoom, rotation, and a placeholder sprite drawn with per-pixel depth and a silhouette when hidden.
- First style reference sheet: palette, ramps, outline rules.
- `docs/world-format.md` v0, plus TS/Python codecs with golden files.

**Exit criteria:**
- At 1× zoom, screenshots pass review against the style sheet: clean staircases, no stray pixels, consistent ramps.
- Scrolling doesn't shimmer, and all 4 rotations work.
- The sprite hides correctly behind cliffs.
- Bake time per tile has been measured on desktop and on a phone, and budgets are recorded.

#### M0 results

![M0 overview, rotation 0 at 1×](images/m0-overview-r0.png)

| Exit criterion | Result |
|---|---|
| Screenshots pass review at 1× against the style sheet | Done. Reviewed over several iterations (outline threshold, AO dead zone, terrain smoothing); see [style-guide.md](style-guide.md). |
| No shimmer while scrolling | Verified by an e2e test: a ¼-pixel pan at 4× shifts the output by exactly one device pixel. |
| All 4 rotations work | Verified: an e2e test finds zero holes or seams in every rotation. |
| Sprite hides correctly behind cliffs | Verified: the e2e test finds the silhouette when the rover is hidden and none when it's in the open. |
| Bake time measured on desktop and phone | **Partly.** Measured only on software rendering (SwiftShader, headless): about 45 ms mesh generation in JS (about 53k vertices for a tile plus margin) + 105 ms bake per 32×32 tile, max 235 ms; compositing ran at about 30 fps at 1280×720. No GPU desktop or phone has been measured yet. |

**Proposed budgets** (to confirm on real hardware):
- ≤ 50 ms per tile on a desktop GPU and ≤ 150 ms on a recent phone.
- Compositing at 60 fps on both.

If phones miss the bake budget, the first step is profiling mesh generation (per-vertex AO sampling is a likely cost). After that, try smaller tiles or a smaller context margin.


### M1: Real region at uniform scale

**Goal:** the Southwest region from real data, end to end, without warping.

- `pipeline` CLI for fetch, normalize, semantics (terrain, water, land cover, roads), gridify and export.
- Region spec format (`worlds/southwest/region.yaml`).
- Road snapping to 8 directions with cut-and-fill.
- Chunk streaming and persistent cache in the client.
- Attribution screen built from the manifest.

**Exit criteria:**
- The whole region is explorable at one uniform scale.
- Re-running the pipeline produces an identical package hash.
- Roads stay connected and drivable after snapping.

### M2: Elastic map and editor v0

**Goal:** demonstrate the core idea: Las Vegas, Hoover Dam and the Grand Canyon within a short drive.

- `importance` stage: Wikidata, pageviews and OSM tags combined with focus areas into a scale field.
- Warp v1 (separable), then v2 (mesh solve with pins and a fold check).
- Rigid stamping of landmark anchors.
- Vertical exaggeration and per-feature caricature.
- `apps/editor`: scale brush, pins, re-solve through the local pipeline server, live preview.

**Exit criteria:**
- The warp has no folds.
- Roads and rivers stay continuous and recognizable.
- Each focus area hits its target scale within tolerance.
- An editor change shows up in the preview within seconds for the affected area.

### M3: Components and landmarks

**Goal:** the world looks inhabited and the landmarks read instantly.

- Building generator (massing, roofs, facades) and the `desert-southwest` style pack.
- 3DEP lidar heights and canopy data integrated.
- Vegetation and props, with gameplay-relevant ones placed by the pipeline and decorative scatter added by the client.
- Landmark registry with depiction variants, and generic signage by default.
- First 3 hero landmarks, baked offline and painted over.

**Exit criteria:**
- The Strip, Hoover Dam and the canyon rim are recognizable in blind screenshots.
- Generated buildings match the style sheet.
- Painted-over overrides survive a full re-bake.

### M4: Drive, fly, build

**Goal:** make the world playable.

- Car on the road network and terrain slopes, with grid collision.
- Plane with an arcade flight model, drop shadow and canyon collision.
- Occlusion silhouettes.
- Speeds tuned to the compressed layout.
- Grid building mode (place and remove) with local re-bake.
- Palette LUT variants (day/night) and water palette cycling.

**Exit criteria:**
- A complete Vegas → Hoover Dam → Grand Canyon run by car, then a canyon flight, at 60 fps on desktop.
- A placed building appears immediately and persists.

### M5: Scale out

**Goal:** prove the system generalizes beyond one region.

- Zoom-level (semantic LOD) bakes: blocks → city silhouettes → landmark icons.
- A second region from coverage tier 1 (open 3D city models, e.g. NYC, a Dutch city or a PLATEAU city), with CityJSON/CityGML ingestion.
- A second style pack.
- CDN hosting with archive range requests.
- Performance budgets met on mid-range phones.

**Exit criteria:**
- The second region is built with no code changes beyond new ingest adapters and its style pack.
- Mobile hits its budgets.

### Later (exploratory)

- Full 3D mode: a live chase camera on the same scene, materials and palette.
- WebGPU backend.
- Multiplayer: keep the simulation deterministic and its state serializable from M4 onward so this stays possible.
- Linking regions and traveling between them.
- Seasons.
- Imagery segmentation to fill feature gaps.
- Roof fitting from lidar.

## 3. Technology tracks

| Track | M0–M1 | M2–M3 | M4–M5 | Later |
|---|---|---|---|---|
| **Grid and world format** | projection, rotations, cell model; format v0 + codecs | instances, landmark stamps, overrides in the format | player-edit delta layer; LOD levels in the manifest | region linking |
| **Rendering and bake** | client bake (WebGL2 worker), palette composite, cleanup, compositor | building/landmark bakes, offline bake CLI, paint-over pipeline | palette LUT variants, palette cycling, semantic LOD bakes | WebGPU; full 3D mode |
| **Geo pipeline and semantics** | fetch → export at uniform scale; DEM, OSM, NLCD/WorldCover, NHD | importance stage; 3DEP lidar heights; canopy | CityJSON/CityGML adapters (tier 1); second region | imagery segmentation; lidar roof fitting |
| **Elastic map** | none (uniform) | v1 separable → v2 mesh solve, pins, fold check, caricature | tuning for multi-focus regions | automatic pin suggestions |
| **Content generation** | terrain + strata materials | buildings, roads, vegetation, landmark DSL / `.vox`, style pack #1 | style pack #2, LOD representations | landmark DSL drafts with LLM assistance |
| **Editor and tooling** | — (spec files by hand) | editor v0: scale brush, pins, preview; local pipeline server | override editing, landmark placement, depiction variant switch | collaborative editing |
| **Gameplay and simulation** | placeholder sprite with depth | — | vehicles, flight, grid building | multiplayer; full 3D physics (Rapier) |
| **Platform** | monorepo, CI, golden-image tests, persistent cache | reproducibility checks, package hashing | CDN hosting, range-request archive, mobile performance | — |

## 4. Risks

| Risk | Mitigation |
|---|---|
| Procedural bakes don't look hand-made | M0 is dedicated to the look; style reference sheet; cleanup passes; paint-over for hero assets |
| Client baking too slow on phones | Measure in M0; prioritize visible tiles; smaller bake tiles; serve pre-baked tiles from the CDN for busy areas |
| GPU rasterization differs across devices | Compare palette indices with tolerance in tests; hero assets are baked offline only |
| Warp distorts or folds | Shape-preserving solver, fold check, editor pins; v1 separable as a fallback |
| Thin data outside the US / Europe / Japan | Prefer tier 1–2 regions first; procedural fallbacks for every layer |
| Licensing or depiction problems | Rules in [data-sources.md](data-sources.md), attribution manifest, depiction variants, generic signage, legal review before commercial launch |
| Scope creep | Curated regions only; milestone exit criteria |

## 5. Open questions

The current defaults are in parentheses.

1. **Multiplayer:** single-player through M5, but keep the simulation deterministic so it stays possible.
2. **Hand-authoring budget:** about 10–20 hero landmarks per region.
3. **Second region:** a tier-1 city with open 3D city models.
4. **Target devices:** desktop and modern mobile browsers; WebGL2 required.
5. **Commercial intent and timeline:** affects when legal review happens and which depiction variants are the defaults.
6. **Grid building:** core gameplay loop or sandbox tool?
