# Decision log

Lightweight architecture decision records. Add entries; don't rewrite history. If a decision is reversed, mark it **Superseded by D-xxx** and add a new entry.

Status values:
- **Accepted:** agreed in discussion.
- **Proposed:** the current default, pending confirmation or an M0 experiment.
- **Superseded:** replaced by a later decision.

| ID | Decision | Status |
|---|---|---|
| D-001 | Curated regions, not the whole planet | Accepted |
| D-002 | Offline geo pipeline producing a static world package; the browser renders | Accepted |
| D-003 | 3D world model; baked isometric pixel art is the canonical view; full 3D later | Accepted |
| D-004 | Everything snaps to one cell grid | Accepted |
| D-005 | Bake with raster passes + cleanup; paint over hero assets; bake depth | Accepted |
| D-006 | Open data only; no Google / Mapbox / Esri / Bing content | Accepted |
| D-007 | Elastic terrain, rigid landmarks | Accepted |
| D-008 | Facts → rules → overrides, deterministic and seeded | Accepted |
| D-009 | Pipeline decides what and where; client generators decide how it looks | Proposed |
| D-010 | Three independent scales: layout, object, vertical | Proposed |
| D-011 | Integer projection: 32×16 px cell, 8 px height step | Proposed (validated in M0 review) |
| D-012 | Bake indexed color + depth; palette LUT applied at runtime | Proposed |
| D-013 | Client bakes generated content; hero assets are baked offline | Accepted |
| D-014 | WebGL2 baseline; Three.js for bake scenes; custom compositor | Superseded by D-019 |
| D-015 | Custom grid kinematics for gameplay; physics engine deferred | Proposed |
| D-016 | Python geo pipeline, TypeScript client | Accepted |
| D-017 | Depiction variants for compliance; generic signage by default | Accepted |
| D-018 | First region: US Southwest (Las Vegas, Hoover Dam, Grand Canyon) | Proposed |
| D-019 | Raw WebGL2 for baking and compositing; Three.js only for the later 3D mode | Proposed (M0) |
| D-020 | Terrain quantization: bilateral smoothing + flat terraces for steep cells | Proposed (M0) |
| D-021 | Bake tiles of 32×32 cells with a 16-cell context margin; ownership per cell | Proposed (M0) |
| D-022 | Vertical scale set as exaggeration relative to true proportions, applied before quantization; fixture default 2.5× | Proposed |
| D-023 | Multi-step slope tiles: corners 0–3 steps above base (chunk format v1), pipeline cap default 2 | Proposed |
| D-024 | M1 base scale 400 m per cell; region packages committed as gzipped chunks | Proposed (M1) |
| D-025 | Vectors from pinned Overture releases via bbox-pruned GeoParquet range reads; land cover from ESA WorldCover | Proposed (M1) |
| D-026 | Roads: 8-direction snapping with corner-crossing bits; cut-and-fill on the shared corner-height field | Proposed (M1) |
| D-027 | Geology provinces select strata sets per cell | Proposed (M1) |
| D-028 | Client streams chunks and caches baked tiles in IndexedDB, keyed by package hash, style hash and bake version | Proposed (M1) |
| D-029 | Pixel-resolution visuals decoupled from the gameplay grid: micro-terrain (M1.6) plus an object layer | Accepted |
| D-030 | Objects come from semantic asset groups; procedural generators first, hand-drawn assets supported per group | Accepted |
| D-031 | Order of work: pixel experiment → micro-terrain → M2 → detail pass | Accepted |

---

### D-001: Curated regions, not the whole planet
A world is a set of regions, each continuous inside. Curation (focus areas, landmarks, overrides) can't scale to the whole planet, and quality depends on it. Regions may be linked later.

### D-002: Offline pipeline, static world package
Geo processing is heavy, and the warp needs to see the whole region at once. The pipeline bakes a chunked world package that is served as static files. The browser streams it and renders.

### D-003: 3D model, isometric output
Live "3D + pixel filter" rendering looks inconsistent: sub-pixel camera positions, geometry at arbitrary angles to the pixel grid, and no time for cleanup. Fixed isometric views baked from a 3D model are crisp and consistent. The same model allows a live 3D mode later (e.g. a flight chase cam) as an optional, non-canonical view.

### D-004: Grid snapping
All terrain, networks, buildings and gameplay snap to a cell grid with RCT-style terrain (base height + slope + cliffs) and 8 directions. Edges land on exact pixel staircases or straight screen lines, and grid gameplay (building, grid movement) becomes possible.

### D-005: Bake and cleanup strategy
Bakes render material ID, normal, depth, shadow and ambient-occlusion passes, then composite to palette ramps. Off-grid shapes are downsampled by majority vote on material ID. Cleanup passes remove stray pixels, apply outline rules and straighten line runs. Hero assets can be painted over. Baked depth gives per-pixel occlusion for dynamic sprites.

### D-006: Open data only
Google Maps Platform Terms §3.2.3 explicitly prohibit tracing, 3D modeling, terrain modeling and ML training from Google content, and using it near non-Google maps. Mapbox, Esri and Bing allow tracing only for OSM contributions. We use open sources; see [data-sources.md](data-sources.md).

### D-007: Elastic terrain, rigid landmarks
The map warp moves things but never resizes landmarks. Landmarks are stamped at their own (often exaggerated) scale, as illustrated tourist maps do.

### D-008: Facts → rules → overrides
Everything visible is `f(facts, rules, overrides, seed)`. Overrides are keyed by stable feature IDs with geo anchors, so they survive re-bakes.

### D-009: Pipeline/client split (proposed)
The pipeline emits semantic instances (footprint, height, roof, style, seed). Generators that turn these into geometry run in TypeScript on the client. This keeps chunks small, lets the art style change without re-running the geo pipeline, and lets player edits re-bake locally.

### D-010: Three scales (proposed)
- **Layout scale** (meters per cell) comes from the warp and varies.
- **Object scale** (sizes of cars, roads, floors) is fixed game-wide.
- **Vertical scale** (meters per step) is set per region, with caricature.

Real buildings take more or fewer cells depending on the local layout scale and are merged or dropped below the minimum footprint.

### D-011: Projection constants (proposed)
A cell is a 32×16 px diamond and a height step is 8 px: `sx = 16(x−y)`, `sy = 8(x+y) − 8h`. This equals an orthographic camera at 45° yaw and 30° pitch when one step is 1/√6 cell in true 3D, so lighting uses true geometry. To be confirmed by the M0 style review.

### D-012: Indexed color bakes (proposed)
Bakes store u8 palette indices plus u16 depth. A runtime LUT maps indices to RGB, enabling day/night, seasons, style variants and palette cycling at almost no cost. Artists paint over in indexed mode.

### D-013: Where baking happens
Terrain and generated content are baked on the client, in workers, as chunks stream in, and cached. Pre-baking whole regions at 4 rotations would be gigapixels. Hero assets, building kits and vehicle sprite sheets are baked offline with the same code in headless Chromium, and can be painted over.

### D-014: Rendering technology (superseded by D-019)
WebGL2 is the baseline: universal support, and headless CI baking via SwiftShader. Three.js builds the bake scenes, with our own shaders and multiple render targets. A small custom WebGL2 compositor does the runtime work. WebGPU comes later.

### D-015: Gameplay physics (proposed)
On a grid world, vehicles and flight use custom kinematic controllers against cell heights and occupants. These are simpler, deterministic, and good for future multiplayer. Rapier is reconsidered when full 3D mode needs it.

### D-016: Languages
The geo pipeline is in Python, for its mature geospatial libraries. The client, editor and offline baker are in TypeScript. They share a versioned binary world format, kept in sync by golden test files.

### D-017: Depiction variants
Landmarks have canonical, stylized and generic variants, chosen per release target for IP and jurisdiction reasons. Real brand names and logos are not shown on buildings by default.

### D-018: First region (proposed)
The US Southwest: dramatic elevation, a few unmistakable landmarks, low building counts, coverage tier 2 data (lidar + NAIP + OSM). It shows off both driving and flying.

### D-019: Raw WebGL2 for baking and compositing (proposed, M0)
Supersedes D-014. The bake projection is a fixed integer formula (`sx = 16(x−y)`, `sy = 8(x+y) − 8h`), written directly in the vertex shader. A camera library would only add floating-point round trips. The baker also needs precise control of render targets, depth textures and shadow maps. Building on raw WebGL2 kept the baker small (about 750 lines, shaders included), exact, and runnable headless via SwiftShader. Three.js stays the plan for the later live 3D mode, where it can consume the same generator meshes.

### D-020: Terrain quantization (proposed, M0)
Corner heights are bilateral-filtered (1.5 cells spatial, 1.2 steps range) before quantizing. Steep cells become flat terraces at their mean height. In the M0 review, Gaussian smoothing and "slope-clamped" steep cells were tried and rejected. Both turned canyon walls into sawtooth triangle facets, while flat terraces read as the canyon's stepped buttes. See [style-guide.md](style-guide.md) §8.

### D-021: Bake tiling and ownership (proposed, M0)
- **Tiles:** clients bake 32×32-cell tiles per rotation. Each bake renders the tile plus a 16-cell margin of context, so shadows, AO and outlines cross tile seams correctly.
- **Ownership:** every face carries its owning cell. Pixels whose front-most surface belongs to another tile are left empty and filled by that tile.
- **Compositing:** the runtime composites tiles with per-pixel depth, so draw order never matters. An e2e test checks that all 4 rotations are hole-free.

### D-022: Vertical exaggeration (proposed)
- **What it is:** one factor E that multiplies every height difference, expressed relative to true proportions (E = 1 means real slopes, the usual cartographic sense). Metres per step are derived from it: `metersPerCell × (1/√6) / E`.
- **Why it's set in the pipeline:** steps are integers, so exaggeration has to happen before quantization, not at render time.
- **Why it's relative to true proportions:** that keeps it meaningful when the warp makes metres per cell vary (M2).
- **What stays in real metres:** smoothing, surface classification and strata colours, so changing E changes only height.
- **Default:** 2.5×, chosen from a visual comparison of 1.63×, 2.5×, 3.5× and 5× (see [style-guide.md](style-guide.md) §8).
- **Manifest and safety:** the manifest records `verticalExaggeration`. The baker warns if a tile's depth span overflows its 16-bit local range, which only happens at exaggerations well above 10.

### D-023: Multi-step slope tiles (proposed)
- **What changed:** cells now store each corner's height above the base, 0–3 steps (two bits per corner, chunk format v1), instead of a one-step slope mask. Neighbours share corners, so slopes up to the cap are continuous instead of becoming terraces.
- **Cap:** the pipeline caps the rise per cell with `max_slope`; anything steeper still becomes terrace plus cliff (D-020).
- **Why at most 3:** rising edges stay on clean pixel angles.
- **Default:** 2, chosen from a visual comparison of 1, 2 and 3 at 2.5× exaggeration (see [style-guide.md](style-guide.md) §8). With `max_slope` 1, the pipeline produces exactly the previous terrain.
- **Compatibility:** readers still accept v0 chunks.
- **Gameplay:** the rover now has a grade limit (2 steps per cell travelled) rather than a fixed climb height, so steep slope tiles block it like cliffs do.

### D-024: Base scale and committed packages (proposed, M1)
- **Scale:** M1 builds the Southwest at a uniform 400 m per cell, the "base" scale from the architecture's region example. M2's warp will enlarge focus areas.
- **Committing packages:** at this scale the package is 187 deterministic-gzip chunks (about 1 MB), so it's committed under `fixtures/southwest/`. The app and CI then work without running the pipeline.
- **When to revisit:** for larger regions, packages move to release assets or a CDN.

### D-025: Data access (proposed, M1)
- **Vectors:** roads and rivers come from Overture, an OSM-derived dataset under the ODbL, with the release pinned in the region spec. Each GeoParquet file's row-group bounding boxes are indexed once from its footer and cached. After that, only intersecting row groups and columns are downloaded (about 20 s for the Southwest). This gives reproducible inputs without downloading OSM extracts.
- **Rasters:** elevation and land cover are read from COG overviews at roughly the target resolution.
- **Land cover:** ESA WorldCover is the M1 source because it's global. NLCD remains an option for US-only detail.

### D-026: Roads on the grid (proposed, M1)
- **Snapping:** polylines become thin 8-connected cell paths, with staircase corners replaced by diagonal moves. Cells store connection bits for 8 directions, plus 4 bits for diagonal roads crossing their corners, so road strips are drawn without notches.
- **Cut-and-fill:**
  1. Road heights are smoothed along the network.
  2. They're relaxed until connected cells differ by at most 1 step.
  3. They're written into the shared corner field before gridify.

  Connected road cells therefore always meet without cliffs. The build validates this and fails if it doesn't hold.
- **Known gap:** dual carriageways (see the M1 results).

### D-027: Geology provinces (proposed, M1)
- **Mechanism:** a per-cell `GEOL` layer, from polygons in the region spec, picks the strata set used for rock and cliffs.
- **Why:** it keeps the Grand Canyon bands on the Colorado Plateau and gives basin-and-range mountains their own palette.
- **Next step:** polygons are hand-drawn for now; a geologic map could replace them later.

### D-028: Streaming and the tile cache (proposed, M1)
- **Streaming:** the client fetches chunks around the view and gives the worker per-tile slices.
- **Cache:** baked tiles persist in IndexedDB, gzip-compressed and pruned least-recently-used. Keys include the package hash, a hash of the style pack and `BAKE_VERSION`, so stale tiles are never shown after a change; bump `BAKE_VERSION` whenever bake output changes for the same inputs.
- **GPU memory:** tile textures stay on the GPU up to a 192 MB budget.

### D-029: Pixel-resolution visuals (accepted)
The coarse look has two causes: one height per cell, and no objects. Visuals get pixel-level detail on top of the gameplay grid, which stays the unit for roads, placement, collision and chunks:
- **micro-terrain:** a K×K grid of fine heights per cell (M1.6)
- **an object layer:** vegetation, buildings, landmarks and life (M3)

The point is more room for visual interest; both halves are wanted.

### D-030: Semantic asset groups (accepted)
- **Groups:** objects are named by semantic group (`tree.conifer`, `building.tower.brutalist`, `building.residential.colonial`, `tree.coastal-cypress`, …). The pipeline decides which group goes where from data.
- **Sources:** a style pack maps each group to an asset source, either a procedural generator with parameters or hand-authored assets (sprites or voxel models). Generators come first; hand-drawn assets can replace or add variants to any group later.
- **Growth:** new groups are added as regions need them.

### D-031: Order of work (accepted)
- **Sequence:** the M1.5 pixel detail experiment comes first, to choose the look, then M1.6 micro-terrain, then the M2 elastic map, then the M3 detail pass.
- **Why:** micro-terrain and the warp change the canvas the detail pass draws on.

### D-032: Render scale for fine worlds (proposed, M1.5)
- **What:** a manifest can set `render.scale` < 1. The worker scales mesh positions to render units, so a cell covers fewer pixels; the camera, tile rects and depth range work in render units.
- **What stays in world units:** road decals, ownership and shadow lookups. Road widths and the field and block patterns are in render units, so they keep their pixel size.
- **Scope:** an experiment tool that emulates micro-terrain with ordinary cells. M1.6 replaces it with micro-heights inside normal cells.

### D-033: Object pixel scale (proposed, M1.5)
- **Fixed pixel size:** one voxel is a 2×1 px top and 1 px tall at native zoom, whatever the map scale (`objectVoxelScale`). At the 160 m/cell layout a voxel is 10 m across.
- **Heights:** depicted height in voxels is `metres × heightStretch ÷ voxel metres`, with `heightStretch` 2.5 in the style pack. Footprints come from data and sit on their lowest corner.
- **Landmarks:** a landmark's depicted height can exceed its real one when that's what makes it read (the Desert View watchtower is drawn at 80 m, about ×4).
- **Outlines:** the depth threshold is 2 world cells, i.e. 2 × render scale in render units.

### D-034: Objects in the world package (proposed, M1.5)
- **File:** `objects.json.gz` lists instances: semantic group, position in cells, seed, optional quarter-turn, footprint and height. It is hashed into the manifest.
- **Placement:** the pipeline places objects from rules in the region spec: land-cover scatter, street trees by road class and name, Overture buildings, and landmarks. Placement works in metres, with seeds that don't depend on cell size, so variants of an area get the same objects.
- **Drawing:** the client builds objects from the style pack's catalog (D-030). Repeated objects are instanced per variant (6 per group); unique objects such as buildings and landmarks are merged into one mesh.
- **Classification:**
  - A building becomes a tower at 45 m or more.
  - A building with parts becomes a podium, capped at 15–18 m, with its parts on top.
  - In the city, unclassified footprints under 350 m² count as houses.

### D-035: Night palette by palette swap (proposed, M1.5)
- **Mechanism:** a style pack's `night` section dims and blue-shifts every ramp (saturation, then a multiplier and offset per channel) and replaces emissive ramps with glowing colours. Indices don't change, so night needs no re-bake.
- **Lit windows:** windows that are lit use their own ramp (`lit`, `lit-cool`), identical to glass by day, so each building has a fixed set of lit windows. Neon trim uses emissive ramps too.

### D-036: Fine-terrain rules (proposed, M1.5)
- **Steep ground:** with fine cells, every cell steeper than 0.6 rise over run is bare rock, whatever its land cover.
- **Water:** water bodies smaller than an area threshold, or whose ground spans more than a few metres (canyon shadows that WorldCover reads as water), are dropped.
- **Rivers:** they are buffered to their real width.
- **Scope:** these are region-spec options (`terrain:`), so coarse worlds keep their M1 rules and their package hashes.

### D-037: Micro-terrain resolution (open, M1.5)
- **Candidates:** K=4 (8×4 px micro-cells, 2 px height steps) or K=8 (4×2 px, 1 px steps).
- **Recommendation:** K=4. Its ledges form clean 2 px clusters, and it needs about a quarter of K=8's data and a third of its meshing time. K=8's 1 px treads read as hatching on steep walls.
- **To decide:** the user picks the look from the M1.5 comparisons; M1.6 builds to that choice.

