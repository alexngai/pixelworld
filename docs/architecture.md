# Pixelworld architecture

Status: living document. It describes the target architecture. When a decision changes, update this file and add an entry to [decisions.md](decisions.md).

## 1. What we are building

Pixelworld is a web-based, interactive world built from real geography and drawn as isometric pixel art. It favors **recognizable over realistic**:

- Places are compressed and rearranged so interesting things sit close together. For example, Las Vegas, Hoover Dam and the Grand Canyon end up a short drive apart.
- Landmarks are exaggerated so they read instantly.
- The art style is fixed, so generated content looks hand-made and consistent.

The world is playable. You can drive on the roads, fly through the canyon, and build or move on the grid.

### Guiding principles

1. **3D model, isometric output.** The world is modeled in 3D, and the main view is baked isometric pixel art. Live free-camera 3D is a later, optional mode built on the same model.
2. **Everything lives on a grid.** Terrain, roads, buildings and gameplay all snap to one cell grid. This keeps the pixel art clean (edges land on exact pixel staircases) and makes grid gameplay possible.
3. **Facts → rules → overrides.** Every visible thing comes from source data (facts), passed through deterministic generators and a style system (rules), then adjusted by explicit curation (overrides).
4. **Terrain stretches; landmarks don't.** The map is warped to make room for interesting places. Objects are placed at their warped location but keep their own size.
5. **Open data only.** No Google or Mapbox content enters the pipeline or the tools. See [data-sources.md](data-sources.md).
6. **Deterministic and reproducible.** The same inputs, rules, overrides and seed always produce the same world.

## 2. System overview

```
 Open data                 Geo pipeline (offline, Python)          World package (static)
 ─────────                 ──────────────────────────────          ──────────────────────
 DEM, lidar           ─►   fetch → normalize → semantics      ─►   manifest + chunks
 OSM / Overture            → importance → warp → gridify            (cells, networks,
 3D city models            → generalize → place → export            instances, landmarks)
 land cover, imagery            ▲                                          │
 Wikidata                       │ region spec, overrides                   ▼
                          ┌─────┴──────────┐                    Web client (TypeScript)
                          │ Editor (web)   │◄──── preview ───── ┌─────────────────────────┐
                          │ scale brush,   │                    │ stream + cache chunks   │
                          │ pins, overrides│                    │ build 3D scene per chunk│
                          └────────────────┘                    │ bake → indexed + depth  │
                                                                │ composite + palette LUT │
 Offline asset bake (headless browser, same renderer):          │ gameplay (grid sim)     │
 landmarks, building kits, vehicle sheets → paint-over ───────► └─────────────────────────┘
```

**Division of labor:**

- **The geo pipeline decides *what* and *where*.** It turns real data into semantic grid content. For example: "a 3×2-cell commercial building, 9 steps tall, hip roof, style `sw-stucco`, seed 81723, at cell (412, 977)".
- **The client decides *how it looks*.** Generators turn that content into 3D geometry, and the baker turns the geometry into pixel art.

This split keeps chunks small. It also means that changing the art style never requires re-running the geo pipeline.

## 3. Coordinate systems and scales

### 3.1 Coordinate spaces

| Space | Units | Notes |
|---|---|---|
| Geographic | WGS84 lon/lat | Source data. |
| Region-projected | meters | A local projection centered on the region (transverse Mercator or LAEA). All geo processing happens here. |
| World | cells (continuous) | The output of the warp. Real meters have no fixed relationship to cells. |
| Grid | integer cell (i, j) + height step h | Snapped world. This is the space for gameplay and generation. |
| Screen | pixels | The integer isometric projection of grid space for one of the 4 view rotations. |

### 3.2 Three independent scales

1. **Layout scale (meters per cell)** comes from the warp and varies across the map. It is fine in places like the Vegas Strip (around 15 m/cell) and coarse in empty desert (around 400 m/cell). It decides *how much real geography fits*.
2. **Object scale** is fixed game-wide: road widths, vehicle sizes, a floor height, a tree. A car is the same size everywhere. Style packs define object sizes in cells and steps. Landmarks may set their own exaggerated scale.
3. **Vertical scale** is set per region as a **vertical exaggeration** E relative to true proportions (1 = real slopes). Every height difference spans E times as many steps, and meters per step = meters per cell × (1/√6) / E. It's applied before quantization, because steps are integers, so it can't be changed at render time. Per-feature caricature (e.g. deepen the canyon) comes on top. Exaggeration is capped so that driving stays possible.

Because of this, the same real building can take up more or fewer cells depending on the local layout scale. When it would fall below the minimum footprint, it is merged into a block or dropped. Only landmarks are protected from this, by their rigid stamps.

### 3.3 The grid

- **Cell:** a square footprint. It is the unit of placement, collision and building.
- **Height step:** the vertical unit. Terrain and object heights are whole steps.
- **Terrain model:** RCT-style, extended to steep slope tiles. Each cell has a base height (its lowest corner) and a corner shape: each corner sits 0–3 steps above the base. Neighbouring cells share corner heights, so slopes are continuous. Where they don't match, the edge becomes a vertical cliff face. The pipeline caps the rise per cell (`max_slope`, default 2); anything steeper becomes a terrace with cliffs. This gives gradual slopes on gentle ground, readable terraces and cliffs on canyon walls and mesas, and ramps that roads can climb. Rises of 1–3 steps per cell keep cell edges on clean pixel angles (horizontal, 2:1 or 1:1 going up).
- **Directions:** 8. A world-axis edge projects to an exact 2:1 pixel staircase. A world diagonal projects to a perfectly horizontal or vertical screen line, so 45° roads and building cuts are also pixel-clean. Curves become 8-direction polylines.
- **Micro-terrain (M1.6, D-037, D-038):** inside every cell, a K×K grid of micro-cells (K=4: 100 m at the Southwest's 400 m cells), each an 8×4 px diamond with quarter-step (2 px) heights. Micro-cells follow the same model, derived from shared micro-corner heights: a slope tile up to 3 micro-steps, a flat terrace when steeper. Cells stay the unit of gameplay and the summary of their micro-cells; water and roads constrain the micro-terrain so the two agree.
- **Chunk:** 64×64 cells, the unit of streaming and storage. Bake tiles, the unit of client baking, may be smaller (to be tuned in M0).

### 3.4 Projection (initial constants, tuned in M0)

At 1× zoom, a cell is a 32×16 px diamond and one height step is 8 px (so a "cube" is 1 cell × 2 steps):

```
screen_x = 16 · (x − y)
screen_y =  8 · (x + y) − 8 · h          (x, y in cells; h in steps; y-down screen)
depth    ∝ x + y + h / 3                  (larger = closer to the camera)
```

This is exactly a standard orthographic camera at **45° yaw and 30° pitch**, provided that in true 3D one height step = **1/√6 cell (≈ 0.408)**. The baker writes the integer formula directly in its vertex shader (no camera matrix), while normals and shadows use true geometry. Every grid vertex lands exactly on an integer pixel.

- **View rotations:** r ∈ {0, 1, 2, 3}. World (x, y) is rotated by r·90° before projection. Each rotation is a separate bake.
- **Lighting is view-relative:** the sun always comes from the same screen direction, as in classic isometric games, so all 4 rotations look equally good.

## 4. World definition (source of truth)

A world is a set of **regions**. Each region is continuous inside and defined by files in `worlds/` that are version-controlled and reviewed like code. The M1 spec is [`worlds/southwest/region.yaml`](../worlds/southwest/region.yaml). It holds bounds, a uniform `metersPerCell`, `verticalExaggeration`, `maxSlope`, smoothing, a start point, pinned data sources and geology provinces. The fields below for focus areas, pins, landmarks and overrides arrive with M2–M3:

```yaml
# worlds/southwest/region.yaml (target shape, M2+)
region: southwest
bounds: [-116.0, 35.0, -111.5, 37.5]      # lon/lat
projection: auto-tmerc
base_scale_m_per_cell: 400
vertical_m_per_step: 25
focus:                                     # painted into the scale field
  - name: las-vegas-strip
    at: [-115.17, 36.11]
    radius_km: 6
    scale_m_per_cell: 15
  - name: grand-canyon-south-rim
    at: [-112.14, 36.05]
    radius_km: 25
    scale_m_per_cell: 40
    vertical_exaggeration: 1.5
pins: []                                   # warp constraints, written by the editor
style_pack: desert-southwest
landmarks: [hoover-dam, stratosphere-tower, grand-canyon-skywalk]
overrides: overrides/                      # per-feature edits, keyed by stable ID
```

Supporting files:

- **Style packs** (`worlds/_styles/<pack>/`): palette ramps, material definitions, generator parameters (building massing, roofs, facades, vegetation templates) and object scale tables.
- **Landmark registry** (`worlds/_landmarks/<id>.yaml`):
  - geo anchor, Wikidata ID, footprint, scale boost, orientation
  - hero asset references
  - **depiction variants**: canonical, stylized or generic, with the variant chosen per release target for IP/compliance reasons
- **Overrides:** keyed by our own **stable feature IDs**. These are derived at ingest from source + source ID, with a geo anchor so they can be re-matched when upstream IDs change. Overrides survive re-bakes.

## 5. Geo pipeline (offline, Python)

Stages run in order. Each one caches its outputs, keyed by the hash of its inputs, so editing a region only re-runs what changed. In M1 this means downloads cached as `.npy`/JSON under `pipeline/.cache/`, plus a fast in-memory rest of the build (about 20 s for the Southwest). Entry point: `uv run pixelworld build worlds/<id>/region.yaml`.

**M1 implementation** (`pipeline/src/pixelworld_pipeline/`):
- **Sources** (`sources/`): rasters are read from cloud-optimized GeoTIFF overviews over HTTP range requests, mean-resampled for elevation and mode-resampled for land cover. Overture GeoParquet is read the same way: a one-time index of every file's row-group bounding boxes (footers only), then only the intersecting row groups and columns.
- **Corner field:** every height decision works on one integer corner-height grid before cells are formed:
  1. Elevation is converted to steps.
  2. Lakes are flattened per water body.
  3. River corners are lowered.
  4. Roads are cut and filled (`roads.py`).
  5. Gridify turns corners into cell shapes. Connected road cells share their corners, so they meet without cliffs by construction.
- **Validation:** the build writes `build-report.json`, which checks that every road edge is continuous and not over-steep, that no segment is split by snapping, and that no junction comes apart. The CLI exits non-zero if not.

1. **fetch:** download the raw sources clipped to the region bounding box. The raw cache stays outside the repo.
2. **normalize:** reproject to the region CRS, unify schemas, and assign stable feature IDs.
3. **semantics:** fuse sources by priority into semantic layers: terrain, water, land cover, road/rail networks, buildings (footprint, height, roof shape, use), vegetation and POIs. See the fusion matrix in [data-sources.md](data-sources.md).
4. **importance:** score features and areas by fame and interest (Wikidata sitelinks, Wikipedia pageviews, OSM tags), combine with the hand-painted focus areas, and produce a target **scale field**.
5. **warp:** solve the map deformation (§6), producing forward and inverse maps.
6. **gridify:**
   - Resample the DEM into cells (base height + corner shape + cliffs) and land cover into surface materials.
   - Snap networks to 8-direction cell paths, with cut-and-fill so road grades are drivable.
   - Turn building footprints into cell polygons and quantize heights to steps.
7. **generalize & caricature:**
   - Thin networks where the scale is coarse, merge small buildings into blocks, widen rivers so they read.
   - Apply vertical exaggeration and per-feature boosts.
8. **place:** emit instances for everything gameplay cares about: buildings, trees, props with collision, and landmark stamps (rigid, own scale). Purely decorative scatter (grass tufts, pebbles) is left to the client.
9. **export:** write the chunked world package plus a manifest.

The editor drives the same stages through a local pipeline server, so changing a pin or a scale brush re-solves and re-exports the affected area.

## 6. Elastic map (warp)

Goal: a smooth, fold-free mapping from region meters to world cells that matches the target scale field while keeping local shapes recognizable.

- **v0 (no warp):** uniform scale. Used for M1.
- **v1 (separable):** x′ = F(x), y′ = G(y), built from the cumulative interest along each axis. Simple and grid-friendly, but it can't scale two places at the same latitude independently.
- **v2 (mesh solve):**
  - Lay a triangle mesh over the region. Solve for vertex positions so that each triangle is close to a *similarity transform* (rotation + uniform scale) at its target scale, using sparse least squares with alternating local/global iterations.
  - Pins act as hard or soft positional constraints.
  - A fold check (every triangle keeps its orientation) rejects invalid solutions.
  - Editor UX: paint scale, drag pins, re-solve in about a second for a region.
- **Applying the warp:**
  - Rasters (DEM, land cover) are sampled through the inverse map.
  - Vectors are densified, then forward-mapped.
  - Landmarks and building anchors are forward-mapped as points. Their geometry is stamped at object/landmark scale and never deformed.

## 7. Content generation (client, TypeScript)

Generators are pure functions: `(semantic instance, style pack, seed) → 3D geometry + material IDs`. Seeds are a stable hash of (region, feature ID, purpose).

- **Terrain:** cells → mesh with top faces, slope faces and cliff faces. Materials come from the surface class, plus elevation bands (rock strata) and a seeded pattern. Worlds with micro-terrain skip the JavaScript mesh: the baker builds the geometry on the GPU (§8.1).
- **Buildings:** footprint → massing (setbacks by height) → roof (flat, gable, hip, dome, …) → facade pattern → material ramps. The parameters come from the style pack and building use.
- **Networks:** each road or rail cell, based on its connectivity mask, becomes a road piece (straight, corner, junction, ramp, bridge) with markings by class.
- **Vegetation and props:** species templates per biome, with density from land cover and canopy data.
- **Landmarks:** hero assets, either voxel models (`.vox`) or a small parametric DSL built from the component kit (towers, arches, domes, lattices…). Each depiction variant is a separate asset.

Hero assets are baked offline and can be painted over. A painted-over sprite replaces the generated one through an override.

## 8. Rendering

### 8.1 Bake (3D → indexed pixel art)

Bake tiles are 32×32 cells. Each bake renders the tile plus a 16-cell margin of context, and every face carries its owning cell, so shadows, AO and outlines cross seams correctly. Pixels whose front-most surface belongs to another tile are left empty for that tile to fill (D-021). The exact rules are in [style-guide.md](style-guide.md). For each bake tile and view rotation:

1. **Scene:** build the 3D geometry for the cells from the generators. Micro-terrain (M1.6, D-039) is the exception:
   - **Upload:** it goes up as textures (drawn micro-cell corners, cell attributes), and the vertex shader builds tops and walls from them.
   - **Walls:** only walls on the edges facing the viewer are drawn, because those are also the sunlit ones.
   - **AO:** a pre-pass computes AO per micro-corner.
   - **Margin:** micro-terrain tiles use an 8-cell margin.
2. **Shadow map:** an orthographic light view. Its XY extent covers the receivers (owned cells) and its depth range covers every caster.
3. **G-buffer pass** (integer projection, no anti-aliasing): ramp, quantized light level (N·L and shadow), material pattern, AO darkness, ownership and face kind, plus depth.
4. **Downsample by vote:** shapes that aren't on the grid (domes, organic forms) will be rendered at a higher resolution and reduced by majority vote on material ID, never by averaging colors. This is needed from M3; terrain doesn't use it.
5. **Composite to palette indices**, with cleanup:
   - Remove lone pixels.
   - Dither AO with a 4×4 ordered pattern.
   - Outline depth jumps of 2 or more units and the world edge with the ramp's shade 0.
   - Straighten uneven line runs (from M3, for geometry that isn't on the grid).
6. **Output:**
   - **Indexed color:** u8 palette index per pixel.
   - **Depth:** u16 per pixel.
   - **Optional normal + material ID** buffers, kept in case relighting is wanted later.

Bakes run in two places with the same code:

- **On the client**, in a worker using OffscreenCanvas + WebGL2, for terrain and generated content as chunks stream in. If a worker can't create WebGL2, baking falls back to the main thread. When a player edits the grid, only the affected bake tiles are re-baked.
  - **Streaming (M1):** a `ChunkStore` fetches gzipped chunks around the view, deduplicated, with URLs carrying the chunk hash. For each tile it slices the tile plus margin across chunk boundaries and hands the slice to the worker. The mesh builder only adds skirts at real world edges, not slice edges.
  - **Persistent cache (M1):** baked tiles are kept in IndexedDB, gzip-compressed and pruned least-recently-used. Cache keys include the package hash, style hash and `BAKE_VERSION`, so any change to the world, the style or the baker makes old tiles unreachable.
  - **GPU budget:** tile textures stay on the GPU within a memory budget (192 MB), evicting least-recently-drawn tiles.
- **Offline**, in headless Chromium via Playwright, for hero assets, building kits and vehicle sprite sheets. Cars get 16 headings; planes get 16–32 headings × pitch/bank steps. These outputs are indexed PNGs that can be painted over (e.g. in Aseprite's indexed mode).

### 8.2 Runtime compositor

1. Draw bake tiles into an **index + depth** framebuffer at the internal resolution. Each tile writes its baked depth.
2. Draw dynamic sprites (vehicles, characters, effects) with per-pixel depth. Their depth comes from the object's 3D position plus the sprite's own baked depth offsets. Correct occlusion falls out of the depth test.
3. Draw the player's silhouette where they are hidden: pixels that fail the depth test are drawn with a dither pattern.
4. **Palette pass:** index → RGB through a palette LUT. Swapping LUTs gives time of day, seasons, style variants and **palette cycling** (water, lights) almost for free.
5. Upscale by an integer factor with nearest-neighbor sampling. The camera position is snapped to whole pixels at internal resolution, and the leftover sub-pixel amount is applied during the upscale so scrolling stays smooth.

- **Internal resolution:** chosen per screen as an integer divisor (e.g. 1080p shown at 3× = 640×360, or 4× = 480×270).
- **Zoom:** integer zooms only. Zoomed-out levels use separate **semantic LOD bakes**, not shrunken images: blocks → city silhouettes → oversized landmark icons.

### 8.3 Full 3D mode (later)

The same scene builder feeds a live Three.js camera (e.g. a chase cam for flight) using the same materials and palette ramps. It is an optional mode, accepted to be less crisp than the baked isometric view, which remains canonical.

## 9. Gameplay and simulation

- **Cell model:** each cell has a terrain layer (height, corner shape, surface), a network layer (road/rail mask) and occupants (building parts, props). Player edits are a delta layer on top of the baked chunk, which triggers local re-bakes.
- **Vehicles:** kinematic controllers on the grid. They follow road connectivity and terrain slopes and collide with cell occupants. A general physics engine (e.g. Rapier) is deferred until full 3D mode needs one.
- **Flight:** an arcade flight model moving freely in 3D above the grid. Altitude is shown by a drop shadow; collision is checked against cell heights and occupant heights.
- **Building:** place and remove on the grid using the same generators. Valid placement is checked against slope and occupancy.
- **Tuning:** speeds are tuned to the compressed layout ("Vegas to the Grand Canyon in about 90 seconds"), not to real-world time.

## 10. World package format

- **Manifest:** region metadata, grid bounds, chunk index, LOD levels, palette/style pack versions, attribution list and content hashes.
- **Chunk (64×64 cells), in binary sections:**
  - terrain: base height `i16`, corner shape `u8`, surface `u8`, water `i16`
  - networks: connectivity mask `u8` + class `u8`
  - instances: kind, stable ID, anchor, footprint, height, parameters, seed
  - landmark stamps
  - labels
- **Compression:** chunk files are stored as deterministic gzip (`.pxwc.gz`) and decompressed in the client with `DecompressionStream`. A CDN may also apply brotli.
- **Codecs:** a TypeScript reader and a Python writer, kept in sync by shared golden test files.
- **Spec:** [world-format.md](world-format.md).
- **Hosting:** packages are static files on any CDN, possibly bundled as one archive the client reads with HTTP range requests.

## 11. Repository layout

Entries marked † don't exist yet.

```
docs/                     architecture, roadmap, data sources, decisions, format + style specs
worlds/                   region specs, style packs, landmark registry†, overrides†
assets/†                  hero models (.vox), painted sprite overrides, palettes
fixtures/                 committed world packages served by the dev app (M0 slice, Southwest)
testdata/                 cross-language golden files
pipeline/                 Python geo pipeline (uv-managed package + CLI)
packages/grid/            coordinates, projection, rotations, cell model
packages/world-format/    chunk + manifest codecs (TS)
packages/style/           style-pack validation, palette, material tables
packages/generators/      terrain and object meshes (buildings, networks, vegetation, landmarks†)
packages/bake/            WebGL2 baker: shadow, G-buffer and composite passes
packages/runtime/         chunk streaming, tile cache, bake worker + service, compositor, camera
packages/sim/†            vehicles, flight, building, cell occupancy
apps/web/                 player app
apps/editor/†             editor (warp tools, overrides, landmark placement)
tools/bake-cli/†          headless offline baking (Playwright)
e2e/                      Playwright golden-image and behaviour tests
```

## 12. Testing and quality

- **Pipeline:** pytest on small fixture regions. Stage outputs are checked against snapshots.
- **Format:** cross-language round-trip tests on golden chunk files.
- **Bake:** golden-image tests in headless Chromium on SwiftShader, with a small tolerance (`e2e/`). Behaviour tests check that every rotation is hole-free, that sub-pixel scrolling moves the image rigidly (no shimmer), and that occluded players show a silhouette. GPU rasterization isn't guaranteed to be bit-identical across devices, so goldens come from software rendering only. Hero assets are baked offline only, so they are pixel-exact.
- **Art review:** each milestone ends with a screenshot review at 1× zoom against a style reference sheet.
- **Performance budgets:** targets are 60 fps compositing on a mid-range laptop and recent phones, and tile bake time low enough that streaming never shows holes at normal driving speed. M0 measurements are in [roadmap.md](roadmap.md#m0-results).
