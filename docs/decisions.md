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
| D-032 | Render scale for fine worlds | Proposed (M1.5) |
| D-033 | Object pixel scale | Proposed (M1.5) |
| D-034 | Objects in the world package | Proposed (M1.5) |
| D-035 | Night palette by palette swap | Proposed (M1.5) |
| D-036 | Fine-terrain rules | Proposed (M1.5) |
| D-037 | Micro-terrain resolution | Accepted (M1.5) |
| D-038 | Micro-terrain storage | Accepted (M1.6) |
| D-039 | Micro-terrain on the GPU | Accepted (M1.6) |
| D-040 | Elastic map solver | Accepted (M2) |
| D-041 | Vertical caricature keeps proportions | Accepted (M2) |
| D-042 | Importance from Wikidata sitelinks | Accepted (M2) |
| D-043 | Editor v0 architecture | Accepted (M2) |
| D-044 | Neighbouring road cells share one level | Accepted (M2) |
| D-045 | Warped land cover is sampled 3×3 per cell | Accepted (M2) |
| D-046 | Scale levels are separate world packages | Accepted |
| D-047 | Depiction scale and selection | Accepted |
| D-048 | Geo grid for moving between levels | Accepted |
| D-049 | Snap roads and buildings to the 8 grid directions | Accepted |
| D-050 | Roads and paths at their real width | Accepted |
| D-051 | A landmark registry with generic depictions by default | Accepted (M3) |
| D-052 | Building heights and towers from 3DEP lidar | Accepted (M3) |
| D-053 | Hero landmarks are baked offline and painted over | Accepted (M3) |
| D-054 | Decorative scatter is the client's, gameplay objects the pipeline's | Accepted (M3) |
| D-055 | Building typologies from geometry, streets and public records | Accepted |
| D-056 | Long landmarks: per-column ownership, a fixed base, snapped with their road | Accepted |
| D-057 | Objects file version 2, footprints relative to their anchor | Accepted |
| D-058 | Ways that graze the world's edge stay in one piece | Accepted |
| D-059 | Not used: the number was skipped | — |
| D-060 | Ambient traffic follows routes exported from the built package | Accepted (M4) |
| D-061 | Rails drawn in the street as their own layer | Accepted (M3.5) |
| D-062 | Ground surfaces from land use: park lawns and yards | Accepted (M3.5) |
| D-063 | Fog as an atmosphere layer over the baked world | Accepted (M3.5) |
| D-064 | Traffic vehicles as procedural voxel models from the style pack | Accepted |
| D-065 | Lanes and medians from one-way pairs and way widths | Accepted (M3.5) |
| D-066 | A dam holds its lake just under its crest, and stands as a wall | Accepted |
| D-067 | Coarse levels draw built-up land as city blocks | Accepted |
| D-068 | Pipeline plugins through a registry of entry points | Accepted (M4) |
| D-069 | An engine API the viewer and games are clients of | Accepted (M4) |
| D-070 | The example game drives and flies on the public engine API, at a paced speed | Accepted (M4) |
| D-071 | Generator plugins, and San Francisco's generators as the city pack's browser half | Accepted (M4) |
| D-072 | Tiles are cached by the code that bakes them; a failed model is a marker; load errors name the URL | Accepted |
| D-073 | Views that switch cleanly, game time, world → canvas and baking ahead | Accepted |
| D-074 | San Francisco's city pack packaged for npm, and the viewer's city packs in one file | Accepted |
| D-075 | Style packs get a versioned JSON Schema, path-qualified validation and `extends` | Accepted |
| D-076 | Every package has a geo grid; specs are checked against a schema; builds are staged | Accepted |
| D-077 | Contributor tooling: a pixel inspector, a model preview, e2e servers per checkout, a smoke subset and CI shards | Accepted |
| D-078 | Next regions: New York, then Paris, then Amsterdam | Accepted (M5) |
| D-079 | A player sees through the buildings in front of it; tall objects stay in view | Accepted (M5) |
| D-080 | New York's building facts: footprints joined to PLUTO lots and LPC records; a `materials:` rule | Accepted (M5) |
| D-081 | New York's look: a `new-york` style pack and the `@pixelworlds/city-nyc` generator plugin | Accepted (M5) |
| D-082 | Roads drawn along their own centre lines, and snapped to 16 directions | Accepted (M5) |
| D-083 | New York beyond Lower Manhattan: a driving level for the island, the walking level to 86th Street | Accepted (M5) |
| D-084 | Paris's sources and plugins: APUR's footprints with IGN's BD TOPO, IGN's DTMs, and heights from facts | Accepted (M5) |
| D-085 | Paris's look: a `paris` style pack and the `@pixelworlds/city-paris` generator plugin | Accepted (M5) |
| D-086 | Paris's walking level: the Eiffel Tower to the Marais at 10 m, typed by period, fabric and storeys | Accepted (M5) |
| D-087 | Paris's landmarks drawn on their own proportions: four shapes of the Paris pack's own, two refined | Accepted (M5) |
| D-088 | More Paris landmarks, palaces typed by name, and footprints that keep their courtyards | Accepted (M5) |
| D-089 | Japan's city pack: PLATEAU's building models as facts, roof shapes from LoD2, and GSI's elevation tiles | Accepted (M5) |
| D-092 | Tokyo's look: a `tokyo` style pack and the `@pixelworlds/city-tokyo` generator plugin | Accepted (M5) |
| D-093 | Tokyo's walking level: Shibuya to Shinjuku at 10 m, typed by use, storeys, size and neighbourhood boxes | Accepted (M5) |
| D-094 | Rail corridors: parallel tracks bundled into one corridor, drawn along its centre line with its track count | Accepted (M5) |
| D-095 | Wires strung from pole to pole: utility poles along whole streets, each span a one-pixel line at any angle | Accepted (M5) |
| D-096 | Props with one-pixel detail: lines on instanced props; slender street lights, mast-arm signals, lantern wires and pole arms, on in every pack | Accepted (M5) |

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

### D-037: Micro-terrain resolution (accepted, M1.5)
- **K=4:** every cell holds 4×4 micro-cells. A micro-cell is an 8×4 px diamond, and its height step is a quarter step (2 px).
- **Why:** its ledges form clean 2 px clusters, and it needs about a quarter of K=8's data and a third of its meshing time. K=8's 1 px treads read as hatching on steep walls.

### D-038: Micro-terrain storage (accepted, M1.6)
- **Corner heights only:** chunks store the height of every micro-corner (`MHGT`, rows delta-coded) rather than a base and shape per micro-cell. The shape bytes compressed badly: 4.5 of 8.9 MB in the first build.
- **Derivation:** micro-cells follow from their corners by one rule that the pipeline and the client share (a slope tile up to 3 micro-steps, else flat at the rounded mean).
- **Cost:** the Southwest grows from 0.63 MB to 3.97 MB gzipped, about 6.3×.
- **Constraints from the cell layers:**
  - Water cells are flat at their level.
  - Roads run on a bed cut 0.3 cells either side of the line between connected road-cell centres, following the cells' road profile.
  - The cell layers, their package hash inputs and the road report are unchanged.

### D-039: Micro-terrain on the GPU (accepted, M1.6)
- **Geometry:** the vertex shader builds it from textures: drawn corners per micro-cell, and per cell its surface, roads, class and geology.
- **Draws:** tops for every micro-cell, and walls only for micro-cells listed as having one on an edge facing the viewer (also the sunlit edges).
- **Plain draws:** they use `gl_VertexID`. Instancing made software rendering 4× slower, because SwiftShader runs instances one by one.
- **AO:** a pre-pass computes it per micro-corner at the corner's lowest and highest height, and vertices interpolate between the two.
- **Materials:**
  - Steep micro-tops become bare strata.
  - Land-cover borders are jittered per micro-cell.
- **Margin:** micro-terrain tiles use an 8-cell bake margin (shadows and AO reach a few cells).

### D-040: Elastic map solver (accepted, M2)
- **Energy and method:** v2 minimises a weighted symmetric Dirichlet energy relative to each triangle's target scale, using SLIM-style reweighted local/global steps. A flip-preventing line search starts from the fold-free separable map.
- **Rejected alternative:** plain ARAP/similarity energy. It folded or crushed the background once focus areas were weighted enough to hit their targets.
- **Weights:** they count distortion by output area (magnification²), so focus areas keep their scale and the transitions absorb the stretch.
- **Boundary:** it slides along a solved rectangle, so the world stays a rectangle.
- **Corrections:** two passes rescale the internal targets, bringing focus cores within 0.5%.
- **Result:** the magnified areas push their surroundings outward like a fisheye. The anisotropy sits in the transition rings: p95 about 3, a few slivers higher.

### D-041: Vertical caricature keeps proportions (accepted, M2)
- **Problem:** with one metres-per-step everywhere, magnified places would look flatter than the base, and the compressed background spikier.
- **Rule:** local relief is exaggerated around a smoothed reference, elev′ = ref + R·(elev − ref), with R = (base / local metres per cell)^γ clamped to [0.6, 4]. Flat ground and the regional trend are unchanged.
- **Strata:** they stay at real elevations through the per-cell `VREF`/`VFAC` layers.
- **The reference was zero until M3.5's Southwest round:** it is sampled at 480 m, a level the 1 arc-second DEM doesn't carry (its overviews stop at 8×, 240 m). Every read of that level failed and was cached as zeros, so R multiplied absolute elevation: magnified places stood on domes (the canyon rim drawn at 2.7 × 2,100 m), and the flying level, whose cells sample that level almost everywhere, had flat cells at sea level outside the Strip and Hoover Dam, under micro-terrain that still had relief. A level coarser than a source's deepest overview is now averaged from that overview while it is read, under a cache key of its own.
- **Caps per focus area:** a focus area's `reliefMax` lowers the clamp's upper bound over the area and its falloff ring, fading back over one more falloff. Fading over the ring itself let R peak there (2.4 round Hoover Dam), where the scale is still fine but the cap has risen. Hoover Dam's is 1.6, Lake Mead's own factor, so Black Canyon is exaggerated as the lake is: the dam stands at true proportions at its 100 m cells instead of a slot four times deeper than it is wide.

### D-042: Importance from Wikidata sitelinks (accepted, M2)
- **Scoring:** places with coordinates in the region are scored by sitelinks. Counties, deserts, mountain ranges, rivers and events are left out.
- **Snapshot:** the result is a committed snapshot, so builds don't depend on the live service, which was rate-limited during M2.
- **Effect:** Gaussian splats of log-sitelinks give up to 1.6× magnification. Hand-painted focus areas remain the main control.

### D-043: Editor v0 architecture (accepted, M2)
- **Pieces:** a local pipeline server (standard library HTTP on 127.0.0.1) and a canvas editor (`apps/editor`).
- **Fast loop:** an edit re-solves the warp on a 4 km mesh and returns a warped preview of a source-space map plus a forward-map lattice, in about 5 s for the Southwest.
- **Full build:** it runs in the background on request, about 1.5 min.
- **File:** the editor owns `worlds/<id>/warp.yaml`; the region spec includes it.

### D-044: Neighbouring road cells share one level (accepted, M2)
- **Rule:** road height relaxation keeps every pair of neighbouring road cells within one step, connected or not.
- **Why:** parallel carriageways and crossings share corners. In magnified areas a bigger gap split road cells into terraces: 27 discontinuous edges in the first warped build, 0 after this change.
- **Validation:** the steep-edge check now scales its threshold by step length (√2 for diagonals).
- **Trade-off:** overpasses can't be more than one step above the road below.

### D-045: Warped land cover is sampled 3×3 per cell (accepted, M2)
- **Problem:** the warped layout sampled land cover once, at each cell centre. At Lake Mead's 250 m cells, Boulder Canyon's narrow strait fell between centres and split the lake from the Colorado. The uniform build doesn't do this because it takes the mode over the whole cell.
- **Rule:** each cell takes 9 samples spread over it. The most common class wins, with ties going to the centre sample, and water wins from 3 samples.
- **Result:** a channel wider than a third of the cell, measured across the channel, stays connected. Lake Mead and the Colorado are one water body again.
- **Cost:** water cells grew 6% and land-cover sampling takes about 10 s more per build.

### D-046: Scale levels are separate world packages (accepted)
- **What:** a region is built once per way of moving through it: flying, driving, walking. Each level is its own package with its own grid, warp, generalization and depiction, so each can be recognizable and interesting at its own pace.
- **Specs:** a level spec `extends:` the region's base spec and overrides parameters (architecture §3.5). The base lists the levels by name and package id, and every manifest carries that list.
- **Moving between levels:** the client reloads at the same lon/lat in the other package, through each package's geo grid (D-048). The baked-tile cache makes returning to a level cheap.
- **Rejected alternatives:**
  - Zooming out the driving map: shrunken pixels lose legibility, and the map gets no generalization or oversized landmarks.
  - One package holding all levels: the levels share nothing at the chunk level, and a walking level covers a different extent. It can come later if packaging them together helps.

### D-047: Depiction scale and selection (accepted)
- **Rule:** a depiction scale s draws an object as if its local metres per cell were m / s. Footprint and height grow by s about the object's anchor, and parts move with their building.
- **Selection:**
  - Scaled-up buildings are placed tallest first; one that would overlap a building already placed is left out.
  - `minHeightMeters` drops low buildings, so a coarse level keeps the skyline rather than a smear of boxes.
- **Exceptions:** dams keep their real size, because they're shaped to their canyon.
- **Heights:** a level can set its own object height stretch (`depiction.heightStretch`). The walking level uses 1.0, true proportions.
- **Neutral by default:** with no depiction settings, output is unchanged.

### D-048: Geo grid for moving between levels (accepted)
- **What:** each level package stores the lon/lat of cell corners every 4 cells (warped) or 16 cells (uniform), as gzipped int32 microdegrees delta-coded along rows. That's 228 KB for the driving Southwest.
- **Accuracy:** bilinear interpolation of the warped Southwest is off by 0.005 cells (median) and 2.5 cells at worst, in stretched transition rings. A grid point every 8 cells would be 7 cells off at worst.
- **Inverse:** lon/lat → cell is Newton's method from the nearest grid point. A residual over half a cell means "outside this world".
- **Rejected alternative:** shipping the warp mesh is exact, but the client would need the projection, and inverting the warp needs point location.

### D-049: Snap roads and buildings to the 8 grid directions (accepted)
- **Why:** in this projection only the 8 grid directions draw as clean pixel lines: axes as 2:1 staircases, diagonals as horizontal or vertical lines. Tracing roads cell by cell turned slightly rotated street grids into straight streets with one-cell jogs, and roads at other angles into zigzags. Buildings rotated a few degrees by the projection and the warp drew jagged walls.
- **Roads:**
  - The network is simplified between shared vertices, then straightened as a whole. Each edge within `snap.roads.angle` of a grid direction becomes a constraint that it run exactly along it.
  - The nodes take the smallest moves that satisfy all constraints: a sparse least-squares projection. A node pushed further than `maxShift` frees its edges' constraints and the solve repeats. Nodes never cross the world edge.
  - Each edge is then laid in as few runs as keep it within `deviation` of its line.
- **Objects:** they move with the roads through a smooth field built from the node moves, applied to whole footprints so shapes stay rigid. Building groups within `snap.buildings.angle` of a grid direction turn to it about their anchor. Dams keep their place.
  - **Off the asphalt (M3.5):** with `snap.buildings.clearRoads`, a building whose footprint (with its parts) the moves and the real widths (D-050) leave over the drawn asphalt by 5% or more moves away from it, whole, by the smallest step that clears it, up to `nudgeMeters` (5 m); one that can't is trimmed, each footprint keeping its largest piece off the road. On the San Francisco walking level 4,732 of 43,650 buildings move and 1,823 are trimmed: the share over asphalt drops from 22% of buildings (by a median 10% of their footprint) to 15% (by a median 1%). On the Southwest's, 456 of 5,090 move and 626 are trimmed (31% to 23%, by a median 11% to 1%). The driving levels don't opt in: their roads are drawn 1.5–2× real width, so 39% of San Francisco's buildings stand over them by a median 36%, which nudging or trimming would turn into a different city.
- **Rejected alternatives:**
  - Snapping each road on its own: the jogs come from junction positions, so they can't be removed one road at a time.
  - Adding a rotation term to the warp solver: it only helps warped worlds, and it wouldn't straighten roads that are merely noisy.
- **Neutral by default:** without a `snap:` section, roads are traced as before and outputs are unchanged.
- **Kept ways (M3.5):** `snap.roads.keep: [{bounds, width?}]` lists boxes whose ways keep every vertex and add no constraints, for streets whose shape is the point (Lombard Street's hairpins on the walking level, drawn 5 m wide with `width` so the bends stay apart).
  - **Depicting a crooked street:** true, Lombard's hairpins swing about 7 m either side of its line, less than a 10 m cell, so they drew as a wide road. A rule's `widen` swings its ways that many times further from the street's axis (the line between its roads' two ends farthest apart), never past `within` metres of it (the houses either side), easing in over a cell at each end so the cross streets keep their line. A vertex another way shares moves with it, so junctions stay joined.
  - `class` draws the kept roads as a road class of their own (`brick`, below every other class so the streets it meets keep their junctions; the style gives it its ramp), and `surface` gives the cells the bends sweep a surface of their own (the gardens between them).

### D-050: Roads and paths at their real width (accepted)
- **Why:** a road was a fixed-pixel decal that never left its cell. At street level (20 m cells), a 50 m boulevard drew 6 m wide, and there were no sidewalks or crosswalks.
- **Pipeline:**
  - Each road and path class has a typical real width (one carriageway where a road is mapped as two), and specs can override it.
  - Each cell stores the half-width of its widest way in 1/32 cell (`RWID`, `PWID`): `widths.scale` × real width at the local scale, at least `widths.minCells`.
  - Road beds flatten micro-terrain across the full width, and the paved band blocks scatter and street trees.
- **Paths:** footways, sidewalks, crosswalks, pedestrian streets, steps, paths and cycleways form their own network (`PATH`, `PCLS`). Sidewalks run beside roads and crosswalks across them, so one class per cell couldn't hold both. Paths straighten together with roads (D-049), so crossings stay attached.
- **Classes:** road classes are numbered by priority among those a world uses, so the classic four keep ids 1–4.
- **Client:**
  - The micro-terrain shader looks at the cells within reach (the widest half-width, rounded up). It draws the nearest way whose half-width covers the pixel, with paths over roads.
  - A road is never narrower than the style's width for its class, so coarse maps keep their road hierarchy while fine ones grow to real width.
  - Crosswalks are pale stripes, on gentle crossings only (M3.5).
  - Pavement is lit by its way's grade rather than its micro-tiles (M3.5), so a steep street reads as one slope.
  - Without width data, the old in-cell decal is used, so older worlds are unchanged.
- **Cost:** about 1.6× the software (SwiftShader) bake time on the walking level, from one texel fetch per neighbour cell.
- **Overture cache:** the cache key now includes the row filter. Two filters over the same box used to share one cache entry, which would have dropped the walking level's new classes.
- **Sidewalks on their road's bed (M3.5):** where a sidewalk's or crosswalk's band would cross a terrace in the micro-terrain (a micro-cell too steep to slope), the micro-cells its band lies on take the profile of its road (the road segment nearest the sidewalk segment's middle, within 1.5 cells of its bed) where they lie along it, so the pavement follows its road along and across and the step moves a micro-cell out, past the pavement. Smooth ground stays as it was: on flat ground, two roads a step apart would otherwise split the sidewalk between them. Terrace walls crossed by sidewalks drop from 1.78 to 0.88 per 100 cells on the San Francisco walking level and from 1.51 to 0.98 on the Southwest's; those left are mostly the road's own steps. Footways, pedestrian streets and plazas keep their own ground.
- **Islands (M3.5):** `sources.roads.joinIslands` names left-out subclasses (`parking_aisle`) that may join the network: for each island, the fewest of those segments, by connectors, that link it to the largest network. On the Southwest walking level 104 parking aisles take its 53 networks to 28, and on San Francisco's 27 take 30 to 21; the rest connect only through driveways, links or beyond the level's edge.

### D-051: A landmark registry with generic depictions by default (accepted, M3)
- **What:** one file per landmark in `worlds/_landmarks/<id>.yaml`: an anchor point (or a line, for dams and bridges), real or depicted height, clearance, the Overture buildings it stands in for, sub-parts, and a map of depiction variants. Regions list landmarks by id and may override fields. Loading a region expands each reference into the inline form object placement already used.
- **Generic by default:** every landmark must have a `generic` depiction, and it is the default (`objects.landmarkDepiction`). Generic depictions draw a type (an observation tower, a lattice tower, an observation wheel, an arch bridge), never names, logos or trademarked designs, so any release is safe. Names in the registry are references for people, never drawn.
- **Replacing buildings:** a landmark's `replaces` drops the Overture buildings it stands for (by name or id) with their parts, so the generic tower doesn't stand inside an Overture box of itself.
- **Ids in the package:** every instance of a registry landmark, its parts included, carries the landmark's `id`. Offline tools find landmarks by it (D-053).
- **Rejected alternative:** landmarks inline in each region spec, as in M2. The same landmark appears in several levels (D-046), and its facts would be copied into each one.

### D-052: Building heights and towers from 3DEP lidar (accepted, M3)
- **Why:** Overture heights on the Strip are often machine-estimated and far too low for large complexes: Excalibur's towers came out 13.8 m, against about 74 m measured. A podium-and-tower resort drawn as one box at its mean height also loses its silhouette.
- **Source:** the USGS 3DEP lidar point clouds on AWS (public domain), read as Entwine Point Tiles. Only the octree nodes over the building boxes are fetched, down to a set depth, and cached. Each grid cell (4 m) keeps the lowest ground return and the highest return of classes 1 and 6. The Las Vegas survey classifies no buildings, and unclassified returns inside a footprint are mostly roof.
- **Rule per footprint:**
  - Keep Overture's height unless lidar covers at least half the footprint and either Overture has no height or lidar's 95th-percentile roof is over 1.5× it and more than 15 m above it.
  - Large roofs (3,000 m² or more) whose 95th percentile stands more than `towerGap` (25 m) above the median become a podium at the median height plus tower parts. Each part is a connected region of tall roof of at least `minTowerArea` (600 m²), drawn at its own 95th-percentile height.
- **Result:** 1,199 buildings take lidar heights on the driving level and 25 tower parts appear (1,196 and 24 on the walking level). Mandalay Bay measures 146 m (146 m listed) and Wynn about 174 m.
- **Rejected alternative:** fitting roofs to the points. It's on the "Later" list. Medians and towers are enough for the silhouettes the Strip needs at these scales.

### D-053: Hero landmarks are baked offline and painted over (accepted, M3)
- **What:** a hero landmark (`hero: true` in the registry) is baked alone, in every rotation, by `tools/hero-bake.mjs`. The tool drives the player app in headless Chromium with SwiftShader, the same renderer the client uses, so the offline bake equals the client's.
  - **Bakes:** RGBA PNGs (palette index, depth high byte, depth low byte, coverage) plus each one's screen position and depth base, in `worlds/_landmarks/<id>/hero/<world>/`.
  - **Paint-overs:** indexed PNGs in the style palette, where index 0 keeps the baked pixel, in `worlds/_landmarks/<id>/paint/<world>/`. A `-view.png` of each bake in palette colours is written for artists to paint against.
  - **Packaging:** the build (or `pixelworld heroes <spec>`, which needs no rebuild) copies bakes and paints into the package and lists them in the manifest's `heroes`. Their hashes are part of the package hash, so a new paint invalidates cached tiles.
- **At run time:** after every tile bake, painted pixels are stamped in.
  - **On the silhouette:** a pixel is painted only where the tile shows the landmark there, its depth within 3/256 of the offline bake's. Anything standing in front still hides it.
  - **Beyond the silhouette:** a pixel is painted where the tile is empty or shows something behind the landmark's nearest point (a beacon light above a tower, say).
- **Surviving re-bakes:** the stamp runs on every bake, so painted pixels survive cache misses, style changes and rebuilds.
  - **Re-registration:** when a rebuild moves or reshapes a landmark, a fresh `hero-bake` re-registers each paint. It shifts the paint by the offset (±4 px) that best overlaps the old silhouette with the new one, and reports the overlap.
  - **Check:** `--check` fails if a fresh bake no longer matches the stored one.
  - **E2E:** a test checks that the stored bake still equals a fresh one, and that painted pixels appear in freshly baked tiles and go away with `?paint=0`.
- **First heroes:** the Strat, Hoover Dam (with its intake towers) and the Desert View Watchtower, on all three Southwest levels where they appear (28 bakes). Their paints are demo touch-ups generated by the tool (`--demo-paint`) as stand-ins for an artist's: a lit window band and a warning light on the Strat, lift joints on the dam's concrete, masonry coursing on the watchtower, and a selective outline on all three.
- **Rejected alternatives:**
  - Replacing the baked landmark with a sprite. Terrain, neighbours and shadows around it change with every bake, and a sprite with its own depth would need its own occlusion rules. Stamping only the painted pixels keeps the bake authoritative.
  - Storing paint in tile space. Tiles are re-cut whenever tile size or margins change, and a landmark spans several tiles.

### D-054: Decorative scatter is the client's, gameplay objects the pipeline's (accepted, M3)
- **Client scatter:** shrubs, small trees and boulders are placed per bake tile by surface class from rules in the style pack (`scatter`), as a pure function of the world cell (a hash). Overlapping tiles agree, and nothing is stored per instance.
  - **Where:** not on water, roads, paths or cliffs, beside wide roads, or under objects the pipeline placed.
  - **Density:** each level's `depiction.scatter` scales it: 0.6 flying, 1.0 driving and walking.
- **Pipeline objects:** trees where they really stand (the WRI/Meta 1 m canopy height map, CC BY 4.0, at 3 m or more on the walking level), street trees, street lights along main streets, and traffic signals where three or more street segments meet. These matter for gameplay (collision, landmarks to steer by) or need data the client doesn't have.
- **Rejected alternative:** the pipeline placing every shrub. The driving Southwest would carry hundreds of thousands of instances for decoration that needs no facts.

### D-055: Building typologies from geometry, streets and public records (accepted)
- **Why:** a city is recognized by its ordinary fabric as much as by its landmarks. In San Francisco that means rows of narrow Victorians and Edwardians with bay windows, the stucco rows of the Sunset, corniced apartment blocks, Chinatown and the piers. A generic "residential" box can't carry any of it.
- **Features (pipeline, `typology.py`):** for each building:
  - width and depth (its oriented rectangle)
  - the share of its outline against neighbours
  - the side facing the nearest street, from the straightened network
  - corner lots, and whether it stands over water
  - from a facts source where one exists, year built, storeys, use and neighbourhood
- **Facts for San Francisco:** DataSF's parcels and the assessor's secured roll (ODC PDDL), joined by map lot. Condominium units are aggregated: the earliest year, the most storeys, the sum of units, the most common use. 160,796 of 168,883 buildings on the driving level fall on a lot with a record.
- **Rules:** an ordered list in the region spec (`objects.typology.rules`) maps features to a group; the first match wins, and unmatched buildings keep their generic group. A rule names any of: a year range, uses, neighbourhoods, width, depth, shared-wall share, storeys, height, over water, corner lot. Rules replace only generic groups unless they say `from:`.
- **Hints:** typed buildings carry `fr` (the front's direction), `cn` (corner), `yr` (year built) and `fl` (storeys) for their generator.
- **Variants by place:** a rule can retype a group into a paint variant (`building.rowhouse.victorian.pale` by neighbourhood, `building.rowhouse.edwardian.painted`), so a street's colours follow its district rather than one city-wide mix. Judges called a city-wide random mix "procedurally assigned".
- **Rhythm:** row houses step a voxel up or down from their neighbours and never fall below their storeys (`fl`), since Overture gives most houses in a row the same height. Corner lots (`cn`) get windows on their side-street wall.
- **Buildings in parts:** a building drawn in parts (Overture's parts, lidar's tower parts) shares the facts of whichever part stands on a lot, and each part keeps its own height and storeys. Parts have no geometry features and match only rules with an explicit `from:`, so a tower's parts are typed by its year while a podium or roof part is never drawn as a house of its own.
- **Generators (`facades.ts`, `towers.ts`):**
  - `rowhouse`: Victorian (type 0) and Edwardian (type 1). A bay is drawn by stepping the rest of the front back a voxel. Each house has a false front with a cornice, a frieze and string courses, a garage and an entry door, and sometimes a short Queen Anne gable.
  - `stuccoRow` (rowhouse types 2 and 3, the Sunset's and Richmond's "junior fives"): an entry stair in a recess on one side, a white garage door, and a box, canted or curved bay over it. Parapets take a profile by seed, most with a white coping; about a fifth have a tiled pent roof or a storybook gable, mostly in the 1920s. Type 3 is mid-century: a band of sliding windows and a flat fascia.
  - `block`: apartments with stacked bays, historic commercial blocks, Chinatown (balconies, vertical signs, a jade eave round every wall, pagoda towers on corner lots), pier sheds and warehouses. Chinatown's street also has lanterns strung across Grant Avenue and Stockton Street, and the Dragon Gate (`gate`, a registry landmark).
  - `decoTower` and `sfTower`: towers by era. Deco (1906–1950, at most 140 m): terracotta, buff or granite piers between recessed bays, setbacks with pinnacles, a stepped, pinnacled or lantern crown. White or granite slabs to 1983, postmodern stone towers with sculpted tops to 2000, pale glass after. A tower with no record takes a kind by seed.
  - All follow the style guide's building rules: inside the footprint, no overhangs, glass only on the skin.
- **Tuned by blind tests:** a fresh-context evaluator first read the Victorian rows as Dublin and Chinatown as Berlin, because of pitched slate roofs and plain colour. Victorian rows are now mostly flat-roofed behind false fronts, with painted-lady trim.
- **Rejected alternatives:**
  - Classifying by neighbourhood polygons alone. It needs no records, but every block in a neighbourhood would get the same type, and a 1960s apartment block among Victorians is part of the look. Neighbourhoods remain a rule field.
  - Imagery (roof colour from NAIP). Facades, which carry most of the look, can't be seen from above.

### D-056: Long landmarks: per-column ownership, a fixed base, snapped with their road (accepted)
- **Why:** the Golden Gate Bridge is 109 cells long on the driving level. Objects were owned by their anchor's cell and baked only in tiles whose slice held that anchor, so anything longer than a tile's margin would be clipped.
- **Ownership:** a footprint wider than 16 cells is owned per voxel column, each column by the cell under it. Faces never merge across cell lines, and the object joins every slice its footprint reaches. Each tile bakes its own part, with shadows from the whole.
- **Base:** such landmarks carry `z0`, their base in steps (a bridge's water level), so every tile builds them at the same height wherever its slice ends.
- **Snapping:** a line landmark marked `snap: true` (bridges) moves with the road shift at its middle and turns about it to the nearest grid direction within the roads' snap angle, as its road did (D-049). Where a road runs along it, the bridge instead lies on that road's drawn axis: a line fitted through the road along the span. A road too slanted to straighten within `maxShift` keeps its slant (the Golden Gate's does), and so does its bridge, so the deck always carries the road. Dams don't snap: they stay fitted to their canyon.
- **Water under the deck:** over water a bridge's deck is the road. Cells under a bridge piece that are water lose their road decal and stay water, so the road isn't painted on the bay beneath the deck. The road report still checks the network as rasterized.
- **Pieces:** a snapped line landmark is cut into pieces of at most 12 cells along its line.
  - **Shared line:** each piece carries the whole line (`ln`, `lw`), so the generator measures its position along the span (towers, cable sag, hangers) against the whole and the pieces join exactly.
  - **Why:** a diagonal bridge in one piece is a square voxel box. The Bay Bridge's west span was about 335 million voxels, mostly empty, rebuilt in every tile it touched; a view of it took 215 s to bake in software.
- **Seen side-on (M3.5):** a braced tower's X-bracing between its legs is edge-on from the side, where a long bridge is usually seen, so with `sideBrace` each leg is drawn as a braced frame along the bridge (posts, struts and an X in each panel, filled behind with a `plate` role). Main cables sag to `sag` above the deck, the side spans hang with the main span's curve, and `anchorTop` raises a central anchorage under the cables with the road through it left open. A blind judge read the Bay Bridge's towers without this as "generic lattice".

### D-057: Objects file version 2, footprints relative to their anchor (accepted)
- **Why:** absolute footprint coordinates, in cells with two decimals, made up most of the San Francisco driving level's `objects.json.gz`: 8.3 MB for 169k buildings.
- **Format:** version 2 stores each footprint point as `[dx, dy]` in integer hundredths of a cell from the instance's anchor, itself rounded to hundredths. This decodes to exactly the numbers version 1 held, so footprints and seeds don't change and every world draws the same buildings.
- **Reading and writing:**
  - **Pipeline:** `world_format.encode_objects` and `decode_objects`; packages are written as version 2.
  - **Client:** `parseObjects` in `packages/world-format` converts back to absolute footprints, so nothing downstream changes. Version 1 files still load.
  - **Tests:** shared golden files in `testdata/world-format/` cover both sides.
- **Result:** the driving level falls from 8.30 to 6.15 MB before street trees, the walking level from 2.69 to 2.22 MB and the Southwest from 0.30 to 0.22 MB.
- **Rejected alternatives:**
  - Flat `[dx, dy, dx, dy, …]` arrays: they save about 0.2 MB more but change the shape of `fp`.
  - 16-bit seeds: they would change every existing world's buildings.

### D-058: Ways that graze the world's edge stay in one piece (accepted)
- **Why:** a street on the walking level's north edge had one vertex 0.19 cells outside the grid. Its cell path stepped out and back, and steps through outside cells aren't drawn, so the street fell into stubs. That gave a split segment and two disconnected junctions in the road report.
- **Rule:** in both rasterizers, a run of outside cells between two inside cells that stays within one cell of the edge is drawn on the edge cells. Ways that really leave the grid are drawn as before.
- **Effect:** the San Francisco walking level's road report is clean. Only cells along world edges change elsewhere: 16 road and 20 path cells on the Southwest walking level, 8 road cells on the 20 m Strip experiment.

### D-060: Ambient traffic follows routes exported from the built package (accepted, M4)
- **Why:** a world that is empty of moving things reads as a model. Cars, buses, trains, cable cars, streetcars and ferries moving along real lines make it read as a place, and they are the groundwork for M4's drivable car.
- **Routes come from the package, not the sources:** `pixelworld routes <region.yaml>` writes `routes.json.gz` next to a built package and lists it in the manifest, without rebuilding chunks or objects, so routes can be refreshed after any rebuild. `pixelworld build` runs it at the end (unless `--no-routes`).
  - **Roads** are traced from the drawn road layer (the chunks' `ROAD` bits): every polyline runs through cell centres along drawn connections, so vehicles follow exactly the roads on screen, with D-049's straightening already in them. A polyline ends at a junction (a cell with other than two connections) or a dead end. An edge needs both cells to point at each other, so a road cut at a bridge's water leaves no stubs.
  - **Bridge decks (D-056):** over water the road layer stops at the deck. Each bridge landmark gets a route along its own line (`ln`) at its deck height (`top`), joining the road cells on either side of the gap. A road running along a deck's band over land (within 30° of its line) takes the deck's height; a road crossing under it keeps its own.
  - **Rail and ferries** come from Overture transportation segments (`sources/transit.py`): rail by class (tram → streetcar, light_rail, standard and narrow gauge → train; subways, tunnels, disused and abandoned track are left out) and water segments as ferry lines. Street-running kinds (cable cars, streetcars, light rail) are matched onto the drawn road graph: the cheapest road path between the cells nearest a line's ends, through cells within 2.5 cells of the line, each step costing its length × (1 + distance²). Other rail is laid in octilinear runs like roads but isn't drawn. Of two parallel tracks (a few metres apart, they would draw ladders of crossovers on the grid) only the longer is kept.
  - **Cable cars:** Overture records San Francisco's as unnamed tram lines. A region may say `routes.rail.unnamedTram: cablecar`: a tram network (segments joined end to end) with no route name anywhere becomes cable car lines. The F and E streetcars carry their names, so they stay streetcars.
  - **Heights:** every vertex carries the drawn surface height (micro-terrain sampled as the client does), or the deck's. Vertices are kept where the rest wouldn't interpolate within 0.02 cells in plan and 0.15 steps in height.
  - **Lon/lat to cells** goes through the package's own geo grid (D-048), inverted by Newton steps, so warped levels need no layout rebuild.
- **Simulation (`packages/sim`):** deterministic and serializable, as architecture §9 asks.
  - **Ticks:** fixed steps of 1/30 s. Every random choice comes from one seeded mulberry32 state, and the whole state (vehicles, RNG, focus, leftover frame time) is plain JSON.
  - **Vehicles** are positions on a chain of legs (a route and a direction). At a junction a vehicle picks its next route, weighted toward going straight; trains don't take switches sharper than about 70°. At a dead end it stands for its kind's dwell time, then reverses, the tail of a train becoming its head. A vehicle slows behind the one ahead on its leg.
  - **Around the view:** each kind is kept at a density per cell of usable route within a circle covering the view. The first fill of a place is anywhere in the circle; after that, new vehicles enter at its edge, out of sight, and vehicles beyond 1.25 radii are dropped.
  - **Speeds:** by road class or kind, in real metres per second. Walking levels run at real time; driving and flying levels compress it by (metres per cell / 10)^0.75, about 2× in San Francisco (25 m) and 16× in the Southwest (400 m), so traffic looks busy at the level's pace.
  - **Sizes:** a car is drawn at least 0.55 cells long. Longer kinds are enlarged less, by the square root of their length ratio to a car, so a bus stays longer than a car without a train filling the street. Heights follow the level's `depiction.heightStretch`, like its buildings.
  - **A level may cap the enlargement** (`objects.depiction.vehicleScale`, written to the manifest's `depiction`). San Francisco's flying level draws vehicles at most 4× their size: at 0.55 cells a car there was 55 m long, longer than the Bay Bridge's deck is wide. Levels without it are unchanged (the driving level's cars are about 3×, 14 m).
- **Drawing:** procedural voxel models from the style pack's `vehicle.*` assets (D-064), or generic box models for a pack without them; no names or logos. They are baked through the bake service as the rover is, once per model and 16 headings, in view rotation 0 only: a model turned by θ in rotation r looks like the model turned by θ + r·90° in rotation 0, and lighting is view-relative. The compositor draws them with per-pixel depth, so buildings in front hide them.
- **An optional layer:** traffic sits on top of the world, not in it. Its routes are their own versioned file; the chunk format, the objects file and the bake are unchanged, and a package without routes works as before. Vehicles are a dynamic overlay depth-tested against the baked tiles, which never contain them, so nothing re-bakes as they move. world-format.md describes this as the pattern for later layers (people, boats, aircraft).
- **Control:** traffic is on where a package has routes; `traffic=0` turns it off, V toggles it, and the layer panel (top right, with the HUD) toggles it and its sublayers: road vehicles, rail and transit, ferries (`trafficLayers=road,rail,ferry` in the URL). Hidden sublayers still simulate, so toggling one changes nothing else. `trafficTime`, `trafficPause`, `trafficSeed` and `trafficDensity` fix a scene for tests. The e2e helper turns traffic off unless a test asks for it, so earlier goldens don't change.
- **Cost:** about 175 vehicles cost about 0.1 ms of simulation, 0.2 ms of poses and sprite lookups and 0.2–0.3 ms of compositor submission per frame (SwiftShader, 1280×720); the frame stayed at 16.7 ms with and without traffic.
- **Rejected alternatives:**
  - **Routes from the straightened source lines in the build:** they would need the whole build (sources, warp, straightening) to refresh routes, and they don't record where rasterizing moved a road.
  - **Steering on the road bits at run time:** the client would need every chunk along a vehicle's way loaded, and decks over water have no road bits.

### D-061: Rails drawn in the street as their own layer (accepted, M3.5)
- **Why:** San Francisco's cable-car and streetcar lines are part of how its streets look, even without a car on them. Static props would clash with the moving vehicles of the traffic layer (D-060), so the tracks are drawn into the ground.
- **Data:** an optional `RAIL` chunk layer: connections like `ROAD`, and the kind drawn in bits 12–15. Rules in `sources.rails` pick each Overture rail segment's kind by class, name (or `unnamed`) and a lon/lat box; the first match wins. Tunnels (`is_tunnel` ranges in `rail_flags`) are cut out.
- **Placement:** street and cable-car tracks move with the straightened roads (D-049) and snap onto the road they run in; trains keep their own way.
- **Drawn by the style:** `roads.rail` names the ramp. A style without it draws no rails, so other worlds are unchanged.
- **Two readers of Overture rail:** the traffic layer reads rail segments for routes (`sources/transit.py`, which keeps route names), and this layer reads them for drawing (`overture.rails`, which keeps tunnel ranges). They are separate queries and caches; the routes for street-running lines are matched onto the drawn road graph, so the moving cars run on the tracks.
- **Continuous tracks (M3.5):** where a track bends in a cell (two connections that aren't opposite), its point there moves a quarter cell toward the inside of the bend, and each cell draws from its point to halfway to its neighbour's. A track that steps from run to run along a curving or slanted street then cuts its corners and reads as one line; straight runs are unchanged. A street's second mapped track joins the first wherever it runs in the cells beside it, so the pair no longer steps across between rows.
- **Known limits:** tracks run in a carriageway, not in the median between a divided road's carriageways (the Embarcadero's F line).
- **Rejected alternative:** parked cable cars and streetcars as props. They would double up with the traffic layer's moving ones. The voxel models made for them (`generators/vehicles.ts`: a cable car with riders on its running boards, a heritage streetcar in paired liveries, an articulated light-rail car) stay registered as `prop.*` groups in the `bay-area` pack, placed by no world, for the traffic layer to adopt in place of its box models (M4).

### D-062: Ground surfaces from land use: park lawns and yards (accepted, M3.5)
- **Why:** WorldCover sees an irrigated park lawn and a dry hillside as the same grassland, and a block of houses with green backyards as built-up land. Blind judges read San Francisco's parks as "bare, dry ochre hillside" and its avenues as arid ("dusty grey-beige ground, very little green").
- **Lawns:** a region spec's optional `ground.lawn` names Overture `base/land_use` classes (park, golf, pitch, garden, cemetery, …). Their cells become a `lawn` surface where they were grass, bare, built-up or cropland.
  - **Kept wild:** natural land from `base/land` (grassland, scrub, heath, beach) stays as it is, and a park whose median slope is over `maxSlope` (0.2) stays golden (Bernal Heights, Glen Canyon).
  - **Wooded parks:** tree-covered park cells become lawn where the canopy map shows the ground mostly open, so a park's trees stand on lawn rather than in a solid wood.
  - **Edges:** lawn spreads a little into the open grass around it, so no strips are left between a park and its streets.
  - The polygons move with the straightened roads (D-049), as buildings do.
- **Yards:** `ground.yard` turns open cells within `reachMeters` of house footprints into a `yard` surface (green patchwork with paved squares, a share paved by seed), after objects are placed. Roads, wide-road pavement and water are excluded.
- **Smooth lawns:** `micro.smooth: {surface: metres}` smooths micro-terrain on those surfaces before roads and water are cut in, so the walking level's 2× hills don't carve parks into gullies.
  - **Lit by slope:** smoothed heights are still whole micro-steps, so a sloped lawn drew as light and dark stripes. A style pack's surface can ask for `light: "slope"`: its tops are lit by a plane fitted to the drawn heights a cell around (as pavement is by its way's grade, D-050), and its risers take its own colour a shade darker. The `bay-area` lawn does; every other surface, and the whole Southwest, keeps its terraces.
- **Trees read as buildings:** machine-made footprints sometimes outline a tree. `objects.buildings.implausible` (on by default) drops a footprint with no class, type, name or parts, at most 200 m², whose stated height is at least 8 m and 2.5 times its width, where it stands in a park (the lawn's land-use classes). Alamo Square's 7-storey "apartment block" (45 m², 22 m) was one. Real park buildings have a class or a name, or are low. It drops 5 footprints on the walking level and 14 on the driving level, most where the canopy map shows trees; two on both levels are Crane Cove Park's harbour cranes, which a box drew no better. None in the Southwest.
- **Neutral by default:** without a `ground` section nothing changes; the Southwest builds to the same package hash.
- **Rejected alternative:** recolouring all grass green. San Francisco's wild hills (Twin Peaks, the Presidio bluffs) are golden in summer, and the Southwest shares the surface.

### D-063: Fog as an atmosphere layer over the baked world (accepted, M3.5)
- **Why:** the marine layer over the western avenues and through the Golden Gate is one of San Francisco's signatures. Blind judges reading the Sunset and the Richmond as a Gulf city and Havana named the absence of "hills, fog or the ocean".
- **Where it's defined:** a style pack's `atmosphere.fog`: lon/lat areas, each with a density and a soft edge in metres, a height ceiling and a fade under it, drift, a multiplier per level (`levels`) and at night. Each world turns the areas into a coverage grid over its cells through its geo grid (D-048) at load: no pipeline step, no manifest field.
- **How it draws:** a compositor pass between the scene and the palette pass (architecture §8.2). Tiles now write their depth beside the index, so the pass recovers each pixel's ground and height. The bake is unchanged, and the atmosphere is left out of the tile cache key.
- **A layer like traffic (D-060):** `fog=0/1`, the G key and the layer panel; `fogTime` and `fogPause` fix a scene for tests; the e2e helper turns it off unless a test asks for it, so earlier goldens hold. With fog off, frames are pixel-identical to before.
- **Cost (SwiftShader, 1280×720):** the frame stays at 16.7 ms with traffic moving. Measured per frame waiting on the GPU, the Sunset at 3× goes from 7.9 to 10.1 ms and the Golden Gate at 1× from 18.1 to 37.0 ms; no fog in view costs nothing. With the camera still, drifting fog redraws at 12 Hz.
- **Rejected alternatives:**
  - A flat fog colour dithered over the scene: a screen door at 3×.
  - Snapping to the nearest colour of the pixel's own ramp: shadowed water came out brighter than lit water.
  - Greys only: drained the avenues' colour past a third of coverage.
  - Sampling the depth buffer as a texture: three times the cost in software.
  - Fog computed in the palette pass: zoom² more work.
  - Areas in the region spec, exported through the manifest: needs a pipeline export and rebuilt manifests. A world could carry its own areas later.
- **Known limits:** the ceiling is in drawn metres, so landmarks drawn taller per level rise further out of it; from the driving level, Twin Peaks shows little fog because the fog sits west of and below its summits.

### D-064: Traffic vehicles as procedural voxel models from the style pack (accepted)
- **Why:** the traffic layer's box models (D-060) read as coloured bricks beside voxel buildings: a cable car was a dark box, every car the same shape in eight paints.
- **Assets:** each vehicle kind is a style-pack asset, `vehicle.car`, `vehicle.bus`, `vehicle.cablecar`, `vehicle.streetcar`, `vehicle.lightrail`, `vehicle.train`, `vehicle.ferry`, drawn by a generator in `generators/vehicleModels.ts` with the pack's ramps (D-030). A pack without them falls back to the box models.
- **Generators** (a model faces +x; the seed picks the body and paint):
  - `car`: sedan, hatchback, SUV, wagon, coupe, pickup, van (minivan or cargo) and taxi (the `taxi` paint and a roof sign), with a hood, cabin and trunk by type, wheels at the corners, headlights and tail lights.
  - `bus`: a livery band under a band of windows between pillars, a windscreen under a blank sign, kerb-side doors, roof units; long buses are articulated.
  - `cableTram`: a cable car with open ends, benches, posts, running boards and riders.
  - `tram`: streetcars with a trolley pole, or light rail with a pantograph and bellows.
  - `train`: a hood unit (freight) or a cab unit (passenger) at the head, then box, tank, hopper, container and gondola wagons, or two-level coaches.
  - `ferry`: a hull narrowing to the bow, decks with railings, cabins with window bands, a wheelhouse and a mast.
- **Size:** the traffic layer asks for a size in object voxels (2×1 px tops, 1 px tall, D-010), so vehicles share the buildings' pixel scale. Length follows the simulation (`kindCells`); width and height are enlarged like a car's, but at most 1.6 times the length's factor, so a bus is at least as wide as a car and a ferry keeps its shape. Too small for detail (a flying level), a model is a body under a roof.
- **Baking:** a model becomes boxes (runs merged along x, then across y, `modelBoxes`) turned to each of the 16 headings and baked as a sprite, as before. Models are cached per kind, variant and car; a consist shows up to four kinds of wagon.
- **Night:** transit windows use `lit` and headlights `lit-cool`, which match glass by day and glow at night; tail lights use `marker`.
- **Variety:** cars have 24 variants, buses 6, cable cars, streetcars, trains and ferries 4.
- **Rejected alternative:** voxels rotated per heading. Sampling a voxel grid at 22.5° steps breaks thin parts such as poles and pillars; turning boxes keeps them whole.

### D-065: Lanes and medians from one-way pairs and way widths (accepted, M3.5)
- **Why:** roads drew at their real width (D-050) with at most one centre line, so on the walking level Las Vegas Boulevard, Van Ness Avenue and the Embarcadero read as wide grey bands rather than multi-lane boulevards, and carriageways that met showed no median.
- **Data:** Overture has no lane counts, and its `width_rules` are almost never filled in (7 of 12,702 roads around the San Francisco walking level). It does say which ways are one-way (an unconditional `denied` restriction on one heading in `access_restrictions`).
  - **Lane counts:** a way's width over `widths.lanes.meters` (3.5 m): 14 m of one-way carriageway is four lanes, a two-way road an even number. A way's width is its class width, its `width_rules` where mapped, or the first `widths.ways` rule it matches (by name, lon/lat box and whether it is one-way), which can also give `lanes`. Downtown Market Street is one such rule.
  - **Divided roads:** a one-way way with another of the same name running the opposite way, roughly parallel, within `widths.lanes.medianMeters` (60 m) of its middle. Both are carriageways with a median between them.
- **Layer:** an optional `LANE` chunk layer (u8) for the widest road through each cell, like `RWID`: the lane count in bits 0–3, one-way in bit 4, divided in bit 5. Levels opt in with `widths.lanes`; `lines: false` stores only the flags (medians without lane lines). Both walking levels count lanes; the San Francisco driving level has medians only; the flying levels have neither.
- **Drawing (`roads.lanes` in the style):**
  - **Lane lines:** on classes marked `lanes`, dashed lines in the style's `lanes.ramp` (`concrete`) divide a road into lanes at least `minPixels` (4) across; a road whose lanes are narrower draws fewer, wider ones (Las Vegas Boulevard's 2.8 px lanes draw in pairs), and none below two. A two-way road's middle line is a solid centre line in `marking`. Lines are one pixel thick in every direction and rotation, follow the road's centre line with its steps cut (as rails, D-061), and stop at junctions.
  - **Medians:** between a divided road's carriageways, a one-pixel kerb (a shade lighter) runs along the ground between their asphalt; where the drawn carriageways meet, a strip `median` lanes wide (a shade darker) is carved between them, only where lanes are counted. Cross streets and junctions cut through. The cells between a divided road's carriageways (found across the road from each carriageway cell, up to six cells) look up to three cells out for them; elsewhere the decal's reach is unchanged.
- **Neutral by default:** without `LANE` data or `roads.lanes`, roads draw exactly as before, the old centre line included. A style turns markings off by leaving out `roads.lanes`.
- **Cost:** in software rendering (SwiftShader), about 25% more bake time over the Strip at the walking level, where divided roads are everywhere, and about 10% on San Francisco's walking and driving levels, from the medians' longer look.
- **Rejected alternatives:**
  - **Lanes in ROAD's free bits 12–15:** too few bits for a count and two flags, and it would change an existing section's meaning.
  - **Medians as a path class:** a median lies between two cells' centre lines, often on a cell edge, where a centre-to-centre network can't put it.
  - **Lane lines at every real lane:** on the Southwest walking level they would be 2.8 px apart, a hatching rather than lanes; on the driving levels, clutter.

### D-066: A dam holds its lake just under its crest, and stands as a wall (accepted)
- **Problem:** a lake is flattened to one level, the 10th percentile of its corners. Where the relief factor (D-041) differs across a long lake, that level isn't the drawn height of the water at the dam: Lake Mead spans focus areas and their rings, and met Hoover Dam 17 steps below its crest in M3 (2 steps once Black Canyon's relief was capped).
- **Rule:** a dam's registry entry gives `reservoir`, the metres below its crest its lake stands. The lake with a cell between half a cell and two and a half cells upstream of the dam's upstream face is raised to at least the drawn height of crest − reservoir, rounded down to a step, so the water stays under the crest. Lakes are only raised, and no other lake changes. Hoover Dam's is 10 m.
- **The wall:** a dam carries its abutment line and half-thickness (`ln`, `lw`), so the generator knows its upstream face (the line's left, where it bows). With the style's `crest` (voxels) the upstream face stands sheer and the downstream face is battered: the thickness runs from the footprint's at the foot to the crest's at the top along a concave curve (`batter`, the profile's exponent). Hoover Dam's footprint is 120 m thick at the foot and 2 voxels at the crest; it reads as a thin curved wall with a fanned face, not a drum.
- **Neutral by default:** without `reservoir`, or the style's `crest`, lakes and dams are drawn as before.
- **Rejected alternative:** a lake level from its cells nearest the dam only. Lake Mead would then stand above its own shores far from the dam, wherever the relief factor is lower; raising it to just under the crest moves its whole level by one step.

### D-067: Coarse levels draw built-up land as city blocks (accepted)
- **Why:** a flying level keeps only towers of 80 m or more and landmarks (D-047). A house is a hundredth of a 1.5 km cell, so Las Vegas read as models on an empty plain.
- **Rule:** with `objects.lowrise: {group, heightMeters}`, every built-up cell not blocked (roads, water, cliffs) or under another object (a footprint's cells; a cell and its ring for an object without one) gets one instance covering the cell, `city.blocks` by default.
- **Generator** (`cityBlocks`): one-voxel streets every `pitch` voxels of the world's voxel grid, so streets run on from cell to cell, and each block picked by a hash of its place, so a block cut by a cell edge matches on both sides: houses (one roof colour per block, a few in another), a flat-roofed commercial box, a taller apartment block, a park or an open lot. The desert pack's roofs are mostly stucco and sand, a fifth tile; blocks are 4 voxels with `pitch` 5.
- **Southwest flying level:** 2,889 cells. Its objects file grows from 4 KB to 37 KB and the package from 0.56 to 0.63 MB.
- **Rejected alternatives:**
  - A surface pattern in the bake shader: flat, with no height or shadow, and the shader is shared by every level.
  - Client scatter by surface: a style's scatter applies to every level of a region, and the walking level's open built-up cells (car parks, plazas) would fill with blocks.

### D-068: Pipeline plugins through a registry of entry points (accepted, M4)
- **Why:** a city's records (DataSF's assessor roll) and a region's elevation and land cover were hard-wired into the pipeline, so a second city or a non-US region meant editing it. As a library (library.md, D4), cities and data sources must be addable as packages.
- **Registry** (`pixelworld_pipeline/plugins.py`): groups of Python entry points.
  - `pixelworld.facts`: per-building facts sources, answering year, storeys, use, neighbourhood, class code and roof for projected points.
  - `pixelworld.sources`: raster sources with a role (terrain, land cover), a resolution, overviews and attribution. They either list GeoTIFFs or fill a grid; the pipeline keeps reprojection, resampling, block pyramids and caching.
  - `pixelworld.stages`: reserved.
- **Resolution:** names registered in the process come first, then installed entry points, then built-ins (USGS 3DEP at 1 and 1/3 arc-second, ESA WorldCover 2021). Specs name plugins as before (`sources.dem.kind`, `objects.typology.facts: datasf` or `{plugin: …, options}`). A build checks every name its spec uses before fetching anything. A missing plugin fails with the list of installed ones.
- **City packs:** DataSF moved into `pixelworld-city-sf`, a separate distribution in `pipeline/plugins/`. It is a uv workspace member, installed by default for development. San Francisco's TypeScript generators will join it.
- **Rules:** typology rules gain `classes:` (class codes, exact or by prefix) and `roofs:` (facts or Overture roof shapes). In most cities the iconic building type is a class code, not a year and a use.
- **Python API:** `pixelworld_pipeline.build(spec, out_dir=None, …)` beside the CLI. `pixelworld plugins [spec]` lists the plugins, and the ones a spec names.
- **Neutral:** San Francisco and the Southwest rebuild byte for byte.

### D-069: An engine API the viewer and games are clients of (accepted, M4)
- **Why:** pixelworld is a library (library.md, D1: engine first). The viewer's 940-line `main.ts` held the engine's assembly and the app's behaviour together, so a game could only copy it.
- **`@pixelworlds/engine`:** `createWorldView({canvas, worldUrl, style, layers, controller, camera, …})` loads and streams a world, bakes and caches tiles, composites, and runs a lazy frame loop: it redraws only when something changed. It owns no input, DOM UI or URL parsing.
- **Extension points:**
  - **Layers** (`Layer`): `init` (skipped where a world has nothing for it), `update`, `sprites`, an optional screen pass, sublayers, `serialize`/`restore`. `fogLayer()` lives in the engine; `trafficLayer()` lives in `@pixelworlds/sim` and uses only the engine's types.
  - **Entities:** models (boxes, or a style group with a seed and size) baked per rotation and heading, depth-tested; the rover is one.
  - **Controllers:** the app forwards input, or the controller listens on targets it's given; `roverController()` is the first, with the viewer's keys.
  - **Queries:** `heightAt`, `surfaceAt`, `roadAt` (class, width, lanes, one-way, divided), `pick` (screen to cell), lon/lat ↔ cell, `elevationAt`.
- **The viewer:** `apps/web` is now a client of the engine, about 430 lines (URL parameters, HUD, layer panel, levels, the debug API with the same shape). Every golden is unchanged, and nine scenes compared pixel for pixel are identical before and after.
- **Proof:** `examples/minimal-viewer` (about 45 lines: San Francisco, the rover, traffic, queries under the pointer) uses only the engine and the traffic layer.
- **Later:** traffic's sprites as entities; more screen passes; `pick` against buildings; edits; the export CLI; npm packaging; level switching without a reload.

### D-070: The example game drives and flies on the public engine API, at a paced speed (accepted, M4)
- **Why:** M4's gameplay is the engine's first real client (library.md §5): a car, a plane and the move between scale levels, built with nothing the engine doesn't publish. `apps/game` (`@pixelworlds/game`) imports only `@pixelworlds/engine`, `@pixelworlds/sim` and the style packs.
- **Engine additions** (additive, library.md §7.6, §7.9):
  - `query.objectsAt(x, y)`: the placed objects standing at a point, with group, landmark id, bounds, base and an estimated drawn top; `query.landmarks()`: one entry per registry id.
  - `createWorldView({ replace })`: a new view on the same canvas draws nothing until its first frame is complete, then destroys the old one in the same animation frame. A take-off or a landing never reloads the page or shows a half-baked world: the old level stays on screen while the new one bakes.
  - A view sets its canvas's size only when it changes; `destroy()` releases entity sprites and the compositor's GPU objects. Traffic's `vehiclesNear()` and `dispose()`.
- **The car** (pure physics in `car.ts`, a `Controller` in `carController.ts`):
  - **Speeds by surface:** the top speed is the road's class under the car (on its drawn asphalt, from `roadAt` and the cell's centre line), else the surface's off-road speed; water stops it. Throttle accelerates toward it, the brake stops then reverses, coasting rolls to a stop, and over a surface's top speed the car slows hard to it.
  - **Slopes:** the grade over the car's length lowers its top speed when climbing (to 60% at 2 steps per cell) and pulls it down slopes while it rolls. Steeper than 2 steps per cell off-road is a cliff; on a road the limit is 4.5, since the drawn roads follow the micro-terrain and the vertical caricature, and a bridge's abutment can dip.
  - **Height:** on a road the car rides the road's graded surface: traffic's routes (D-060), whose vertices carry the drawn surface's height, within the road's half-width and a quarter cell of the line and near the car's height (so a car under an overpass stays under it). A deck route, a join between route ends that stop a cell or two short of each other at about one height (a deck's routes, a road cut at a river), or a bridge landmark's footprint at its deck height (its `top`) carries it over whatever is below. Off the roads it stands on `heightAt`. A suspension spring bobs the drawn car over changes of slope; the car's own height is the surface's. (Standing on `heightAt` everywhere stopped the car where a road is cut into a slope, at junctions whose roads meet a little apart in height, and in the dip where the Hoover Dam bypass bridge meets the land.)
  - **Collisions:** its leading end (middle and corners) against buildings and landmarks other than bridges (`objectsAt`), except within 0.35 cells of a road's asphalt: the driving levels draw roads wider than real, and buildings stand over their edges (D-049). Traffic (`vehiclesNear`) by oriented boxes, only vehicles ahead. A bump stops the car and sends it back at a quarter of its speed.
  - **Steering:** the wheel eases toward the keys; the turn rate is 2.6 rad/s at low speed, falling to 1.6 at 11 cells/s, and fades in as the car rolls; reversing turns the other way. **Road assist** (G): with the wheel straight on a road, the car follows the road traced ahead along its connections (stepping across where a divided road's carriageways jog), within 35°.
  - **Drawn:** the style's `vehicle.car.player` (the car generator in one paint of the pack's own, D-064) at a traffic car's size plus 2 × 1 voxels, with a silhouette.
- **The plane** (`plane.ts`, `planeController.ts`): throttle sets a speed between the stall (2.6 cells/s) and the top (8), cruise 5; pitch sets the flight path angle (up to 22° climbing, 28° diving), which levels out without input; below the stall the nose drops; bank (up to 40°) turns it at up to 0.85 rad/s and levels out. The ground or water under it or under its nose, or a tower's top, within 0.15 steps is a crash: it is put back where it was 3 s earlier, at least 2.5 steps up. The ceiling is 14 steps over the world's highest ground. Its shadow is the `vehicle.plane` model's `part` 1 (its outline from above, one voxel thick, dithered) on the highest ground under its outline; the camera looks between the two, so height reads as the gap.
- **Pace:** speeds are in cells per second and tuned to the screen, not to real metres: a warped level compresses the empty desert (500 m cells) against the Strip and Hoover Dam (100 m) and the rim (150 m), so a steady pace covers real distance fastest where there is least to see. A level's speeds scale by `(metres per cell / ref)^0.3`, between a floor and 1: driving `ref` 400 m (floor 0.55: San Francisco's 25 m driving level runs at 0.55), flying 1,500 m (floor 0.5).
  - **Driving, at pace 1:** motorway 11 cells/s, trunk 9.5, primary 8, secondary 7, tertiary 6.5, residential 5.5, living street and service 4; off-road 3.5 × the surface (urban 0.9, desert and grass 0.8, sand 0.5, rock 0.45, forest 0.35, water 0); acceleration 4.2 cells/s², braking 12, reverse 2.2.
  - **The run** (`run.ts`, driven by the autopilot with a fixed 1/30 s step): Las Vegas Boulevard → Hoover Dam (over the bypass bridge) is 52 s for 308 cells; on to the South Rim by Mather Point (US-93, I-40, AZ-64) 159 s for 1,009 cells; 3 min 31 s for 1,317 cells in all, 0.5% of them off the asphalt where it cuts corners. The take-off run down AZ-64 takes 5 s; the canyon flight (north across it, east along it past the North Rim to Desert View, back west, then south to land on I-40 at Williams) 48 s and 224 cells, with no crash. The autopilot holds the speeds a player can, so the run takes about as long played.
  - **Frames (software rendering):** run in real time (`?run=1`) under SwiftShader at 1280×720 with traffic, the run's 15,365 frames had a median of 16.7 ms and a 95th percentile of 16.8 ms; 403 (2.6%) took over 20 ms, the worst 1.5 s, while tiles baked (1.1 s each in software) and at the two level changes (8.8 s and 11.6 s to show the new level). A frame redrawn takes 15 ms (`timeFrames`). Driving a motorway for 15 s: 16.7 ms median, 16.8 ms at the 95th percentile, 28 of 625 frames over 20 ms. The 60 fps check is on a desktop GPU: `?run=1` reports the same numbers on the page.
- **Take-off:** at 7 cells/s or more (paced), on a road running straight ahead (traced, within 0.75 cells of the heading's line) for 8 cells, T loads the level named `fly` at the car's lon/lat; the heading crosses as the direction to a point one cell ahead, through both geo grids (D-048). The plane starts 1.6 steps up, climbing 6°, at cruise. **Landing:** within 1.2 steps of the ground, at 3.8 cells/s or less, within 1.5 cells of a road, for 0.6 s (or L), loads the `drive` level at the plane's lon/lat; the car starts on the nearest road within 8 cells, along it, rolling. A place outside the driving level starts at its start, and the HUD says so.
- **HUD:** gauge speed (12 km/h per cell/s at the level's pace: a feel, not a measurement), level, the nearest registry landmark within 3 km or else a town from a small gazetteer, lon/lat, the plane's altitude and height over the ground in real metres, a minimap of the routes, key help (H). `?world=`, `?start=lon,lat`, `?traffic=0`, `?run=1` (the run in real time, then its frame times), `?paused=1` (the vehicle waits for a script).
- **Tests:** unit tests for the physics, roads, decks, the route planner, the pilots and the controllers on a fake view; `e2e/game.spec.ts` scripts the Strip, a building, a take-off sampled every frame for a flash, a flight over the shadow, a landing, and the San Francisco and `start=` starts.
- **Rejected alternatives:**
  - **Speeds in real metres per second, time-compressed per level like traffic's (D-060):** on a warped level a steady real speed crawls across the Strip and races across the desert on screen. At a pace that reads on the Strip (8 cells/s at 100 m per cell), the desert's 500 m cells pass at 1.6 cells/s, and the 450 km by road take about ten minutes, most of them in empty desert.
  - **Driving on traffic's routes only:** snaps the car to polylines; the brief asks for free driving on the roads and terrain. The routes still give the roads' surfaces and decks, the autopilot's plans and the minimap.
  - **Swapping a view's world in place (`view.loadWorld`):** every part of a view (store, geo grid, objects, bake worker, tile grid, queries, layers) belongs to one world; rebuilding them in place would rewrite the view for the same result as a second view that takes over.
  - **Tilting the car on slopes:** entities are baked per heading only; pitch would multiply the sprites. A bob reads the bumps for nothing.
- **Known limits:** the car doesn't join traffic's routes or obey junctions, and traffic doesn't yield to it; behind slow traffic it bumps until it steers round. The scripted run's autopilot doesn't overtake, so it drives through traffic (`collideTraffic` off). The autopilot cuts corners on the stairs of octilinear roads. Runways aren't in the data, so a take-off needs a straight road. The flying levels have trunk and motorway roads only, so landings are on those.

### D-071: Generator plugins, and San Francisco's generators as the city pack's browser half (accepted, M4)
- **Why:** San Francisco's facades, towers and Chinatown were built into `@pixelworlds/generators`, so every page carried them and another city's building types meant editing core. As a library (library.md, D4), a city's generators must come as a package, as its facts already do (D-068).
- **Registry** (`@pixelworlds/generators`, `registry.ts`): `registerGenerators(record, { source, replace })`, `hasGenerator`, `getGenerator`, `listGenerators`, `unregisterGenerators`. It starts with the built-ins (`builtins.ts`), read on first use so that importing the package does no work. Registering a name again from the same source replaces it; another source's name, a built-in's included, is an error unless `replace`.
- **Missing generators:** a `MissingGeneratorError` names the generator and the group that asked for it, and for the plugins published from this repository (`KNOWN_PLUGIN_GENERATORS`) the plugin to load, as the pipeline's registry does for `datasf`.
- **Plugins:** a plugin is `{ name, register(api) }`. Its module calls `definePlugin(plugin)`; a page passes a descriptor `{ name, url }` (the module's URL) to `createWorldView({ plugins })`, or a function given the plugins the style pack names.
  - **The bake worker** runs the generators, and functions can't be posted to it, so the plugin travels as a URL: `loadPlugins` before `init`, the worker imports each module, registers the plugin through an API bound to its own registry, and answers `pluginsLoaded`. Messages that arrive meanwhile wait. A plugin that fails to load fails `createWorldView`.
  - **Found by announcement:** `definePlugin` adds the plugin to a realm-wide list (`Symbol.for("pixelworld.plugins")`). Vite drops a worker bundle's exports, and a bundled plugin carries its own copy of the generators package; the announcement survives both, and registration always goes through the loader's API.
  - **The main thread** registers each plugin too (entity models, the inline baker): the descriptor's `plugin`, or its module by URL.
  - **Style packs** name the plugins they need: `"plugins": ["@pixelworlds/city-sf"]` in bay-area. A named plugin a view doesn't load is a warning; the tile cache key includes the loaded plugins (name and `version`).
- **The city pack's browser half:** `@pixelworlds/city-sf` (`packages/city-sf`; the Python half is `pixelworld-city-sf`): `rowhouse` (with the stucco rows), `block`, `decoTower`, `sfTower`, `gate` and `lanterns`, their tests, `cityPlugin` (the descriptor; the worker module built with Vite's `?worker&url`, 28 KB) and `register()` for the main thread. Core keeps what every region uses: terrain, trees, the generic building, city blocks, dams, the landmark kit, the rail props and the vehicle models. The Southwest's style names only built-ins.
- **Wiring:** the viewer loads the plugins the world's style names, so the bench page and the hero bake tool, which drive it, do too; the minimal example passes `cityPlugin`.
- **Neutral:** every e2e golden is unchanged, and eight scenes (seven of San Francisco's on its three levels, by day and night, and the Southwest's) are identical pixel for pixel to before, in dev and in the production build. The bake worker's bundle shrinks from 148 to 124 KB and the viewer's main bundle from 282 to 260 KB; San Francisco's generators load as their own 28 KB module.
- **Rejected alternatives:**
  - An app-written bake worker entry that imports its plugins statically: one bundle and no URLs, but every app would write and maintain a worker file, and a view couldn't pick plugins by the world it opens.
  - A registry shared through `globalThis`: plugin bundles with their own copy would then register directly, but any copy of the package, of any version, could change any other's table. Only the announcement list is shared.
  - Keeping San Francisco's generators built in "with clear names" (library.md §4.5): every page would still carry them, and the next city would have no template.
- **Later:** a published build of the pack (a self-contained `dist/worker.js` and a descriptor on `new URL("./worker.js", import.meta.url)`, with the npm packaging); the bay-area style pack as a data package beside it; plugins for other extension points (hand-drawn assets, layers).

### D-072: Tiles are cached by the code that bakes them; a failed model is a marker; load errors name the URL (accepted, M4)
- **Why:** a developer-experience review found three ways the engine hid what went wrong.
  - **Stale tiles:** the tile cache keyed on `BAKE_VERSION = "m1.6"`, bumped by hand (D-028). 41 commits to the generators and the baker went by without a bump, so an edited generator never showed after a reload (0 pixels changed until `?cache=0`), and returning visitors could get old tiles.
  - **Blank tiles:** one missing or throwing generator failed every tile its model touched, and `ready()` still resolved. San Francisco without its city pack drew nothing but traffic over a void. Errors came once per model, without the group, seed or footprint.
  - **Opaque loading errors:** a wrong `worldUrl` behind Vite gave `SyntaxError: Unexpected token '<'`, and a missing manifest `manifest: HTTP 404`, without the URL.
- **The bake code's identity** (`BAKE_CODE`, `packages/bake/src/code.ts`, computed by `tools/bake-code.mjs`): 16 hex digits of a SHA-256 of the source of everything that turns a package and a style into tile pixels.
  - **What it covers:** the bake worker's module graph, followed from `packages/runtime/src/bake.worker.ts` through relative and `@pixelworlds/*` imports (TypeScript's `preProcessFile`, which skips comments). That is the baker and its shaders, the built-in generators, the grid, the style's tables, the bake host and hero paint. It adds the main-thread code that decides what a bake is given: the world format's decoding (followed from its index), the chunk store, and the engine's `world.ts` (bake init, and the tile slices, moved there from `view.ts`). 40 files today.
  - **What it leaves out:** the compositor, cameras, fog, the tile cache, the view loop, the rover and the apps. An edit there keeps every cached tile.
  - **How it reaches the engine:** a constant, `__PIXELWORLD_BAKE_CODE__`. The npm build (`packages/pixelworld/build.mjs`) defines it and fails if a built file still reads it. In the apps (`apps/web`, `apps/game`, `examples/minimal-viewer`), a Vite plugin from the same file sets it on transform, in dev and in `vite build`. When a file it hashed changes, its `hotUpdate` adds the constant's module to the update, so the reload that follows the edit gets the new hash.
  - **Without it** (a bundler without the plugin, tests), `BAKE_CODE` is null and the engine keeps no tiles in IndexedDB, with a `console.info` saying why. An app's own `TileStore` is still used.
  - **`BAKE_VERSION` is gone,** and with it D-028's "bump `BAKE_VERSION`" rule. Nothing is left for a hand-set number to cover.
- **A plugin's code** is in the key with its name and `version`: an FNV-1a hash of the source text (`toString()`) of the generators it registered on the main thread, and of its module's text and the modules that imports by URL. Those are fetched from `url` after the main thread has registered the plugin, and only with a cache.
  - **A bundled plugin** is one file, so its text is its whole code.
  - **In a dev server,** each source module comes on its own URL, so a helper outside the registered generators counts too, across server restarts. Vite's `?t=` timestamps are taken out; npm dependencies count by the version in the importer's URL; `/@vite/` modules and URLs in comments are left out.
  - **`version`** is optional now: it still keys the cache, for a plugin that draws differently with the same code.
- **The key:** package id and hash, the style pack's hash (fog left out), `bake:<BAKE_CODE>`, the objects flag, a render scale other than the package's, then `plugins:<name>[@version]#<code>,…`. Every old key becomes unreachable once, and the cache's least-recently-used pruning clears the old entries.
- **The dev servers still cache by default.** With the key following the code, a reload after an edit to the bake bakes afresh. A reload after any other edit (camera, compositor, rover, app, a fog or traffic change) draws from the cache, in about a second instead of a full rebake (28 s for the default view under SwiftShader). The style hash was already right for art changes. `?cache=0` stays, for timing cold bakes.
  - **Checked** in the viewer's dev server (San Francisco, 4 tiles, one browser profile, edit then reload). A plain reload, and reloads after edits to `engine/src/camera.ts` and `runtime/src/compositor.ts`: 0 baked, 4 cached. After edits to `generators/src/builtins.ts` and `bake/src/shaders.ts` (new `BAKE_CODE` each time), and to the city pack's `facades.ts` (a helper, not a registered generator; `BAKE_CODE` unchanged): 4 baked, 0 cached. The npm build's `BAKE_CODE` equals the hash of the sources it was built from.
- **Failure containment** (`@pixelworlds/generators` `failures.ts`; `buildObjects` calls it for each model).
  - **What fails:** a model whose generator isn't registered, throws, or returns no voxel model.
  - **What is drawn instead:** a missing-model marker, a checkerboard of 4-voxel squares in the pack's `marker` ramp and the asset's own first ramp. Over a footprint it is a low slab (the marker squares 4 voxels high, the others 2). Where there is no footprint it is an 8-voxel block in a 3D checkerboard. It is small, so it can't pass for what it replaces.
  - **The rest of the tile bakes:** the other models, the terrain, the tile itself.
  - **The record:** a `ModelFailure` holds the group, generator, seed, place, footprint (cells and voxels), height in voxels, who registered the generator, the plugin a missing one comes with (`KNOWN_PLUGIN_GENERATORS`), and the error. The worker sends the records with each bake of the tile, in every rotation.
  - **Not cached:** a tile with markers isn't written to the persistent cache, so a reload bakes it again and reports why, instead of drawing markers from IndexedDB in silence.
  - **Reporting** (`runtime` `ModelFailures`, in `BakeService`): each model is counted once, by place and seed, or by variant for a repeated object. `onError` (default `console.error`) gets one message per generator and cause; causes that differ only in their numbers are one cause. For a generator nobody knows, the message names the plugins the style pack names but the view didn't load. `stats().modelsFailed` is the count.
  - **Other errors:** the plugin-load and registry errors of D-071 are unchanged; the style-names-a-missing-plugin warning adds that its models become markers. A bake that fails outside a generator still fails its tile, and the error now names the tile and rotation.
- **Loading errors** (`@pixelworlds/world-format` `fetch.ts`): `fetchWorldFile` and `fetchWorldJson` throw a `WorldFetchError` (with `url` and `status`) for a network failure, an HTTP error, an HTML page where data was expected (by content type, or a first byte of `<`), gzip that doesn't inflate, or JSON that doesn't parse. `parseWorldFile` adds the URL to a parser's error.
  - **The message:** `<what>: <url> <problem> (expected <what should be there>)[: cause][; hint]`. For example: `not a world package: /foo/manifest.json returned an HTML page (expected a world manifest); check worldUrl ("/foo/")`, and `world chunk 3,4: /sf/chunks/3_4.pxwc?v=… answered HTTP 404 Not Found (expected a chunk the manifest lists); the package is incomplete, or its files are from different builds`.
  - **No answer at all** (a server that's down, a cross-origin host without CORS headers) asks about the server instead of the package.
  - **Where it is used:** the manifest, chunks (the chunk store and `runtime`'s whole-world `loadWorld`), objects, routes (`sim`), the geo grid and the hero PNGs.
  - **The style:** a style resolver that throws is wrapped with the pack's id, plus a hint when it parsed an HTML page.
- **The viewer:** `stats()` and the HUD show `modelsFailed`. `?plugins=0` loads no plugin, to show a style's models failing. The e2e `open()` helper asserts that no model failed in any scene.
- **Tests:**
  - **`tools/bake-code.test.mjs`:** what the identity covers. It changes for an edit to a generator, the voxel model, the baker, its shaders, the bake host, `world.ts` or the chunk codec, and not for the compositor, the view or the rover. It follows a new import. The Vite plugin's transform and hot update.
  - **`engine/test/plugins.test.ts`:** the plugin key changes with a registered generator's source and with an imported helper's text, not with `?t=` stamps.
  - **`engine/test/world.test.ts`:** the tile key changes with the bake code and the plugins' code, and stays stable otherwise. No IndexedDB without an identity. The style resolver's errors.
  - **`generators/test/failures.test.ts`:** markers and failure records for a throwing, a hollow, a missing (known plugin) and a repeated model, while the good models are drawn.
  - **`runtime/test/modelFailures.test.ts`:** messages, one report per generator and cause, the count, and through `BakeService`.
  - **`world-format/test/fetch.test.ts` and `runtime/test/chunkStore.test.ts`:** every loading error.
  - **e2e (`render.spec.ts`, "Failures"):** a wrong world URL's message in the HUD; San Francisco with `plugins=0` bakes every tile, with markers in the marker ramp and one error per generator naming `@pixelworlds/city-sf`, and with the cache on writes none of them to it.
- **Neutral:** a tile whose models all generate is drawn as before: the goldens run for this change (the M0 overview, Las Vegas, Telegraph Hill) are unchanged, and the persistent-cache e2e test passes. The packed package passes `pnpm package:check` and the Vite and plain-ESM consumers (`tools/consumers.mjs`).
- **Rejected alternatives:**
  - **Hashing in the browser the worker's own script and what it imports:** no build hook, but the main-thread inputs aren't in the worker, and a fetch of the worker at every start. A dev server's per-session `?t=` stamps can't tell an edit made while the server was down. The source walk sees the files themselves. Plugins do use this, for want of a build hook in a third party's project.
  - **The registered generators' `toString()` alone, for the built-ins:** it misses the helpers outside them (most of `builtins.ts`, the voxel model, meshing, the landmark kit) and the baker.
  - **Hashing whole packages** (bake, generators, runtime, engine): simpler to state, but every edit to the compositor, cameras, fog or view loop would rebake every tile, the case where the warm cache saves most.
  - **Cache off in dev, or a key per server start:** correct, but it throws the warm cache away for the many edits that can't change a tile.
  - **A CI check that `BAKE_VERSION` was bumped:** still a hand step, and the rule had been missed for 41 commits.
  - **Skipping a failed model without a marker:** the picture would hide the failure. **A full-size box:** it would pass for the building.
  - **Failing `createWorldView` when the style names a plugin that isn't loaded:** kept a warning (D-071). With markers the view is usable, and the failure is on screen and counted.
- **Known limits:** a plugin module the page can't fetch (CSP `connect-src`, offline) keys by its URL, its generators' source and `version` alone. An app that passes `workerUrl` with a worker from another release than its engine gets the engine's identity. A new Vite app in the repository needs the plugin, or it keeps no tiles. The entity models of `view.entities` and traffic still throw on a missing generator: they aren't tiles.

### D-073: Views that switch cleanly, game time, world → canvas and baking ahead (accepted, M4)
- **Why:** a game developer building on the published package (the DX review's game, a drone courier over San Francisco) hit the gaps a real game hits next. A level switch reusing its traffic layer never showed the new level; HUD labels needed the projection reverse-engineered; pausing meant pausing every part by hand; a fast player flew into unbaked void with traffic floating over it; and the autopilot won before the first frame was drawn.
- **Bakes settle on dispose:** `BakeService.dispose()` resolves every sprite and object bake still asked for with null (it dropped them before), rejects plugin loads, answers later bakes with null at once, and drops answers and prepared tiles that arrive afterwards. A layer counting its bakes is no longer left waiting by a destroyed view.
- **One view at a time:** a layer or controller added to a view leaves the view it is in first (`dispose` there; a controller is detached), so the old view stops drawing and updating it, and destroying the old view later leaves it alone. `Layer.dispose` means "leave the view"; `init` starts the per-view state afresh. Traffic's layer resets its sprites and pending bakes when it joins or leaves a view, and drops a bake from a view it left (giving the sprite back to that view). A sprite whose bake failed (null) is settled, not waited for, in traffic and in entities, so it can't hold up `ready()` either.
- **Game time:** the `dt` controllers, layers and `onFrame` listeners get is game seconds: the wall-clock frame time (at most 0.1 s) × `view.timeScale`, and 0 until the view's first complete frame (`view.started`) and while `view.paused`. Updates still run every frame, with a `FrameClock` (`dt`, `realDt`, `time`, `started`, `paused`) as the controller's second and the layer's third argument and in `FrameEvent`, so a camera can ease while paused. With `replace`, a new view's time starts when it takes over. `FrameEvent.dt` was wall-clock time; it is now game time (`realDt` is the old value).
- **World → canvas:** `camera.project(x, y, h?)` returns canvas CSS pixels and `onScreen`, the inverse of `query.pick` (the same origin, sub-pixel shift, zoom and pixel ratio); without a height, the ground.
- **Baking ahead:** the wanted tiles are the visible ones, then those a view `lookAhead` seconds (default 1.5) along the camera's measured motion would show, then `view.prefetch(x, y, radius?)` requests, then the ring around the view. `ready()` waits for the view and its ring, not for tiles baked ahead. `view.isDrawn(x, y)`, `frame.isDrawn` for layers, and `stats().tilesPending`. Entities and traffic aren't drawn where the ground under them isn't baked.
- **Saved state:** an optional `Controller.serialize`/`restore`, kept in `ViewState.controller` under the controller's id (the rover's: its place and switches).
- **Landmarks drawn from an anchor** (City Hall, the towers) occupy, in `objectsAt`, the voxel columns of the model the bake generates for them, worked out when a query first comes within 16 cells (one generator call each; City Hall's 5.6 × 7.9 cells took about 25 ms in Node); else their anchor's cell.
- **The example game:** P pauses through `view.paused` (kept across level changes), and the HUD names the landmarks in view over them with `camera.project`.
- **Neutral:** the existing unit tests pass (a fake `FrameInfo` gained `isDrawn`), as does the game's e2e; the e2e goldens checked (traffic on Russian Hill, fog at the Golden Gate, Las Vegas, the silhouette) are unchanged. Without camera motion or prefetches, the bake order is exactly the view's as before. The review's own repro (a traffic layer moved to a new view after its old one was destroyed mid-bake), run on a package built from this change, now shows the new view (it hung with 8 bakes pending), and its game typechecks against the new types unchanged.
- **Rejected alternatives:**
  - **Holding controller and layer updates until the view is ready** instead of a zero `dt`: a controller couldn't put the camera on its vehicle while the view loads, and traffic couldn't keep its focus on the camera.
  - **Letting a layer be in two views** (the old one drawing it while the new one loads): its sprites, simulation focus and bakes would belong to whichever view called it last, and the old view's `dispose` would wipe the new one's state.
  - **Drawing a placeholder under sprites over unbaked ground:** the void says "still baking" honestly; a flat placeholder would be redrawn when the tile arrives and could disagree with it.
- **Later:** a fixed-step `update` option for controllers and layers (every game writes the accumulator); an input action map; `floorAt(x, y)` combining the ground and object tops.

### D-074: San Francisco's city pack packaged for npm, and the viewer's city packs in one file (accepted)
- **Why:** `@pixelworlds/city-sf` was a private package of TypeScript sources that imported the workspace-only `@pixelworlds/generators` and Vite's `?worker&url`. A project outside the repository couldn't install it, and San Francisco without it draws almost nothing (4% of a frame). The DX review's game developer copied 7 source files (1,764 lines) and added an alias and tsconfig paths. D-071 left the published build for later.
- **The package:** no longer private, MIT OR Apache-2.0, `publishConfig.access: public`. Not published yet: releases stay manual.
  - **Its peer:** `pixelworld` (`workspace:^`, which `pnpm pack` writes as `^<version>`). Its sources import `pixelworld/generators`, which in the workspace is the same module as `@pixelworlds/generators`, so the packed entry and types name only the peer.
  - **In the workspace** its `exports` stay on `src/`, so the apps, tests and typecheck run it unbuilt. `publishConfig.exports` points the packed manifest at `dist/`, as for `pixelworld` (D3).
- **The build** (`packages/city-sf/build.mjs`, tsup; `prepack` runs it):
  - **`dist/index.js` and `index.d.ts`:** `pixelworld` stays external. The `?worker&url` import becomes `new URL("./worker.js", import.meta.url).href`, which bundlers follow with no configuration: Vite's dev server (its optimizer rewrites the URL to the file in `node_modules`), a Vite build (an asset), webpack 5 (an asset) and Rollup.
  - **`dist/worker.js`:** self-contained and minified, 28 KB, as Vite's bundle of it was.
  - **The descriptor** carries the package's version, so a returning visitor's tile cache follows releases.
- **Checks:**
  - **The tarball** (`tools/city-pack-check.mjs`, in `pnpm package:check` and CI's npm job): its files; its manifest (`pixelworld` its only peer, no dependencies, `publishConfig` applied); its exports; the `new URL`; imports of the peer only. The worker module is imported alone in Node: it must define and announce the plugin and register exactly the generators `KNOWN_PLUGIN_GENERATORS` gives it. Size budgets too.
  - **The consumers:** each example (Vite dev and build, webpack 5, plain ESM) also draws San Francisco's flying level from both tarballs, loading the pack because the style names it. A run needs the pack's worker module loaded from where the bundler put it, tiles baked, no error or plugin warning, and at least half the frame drawn: 100% with the pack, 4% without.
- **Versions:** changesets versions both packages, each on its own. `.changeset/city-sf-npm-package.md` makes the pack's first release 0.1.0, beside `pixelworld`'s. A `pixelworld` release that leaves the pack's peer range bumps the pack (patch), so it is republished with the new range.
  - **Pins:** the consumer examples pinned `pixelworld` `^0.1.0`, a version that doesn't exist. They, the CDN recipe and the plugin quickstart now name the packages' versions (`^0.0.0` until the first release).
  - **Kept in step:** a unit test (`tools/version-pins.mjs`) fails when the pins drift; its `--write` is a release step.
- **Docs:**
  - **npm.md:** San Francisco's traffic example loads the pack (it drew a blank world); install, plugins and the two-package release (§1, §2, §6, §7, §9).
  - **plugins.md §9:** in public names (`pixelworld/engine`, `pixelworld/generators`), with a quickstart for a city pack outside the repository: scaffold, generator, worker module, descriptor, build, a style pack that names it, a view, a test (§9.6). It was followed as written in a scratch project against the packed `pixelworld`: Vite dev and build drew its adobe houses, from a 2.5 KB worker module.
- **The viewer:** its city packs are one file, `apps/web/src/plugins.ts` (`CITY_PACKS`). A style that names a plugin missing from it gets a warning saying where to add it. `?style=` is documented (plugins.md §9.7, README).
- **Neutral:** the engine's plugin loading is unchanged, and San Francisco draws as before in the workspace.
- **Rejected alternatives:**
  - **Keeping the `@pixelworlds/generators` imports and aliasing them in the build:** the declarations would need rewriting too, and the repository's pack would stop being a template an outside author can copy.
  - **Building the pack into `pixelworld`'s bake worker:** every page would carry San Francisco again (D-071), and the worker has a size budget.
  - **`fixed` or `linked` versions for the two:** a city pack versions like any plugin; its peer range says which `pixelworld` it works with.
  - **Discovering packs by globbing `packages/city-*` in the viewer:** a pack from npm would still need a list, and a glob of source paths bypasses package resolution.
  - **`optimizeDeps.exclude` in Vite apps:** not needed, since Vite 8's optimizer rewrites `new URL(…, import.meta.url)` in pre-bundled packages.
- **Later:** the first publish, by a maintainer ([npm.md §9](npm.md#9-releases)); the bay-area style pack as a data package beside the pack.

### D-075: Style packs get a versioned JSON Schema, path-qualified validation and `extends` (accepted)
- **Why:** the content and game reviews found that a style pack's mistakes pass or fail far from their cause. A misspelt key was ignored, a missing role drew in an undefined colour, errors named no pack, ramp or place, one bad comma blanked every world in the viewer, and the 42-ramp cap was undocumented. library.md claimed a schema that didn't exist.
- **The schema:** `packages/style/schema/style-pack.v1.schema.json`, draft-07 for the widest editor support. Packs name it in `$schema`, and npm ships it as `pixelworld/style-pack.v1.schema.json`.
  - **Hand-written, in TypeScript** (`schema.ts`). The JSON file is generated from it by a test that fails while it is stale. Descriptions live in `schemaDocs.ts`, keyed by path; a test checks every key has one and none is stale.
  - **The loader walks the same schema** (`checkSchema`, about 23 keywords), so editors and the loader can't disagree on a pack's shape. Cross-field rules a schema can't state are checked in code after it: names that must exist, strata order, scatter.
  - **Packs that `extends` another** get a generated lenient variant: no key required, any key may be `null`, chosen by `if`/`then`/`else`.
  - **Checked against a standard validator:** ajv 8 in strict mode agrees with `checkSchema` on both packs, the variant fixture and 14 edited ones, 13 of them broken (a one-off check, not a dependency).
  - **Versions:** the major version is in the file name and `$id`. Optional keys are added in place. A breaking change makes v2 beside v1. A pack naming another version is refused before its keys can read as typos.
- **Messages:** every problem has a path (`ramps.desert[0]`, `assets["building.residential"].generator`). A misspelt key, enum value or name gets a "did you mean" (edit distance with swaps, about one edit per three letters). All problems are listed at once, under the pack's id. A `StyleError` carries `pack` and `issues`.
- **When a view starts:** after its plugins register on the main thread, every asset's generator must be in the registry, or the view fails with a `StyleError` naming each one and a likely match, or the city pack to add. This is the same strictness as an undefined ramp, which already failed the view. It is skipped while a plugin the pack names isn't loaded (already warned), since its generators can't be told from typos. The engine edit is one line in `createWorldView` and a function in `plugins.ts`.
- **Roles:** `ctx.ramp(role)` throws a `MissingRoleError` naming the asset (its key in the pack, found only on error), the generator and the role, and listing the asset's roles. `ctx.ramps(role)` stays empty for a missing role, since generators use that for optional roles (`eave`, `sign`, `deco:` scopes). `VoxelModel.material` refuses a value that isn't a ramp id instead of drawing in no colour.
- **Loading:** `parseStyleJson` names the file, line and column with its own scanner, because V8 omits the position for some errors and Safari for all. `createWorldView` wraps a resolver's errors with the pack id and warns when a resolver returns another pack. The viewer reads each pack as text only when a world needs it (`import.meta.glob` with `?raw`), so one broken pack fails only its worlds and the HUD shows the error, wrapped. An unknown pack id lists the packs there are, with a "did you mean".
- **`extends`:** the region specs' rule: objects merge key by key, anything else replaces, `null` deletes. Keys keep the parent's order, so the parent's ramps keep their palette indices. The child needs its own `id`; chains are capped at 8 and circles are errors. `resolveStyleExtends(pack, load)` merges; `createWorldView` merges with its resolver, and the viewer's loader merges so `?style=` takes variants. The merged pack keys the tile cache. The content review's `desert-adobe` is a 1 KB test fixture, not a committed pack.
- **The 42-ramp cap:** documented in the style guide, the schema and the error message. Every ramp of both committed packs is used: `node tools/swatches.mjs <pack>` shows what uses each ramp. Raising the cap means a ninth index bit: the bake's output (alpha only flags coverage), the G-buffer's ramp, a 512-entry palette texture, the fog's 8-bit per-index lookups, the night palette, and hero paint-overs, which are 8-bit indexed PNGs, plus a `BAKE_VERSION` bump. Goldens could stay identical, since packs within 42 ramps keep their indices. It isn't done here: the change is across the bake format and wants measuring on its own.
- **Cost:** `createWorldView` as an app bundles it grows from 65.7 to 70.1 KB gzipped (budget 80); the bake worker from 44.7 to 45.1 KB (the role errors). Keeping the descriptions out of the runtime schema saved 2.9 KB, and building the schema in a pure function keeps it out of the worker.
- **Neutral:** the goldens checked (the Grand Canyon overview, Alamo Square's rows) are unchanged, and the Strip's night palette test passes. Adding `$schema` changes the packs' hash, so cached tiles re-bake once.
- **Rejected alternatives:**
  - **Generating the schema from the TypeScript types** (ts-json-schema-generator): a new dependency and build step, and the types can't say ranges, the hex pattern, the ramp cap or which keys are closed without annotations on every field, so the source would be as long.
  - **Validating with ajv at run time:** about 120 KB, and its code generation (`new Function`) breaks under a strict CSP.
  - **Generators declaring their roles** (`defineGenerator({ roles })`), with packs checked in advance: roles are dynamic (variants by seed, scoped roles with fallbacks, optional roles), so declarations would be incomplete or need a small language of their own. The error when a generator asks has the exact role and asset.
  - **Warning instead of failing on an unknown generator:** the tiles would bake with failed or placeholder models while the cause scrolls past in the console.
- **Later:** packs as data packages; a palette page in the viewer; line numbers for schema problems when the pack's text is at hand.

### D-076: Every package has a geo grid; specs are checked against a schema; builds are staged (accepted, M4)
- **Why:** a developer-experience review built a world of a new town (Jerome, Arizona) from nothing. The build crashed in its last stage, the hash it printed wasn't the package's, 9 of 20 broken specs gave Python tracebacks and 3 built silently, builds were silent for minutes, exit 1 meant both "road problems" and "crashed", and no document said how to make a world.
- **Every package has a geo grid** (D-048): the lon/lat of cell corners every 16 cells (uniform) or 4 (warped), not only packages with `levels:`.
  - **The crash:** traffic routes place Overture's rail and ferry lines through the geo grid (D-060). A single-level spec with a railway in its bounds had none and raised a bare `ValueError` after the package was written.
  - **Chosen over routes without it** (projecting through the region for uniform layouts): one code path instead of two; a warped spec without levels would still have needed the grid; and the client's lon/lat queries (`lonLatToCell`, a rover or camera start at a lon/lat) and style fog need it too, which were silently off for such packages. It costs 190 bytes for Jerome.
  - **Older packages:** `pixelworld routes` on a package without a geo grid makes its road routes and skips rail and ferries, with a note, instead of raising.
  - **Unchanged:** packages with levels are byte for byte as before (`sf-fly` rebuilt identical to the committed one, routes included).
- **Staged builds:** a build writes into `.<out>.building/` beside `--out`, then moves the files into place one by one, manifest last, and removes the old package's files it didn't write (other files stay). A failed build leaves `--out` exactly as it was, and a first build that fails leaves no package. Moving files rather than the directory keeps a running dev server serving a whole package.
- **The final hash:** the routes stage rewrites the manifest and its hash; `pixelworld_pipeline.build` now returns, and the CLI prints, the hash read back from the manifest written.
- **The spec schema** (`schema.py`): one table of every key, with its type, range, default and meaning.
  - **Checks:** unknown keys (with "did you mean": close spellings, other case, or the one name a key starts), required keys (a misspelt one is reported once), types, ranges and whole numbers, unknown values (road and path classes, land-cover classes, surfaces, rail kinds), dates YAML made of unquoted releases, a start outside the bounds, landmark ids against the registry, and the style pack.
  - **Where:** every problem carries its file, line and key path, through `extends:` chains and `warp:` files (a YAML composer keeps each key's line). YAML syntax errors, missing `extends:`/`warp:` files and an Overture release that doesn't exist are spec errors too. Plugin options beside `facts:` are kept, unless one is a typo of a known key.
  - **Style packs:** checked against the nearest `_styles/` above the spec, else this checkout's `worlds/_styles` (an installed pipeline outside a checkout doesn't check). A pack of one's own goes in a `_styles/` beside the spec.
  - **Commands:** `pixelworld check <spec>…` validates without building or downloading; `pixelworld reference` prints the reference, which docs/worlds.md §10 holds and a test keeps equal; the docs' example specs are validated by a test too.
  - **Defaults:** `sources.rivers` defaults to `[river]` (it was required by accident). Null optional sections no longer crash the stages that read them.
- **The CLI:**
  - **Progress** goes to stderr, a line per stage with the time since the start, and the stages' notes under it; the build ends with a summary (cells, chunks, objects, routes, hash, time per stage) and the report path. `--json` prints the report to stdout.
  - **Exit codes:** 0 done; 1 the package was written but its road report found problems; 2 the spec or command line is invalid; 3 the build failed, with the stage it failed in and, for anything but a download, the traceback.
  - **`pixelworld view <package>`** serves a package with CORS and prints the viewer URL with `?world=<url>`, warning if the viewer isn't running or lacks the package's style pack.
  - **Help** without decision ids; every argument explained; `--version`; the exit codes and `PIXELWORLD_CACHE` in the epilog. `pixelworld plugins` sizes its columns to the names.
- **The editor:** "Build world" runs `pixelworld_pipeline.build`, routes included (it called the stage build, which writes none). The source map is about 1,024 pixels across whatever the region's size (it was fixed at 400 m per pixel, 8 × 7 pixels for Jerome), and the preview mesh, the lattice, new focus areas and the background range follow the region; the Southwest keeps its 400 m, 4 km and 10 km. The viewer link follows `--out`.
- **The M0 builder** caches through `sources.http` (`PIXELWORLD_CACHE`, retries, the project's User-Agent); its package is byte-identical.
- **Fixtures:** `exp-desert-view-*` were rebuilt: they gain a geo grid and routes, and objects file version 2 with the same instances, and draw identically. `exp-strip-*` stay as built in M1.5: a rebuild adds Overture's roof and facade hints to 157 buildings (M3), which moves `exp-strip-k4-r0.png` by 288 channel values, so they wait for the golden to be re-made (fixtures/README.md).
- **Docs:** [worlds.md](worlds.md), "Make your own world", with Jerome (`worlds/jerome/region.yaml`, no committed package) as the worked example and the generated reference; architecture.md §4 shows the real spec format; `pipeline/README.md`.
- **Rejected alternatives:**
  - **JSON Schema** (and the `jsonschema` package): no line numbers or "did you mean" without a layer of our own, cross-key checks (start inside bounds, styles, landmarks) outside it anyway, and a reference generator to write either way.
  - **Marking a failed package** (deleting its manifest, or a `BUILD-FAILED` file) instead of staging: the previous good package would be lost, and a dev server would serve a broken one meanwhile.
  - **Hiding the progress behind `--verbose`:** a 3-minute build that prints nothing looks hung.
- **Later:** a CI job that rebuilds the cheap fixtures (M0, `exp-*`) from the cache and compares hashes; `pixelworld new <id> --bbox w,s,e,n` to scaffold a spec; the editor's warp preview of a spec without a warp is solved on the region's envelope, so it can be a cell narrower than the uniform build (147 × 134 against 148 × 134 for Jerome); the editor's port (5180) is the minimal example's too.

### D-077: Contributor tooling: a pixel inspector, a model preview, e2e servers per checkout, a smoke subset and CI shards (accepted)
- **Why:** a developer-experience review of the contributor's loop found the workflow scattered or missing (no contributor guide; goldens, `PW_PORT`, changesets and the debug API documented in passing or not at all), a 21-minute serial e2e run with no quick subset, a fixed editor port and silently reused servers (two checkouts could test each other's code), no way to ask which ramp or generator drew a pixel, and no way to look at one model without loading a world.
- **Docs:** [CONTRIBUTING.md](../CONTRIBUTING.md) (setup, a map of the repo and where to change what you see, the checks as CI runs them, one test, ports, goldens, the tile cache, the debugging tools, decisions, changesets and commits) and [viewer.md](viewer.md) (every key, all 27 URL parameters, the debug API, the model preview). The README's checks match CI and link to both.
- **e2e servers:** every port comes from `PW_PORT`: the viewer on it, the editor one below, the game two below (`PW_EDITOR_PORT`, `PW_GAME_PORT` override). Each server starts through `tools/e2e-server.mjs`, the app's own Vite config plus a header naming the checkout it serves; `e2e/global-setup.ts` fails the run on a server from another checkout or one it can't identify. Reusing a server already up is opt-in (`PW_REUSE=1`); by default one on the port is an error.
- **A smoke subset:** ten tests tagged `@smoke` over every app (the M0 and Las Vegas goldens, San Francisco's walking level, the sources screen, the inspector, the model preview, the editor, the game): `pnpm test:e2e:smoke`, 2.3 min here under a load of 10 on 4 cores.
- **CI shards:** tests are independent, so the suite runs fully parallel (one worker by default, `PW_WORKERS` for more) and CI runs it in four shards, each writing a blob report that a last job merges into one HTML report. Playwright splits by test count in file order, so the shard with the two level-switching tests (5 min together) is the longest.
- **The pixel inspector:** `__pixelworld.inspect(x, y)` (Alt+click logs it) reads the canvas pixel, finds its palette entry in the palette shown (ramp, shade) and every place the style pack uses that ramp, picks the ground under it (`query.pick`: cell, surface, road), and finds the placed object drawn there: the nearest object the view ray passes through (`query.objectsAt`, by footprint and estimated height) whose asset draws in the pixel's ramp, with its group, generator, the plugin that registered it and its landmark id. About 6 ms per call. Built in `apps/web` on public queries; no engine change.
- **The model preview:** `pnpm models` opens `apps/web/model.html`: a style pack's asset group (or another generator drawing its roles), seeds, footprints and heights in voxels (vehicles: a size), data hints, in up to four rotations, by day and night, at a zoom, on a ground plate. The same steps as a world's bake: `generateModel`, `meshVoxels` at the object voxel scale, the baker (on the main thread), the night palette over the same indices. Workspace city packs (`packages/*/src/plugin.ts`) are registered, so a generator shows before a style pack names it, with a note when the pack doesn't name the plugin. The parameters are the URL, so the dev server's reload after a save shows the same models re-baked (half a second here).
- **Rejected alternatives:**
  - **An object id channel in the bake, for the inspector:** exact, but it changes the baker, the tile format and cache and the compositor for a debugging aid; the ray march over the occupancy queries answers for placed objects, which is what a content author asks about.
  - **Identifying servers by a file they serve:** Vite answers any path with `index.html` (its SPA fallback) and a main checkout's server serves its worktrees' files, so only a header the server sets says whose it is.
  - **Hot-swapping the generators in the preview without a reload:** the registry, the plugins and the style packs would each need their own HMR handling; a reload with the state in the URL is as quick and can't show a stale mix.
  - **Projects per app, so a run starts only the servers its tests need:** Playwright starts every `webServer` for any selection; the three take about 5 s together.
- **Later:** split the level-switching tests or weight the shards by duration; generate viewer.md's parameter table from `main.ts`; an inspector for traffic and scatter (their sprites and models are known to the layers); a palette viewer.

### D-078: Next regions: New York, then Paris, then Amsterdam (accepted, M5)
- **Why:** [second-region.md](second-region.md) scored these three A. All three will be built; the order puts the cheapest adapter and the closest match to the San Francisco pipeline first.
  - **New York** runs on the same Socrata API as DataSF, uses the US sources already built in (3DEP, USGS lidar, NAIP, Overture), and its records name the fabric outright: PLUTO's class codes, plus the Landmarks Preservation Commission's style and material per building (brownstone, cast iron).
  - **Paris** brings the first non-US terrain source and the most uniform recognizable fabric. Its roofs still come from rules.
  - **Amsterdam** brings CityJSON ingestion (3D BAG) and roofs from data.
- **Verified first:** New York's licence text and datasets were read directly on 2026-11-09 (second-region.md §7).
- **Rejected alternatives:**
  - **Amsterdam first**, for M5's CityJSON goal and roofs from data: the most new pipeline code before the first result. It stays in the plan.
  - **Montréal instead of Paris:** reuses the row-house generators, but its LoD2 covers only some boroughs, and it adds less to the style range than Paris.
- **Later:** M5's exit criterion ("no code changes beyond new ingest adapters and its style pack") is judged on Paris and Amsterdam; New York may still add rule fields (§7).

### D-079: A player sees through the buildings in front of it; tall objects stay in view (accepted, M5)
- **Why:** New York's walking level (D-078) puts a player among towers up to 429 m tall; at walking scale a 326 m tower is already about 730 px, twice the view's height, and a car behind one is hidden for long stretches. The silhouette (D-070) says where the car is, not what's around it. The owner asked for the game view only: buildings in front of the player, and a margin around it, turn see-through; the viewer keeps drawing everything.
- **What a tile holds decides the design:** a baked tile keeps only the front-most surface (palette index and depth), and neighbouring tiles leave empty what a context object hides (D-021), so the street behind a tower exists nowhere. The output is palette-indexed, so transparency is a dithered screen-door, as silhouettes and fog already are.
- **How:**
  - **A bare tile variant:** `TileRequest.bare` bakes a tile with its placed objects' mesh left out of the image but kept in the shadow pass, so the street keeps the towers' shadows and matches its surroundings. Trees and props (instanced batches) stay. Hero paint isn't stamped on it. It has its own tile key and cache key (`…:bare`), and reuses the tile's cached scene in the worker, so it costs a GPU bake, not meshing.
  - **The compositor:** the first sprite with `reveal` defines an ellipse (its sprite's rectangle plus `margin` px). Normal tiles discard a Bayer-dithered share (`density`, with a soft edge) of their pixels inside it whose surface stands in front of the player: the surface's u + v, recovered from its screen row and depth as the fog pass does (u + v = sy/32 + 0.75·depth), is more than half a cell beyond the player's. Bare tiles are then drawn only inside the ellipse with the usual depth test, so they fill exactly what was let through. Sprites depth-test as before, so the player and traffic behind show.
  - **The view:** asks for bare variants of the tiles drawn under last frame's ellipse (grown by 32 px) right after the visible tiles, and applies the reveal only once all of them are baked. A view with no revealing entity asks for none: the viewer is unchanged.
  - **The API:** `EntitySpec.reveal?: { margin?, density? }` (defaults 24 px, 0.75) and `Entity.reveal`. The example game sets it on its car (40 px: behind One World Trade Center on `nyc-walk`, 24 px showed the car but hardly the street) and its plane.
- **Tall objects stay in view:** tile visibility allowed objects only 12 steps (~96 px) above a tile's ground, and the depth range 32 steps above the world's highest ground, so a tower in a tile below the view never drew, and tower tops beyond the range clamped to one depth. Each tile now records its objects' tops (from `hm`, `top` and `z0`; footprints over every tile they cover), and the depth range reaches the tallest. San Francisco's walking level downtown now asks for the tiles whose towers rise into the view.
- **Checked:** in the game on San Francisco's walking level, downtown (`start=-122.3995,37.7908`), with the car behind a tower: the reveal changes 1,551 pixels around it, showing the car and the shadowed street through the dithered tower; with `reveal` off, only the silhouette shows.
- **Rejected alternatives:**
  - **Cutting buildings at a height near the player** (the variant keeps the lower floors): reads better (stumps rather than an empty lot) but needs every model split in two at meshing; it can plug into the same compositor pass later.
  - **Runtime only, no variant** (tint or outline the buildings in front, using spare alpha bits): cheap, but can't show the street, which doesn't exist in the tiles.
  - **Re-baking the tiles with the occluding buildings removed as the player moves:** a new bake per move, at seconds per walking-level tile.
- **Later:**
  - Buildings behind the player inside the ellipse are left out too where a nearer tile hid them (they're in no tile's image there); a variant that hides only objects in front of the player would keep them.
  - A bare variant whose scene left the worker's six-scene cache meshes the tile again; bake both together if that shows.
  - Downtown walking-level tiles take about 6 s each to mesh on the CPU (14 tiles on San Francisco's Financial District start); the visibility fix asks for more of them. This is the D5 (Rust/WASM meshing) question.

### D-080: New York's building facts: footprints joined to PLUTO lots and LPC records; a `materials:` rule (accepted, M5)
- **Why:** New York is the next city (D-078), starting with Lower Manhattan's walking level. Its typology rules (D-055) need facts per building, and its iconic fabric is named in the city's records: PLUTO's building class (C4 old-law tenements, A4 city residences, L lofts, O offices) and the Landmarks Preservation Commission's facade material (brownstone, cast iron).
- **What:** the city pack `pixelworld-city-nyc` (`pipeline/plugins/`), facts source `pluto`:
  - **Data** (second-region.md §7): the city's BUILDING footprints, PLUTO, the LPC building database and the 2020 NTAs, read through the Socrata API limited to the region's box (with a 0.002° margin) and cached under the PLUTO release (`nyc/footprints-<box>-26v2.json.gz`). Option `version` pins the release.
  - **Joins:** PLUTO's API returns no lot polygons (its `geom` is empty), so a footprint finds its lot by BBL (`base_bbl`, else `mappluto_bbl`) and its LPC record by BIN; facts are looked up by point in footprint, not in lot.
  - **Facts:** `year` from LPC's earliest date, else the footprint's construction year unless it is 1900 (the placeholder on 11% of Manhattan's footprints), else PLUTO's year built; `stories`, `units`; `use` from PLUTO's land use code (01–03 residential, 04 mixed, 05 commercial, 06 industrial, 07–08 civic); `class` as PLUTO's code; `hood` as the NTA; `material` from LPC.
  - **`materials:` rule field:** matches the facts' material, in any case (`materials: [Brownstone]`). Nothing else reads material yet: a rule picks a group, the group a generator.
  - **TLS:** the pipeline's downloads verify against certifi's roots: a standalone Python on macOS reads `/etc/ssl/cert.pem`, which lacks GlobalSign Root R46, the root of both Socrata portals (NYC and DataSF).
- **Measured** over the walking bounds `[-74.020, 40.690, -73.970, 40.729]` (2026-11-09, PLUTO 26v2): 12,852 footprints, 12,824 on a PLUTO lot (99.8%), 5,317 with an LPC record, 12,707 with a year (98.9%). Materials: brick 2,749, brownstone 550, cast iron 273, masonry 236, wood frame 114. Classes: C7 1,829, RM 888, K4 597, C1 514, C6 497, C4 474, C0 465, A4 337, O5 319, D4 316. Fetching everything took 74 s; a cached build reads it at once.
- **Rejected alternatives:**
  - **MapPLUTO's lot polygons** (a download of the whole city) for DataSF-style point-in-lot lookups: the footprints already carry their lot's BBL, and a lot with several buildings would give them all one lot's facts anyway.
  - **PLUTO's year alone:** half of Manhattan's are rounded to 5 or 10 years; LPC's dates are per building where they exist.
  - **The 2015 tree census:** not used here; Forestry Tree Points (`hn5i-inap`) is the current one when street trees come from records.
- **Later:**
  - Heights from the footprints' `height_roof` (current; Overture's come from OSM's 2013–14 import): needs a height key in facts that `objects.py` reads before grouping towers.
  - Overture's stacked setback parts (`min_height > 3`) are dropped (`objects.py`), so wedding-cake towers lose their upper tiers.
  - LPC's `style_prim` (Italianate, Greek Revival, Romanesque Revival…) as a `styles:` rule field, if the generators come to draw styles.

### D-081: New York's look: a `new-york` style pack and the `@pixelworlds/city-nyc` generator plugin (accepted, M5)
- **Why:** New York is next (D-078). Its first world is the walking level of Lower Manhattan, and that city reads by a fabric San Francisco's generators can't draw: brownstone stoops and bracketed cornices, fire escapes over shopfronts, cast-iron fronts, and prewar blocks with water tanks on the roof. A style pack alone can recolour `rowhouse` and `block`, but it can't add those parts.
- **How:**
  - **The style pack** `worlds/_styles/new-york` is a full pack, copied from `bay-area`'s layout. It has 41 ramps (D-075's limit is 42): brownstone, red and buff brick, limestone, granite, painted cast iron, terracotta, verdigris, curtain glass, black iron, cedar, the harbour, bridge stone and steel, shop signs, and taxi yellow. San Francisco's fog areas are dropped. It names `["@pixelworlds/city-sf", "@pixelworlds/city-nyc"]`, so SF's `block`, `decoTower`, `sfTower` and `lanterns` are reused for commercial blocks, piers, warehouses, towers and Chinatown's lanterns.
  - **The asset groups are the contract the specs' rules target:** the five every pack has; `building.brownstone`, `.tenement` (and `.tenement.chinatown`), `.loft.castiron`, `.apartment.prewar`, `.commercial.historic`, `.house`, `.industrial` and `.pier`; the towers `building.tower.deco`, `.slab`, `.postmodern` and `.glass`; `tree.street`; bay-area's `prop.*` and `vehicle.*`; and the landmarks the New York spec names: `landmark.bridge.suspension` (stone towers and a steel truss, for both East River bridges), `landmark.tower.obelisk.diagonal` (One World Trade Center) and `landmark.tower.gothic` (the Woolworth Building). Beside them are `.suspension.steel`, `landmark.tower.obelisk` and `landmark.hall.domed`. The landmarks use built-in generators; the gothic tower uses SF's `decoTower` with its lantern crown under a copper cap.
  - **The plugin** `packages/city-nyc` is wired as `city-sf` is (`generators.ts`, `plugin.ts`, `worker.ts`, `index.ts`, `build.mjs`, whose worker-URL rewrite now matches the package's own entry and no hardcoded name). It has four generators: `brownstone`, `tenement`, `castIronLoft` and `prewarBlock` (style guide §19). Core lists them in `KNOWN_PLUGIN_GENERATORS`. The viewer (`CITY_PACKS`), the example game and the model preview load the plugin.
  - **The building rules hold** (inside the footprint, no overhangs, glass only on the skin, no lettering). Cornices and fire escapes are painted flush, and a stoop gets room by setting the facade back. Tests check every group of the pack over footprints from 1 × 4 to 40 × 32, diagonals and heights up to 140 voxels, and also the stoops, fire escapes, tanks and determinism.
- **Rejected alternatives:**
  - **A variant of `bay-area` (`extends`):** committed packs can't use `extends` (`packs.test.ts`). It would also keep SF's 42 ramps, eucalyptus to painted ladies, where New York needs to replace half of them.
  - **New `type`s of SF's `rowhouse` and `block`:** puts two cities in one published package with one version. New York's parts (a stoop's set-back facade, fire escapes, tanks) also don't fit SF's facade plan.
  - **Importing SF's facade helpers from `@pixelworlds/city-sf`:** a dependency between city packs for about 100 lines. They are copied, so each pack stands alone, as a pack outside this repository would.
  - **Stoops, cornices and fire escapes that project:** overhangs, and voxels outside the footprint that neighbouring tiles don't expect (D-021).
- **Later:**
  - **Publishing `@pixelworlds/city-nyc`.** It is `private` for now. Publishing needs `tools/city-pack-check.mjs` and CI to cover a second pack, a changeset, and a consumer example.
  - **Fabric this leaves out:** rear fire escapes, dumbbell light wells, mansard roofs, Federal houses' dormers, and vault-light sidewalks.
  - **Landmark shapes:** the Woolworth Building's crown and One World Trade Center's spire are generic: a lantern under a low copper pyramid, and a lattice crown. A steeper, Gothic crown needs a `decoTower` parameter for the cap's pitch, or a crown generator of its own. Canonical depictions follow data-sources.md §7.
  - **The specs** in `worlds/nyc/` map PLUTO's classes and LPC's materials (the facts plugin's `materials:` rule) to these groups.

### D-082: Roads drawn along their own centre lines, and snapped to 16 directions (accepted, M5)
- **Why:** roads jittered wherever they weren't snapped exactly to the grid. A cell stored its roads as links from its centre to the centres of its 8 neighbours (D-049, D-050), so a street at any other angle drew as a staircase of links whose edges wobbled by about a third of a cell (3 m, several pixels at walking scale). Snapped streets still jogged a cell where one octilinear run handed over to the next. Lower Manhattan's grid runs 29° off north, 16° from the nearest grid direction, so its avenues zigzagged. The pipeline has the true lines; only the encoding lost them.
- **What** (two spec switches, both off by default, so existing worlds are unchanged):
  - **`widths.centrelines: true`:** each cell also stores the stretches of road and path centre line inside it, up to six per kind (`PIECES`), each as its two ends in 1/255 cell (optional chunk sections `RSG0`–`RSG5`, `PSG0`–`PSG5`, written only where a slot holds data; `TerrainLayers.roadSeg`, `pathSeg`; a field texture of 12 texels per cell). A way's consecutive pieces in a cell merge where its bend there strays less than 0.04 cell (what Douglas–Peucker left of its wiggle). The micro-terrain shader measures a way's distance to those pieces wherever a cell has them, for its band, its lanes and its medians; a cell of one piece, or two joined end to end, is a plain stretch for lanes and medians, more is a junction. The connections are traced cell by cell instead of laid in runs, keeping the cells of the line's own vertices (where ways meet), so they stay under the line and joined at junctions; cells a line only clips get its class and width. Road beds widen by 0.75 cell (`CENTRELINE_BED_MARGIN`), the furthest a traced cell's centre lies from its line, so the band never runs over uncut micro-terrain. Traffic routes run through each cell on its nearest piece rather than its centre (chains still end at their junction cells' centres).
  - **`snap.roads.directions: 16`:** snapping (D-049) may also align edges with the 2:1 grid directions (26.6° and its mirrors), which draw as short repeating pixel patterns. Manhattan's grid is 2.4° from one.
- **Tried** on a copy of `nyc-walk` with both switches and a 12° snap angle, compared with `nyc-walk` in the viewer with objects off and on: the avenues and cross streets of the Lower East Side and around City Hall run straight at their real angles, with their lane lines and crosswalks, where before they were octilinear runs with jogs; City Hall Park's paths follow their real lines. 37,688 of 84,626 road edges snap with 16 directions (25,477 with 8). The package grows from 1.4 to 1.8 MB.
- **In use:** `nyc-walk` turns both on (with a 12° snap angle); its golden (Brooklyn Heights) was regenerated, with 28% of its pixels changed: the streets, and the buildings that move with them. Other worlds keep their runs until they opt in.
- **Fixed after the first trial** (the same comparison, rebuilt):
  - **Junctions:** thinning a traced staircase could drop the cell of a junction on a through road, so a side road ending there didn't join it: 16 disconnected junctions and 27 components. Keeping vertex cells: 0 and 11, as with runs.
  - **Road beds:** cut along the cells' centre-to-centre lines, they missed the band where it ran up to 0.7 cell off them, showing stepped micro-terrain beside some streets; widened, the band lies on the bed.
  - **Crowded cells:** with four slots, 403 road cells and 2,487 path cells (sidewalk corners) dropped their narrowest pieces. Merging wiggles and six slots: 12 and 266.
  - **Routes** followed cell centres, so traffic zigzagged along angled streets; they now ride the pieces.
- **Left:**
  - Only micro-terrain worlds draw pieces (the field shader); rails still draw from their connections.
  - The game's car keeps to the road by its cells' connections, so on an angled street its road assist steers along the staircase.
  - The bed margin is a wider cut, not one along the pieces: on steep streets (San Francisco) it would flatten more ground beside the road.
  - The package grows by about a quarter (1.4 to 1.8 MB on `nyc-walk`).
- **Rejected alternatives:**
  - **A distance field per micro-cell:** smooth too, but more data, and class, lanes and junctions still need per-cell records.
  - **16 directions alone:** two-cell "knight" links would have to be known to every cell they cross, and it does nothing for curves or other angles.
  - **Snapping everything to 8 directions:** no jitter, but it would turn Manhattan's grid by 16°, far beyond the snap's 2-cell shift.

### D-083: New York beyond Lower Manhattan: a driving level for the island, the walking level to 86th Street (accepted, M5)
- **Why:** New York's first world was the walking level of Lower Manhattan (D-078). The island reads by what lies north of it: Midtown's setback towers and glass, the prewar apartment blocks of the Upper West and East Sides, the brownstone rows and tenements of Harlem and the Village, Central Park, and the bridges over both rivers. That needs a level that holds the whole island, and the walking level carried into Midtown.
- **What:**
  - **A driving level** `nyc` (`worlds/nyc/region.yaml`, 25 m cells, 424 × 854) from the Battery to Inwood, with what the box takes in across the rivers: Brooklyn from the Heights to Greenpoint (and inland to Bushwick), Long Island City and Astoria, the South Bronx along the Harlem River, and Jersey City, Hoboken and the Palisades to Fort Lee. It holds what both levels share (style, sources, the typology facts and rules, ground, landmark depiction); `walk.yaml` `extends:` it and overrides the scale, bounds, widths, micro-terrain, trees, street props, landmarks, start and the road and path sources. Both levels list each other in `levels` (inherited by the walking level), and both keep `widths.centrelines` and the 16-direction snap (D-082).
  - **The walking level** `nyc-walk` (634 × 1,134 cells) now reaches 86th Street, across the south half of Central Park, and east to the Queensboro Bridge's Queens anchorage, so it takes in Williamsburg, Greenpoint, Long Island City and Astoria's south end. It stops there: see Measured.
  - **Typology** (rules in `region.yaml`, PLUTO's classes, LPC's materials and the 2020 NTAs): rows converted to flats (C0, C2, C3, C5), before 1915, two to five storeys and at most 9 m wide, are brownstone rows in the Upper West and East Sides, Harlem, the Village, Chelsea, Murray Hill and Gramercy and Brownstone Brooklyn, and tenements elsewhere (the East Village, the Lower East Side, East Harlem); prewar elevator apartments (D) are prewar blocks at any height, so the towers on Central Park West and Fifth and Park Avenues are too (no longer deco towers); the outer boroughs' one- and two-family houses (A, B, one to three storeys) after the brownstones are `building.house`. Midtown's towers keep the era rules (1916-zoning setback towers to 1946, slabs, postmodern, glass). No new generator: the existing ones draw all of it.
  - **Setback tiers (`objects.buildings.tiers`):** Overture stacks a setback tower's upper tiers as parts standing on the ones below (`min_height` above 3 m), which the pipeline dropped (D-080, Later), so Midtown lost its tops: of 1,110 buildings with stacked parts in the driving level's box, 67 lost more than 50 m (the MetLife Building drawn at 30 m of 246, Citigroup Center at 35 of 279). With `tiers` such parts are drawn from the ground where they stand over their building's footprint; parts off it (skybridges) are still dropped. Off by default; New York turns it on.
  - **Landmarks** (generic depictions, appended to both lists, so the seeds of the four before are unchanged): the Empire State Building, the Chrysler Building, the Flatiron Building, Grand Central Terminal, the Williamsburg and Queensboro Bridges, and on the driving level the George Washington Bridge. Coordinates and heights are Wikidata's where it has them (the Empire State Building's 453 m and 1,500 ft count the antenna, so it stands 381 m, CTBUH's height to its mast; Grand Central has none, so Overture's 45.8 m). Bridge lines run anchorage to anchorage along Overture's roadways, from the towers, piers and anchorages Overture maps as bridge supports (the Queensboro's anchor piers lie within 2 m of the line computed from its piers and spans); deck widths from Overture's deck outlines.
  - **Their groups** in the `new-york` pack: a limestone setback tower with a stepped crown (`landmark.tower.deco.setback`) and a white-brick one with a stepped steel crown and a needle (`landmark.tower.deco.steel`, from a new `spire` parameter of `decoTower`); the Flatiron as a stone block under a cornice (`landmark.block.wedge`, `prewarBlock`) and Grand Central as a long stone hall of tall windows (`landmark.hall.terminal`, `cellhouse`); the Williamsburg Bridge on the pack's braced steel `suspension.steel` group (unused until now); the George Washington Bridge on a taller one with short side spans (`.steel.long`); the Queensboro, a cantilever, on `landmark.bridge.cantilever`: the suspension generator with its cables down to the deck mid-channel, hangers every 4 voxels and the central anchorage's cables landing at 85% of the towers' height, which reads as two deep steel trusses dipping mid-channel and staying high over Roosevelt Island (every 2 voxels read as a solid wall at walking scale).
  - **Footprint landmarks (`footprint: true`):** a registry landmark can stand on the footprint of the building it replaces rather than on a box sized from its height: the Flatiron's wedge and Grand Central's block are their shapes.
  - **Depiction (data-sources.md §7):** no logos or lettering; the Empire State Building's image is used as a trademark by its owners, so its generic depiction is a setback tower of its height with no mast or lighting of its own.
- **Measured** (2026-11-10, Overture 2026-10-21.0, PLUTO 26v2, by the pipeline's clock; this machine slept and was throttled for much of the session, so wall times were far longer):
  - **Driving level:** 185,581 buildings, 129,188 with facts; 96,371 trees; 25,808 traffic routes; 10 MB (objects 8.3 MB, chunks 1.9 MB, routes 0.6 MB). 431 s the first time, downloads included (the facts for 133,092 footprints in about two minutes); 477 s from the cache.
  - **Walking level:** 67,370 buildings, 60,549 with facts; 76,858 trees; 13,073 routes; 7.4 MB (objects 4.1 MB, chunks 3.0 MB, routes 0.4 MB), from 1.8 MB for Lower Manhattan; 511 s, including the first fetch of its box's facts (53,470 footprints).
  - **Types, driving level:** tenements 26,185, brownstones 16,981, houses 16,526, historic commercial blocks 14,378, prewar apartment blocks 5,497, warehouses 4,145, cast-iron lofts 301, pier sheds 65; towers: deco 2,871, slabs 2,442, postmodern 901, glass 1,640, 354 by seed. **Walking level:** tenements 13,623, brownstones 8,250, historic commercial 7,219, prewar 3,364, warehouses 1,032, houses 805, cast-iron 297, piers 30; towers: deco 3,261, slabs 2,403, postmodern 988, glass 1,678, 288 by seed.
  - **The walking level stops at 86th Street.** Built first to 59th Street (6.2 MB, 335 s), it was measured for going further by Overture's buildings and the cells in each band north of it: to 86th Street +21% buildings and +19% cells (built: 7.4 MB, as estimated), to 110th Street on the East Side (40.805°) +41% and +34% (about 8.5 MB), into Harlem (40.82°) +59% and +51% (about 9.6 MB).
  - **Road reports** clean on both. The Brooklyn Heights golden is regenerated (46% of its pixels changed): the walking level's projection and grid are centred on its new bounds, so the same rows moved by a fraction of a cell.
- **Rejected alternatives:**
  - **Separate specs without `extends`:** two copies of the typology rules and sources to keep in step.
  - **Buildings only in boxes along the waterfronts** (`objects.buildings.bounds`), to keep the driving level near SF's 8.6 MB: inland Brooklyn and Queens would stand empty in the box's corners. Trees one every 16 m instead of 12 (0.9 MB) and a 30 m² minimum footprint bring it to 10 MB.
  - **Raising a tower's base part to the top of its tiers:** lot-filling slabs at full height, losing the setbacks the tiers draw.
  - **A cantilever bridge generator:** the suspension generator's parameters give the silhouette; a generator of its own can come with a canonical depiction.
  - **Landmark depiction parameters per landmark** (rather than groups): the registry passes a group, not parameters; a group per shape keeps the pack the contract.
- **Later:**
  - The walking level north of 86th Street (the Upper West and East Sides' north halves, Harlem), as a second walking level or once packages shrink; and the flying level.
  - Typology for New Jersey (no facts: Hoboken's brownstones are generic rows), and for the postwar housing projects (red-brick slabs, drawn now as walk-ups or white slabs).
  - Heights from the city's footprints (D-080, Later).
  - The Queensboro's island span has a pier block in its middle, where the real bridge has two towers; its towers lack their finials.

### D-084: Paris's sources and plugins: APUR's footprints with IGN's BD TOPO, IGN's DTMs, and heights from facts (accepted, M5)
- **Why:** Paris is next after New York (D-078). Its fabric reads by construction period and height (Haussmann's 1851–1914 street wall at six or seven storeys under zinc mansards), and it brings the first terrain source outside the US. Second-region.md §6 left Paris's elevation licence in conflict and its field names unchecked.
- **Checked first** (second-region.md §8, 2026-11-10), from APUR's catalogue and ArcGIS service, IGN's catalogue records, WFS and WMS-Raster, and the City of Paris's API:
  - **Licences:** APUR's layers are ODbL (catalogue, ArcGIS item and geocatalogue record agree). IGN's records for BD TOPO 3.5, RGE ALTI 2.0 and LiDAR HD give the Licence Ouverte 2.0; data.gouv's "not specified" is a harvesting gap, and the Géoplateforme's terms default to the Licence Ouverte anyway. The city's trees are ODbL. All allow derived databases.
  - **Fields:** APUR's footprints carry `c_perconst` and `h_med` (not `C_PERCONST_APUR` and `H_MEDIANE`, which §4 had from another layer), and also a roof form (`c_forme_toit`, with brisis-terrasson: the mansard) and an urban fabric class (`c_tissu`, with an HBM class). They have no storeys or use; BD TOPO has both.
- **What:** the city pack `pixelworld-city-paris` (`pipeline/plugins/`):
  - **Facts source `apur`:** APUR's built footprints of Paris (ArcGIS REST, the region's box, paged) joined to BD TOPO's buildings (the Géoplateforme's WFS) by each footprint's representative point, and to APUR's 80 quartiers by its centroid; cached in `paris/` under a version tag (option `version`, default APUR's last update date). Facts: `year` (APUR's year where it falls inside its period, else the period's representative year: 1750, 1830, 1880, 1930, 1958, …), `stories`, `units` and `use` (BD TOPO; residential with commerce is mixed), `class` (APUR's fabric code: `TR`, `TC`, `TPE`, `HBM`, `ER`, `IGH`, …), `roof` (flat, gabled, mansard), `height` (APUR's median) and `hood` (the quartier).
  - **Terrain sources `ign-rgealti` and `ign-lidar-hd-mnt`:** the Géoplateforme's WMS-Raster serves both DTMs as float32 GeoTIFFs at any resolution, anonymously. The adapter overrides `read_into`: 2,000-pixel tiles on a fixed Lambert-93 grid at `native_m × overview` (RGE ALTI 1 m, LiDAR HD 0.5 m), cached in `ign/`, labelled EPSG:2154 (the service writes an unnamed datum) and reprojected per cell corner. Copernicus GLO-30 isn't needed. The walking level reads RGE ALTI: LiDAR HD's DTM keeps real cuttings, but also has artefacts in the box that RGE ALTI doesn't (a pit at 12.9 m by the Boulevard Haussmann where RGE ALTI reads 31 m, likely an excavation; 86.9 m on the Passy plateau where it reads 65 m, a roof read as ground).
  - **Heights from facts (a pipeline change):** Overture gives a height to 3% of the walking box's 20,435 buildings and floors to 61%; the other 37% stood at the default 6–8 m, breaking the street wall. A facts source may now give `height` (`facts.FACT_KEYS`), and a building Overture gives neither height nor floors takes it in `type_buildings`, becoming a tower at `towerMeters` or more. Buildings with Overture heights keep them, so other worlds are unchanged (their facts have no height).
- **Measured** over the walking box with its margin (`[2.283, 48.848, 2.367, 48.877]`, version 2026-07-30): 36,048 APUR footprints, 34,518 on a BD TOPO building (95.8%), 34,221 with a year (94.9%), 28,520 with storeys (79%). Use: mixed 17,110, residential 7,247, commercial 5,693, none 5,803. Fabric: `TR` 21,763, `TC` 11,486, `ER` 1,155, `TD` 617, `TPE` 334, `IGH` 57, `HBM` 27. Roofs: mansard 32,010, flat 2,853, gabled 1,160. APUR's median height runs at 3.18 m a BD TOPO storey. Fetching took about a minute; a cached build reads it at once. The DTM: two to four 8 km tiles at 4 m (16 MB each).
- **Rejected alternatives:**
  - **BD TOPO alone** (it has storeys, use and a height for all of France): no construction period, which is what tells Haussmann from faubourg and HBM; its `date_d_apparition` (on 64% of the box's buildings) is a year rounded to ten or fifty, and missing on more than APUR's period.
  - **Two facts sources** (APUR and BD TOPO): a spec names one; the join belongs in the pack, as New York's joins PLUTO, LPC and the NTAs.
  - **Downloading LiDAR HD's 1 km DTM tiles:** 50 cm only, and named per flight block; the WMS-Raster reads any resolution of both DTMs.
  - **Heights from facts for every building** (replacing Overture's): would change other worlds' heights where their facts gain a height; filling gaps keeps Overture first, as the semantic fusion table orders.
- **Later:**
  - The city's tree points (`les-arbres`: 26,950 in the walking box, 9,109 plane trees) for street trees by species; a points input the pipeline doesn't have.
  - BD TOPO's materials (walls and roofs, as codes, on half the buildings) for a `materials:` rule.
  - Amsterdam's AHN as the next terrain source, and the landmark registry's jurisdiction field (data-sources.md §7) when a second country's depiction rules differ.

### D-085: Paris's look: a `paris` style pack and the `@pixelworlds/city-paris` generator plugin (accepted, M5)
- **Why:** Paris reads by one street wall (D-078): cream stone fronts with black iron balconies on the second and fifth storeys under blue-grey zinc mansards, broken by the faubourg's older plastered houses and, on the edges, the brick social housing of the 1920s and 30s. None of the existing generators draws a mansard or a balcony that runs the whole front; New York's draw stoops, fire escapes and flat roofs with tanks. Two of the walking level's landmarks, Notre-Dame and the Arc de Triomphe, have no generic shape in the landmark kit.
- **How:**
  - **The style pack** `worlds/_styles/paris` is a full pack laid out like `new-york` (D-081), with 41 ramps: limestone (cream and warm), weathered grey stone, three renders, HBM brick and its buff, zinc, slate, terracotta, verdigris, black iron, Wallace green, oxblood, navy, awning red, gilt, the Eiffel Tower's bronze-brown, steel grey, plane-tree leaf and pale bark, the parks' pale gravel and a grey-green Seine. Only lit windows and the marker glow at night. It names `["@pixelworlds/city-sf", "@pixelworlds/city-paris"]`: San Francisco's `block` and `sfTower` draw post-war blocks, warehouses and towers.
  - **Asset groups** (what the spec's rules target): `building.haussmann`, `.residential`, `.commercial` and `.civic` (all `haussmann`, with more or fewer shops and balconies; civic under slate with no iron), `building.faubourg`, `building.hbm`, `building.modern`, `.industrial`, `.parking`, `.tower`; plane trees; Wallace-green street lights and signals; bay-area's vehicles; and the landmarks `landmark.tower.lattice` (the built-in `latticeTower`, unlit), `landmark.hall.domed` (`domedHall`), `landmark.bridge.arch` (`archBridge`), `landmark.cathedral.gothic` and `landmark.arch.triumphal`.
  - **The plugin** `packages/city-paris`, wired as `city-nyc` is (core's `KNOWN_PLUGIN_GENERATORS`, the viewer's `CITY_PACKS`, the game's plugins, a changeset): `haussmann`, `faubourg` and `hbm` (style guide §20), and the landmark shapes `cathedral` and `triumphalArch`. Storeys count the ground floor as storey 0, as in France and in BD TOPO. Roofs are built by `wallsAndRoof`: each layer above the wall keeps the columns at least `inset(dz)` from the front and rear walls, so a mansard's brisis (a voxel in for every three up, then a near-flat terrasson) and a faubourg's steep pitch stay inside the footprint with every voxel standing on one below. Dormers are filled back into the roof, and their glass is painted only where it shows.
  - **The building rules hold:** tests build every group over footprints from 1 × 4 to 40 × 32, a notched lot and a diagonal, at heights of 10, 50 and 140 voxels, with and without hints (189 models), and check the balconies' storeys, the mansard's step, the faubourg's ridge, HBM's bands, the cathedral's towers and spire and the arch's openings.
- **Rejected alternatives:**
  - **A variant of `new-york` (`extends`):** committed packs can't use it, and Paris replaces most of New York's ramps.
  - **New `type`s of New York's or San Francisco's generators:** their facade plans (a stoop's set-back front, fire escapes, flat roofs with tanks) don't hold a mansard; a pack per city keeps versions apart (D-081).
  - **Projecting balconies and cornices:** overhangs, which the building rules forbid (D-021).
  - **A generic cathedral from `towerHall`** (a hall with a clock tower): it has one tower in the middle, not two at the front, and no buttresses; Notre-Dame is the second most recognisable shape in the box.
- **Later:**
  - **Publishing `@pixelworlds/city-paris`**, as for New York (D-081).
  - **Fabric left out:** the cut corners (pans coupés) of Haussmann's crossroads, rotundas, roof terraces, courtyards seen from above (footprints come whole), Art Deco and Art Nouveau fronts of 1900–1939, and the grands magasins' domes.
  - **Landmark shapes:** the cathedral has no transept roses at its real angle (its axis runs about 23° off east), the Palais Garnier is a generic domed hall, and the Pont Alexandre III's lamps and statues are left out. The Louvre's pyramid and the Centre Pompidou are protected works and stay ordinary footprints (second-region.md §8).

### D-086: Paris's walking level: the Eiffel Tower to the Marais at 10 m, typed by period, fabric and storeys (accepted, M5)
- **Why:** Paris's first world (D-078), on the sources and plugins of D-084 and the look of D-085. The walking level carries the most recognisable places in the fewest cells: the Eiffel Tower over the Champ de Mars, the Seine and its quays, the Étoile, the Louvre, the Opéra and the islands, with Haussmann's 7th and 8th arrondissements and the older Marais around them.
- **What** (`worlds/paris/walk.yaml`, `fixtures/paris-walk`):
  - **The box** `[2.285, 48.848, 2.368, 48.877]` at 10 m: 610 × 324 = 197,640 cells. It is a little wider than the first sketch so the whole Place de l'Étoile (to 48.875) and the Marais's east edge fit.
  - **Roads:** centre lines on and 16 directions (D-082), with a 6° snap angle (New York's is 12°): 44,153 of 171,001 road edges snap; the rest keep their angle. 45,185 road cells and 82,732 path cells carry pieces.
  - **Terrain:** RGE ALTI at 4 m (D-084), 1.5× vertical exaggeration as for New York: the Chaillot hill and the drop to the lower quays read without lifting the streets.
  - **Typology rules** (first match wins): APUR's remarkable buildings (`classes: [ER]`) as stone civic buildings; APUR's HBM class, then 1920–1939 residential at 5–9 storeys, as HBM; 1851–1914 at 5–8 storeys as Haussmann blocks; before 1851 at up to 5 storeys as faubourg houses; 1940 on as post-war blocks; industrial use as warehouses. Storeys are BD TOPO's, which count the ground floor and the mansard's, so Haussmann's six or seven storeys are 5–8 here. APUR's 1940–1967 period straddles the brief's "after 1960", so it is all post-war.
  - **Landmarks** (`worlds/_landmarks/`, generic): the Eiffel Tower (`landmark.tower.lattice`, unlit), Notre-Dame (`landmark.cathedral.gothic`), the Arc de Triomphe (`landmark.arch.triumphal`, turned so its great arch runs along the Champs-Élysées), the Palais Garnier (`landmark.hall.domed`) and the Pont Alexandre III (`landmark.bridge.arch`, quay to quay along Overture's carriageway). Each replaces Overture's building of the same name.
  - **A golden** (`paris-walk-gros-caillou-r0.png`): Haussmann blocks of the Gros-Caillou at zoom 2.
- **Measured** (build of 2026-11-10): 24,136 buildings, 19,125 with facts (79%; the rest have no APUR footprint under their centroid), 5,144 heights from facts. Types: Haussmann 5,783, faubourg 2,475, post-war 1,411, civic 453, HBM 388, warehouses 12, the stone default 13,584, towers 29. 16,346 canopy and 7,776 street trees, 13,096 lawn cells, 3,554 street lights, 5,850 routes. Road report clean (0 discontinuous or steep edges, 0 disconnected junctions, 19 components). The package is 2.9 MB (New York's walking level: 1.8 MB) and builds in 66 s from the cache.
- **Looked at** in headless views of the viewer and the game: the Haussmann fabric reads as cream fronts under zinc mansards with dormers; the Marais as rendered houses under steep roofs; the Arc in the Étoile with its twelve avenues; Notre-Dame from the parvis with its two towers, rose, portals and spire; the whole Eiffel Tower over the Champ de Mars; the game's car on the Avenue de l'Opéra, with the reveal (D-079).
- **Rejected alternatives:**
  - **Faubourg for every building before 1851:** 6,646 of them, a third of the typed fabric, drawn as narrow rendered houses. Central Paris's pre-1850 buildings of six storeys or more are mostly the Restoration's and July Monarchy's stone rental blocks, close to Haussmann's; capped at 5 storeys, 2,475 are faubourg and the rest keep the stone default.
  - **HBM only from APUR's HBM class:** 27 footprints in the box; the rule by period (1920–1939 residential, 5–9 storeys) gives 388, as the owner's brief asked. Whether each is brick or stone isn't in the facts; see Later.
  - **The Pont Neuf** as the bridge landmark: twelve stone arches, which `archBridge` (one arch) can't draw; the Pont Alexandre III is one steel arch.
  - **A bigger box** (Montmartre, Belleville, the Latin Quarter): past the 300,000-cell budget at 10 m; they belong to the driving level.
- **Later:**
  - **The driving and flying levels** (Montmartre and Belleville are why the terrain source reads better than 30 m), and the blind test.
  - **HBM:** the 1920s–30s blocks inside the box are as often stone as brick; APUR's `c_morpho` or BD TOPO's wall materials could tell them apart.
  - **Street trees from the city's records** (D-084 Later), courtyards and pans coupés (D-085 Later).

### D-087: Paris's landmarks drawn on their own proportions: four shapes of the Paris pack's own, two refined (accepted, M5)
- **Why:** the owner asked for more detail and likeness in Paris's landmarks. Looked at on `paris-walk` (D-086), the Eiffel Tower drew as the landmark kit's generic lattice tower, a solid stepped pyramid on four thin legs; the Palais Garnier as a big box under a small dome with a grid of windows, like an office block; the Pont Alexandre III as a plain deck over an arch hidden under it, with its four pylons drawn by Overture as ordinary buildings with shopfronts. Notre-Dame and the Arc de Triomphe read, but without their belfries, roses' tracery, the chevet's buttresses or the Arc's sculpture.
- **The rule kept:** depictions stay generic (D-051, data-sources.md §7): no names, no statues (where sculpture stands, a recessed panel or a plain gilt block), and the Eiffel Tower unlit. All five are out of copyright as architecture, so the shapes can follow the buildings closely; the shared built-in generators are untouched, since other worlds use them (`latticeTower` draws Las Vegas's Eiffel replica).
- **What** (`packages/city-paris/src/landmarks.ts`, style guide §20):
  - **`latticeArchTower`** (`landmark.tower.lattice`): four hollow piers of X-braced lattice whose outer edges follow the tower's curve, 0.186·e^(−z/0.30H) + 0.003 of its height H from the axis, fitted to its base (125 m square), its first platform (57 m up, about 70 m across) and its second (116 m, about 40 m); the piers thin from 0.078 H to 0.01 H and merge into one shaft near the top. A great arch on each face under the first platform, which is a hollow square with a frieze and glazed pavilions; two decks on the second; a top platform at 0.84 H with a glazed campanile, a lantern and a mast.
  - **`operaHouse`** (`landmark.hall.opera`, a new group): the front block (an arcade of seven arches, a loggia of paired columns, a frieze and an attic, between end pavilions crowned with gilt blocks, under a copper hipped roof), the foyer block with a copper cupola, the auditorium's drum under a low copper dome with gilt ribs and a crown, a domed rotunda on each side, the stage house (the tallest, with pediment gables) and the administration block. Over its height H (56 m, the stage house's ridge): 3.1 long and 2.2 wide, as the building's 173 × 125 m. It is turned three quarter turns so its front faces south, onto the Place de l'Opéra.
  - **`steelArchBridge`** (`landmark.bridge.arch.steel`, a new group): a line landmark whose pieces measure along the whole line (`frame.line`), as the kit's bridges do. A very flat arch of fifteen steel ribs (spring at 0.2 H, crown just under the deck) between stone abutments, open spandrels of posts and rings, a deck with stone sidewalks, a balustrade and lamp standards, and four stone pylons at the corners crowned in gilt. Its line now runs between the pairs of Overture's pylon footprints (a little beyond them), 46 m wide, and it replaces the four pylons by id.
  - **`cathedral`**, refined: two tall lancets on every face of each tower and a pierced balustrade on top, the open gallery across the whole west front, tracery in the west and transept roses, pinnacled buttress piers, and seven flying buttresses radiating round the apse.
  - **`triumphalArch`**, refined: the four great groups at the piers' feet, the reliefs above them and over the side arches as panels recessed one voxel, which the outline and ambient occlusion pick out; an archivolt round the great arch, the impost band, a frieze, a cornice and the attic's shields.
  - A helper `box` fills a box with both corners included: `VoxelModel.fill` excludes the far corner, and a first draft that read it as inclusive drew no single-layer roofs.
- **Checked:** in the model preview (`model.html?style=paris&group=…`) in two to four rotations each, and in the world: the whole Eiffel Tower over the Champ de Mars (a 900 × 1,100 view), Notre-Dame from the parvis and from the east, the Arc in the Étoile, the opera house from the Place de l'Opéra and from behind, the bridge from both banks. Tests check the tower's open foot, hollow first platform, solid second platform and mast; the opera house's heights (front below dome below stage house) and copper dome; the bridge's deck, arch crown, open water under the span, solid abutments and pylons.
- **Rejected alternatives:**
  - **Changing the kit's `latticeTower`, `domedHall` and `archBridge`:** they draw other worlds' landmarks (Las Vegas's replica, San Francisco's and New York's halls, the Hoover Dam bypass), whose goldens must not change, and are meant to stay generic types.
  - **Hero assets painted over a bake (D-053):** the most faithful, but hand-drawn per rotation; the generators get most of the likeness for a fraction of the work, and stay in the palette and its night.
  - **Statues and reliefs as figures:** sculpture, which the depiction rules keep generic even where it is out of copyright.
- **Later:**
  - Notre-Dame's axis runs about 23° south of east; landmarks turn only by quarter turns.
  - The Eiffel Tower's lattice is one panel size at every height; in life the panels grow finer toward the top.
  - The Palais Garnier's front is drawn at one depth (no projecting pavilions) and its loggia's columns as paint; the opera's statues and the bridge's are gilt blocks.
  - More landmarks in the box: the Invalides' dome, the Grand Palais's glass roof, the Louvre's Cour Carrée, the Pont Neuf (twelve arches; a bridge generator of several spans).

### D-088: More Paris landmarks, palaces typed by name, and footprints that keep their courtyards (accepted, M5)
- **Why:** the owner asked for the next landmarks in the walking box (D-087's Later): the Dôme des Invalides, the Grand Palais, the Louvre and the Pont Neuf. Looked at first on `paris-walk`: the dome was an odd tower of Overture's parts; the Grand Palais a dark mansard slab of 27,000 m²; the Pont Neuf a plain deck; the Louvre a 10.5 m slab (Overture gives it three storeys and no height) over its wings and courtyards. The Louvre showed the deeper cause: a footprint kept only its outer ring (`_footprint`), so every courtyard was drawn solid. In the box 4,002 of Overture's 24,998 buildings have holes, 531,000 m² of courtyards in all, the Louvre's Cour Carrée and the Invalides' fifteen courts among them.
- **What:**
  - **Courtyards** (opt-in, `objects.buildings.courtyards: true`): a building's holes of at least `minArea` go out as `fh`, rings in the same cells and anchor-relative hundredths as `fp`, turned, nudged and scaled with it (snapping, roads, depiction); trimming against roads leaves them as they are, since a hole is subtracted, not toggled. `footprintMask(fp, voxel, holes)` leaves their columns out (`pixelworld`, a changeset). Paris's generators step their roofs in from a courtyard's walls as from the front and rear (`facadeOf`'s `court` distance) and put windows on them. Off by default, so other worlds are unchanged; `paris-walk` turns it on: 2,791 of its buildings carry courtyards, and the package stays 2.9 MB.
  - **`names:`**, a typology rule field: Overture's primary name of a building, exactly; its parts and podium share it. `paris-walk` types "Palais du Louvre" and "Hôtel des Invalides" as `building.palace` (33 pieces with their parts), and "Pyramide du Louvre", a protected design, as a plain modern block.
  - **`palace`** (`building.palace`): walls of three storeys on every face (rustication and arched windows, a principal storey between pilasters, an attic) under a high slate roof that rises from every wall by a distance field over the footprint, so it follows each wing round its courtyards and stands higher where wings meet. Its height comes from the wing's half-width (walls 1.6, roof 1.0 voxels per voxel), since Overture's three storeys would make the Louvre 10.5 m tall.
  - **`domedChurch`** (`landmark.church.domed`, the Dôme des Invalides, 107 m): a base of two orders with a pedimented frontispiece, a drum of paired columns, a dome taller than a hemisphere gilded between dark ribs, a gilt lantern and spire; turned to face south. It replaces Overture's "Église du Dôme".
  - **`glassPalace`** (`landmark.hall.glass`, the Grand Palais, 50 m): stone walls with a colonnade and a portico, pale glass barrel vaults on green iron ribs over the nave and transept, a ribbed glass dome over the crossing, the stone wing behind; turned so the nave runs north-south and the main front faces the Avenue Winston-Churchill. It replaces Overture's "Grand Palais".
  - **`stoneArchBridge`** (`landmark.bridge.stone`, seven arches, and `.short`, five): round arches between piers with cutwaters, a half-round bastion with a lamp over each pier, a cornice of plain mascarons. The Pont Neuf is two line landmarks, one per arm, along Overture's carriageways either side of the island's tip. Landmark files can't pass params, so the arm with five arches is a second group.
- **Checked** in the model preview and in the world: the Louvre's wings round the Cour Carrée and the Cour Napoléon under slate; the gilt dome over the Hôtel des Invalides' courts; the Grand Palais's vaults and dome from the east; the Pont Neuf's arches and bastions from the Quai du Louvre. Tests: a courtyard footprint in the building-rules sweep (every group, three heights, three hints); roofs that step in from a court and windows on its walls (`haussmann`, `palace`); `fh` through the mask, the format's decoding, the pipeline's encoding, scaling and snapping; `names:` against a building and its parts. The Paris golden (Gros-Caillou) was regenerated: one block in it now shows its courtyard.
- **Measured:** the view over the Louvre bakes in 47 s on SwiftShader (158 s for a first palace over the filled footprint); the palace models are large (the Louvre's is about 1,100 × 750 voxels in plan). The other views of this decision bake in 7–15 s.
- **Rejected alternatives:**
  - **A keyhole ring** (holes joined to the outline by zero-width slits, which the even-odd rasterizer reads as holes, with no format change): many pipeline steps rebuild shapely polygons from `fp`, which such a ring makes invalid.
  - **Cutting footprints with holes into hole-free pieces:** no format change either, but every cut is a false wall and a notch in the roof.
  - **The Louvre as line landmarks** along each wing: about fourteen hand-traced wings, where the footprint already has them.
  - **Courtyards on by default:** every world's buildings with holes would change, and their goldens with them.
- **Later:**
  - The Louvre bakes slowly at the walking level; a palace drawn in pieces per wing, or meshed by runs, would cut it.
  - The engine's picking (`inPolygon`) still counts a courtyard as part of its building.
  - The Louvre's pavilions (Flore, Marsan, the Horloge) have no roofs of their own; Overture's parts carry no heights to find them by.
  - Other worlds could turn courtyards on when their goldens are next regenerated.

### D-089: Japan's city pack: PLATEAU's building models as facts, roof shapes from LoD2, and GSI's elevation tiles (accepted, M5)
- **Why:** Kyoto and Tokyo (Shibuya–Shinjuku) are next ([cities.md](cities.md)), and both read from the same national data: MLIT's PLATEAU 3D city models for buildings and GSI's elevation tiles for terrain. Overture's footprints there are OSM's, with heights on 0.3% of Kyoto's and 15% of Shibuya–Shinjuku's buildings and roof shapes on almost none; Kyoto's look rests on its tiled roofs, machiya gables against temples' hip-and-gable roofs. One pack shared by every Japanese city, built before either city's look and world (Kyoto D-090–D-091, Tokyo D-092–D-093).
- **Checked first** (second-region.md §9, 2026-11-11): PLATEAU's site policy and GSI's content terms (both PDL 1.0, compatible with CC BY 4.0, a credit and a processing note required; GSI's list of tiles puts the elevation tiles among those usable with the credit alone, no Survey Act application); the data catalog API, the building files and code lists of Kyoto's and Tokyo's 2025 packages; GSI's tiles and its elevation API.
- **What:** the city pack `pixelworld-city-jp` (`pipeline/plugins/`), in the pipeline's `plugins` group and `plugins.KNOWN`:
  - **Facts source `plateau`:** the region's box gives the 3rd-level (1 km) mesh codes of the standard grid (JIS X 0410); the catalog (`api.plateau.reearth.io/datacatalog/citygml/m:<mesh>`) gives each mesh's building file per city, and copies a Tokyo ward repeats from its neighbour (same feature and LoD counts) are read once. Each file is fetched gzip-encoded (4–14% of its 10–330 MB) and streamed through ElementTree's `iterparse`, about 2 s a mesh; only a compact extract per mesh is cached (`plateau/`, named by city code, release year, spec, mesh and an extract version; `keepGml: true` also keeps the gzipped file). Option `year` pins the release: the catalog serves only the current one, so a pinned build reads the extracts it cached. Facts: `height` (`measuredHeight`), `stories` (`storeysAboveGround`; 0 and 9999 unknown), `year` (`yearOfConstruction`; `0001` unknown), `use` (the usage code's group: 401–404 commercial, 411–412 residential, 413–415 mixed, 421, 422, 453 civic, 431–452 industrial), `class` (the usage code as is), `material` (`uro:buildingStructureType`: wood, steel reinforced concrete, reinforced concrete, steel, light steel, masonry, non-wood) and `roof`. Looked up by point in footprint: the LoD0 roof edge, else the LoD1 solid's base. The code lists' meanings are recorded in the module.
  - **Roof shapes from the LoD2 roof surfaces,** in Overture's words: `flat` where half the plan area slopes under 5°; `skillion` (a shed roof) where 80% of the sloped area faces one way (the four ways from the facets' own aspects, modulo 90°); else `hipped` or `gabled` by the sloped edges' plan lengths. A hip joins two facets facing different ways that both fall away from it (a valley, where they fall towards it, doesn't count); a gable verge belongs to one facet and runs down to that facet's eave. So an L-shaped gable stays gabled, and a hip-and-gable roof (入母屋), whose gable stands on its hipped skirt, is hipped.
  - **Terrain source `gsi-dem`:** GSI's PNG tiles on the Web Mercator grid, read at the zoom whose pixels are just finer than 1 m × the overview (17 at 1 m, 15 at 4 m), from DEM1A (1 m, lidar), else DEM5A (5 m), else DEM10B (10 m); a missing tile or one with holes (water) is filled from the next DEM's, the coarser reprojected first. Decoded from 24-bit RGB (0.01 m; 2²³ no data; above it below sea level), mosaicked per DEM, cached as tiles in `gsi/` (an empty file for a tile GSI doesn't have) and reprojected by `read_into`.
  - **Attribution** in each plugin: "出典：国土交通省 PLATEAUウェブサイト" with "加工して作成", and "出典：国土地理院ウェブサイト" with "地理院タイル（標高タイル（基盤地図情報数値標高モデル））を加工して作成", both PDL 1.0.
- **Measured** (second-region.md §9), Kyoto `[135.755, 34.990, 135.785, 35.012]` / Shibuya–Shinjuku `[139.690, 35.655, 139.712, 35.698]`:
  - **Buildings:** 24,109 / 17,760 in 12 meshes each; 106.8 MB in 35 s / 82.7 MB in 29 s; extracted in 65 s / 52 s; read again from the cache at once.
  - **Coverage:** height 100% / 96.9%; storeys 73.9% / 85.9%; year 75.1% (1868–2024, median 1983) / 0%; a known use 77.4% / 88.2%; a known structure 72.4% (wood 10,400) / 0% (Tokyo has fire resistance instead: fireproof 10,605); a roof 96.1% / 35.8% (Tokyo's LoD2 models cover about a third of its buildings).
  - **Top codes:** Kyoto's usage 461 unknown 5,418, 411 house 5,049, 413 house with shop 3,941, 412 flats 3,802; Tokyo's 411 3,847, 401 offices 2,931, 412 2,759, 413 2,475. Kyoto's structure 601 wood 10,400, 611 unknown 6,663, 604 steel 4,362, 603 RC 2,146.
  - **Roofs:** Kyoto gabled 13,041, flat 8,539, hipped 1,166, skillion 420; Tokyo flat 5,531, gabled 517, hipped 176, skillion 142. Wooden buildings in five Kyoto meshes: 78% gabled, 14% flat, 4% hipped. Against OSM's roof tags where Overture has them: 42 of 58 agree in Kyoto, 15 of 28 in Tokyo.
  - **Against Overture:** 91.7% / 92.4% of Overture's buildings have a PLATEAU building at their centroid; 88.7% / 84.8% of PLATEAU's lie inside an Overture footprint. Where Overture has a height, it is PLATEAU's (median difference 0.0 m).
  - **Elevation:** the adapter matches GSI's own elevation API within 0.4 m at ten points in both cities, the Kamo river among them (DEM10B where DEM1A and DEM5A have holes). A box at 4 m is about 125 tiles (8.5 MB) in 50–75 s, nothing on a second build.
- **Rejected alternatives:**
  - **Downloading each city's package:** the zips hold every feature type (Kyoto's 2025 package is 2.7 GB); the catalog's per-mesh building files are what a region needs, and come gzip-encoded.
  - **Keeping the CityGML:** 10–330 MB a mesh as XML (1–45 MB gzipped) where the extract is under a megabyte; an option keeps it.
  - **lxml or a CityGML library:** not a dependency, and `iterparse` streams a mesh in about 2 s.
  - **Overture's footprints with PLATEAU's attributes joined to them:** the pipeline already asks facts at Overture's centroids; a join in the pack would add nothing.
  - **Roof shape from the plane count or aspects alone:** an L- or T-shaped gable has four aspects like a hip; hip-and-gable roofs have long verges. The edges' topology tells them apart.
  - **A `hipped-and-gabled` word** (OSM's tag for 入母屋): not one of Overture's roof shapes, which `roofs:` rules share.
  - **Reading DEM1A at zoom 17 for every overview:** sixteen times the tiles at 4 m; GSI serves every DEM at coarser zooms.
  - **PLATEAU's own DEM** (in each package, `dem/`): TIN reliefs of 60–800 MB per 2nd-level (about 10 km) mesh, where GSI's tiles come at any zoom.
- **Later:**
  - Tokyo's `uro:fireproofStructureType` and `uro:detailedUsage` (in the extract already) as facts, for the Tokyo session; Tokyo's detailed-use codes are the city's own list.
  - Neighbourhoods from each building's ward code (`uro:city`) and the code list `Common_localPublicAuthorities.xml`, for `hoods:` rules.
  - What `yearOfConstruction` means for rebuilt temples (Nishi Hongan-ji's 17th- and 18th-century halls read 1989), and why 14% of Kyoto's wooden buildings have flat LoD2 roofs.
  - Fetching GSI's tiles in parallel (one at a time now, about 0.5 s each).

### D-092: Tokyo's look: a `tokyo` style pack and the `@pixelworlds/city-tokyo` generator plugin (accepted, M5)
- **Why:** Tokyo reads by a fabric no other pack draws: narrow mixed-use mid-rises (zakkyo) faced in tile under stacked tenants' signs and vertical sign boards, apartment slabs whose fronts are all balconies, small detached houses under metal roofs behind block walls, utility poles and their wires over the residential streets, and, by night, the signs' neon. New York's and Paris's generators draw stoops, fire escapes, mansards; San Francisco's `block` and towers fit Tokyo's offices and skyscrapers but not its fabric. The walking level's landmarks (D-093) need three shapes the kit doesn't have: twin towers on a slab, a cylinder, a torii.
- **What:**
  - **The style pack** `worlds/_styles/tokyo`, a full pack laid out like `paris` (D-085), with 42 ramps (the limit): the beige, brown and white tile of Tokyo's mid-rises and mansions, concrete, granite, mortar and metal siding, galvalume and kawara roofs, copper, curtain glass, the signs' neon pink, cyan, yellow, white and red, utility-pole grey and wire, JR green, the crosswalks' white, zelkova street trees, the evergreen Meiji forest, the shrine's gravel and unpainted cypress, Tokyo's indigo taxis. At night the signs glow with the lit windows and the marker (style guide §21). It names `["@pixelworlds/city-sf", "@pixelworlds/city-tokyo"]`: San Francisco's `block` for civic blocks and warehouses, `sfTower` for towers (west Shinjuku's mix has more white slabs and dark granite), `decoTower` for the NTT Docomo Yoyogi Building.
  - **The plugin** `packages/city-tokyo`, wired as `city-nyc` and `city-paris` are (core's `KNOWN_PLUGIN_GENERATORS`, the viewer's `CITY_PACKS`, the game's plugins, a changeset):
    - `zakkyo`: any height, storeys from the record; a shopfront under a lit band; ribbon, punched or glass fronts with a sign panel across most floors' spandrels; on most, a vertical board of stacked boxes, one a floor, standing on the shop's canopy in front of an upper front set back a voxel for it and rising past the parapet; a roof billboard on some. Parameters make the quieter variant (`signs`, `vertical`, `billboard`) and offices (`office: 1`).
    - `mansion`: balconies on the footprint's long side nearer south (`slabFront`), whatever the street: a light parapet band at every floor, the glass behind it, partitions between flats, outdoor units, all painted flush; the open corridor at the back; a lift penthouse and on some a water tank.
    - `kodate`: two storeys (one to three) under a gabled (ridge along the longer side), hipped, flat or shed roof built by distance in from the eaves, so it stays inside the footprint; a yard behind a block wall open for the car; `shop: 1` makes a shop house, and parameters draw the Meiji Shrine's halls in cypress under copper.
    - `twinTowerHall`, `cylinderTower` and `myojinTorii` (D-093's landmarks), and `utilityPoles`.
  - **Utility poles:** the prop system can draw them: `streetProps` with `across: true` places a model on the street's line turned so its x runs across it; the pole stands at one kerb and its power line runs the model's length along the street, sagging to its lowest where one model meets the next, so on a street running north–south or east–west the line is unbroken from pole to pole.
- **Checked:** tests build every Tokyo group over footprints from 1 × 4 to 40 × 18, a notched lot and a diagonal, at heights of 10, 40 and 140 voxels, with and without hints (567 models: inside the footprint, no overhangs, glass only on the skin), and check the zakkyo's signs and boards, the mansion's south-facing parapet bands, the kodate's ridge and hips, its block wall and gap, and the shrine's copper and absence of glass. Looked at in the model preview and in the world (D-093).
- **Rejected alternatives:**
  - **A variant of `paris` or `new-york` (`extends`):** committed packs can't use it, and Tokyo replaces nearly every ramp.
  - **New types of New York's or San Francisco's generators:** their facade plans don't hold a sign board standing in front of a set-back front, balconies across a slab or a pitched roof stepping in from the eaves; a pack per city keeps versions apart (D-081).
  - **A Shinjuku skyscraper generator:** `sfTower`'s white slabs, dark granite and glass towers already read as west Shinjuku's 1970s–2000s towers.
  - **Projecting balconies and sign boards:** overhangs, which the building rules forbid (D-021).
  - **Lettering on the signs:** none, as everywhere (D-051): the signs are blocks of colour that glow at night.
  - **Three lines on each pole** (power, low voltage, telephone): a voxel is 0.6 m at the walking level and each line is outlined, so three lines side by side read as a black band across the rooftops; one line (the telephone cable is a parameter, off) still reads as Tokyo's wires.
- **Later:**
  - **Publishing `@pixelworlds/city-tokyo`**, as for New York and Paris.
  - **Wires at any angle:** a prop turns by quarter turns only, so on streets at other angles the lines run in short staggered pieces; a line prop drawn between pole positions would follow any street.
  - **Fabric left out:** exterior emergency stairs, the rooftop advertising towers of Shinjuku's east side, shuttered shopfronts by day, vending machines, the elevated expressways' structure, wooden row houses (nagaya) in the older quarters.

### D-093: Tokyo's walking level: Shibuya to Shinjuku at 10 m, typed by use, storeys, size and neighbourhood boxes (accepted, M5)
- **Why:** Tokyo's first world (cities.md), on the Japan pack (D-089) and the look of D-092. The walking level from Shibuya to Shinjuku carries the most recognisable places in the fewest cells: the scramble crossing, Dōgenzaka's signs, Harajuku and Omotesandō, Yoyogi Park and the Meiji Shrine's forest, west Shinjuku's skyscrapers and the neon of Kabukichō, with the residential streets of Yoyogi, Sendagaya and Tomigaya between them.
- **What** (`worlds/tokyo/walk.yaml`, `fixtures/tokyo-walk`):
  - **The box** `[139.6875, 35.655, 139.7125, 35.698]` at 10 m: 228 × 478 = 108,984 cells. The check box of D-089 (139.690–139.712) widened to PLATEAU's mesh lines at 139.6875 and 139.7125, so the Metropolitan Government Building's plaza and the Omotesandō crossing are in; the build fetched 16 more meshes (28 in all, five wards).
  - **Roads:** centre lines on and 16 directions (D-082), with Paris's 6° snap angle: 25,811 of 67,538 road edges snap. The scramble's crossing is one striped area (the stripes are screen-space zebras); Overture maps one of its diagonals as a crosswalk and the other as a plain footway, so they read as one striped junction rather than an X.
  - **Typology without a year:** Tokyo's PLATEAU models carry use, storeys and height but no year and no structure. A typology rule field `bounds` (a lon/lat box or a list of boxes holding the building's centroid) gives neighbourhoods where the facts have none, and `maxDepth` bounds the footprint's long side (schema, typology, `docs/worlds.md`'s reference). The rules, first match wins: the Meiji Shrine's halls (civic, 1–3 storeys, in the precinct's box); west Shinjuku's towers by box; tower flats as mansions; in the entertainment districts' boxes (Shibuya and Dōgenzaka, east Shinjuku and Kabukichō, Takeshita Street) every commercial or mixed building of 2–12 storeys up to 26 m wide is a zakkyo; elsewhere narrow (≤ 14 m) offices of 4–10 storeys are quieter zakkyo and other narrow commercial or mixed ones zakkyo; offices of 4 storeys or more; flats of 4 or more as mansions; houses and small flats of 1–3 storeys on a small footprint (≤ 13 by 20 m) as kodate; small mixed ones as shop houses; other low shops as quiet zakkyo; wider low flats (apāto) as mansions; industrial and civic; whatever is left small and low as kodate.
  - **Rails:** Overture's standard and narrow gauge, subway and light rail where they surface (tunnels left out): the Yamanote, Chūō and Saikyō lines along the Meiji forest and through the stations, the Odakyū and Keiō where they surface; Meiji-dōri's Fukutoshin line stays underground.
  - **Landmarks** (`worlds/_landmarks/`, generic): the Tokyo Metropolitan Government Building No. 1 (`landmark.hall.twin`, 243 m and the coordinate from Wikidata Q111973, its plan from Overture's footprint, 111 by 61 m, turned so the towers stand north and south); the NTT Docomo Yoyogi Building (`landmark.tower.spire`, 240 m to the roof and the spire to 272 m from Wikidata Q2090752); Shibuya 109's cylinder (`landmark.tower.cylinder`, on Overture's own round footprint for it, Wikidata Q685328's coordinate; Wikidata gives no height, so it is drawn at a depicted 38 m over its block's 33.6 m from PLATEAU); the Meiji Shrine's great torii (`landmark.gate.torii`, from OpenStreetMap's way 469908912: 12 m tall, 17.1 m wide, its lintel north–south across the approach; the gate has no Wikidata item of its own). Each replaces Overture's building of the same name or id.
  - **Utility poles** every 30 m down residential, unclassified and living streets.
  - **A golden** (`tokyo-walk-yoyogi-r0.png`): houses, apartment slabs and utility poles in Yoyogi at zoom 2.
- **Measured** (build of 2026-11-10): 18,875 buildings, 17,638 with facts (93%), 14,080 heights from facts. Types: kodate 6,965, zakkyo 4,081 and quiet zakkyo 2,049, mansions 2,238, shop houses 967, civic 697, offices 532, warehouses 109, the shrine's halls 37, towers 386 (136 in west Shinjuku); 433 commercial and 369 residential keep the defaults (no record, or none of the rules). 17,758 canopy and 341 street trees, 7,240 lawn cells, 4,207 utility poles, 2,072 street lights, 121 signals, 2,569 rail cells, 5,372 routes (51 for trains). Road report clean (0 discontinuous or steep edges, 0 disconnected junctions, 17 components). The package is 1.8 MB and builds in 53 s from the cache (274 s the first time). On SwiftShader a view at zoom 3 bakes in 5–8 s in the residential streets and 20–25 s in Shibuya; the game loads in 33–47 s in west Shinjuku.
- **Looked at** in headless views of the viewer and the game: Shibuya's zakkyo under their signs round the scramble; Kabukichō by night, its signs glowing pink, cyan, yellow and red; the twin towers over Shinjuku Central Park among west Shinjuku's slabs, granite and glass; the Docomo tower's setbacks and spire over Sendagaya; the great torii over the gravel approach in the Meiji forest, and the shrine's copper roofs; Yoyogi's houses, slabs and wires; the Yamanote along the forest at Harajuku. In the game, among west Shinjuku's towers, the reveal (D-079) cuts a dithered window through the tower in front of the car, once the bare tiles under it have baked (about 25 s on SwiftShader; 8 s was too soon).
- **Rejected alternatives:**
  - **Neighbourhoods from PLATEAU's ward codes** (D-089's Later): wards are too coarse (Shibuya ward holds the scramble and Yoyogi's houses); boxes drawn round the districts are what the rules need, and need no extract change.
  - **Tokyo's fire-resistance codes as a stand-in for the year or structure:** 60% fireproof, which tells reinforced concrete from wood but not a zakkyo from a mansion; left for later (D-089's Later).
  - **All narrow commercial buildings as zakkyo under full signs:** 4,992 of them, offices on quiet streets in Yoyogi and Minami-Shinjuku included; narrow offices outside the entertainment districts carry fewer signs.
  - **A bigger box** (Aoyama, Ebisu, Shinjuku Gyoen): past the walking level's budget; they belong to a driving level.
- **Later:**
  - **The driving and flying levels**, the blind test, Tokyo Tower and the Skytree (other boxes).
  - **Shibuya 109's cylinder** is drawn but barely reads: it rises a few metres over its block among taller neighbours; a taller sign tower, or the block and cylinder as one landmark, would show it.
  - **The scramble's diagonals** as stripes along each crosswalk's own direction, not screen-space zebras.
  - **Street trees:** only 341 on the avenues (the canopy map finds few of Omotesandō's zelkovas); Tokyo's street-tree records would place them.

### D-094: Rail corridors: parallel tracks bundled into one corridor, drawn along its centre line with its track count (accepted, M5)
- **Why:** on `tokyo-walk` (D-093) the Yamanote and the other lines drew as broken, stepping strands. Two causes. Rails still drew from their cells' 8-way connections (D-061), which D-082 replaced for roads but left for rails, so a line at any other angle zigzagged. And OpenStreetMap maps every track on its own: by Harajuku and Shinjuku four to sixteen tracks run a few metres apart, landing in the same or neighbouring cells, where `drop_rungs` cuts the links between them, leaving gaps.
- **What** (opt-in per rail rule, so other worlds are unchanged):
  - **`bundle: <metres>`** on a `sources.rails` rule: its tracks within that distance of each other are drawn as one corridor. In the pipeline (`roads.bundle_tracks`): a kind's segments are first joined end to end where no third meets them (Overture splits a track at every switch); then, longest first, each track is sampled every quarter cell, and its stretches within reach of a corridor already laid join that corridor, while the rest (a cell or longer) start corridors of their own. Each corridor's line moves to the mean of its own and its joined tracks' points, averaged over about eight cells so it runs straight, and is simplified (0.15 cell); its track count is its median along it. A corridor that starts or ends where its track left another joins that one's line where its track was about two cells back, as a switch does.
  - **Data:** the corridors' centre lines as pieces per cell, as roads' are (D-082): optional chunk sections `TSG0`–`TSG5`, `TerrainLayers.railSeg`, the field texture's third set of six slots (18 texels per cell). The `RAIL` layer keeps a corridor cell's track count less one in bits 8–10 (up to eight) and flags every cell its tracks may reach in bit 11. A bundled rule's tracks write no connections.
  - **Drawing** (the micro-terrain shader): a flagged cell looks two cells round for the nearest corridor piece, counting only points beside a piece, not past its ends, so a corridor ends square instead of in rings of rail. It draws the corridor's tracks side by side across that line, 0.36 cell apart (about 3.6 m at 10 m), each a pair of one-pixel rails at the existing gauge, on one ballast bed. Street and cable-car tracks, and worlds without `bundle`, draw as before.
  - **`tokyo-walk`** turns it on at 20 m (its golden of Yoyogi is unchanged), and a second golden shows the Yamanote's corridor by Harajuku (`tokyo-walk-harajuku-rails-r0.png`).
- **Measured** (`tokyo-walk`): 255 tracks as 173 corridors over 1,560 cells, none with more than six pieces; the package stays 1.8 MB and builds in the same 53 s. Looked at with objects off and on: the Yamanote along the Meiji forest and through Harajuku as one straight band of tracks; Shinjuku's station throats as parallel corridors whose branches leave at an angle; the Chūō line meeting the Yamanote at Yoyogi, where the two corridors' tracks overlap. Tests: three parallel tracks and a continuation become one corridor on their middle; tracks that part become two corridors joined where they part; a corridor's cells carry kind, count and the reach flag; `TSG` round-trips in Python and TypeScript. Every existing golden is unchanged.
- **Rejected alternatives:**
  - **Each track along its own centre line** (not tried): ten tracks 0.4 cell apart would need more than six pieces in many cells, and their one-pixel rails would alias into a grey smear; the corridor draws the same number of tracks evenly spaced.
  - **A count that changes along a corridor:** tried first; every change shifted all its tracks sideways by half a track, a visible step at every station throat. The median keeps them straight.
  - **The medial axis of the tracks' buffered union** (not tried): it would follow the corridor exactly, but sprouts a spur at every branch, which would need pruning.
  - **Smoothing the connections further (D-061's bent tracks):** still one track per cell, and still the gaps between parallel ones.
- **Later:**
  - **Viaducts and embankments:** Overture marks bridge stretches (`is_bridge`); much of Tokyo's rail runs on viaducts, which could be line objects as the bridges are.
  - **Traffic's trains** still run on Overture's individual tracks, which lie inside the drawn corridor but not always on a drawn track.
  - **Other worlds** (`nyc-walk`, `paris-walk`) could turn `bundle` on when their goldens are next regenerated; worlds without micro-terrain don't draw corridors.
  - **Overhead wires** (D-092's Later) next: spans as line objects from pole to pole.

### D-095: Wires strung from pole to pole: utility poles along whole streets, each span a one-pixel line at any angle (accepted, M5)
- **Why:** D-092 drew a utility pole and its wires as one prop placed across the street. A prop turns by quarter turns only, so the wire in it lined up with the next pole's only on streets running north–south or east–west: everywhere else, short staggered black strokes, heavier still where four lines a voxel thick were outlined side by side. Looked at on `tokyo-walk` at zoom 1, they read as scribbles over the rooftops.
- **What:**
  - **Streets, not segments** (`objects._strokes`): a street prop rule's roads are joined end to end where only two meet, and through a junction where a road runs on into another, turning less than 30°, the straightest pairs first. A Tokyo block is shorter than two poles' spacing, so poles placed per Overture segment would rarely have a neighbour to string a wire to.
  - **`wires: <group>`** on a `streetProps` rule (`objects.wired_props`): a prop every `spacing` metres along each street, on its left at `offset` (3 m), turned as an `across` prop is so its crossarm spans the street; and between each two in a row, a span of the named group: a line object as the kit's bridges are (D-056), its footprint a band a voxel either side of the line from one pole to the next, `ln` its ends, drawn whatever the angle. A pole kept off a building's footprint takes its spans with it.
  - **The ground at a line object's ends:** the bake now hands a line object's generator the ground's height at its two ends above its base (`frame.line.rise`, voxels), so a span climbs from a pole on low ground to one on higher ground. The kit's bridges ignore it.
  - **One-pixel lines** (after the first look: a wire a voxel thick, outlined, read too heavy): a voxel model may now carry lines as well as voxels (`VoxelModel.lines`, `line(a, b, material)`, in voxel coordinates). The bake draws a unique object's lines as GL lines, one native pixel wide at any angle (`ObjectMeshes.lines`, a mesh with `primitive: "lines"`, face kind 5), casting no shadow and hidden with the objects on the game's bare tiles. The composite leaves their pixels out of its cleanup, which would otherwise erase a diagonal line (each of its pixels has neighbours that agree with each other), and draws them in their ramp's darkest shade, as an outline: the lit shade of a dark ramp is close to the asphalt's and vanished on the street.
  - **`wireSpan`** (`@pixelworlds/city-tokyo`, `prop.wire`): a line in short straight pieces, about one every six voxels, from `height` voxels over the ground at one pole to the same at the other, sagging `sag` voxels between them; no voxels. `utilityPoles` with `wires: 0` is the pole alone in a small model, its crossarm across the street.
  - **`tokyo-walk`:** poles every 30 m, 3 m off residential, unclassified and living streets, with `prop.wire` spans. Its Yoyogi golden is regenerated (the poles and their wires).
- **Measured:** 3,781 poles and 2,893 spans (4,207 props before, each with its own wire); 45,845 objects; the package grows from 1.8 to 1.9 MB; the build takes the same 55 s. The Yoyogi golden's view takes 12 s to open and bake on SwiftShader, against 10 s with the voxel wires. Looked at in Yoyogi, Sendagaya and over the Docomo tower at zooms 1 to 3, by day and night: the wires run along every street at its own angle, a pixel wide (two at zoom 2), dark, from pole to pole, sagging. Tests: streets joined through straight junctions and round a bend, not through a crossing; poles on one side 3 m off with a span between each two; a span an unbroken line from pole to pole at any angle, sagging, and climbing to a pole on higher ground; a model's lines become a lines mesh placed as its voxels, with the line's ground heights. Every other golden is unchanged.
- **Rejected alternatives:**
  - **A voxel-thick wire** (the first version): every column a voxel, outlined as a building is, it read as a dark bar two to four pixels thick across the rooftops.
  - **Half-size voxels for thin things** (not tried): a line half a voxel thick rasterizes to less than a pixel, and breaks up.
  - **One prop per pole and span, turned by eighths:** props turn by quarter turns; a span at any other angle needs its own model, which the line object gives.
  - **Poles on both sides:** in life they stand on one side of a small street, and two rows of wires would double the clutter.
- **Later:**
  - **Wires across junctions** between streets that meet at an angle, and the service drops from poles to houses.
  - **Lines on instanced props** (only unique objects draw them now), and other thin things as lines: tram and trolleybus wires, railings, flagpoles.

### D-096: Props with one-pixel detail: lines on instanced props; slender street lights, mast-arm signals, lantern wires and pole arms, on in every pack (accepted, M5)
- **Why:** the owner asked for the other props to have options for the detail the wires got (D-095). A street light was a column of voxels three voxels wide, 2.5 m tall at the walking scale; a signal, a column with three voxels on top; Chinatown's lanterns hung from a wire a voxel thick, and a utility pole's arms were voxels too. Their thin parts are what one-pixel lines draw well. But lines were drawn for unique objects only, and props are instanced.
- **What:**
  - **Lines on instanced props:** a variant's lines are a batch of their own, a `primitive: "lines"` mesh with its own copies of the instances' offsets and cells (a render scale scales each batch's), drawn with `drawArraysInstanced(gl.LINES)`, casting no shadow. `meshLines` (beside `meshVoxels`) places a model's lines as its voxels are placed, for unique objects, instanced ones and the model preview, which now shows them.
  - **Options, off by default in the generators** (a pack turns them on):
    - `streetLight` with `lines: 1`: a mast a pixel wide and an arm that rises and curves out `reach` voxels to the lamp, the lamp still a voxel that glows at night.
    - `trafficSignal` with `lines: 1`: a pole and a mast arm reaching `reach` voxels over the street, the head of three lamps (the middle one dark) under a hood at its end.
    - `lanterns` (`@pixelworlds/city-sf`) with `lines: 1`: the wire a one-pixel line sagging smoothly, each lantern's top voxel round it.
    - `utilityPoles` with `lines: 1`: the crossarm and the low arm as lines, and on some poles (`stay`, 0.35) a stay wire from the low arm down to the ground along the street; the pole stays a column of voxels, as thick as a concrete pole looks.
  - **The tokyo pack** turns them on: street lights 16 voxels tall (about 7 m at the walking scale) with a 3-voxel arm, signals 12 voxels with a 5-voxel arm, poles with arms and stays. Its two goldens are regenerated (the Yoyogi view's poles; 1% of the Harajuku view's pixels, its lights and signals).
  - **Every pack, at the owner's word:** `bay-area`, `new-york` and `paris` take Tokyo's lights and signals (all their props stand on 10 m walking levels), and `bay-area`'s and `new-york`'s lanterns their one-pixel wire; `desert-southwest`, whose walking level has 20 m cells and so voxels twice the size, takes lights 8 voxels tall with a 2-voxel arm and signals 6 tall with a 3-voxel arm (about the same metres). Two goldens moved: Paris's Gros-Caillou (192 pixels at its left edge, a street light) and the Southwest's flying view of the Strip (2 pixels); every other golden is unchanged, its props out of view or within it unchanged.
  - **The package budget:** the untree-shaken sum of every entry point is 100.2 KB with D-082's and D-094's centre lines and D-095–D-096's lines; its limit is raised from 100 to 110 KB, as the owner allowed for features. createWorldView (78.9 of 80 KB) and a view with traffic (87.1 of 88) stay within theirs.
- **Checked:** in the model preview and in `tokyo-walk` at zooms 2 to 4: Omotesandō's street lights as slender masts with curved arms, Yoyogi's poles with their arms and stay wires; and at zoom 3 Chinatown's lanterns on Grant Avenue, the Champs-Élysées' lights and signals, the Strip's lights, Union Square's. Tests: the voxel light and signal as they were; their line versions' masts, arms, lamps and heads; an instanced model's lines as their own batch with copied offsets; the lantern wire as an unbroken sagging line through its lanterns; poles' arms and a share of stays.
- **Rejected alternatives:**
  - **Lines on by default in the generators:** a pack written for the voxel props (a plugin's, or one outside the repository) would change under it; a pack turns them on.
  - **The utility pole itself as a line** (not tried): a concrete pole is about half a voxel thick, and a one-pixel mast would draw it as thin as its own wires.
- **Later:** the cable car's and streetcar's trolley poles, railings, flagpoles and bridge hangers as lines; Kyoto's pack (on its own branch) can turn the options on too.
