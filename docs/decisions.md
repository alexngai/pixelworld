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
