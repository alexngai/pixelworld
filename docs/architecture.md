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

1. **Layout scale (meters per cell)** comes from the warp and varies across the map. When driving it is fine where places matter (100 m/cell on the Vegas Strip) and coarse in empty desert (500 m/cell). It decides *how much real geography fits*. Each scale level (§3.5) has its own.
2. **Object scale** is fixed within a scale level: road widths, vehicle sizes, a floor height, a tree. A car is the same size everywhere. Style packs define object sizes in cells and steps. A level can draw objects bigger than real (depiction scale, D-047), and landmarks may set their own.
3. **Vertical scale** is set per region as a **vertical exaggeration** E relative to true proportions (1 = real slopes). Every height difference spans E times as many steps, and meters per step = meters per cell × (1/√6) / E. It's applied before quantization, because steps are integers, so it can't be changed at render time. Per-feature caricature (e.g. deepen the canyon) comes on top. Exaggeration is capped so that driving stays possible.

Because of this, the same real building can take up more or fewer cells depending on the local layout scale. When it would fall below the minimum footprint, it is merged into a block or dropped. Only landmarks are protected from this, by their rigid stamps.

### 3.3 The grid

- **Cell:** a square footprint. It is the unit of placement, collision and building.
- **Height step:** the vertical unit. Terrain and object heights are whole steps.
- **Terrain model:** RCT-style, extended to steep slope tiles. Each cell has a base height (its lowest corner) and a corner shape: each corner sits 0–3 steps above the base. Neighbouring cells share corner heights, so slopes are continuous. Where they don't match, the edge becomes a vertical cliff face. The pipeline caps the rise per cell (`max_slope`, default 2); anything steeper becomes a terrace with cliffs. This gives gradual slopes on gentle ground, readable terraces and cliffs on canyon walls and mesas, and ramps that roads can climb. Rises of 1–3 steps per cell keep cell edges on clean pixel angles (horizontal, 2:1 or 1:1 going up).
- **Directions:** 8. A world-axis edge projects to an exact 2:1 pixel staircase. A world diagonal projects to a perfectly horizontal or vertical screen line, so 45° roads and building cuts are also pixel-clean. Curves become 8-direction polylines.
- **Snapping to the grid directions (D-049):** geometry is pulled toward those 8 directions so it draws as clean pixel lines rather than jittery staircases.
  - **Street networks:** they are straightened as a whole. Each road edge within a few degrees of a grid direction is made to run exactly along it, with junctions moving as little as possible (under 2 cells) and staying shared. A slightly rotated street grid therefore comes out aligned rather than full of one-cell jogs.
  - **Long runs:** roads are laid in long runs, so in-between angles alternate a few long runs instead of single steps.
  - **Buildings:** they move with their streets and turn to the nearest grid direction when they're close to one.
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

### 3.5 Scale levels (D-046, D-047, D-048)

A region is built as several world packages, one per way of moving through it. Each is tuned to be recognizable and interesting at its own pace:

| Level | Southwest spec | Cells | For |
|---|---|---|---|
| fly | `worlds/southwest/fly.yaml` | 1.5 km in open desert; 400–600 m in focus areas | short flights between landmarks, which are drawn oversized |
| drive | `worlds/southwest/region.yaml` | 500 m in open desert; 100–250 m in focus areas | the road trip |
| walk | `worlds/southwest/walk.yaml` | 20 m, uniform, the Strip only | street level |

- **Specs:**
  - A level spec `extends:` the base spec and overrides its parameters. Mappings merge key by key, anything else replaces, and `null` removes a section.
  - The base spec lists every level as `levels: [{name, world, label}]`, where `world` is the sibling package's id.
- **What a level tunes:**

  | Aspect | Parameters |
  |---|---|
  | Extent | `bounds`; a walking level covers one district |
  | Layout | `metersPerCell` (the base scale: height step and relief reference), `warp.background`, `warp.focusScale` (multiplies every focus area's target), a warp file of its own, or `warp: null` for a uniform grid |
  | Relief | `verticalExaggeration`, `warp.vertical` (caricature), `reliefMax` on a focus area (D-041), `maxSlope`, `micro.k`, `smoothing` |
  | Generalization | `sources.roads.classes`, `terrain` rules (e.g. minimum lake area), `objects.buildings` (`minArea`, `bounds`), `objects.depiction.buildings.minHeightMeters` |
  | Depiction | `objects.depiction.buildings.scale`, `objects.depiction.landmarks.scale` (or `scale` on one landmark), `objects.depiction.heightStretch`, `objects.lowrise` (built-up land as city blocks, D-067) |
  | Data | `sources.dem` and `sources.landcover`: kind and overview |
  | Snapping | `snap.roads` (`angle`, `simplify`, `deviation`, `maxShift`), `snap.buildings` (`angle`, `follow`, `clearRoads.nudgeMeters`) (D-049) |
  | Widths | `widths` (`scale`, `minCells`, per-class `roads`/`paths` metres, `ways` rules by name, box and one-way: `meters`, `lanes`), `sources.roads.excludeSubclasses`, `sources.roads.joinIslands`, `sources.paths.classes` (D-050) |
  | Lanes | `widths.lanes` (`meters`, `lines`, `medianMeters`) (D-065) |

- **Moving between levels:** every level package has a geo grid, the lon/lat of cell corners (D-048). The client turns the rover's cell into lon/lat in one level and back into a cell in the next (the L key). A place outside the next level's area lands at that level's start.
- **Not a zoom:** zoom enlarges the same baked pixels. A level is a different world, with its own cells, generalization and depiction.

## 4. World definition (source of truth)

A world is a set of **regions**. Each region is continuous inside and defined by files in `worlds/` that are version-controlled and reviewed like code. A region can be built at several scale levels (§3.5), each from a level spec that extends the region's. The M1 spec is [`worlds/southwest/region.yaml`](../worlds/southwest/region.yaml). It holds bounds, a uniform `metersPerCell`, `verticalExaggeration`, `maxSlope`, smoothing, a start point, pinned data sources and geology provinces. The fields below for focus areas, pins, landmarks and overrides arrive with M2–M3:

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
- **Plugins** (`plugins.py`, [plugins.md](plugins.md)): the spec names its elevation and land-cover sources and its building facts source, and the registry finds each by name: built in, or from an installed package's entry points. San Francisco's DataSF facts are the city pack `pipeline/plugins/pixelworld-city-sf`.
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
4. **importance:** score features and areas by fame and interest, combine with the hand-painted focus areas, and produce a target **scale field**. M2 uses Wikidata sitelinks, kept as a committed snapshot (`worlds/<id>/importance.json`, refreshed by `pixelworld importance`). Pageviews and OSM tags may come later.
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

The editor drives the same stages through a local pipeline server (`uv run pixelworld serve worlds/<id>/region.yaml`, plus `pnpm --filter @pixelworld/editor dev`). A pin or focus edit re-solves the warp and shows a warped preview within seconds, and "Build world" re-exports the whole package (about 1.5 min for the Southwest).

## 6. Elastic map (warp)

Goal: a smooth, fold-free mapping from region meters to world cells that matches the target scale field while keeping local shapes recognizable.

Implemented in M2 (`pipeline/src/pixelworld_pipeline/warp.py`, `layout.py`; decisions D-040 to D-044):

- **Scale field:** target metres per cell over the region.
  - **Background:** the scale where nothing is magnified.
  - **Focus areas:** circles with a target scale inside a core radius, blending back over a falloff (smoothstep in log scale).
  - **Importance:** up to 1.6× extra magnification around places with many Wikipedia sitelinks (§5 stage 4).
  - **Combining:** where terms overlap, the finest wins. Focus areas and pins live in `worlds/<id>/warp.yaml`, which the editor writes.
- **v0 (no warp):** uniform scale, used for M1 and for worlds without a `warp` section. The layout itself adds nothing, so these worlds build as before M2, apart from pipeline rule changes such as D-044.
- **v1 (separable):** x′ = F(x), y′ = G(y), built from the cumulative interest along each axis. It's always fold-free and serves as v2's starting point. It can't scale two places at the same latitude independently.
- **v2 (mesh solve):**
  - **Mesh:** a triangulated grid (2 km; the editor uses 4 km).
  - **Energy:** each triangle's distortion is measured relative to its target scale with the symmetric Dirichlet energy. This is minimal for a similarity at the target and infinite at inversion. It is weighted by area times magnification², i.e. by the output area it occupies.
  - **Minimisation:** reweighted local/global steps (SLIM). A line search never lets a triangle flip, so a solve that starts fold-free stays fold-free.
  - **Boundary:** it slides along a rectangle whose size is solved.
  - **Pins:** soft positional constraints.
  - **Corrections:** two passes rescale each focus area's internal target by its measured error.
  - **Southwest:** every focus area lands within 0.5% of its target, in about 20 s on a 2 km mesh or 3–4 s on 4 km.
- **Applying the warp:**
  - **Rasters:** the DEM (cell and micro-corners) and land cover are sampled at inverse-mapped points. Sources are read as a pyramid of levels in fixed, individually cached blocks. Each point uses the coarsest level no coarser than its local sample spacing.
  - **Vectors:** they are densified to about 1 km, then forward-mapped.
  - **Provinces and the start:** they use the maps too.
  - **Landmarks and building footprints:** they are stamped rigidly with the local similarity at their anchor and never sheared. Each instance carries its local metres per cell.
- **Vertical caricature:**
  - **Rule:** local relief is exaggerated as elev′ = ref + R·(elev − ref). ref is the elevation smoothed over about 6 km, so flat ground and the regional trend are untouched. R = (base metres per cell / local metres per cell)^γ, clamped, so magnified places keep the base proportions.
  - **Strata:** per-cell `VREF`/`VFAC` layers carry the mapping, so the shader draws strata at real elevations.
- **Editor UX:** `apps/editor` with `pixelworld serve`; see §11 and the roadmap's M2 results.

## 7. Content generation (client, TypeScript)

Generators are pure functions: `(semantic instance, style pack, seed) → 3D geometry + material IDs`. Seeds are a stable hash of (region, feature ID, purpose).

- **Terrain:** cells → mesh with top faces, slope faces and cliff faces. Materials come from the surface class, plus elevation bands (rock strata) and a seeded pattern. Worlds with micro-terrain skip the JavaScript mesh: the baker builds the geometry on the GPU (§8.1).
- **Buildings:** footprint → massing (setbacks by height) → roof (flat, gable, hip, dome, …) → facade pattern → material ramps. The parameters come from the style pack and building use.
- **Networks:** each road or rail cell, based on its connectivity mask, becomes a road piece (straight, corner, junction, ramp, bridge) with markings by class.
- **Vegetation and props (M3, D-054):** species templates per biome. Decorative scatter (shrubs, small trees, rocks) is placed by the client per bake tile from the style pack's rules by surface, hashed per world cell so overlapping tiles agree. The pipeline places what needs data or matters for play: trees from the canopy height map, street trees, street lights and traffic signals.
- **Buildings (M3):** the generator reads Overture roof-shape and facade hints and lidar tower parts (D-052). The style guide (§13) holds the rules.
- **Landmarks (D-051):** registry entries in `worlds/_landmarks/` pick a depiction per variant (`generic` by default), each a semantic group: parametric generators from the component kit (towers, lattices, wheels, arches, domes, intake towers) or, later, voxel models (`.vox`).

Hero landmarks (D-053) are baked offline (`tools/hero-bake.mjs`) and painted over. After every tile bake the client stamps the painted pixels in where the tile shows the landmark at its baked depth, so paint survives re-bakes and anything in front still hides it.

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
- **Offline**, in headless Chromium via Playwright, for hero assets (`tools/hero-bake.mjs`, D-053), building kits and vehicle sprite sheets. Cars get 16 headings; planes get 16–32 headings × pitch/bank steps. These outputs are indexed PNGs that can be painted over (e.g. in Aseprite's indexed mode).

### 8.2 Runtime compositor

1. Draw bake tiles into an **index + depth** framebuffer at the internal resolution. Each tile writes its baked depth.
2. Draw dynamic sprites (vehicles, characters, effects) with per-pixel depth: the runtime layers' sprites (traffic), then the entities' (the rover). Their depth comes from the object's 3D position plus the sprite's own baked depth offsets. Correct occlusion falls out of the depth test.
3. Draw the silhouette of entities that ask for one (the player) where they are hidden: pixels that fail the depth test are drawn with a dither pattern.
4. **Atmosphere (fog, D-063):** a layer's screen pass. Where a fog layer is in view, a pass recovers each pixel's ground position and height from its screen position and depth (tiles write their depth beside the index), and veils its colour index toward the fog's through per-level lookup tables, dithered on the screen's Bayer pattern. It is skipped when no fog is in view.
5. **Palette pass:** index → RGB through a palette LUT. Swapping LUTs gives time of day, seasons, style variants and **palette cycling** (water, lights) almost for free.
6. Upscale by an integer factor with nearest-neighbor sampling. The camera position is snapped to whole pixels at internal resolution, and the leftover sub-pixel amount is applied during the upscale so scrolling stays smooth.

- **Internal resolution:** chosen per screen as an integer divisor (e.g. 1080p shown at 3× = 640×360, or 4× = 480×270).
- **Zoom:** integer zooms only. Coarser views are separate scale levels (§3.5) with their own generalization and oversized landmarks, not shrunken images.

### 8.3 The engine (the world view as a library)

The client's runtime is a library, `@pixelworld/engine` (library.md §7): `createWorldView({ canvas, worldUrl, style, layers, controller })` streams a world package around the camera, bakes and caches its tiles and composites them as above, in a frame loop that redraws only when something changed. It owns no input handling or UI. Around it:

- **Runtime layers** draw over the baked world without being baked into it: sprites each frame, an optional screen pass, sublayers, and their whole state as JSON. Traffic (`@pixelworld/sim`) and fog (the engine) are layers.
- **Entities** are depth-tested sprites placed in cells and heights, baked per rotation and heading from boxes or a style group and seed. The rover is one.
- **Controllers** turn input into entity and camera movement, using **queries** (the drawn ground, surfaces, roads, the cell under a screen point, lon/lat). The rover and free camera are the first, `roverController`.

The reference viewer (`apps/web`) and the examples (`examples/`) are clients of this API only.

### 8.4 Full 3D mode (later)

The same scene builder feeds a live Three.js camera (e.g. a chase cam for flight) using the same materials and palette ramps. It is an optional mode, accepted to be less crisp than the baked isometric view, which remains canonical.

## 9. Gameplay and simulation

- **Cell model:** each cell has a terrain layer (height, corner shape, surface), a network layer (road/rail mask) and occupants (building parts, props). Player edits are a delta layer on top of the baked chunk, which triggers local re-bakes.
- **Vehicles:** kinematic controllers on the grid. They follow road connectivity and terrain slopes and collide with cell occupants. A general physics engine (e.g. Rapier) is deferred until full 3D mode needs one.
- **Flight:** an arcade flight model moving freely in 3D above the grid. Altitude is shown by a drop shadow; collision is checked against cell heights and occupant heights.
- **Building:** place and remove on the grid using the same generators. Valid placement is checked against slope and occupancy.
- **Tuning:** speeds are tuned to the compressed layout ("Vegas to the Grand Canyon in about 90 seconds"), not to real-world time.
- **Ambient traffic (D-060):** a runtime layer of the world view (`trafficLayer`, §8.3). `packages/sim` moves cars, buses, cable cars, streetcars, light rail, trains and ferries along the routes the pipeline exports from each built package (`routes.json.gz`: the drawn roads, bridge decks at their height, rail and ferry lines). It steps in fixed ticks from one seeded RNG, keeps a density per kind around the view, and its whole state serializes as JSON. Vehicles are baked once per model and heading, in one view rotation, and drawn by the compositor as depth-tested sprites (§8.2).

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
worlds/                   region specs, style packs, landmark registry with hero bakes and paint-overs, overrides†
assets/†                  hero models (.vox), palettes
fixtures/                 committed world packages served by the dev app (M0 slice, Southwest)
testdata/                 cross-language golden files
pipeline/                 Python geo pipeline (uv-managed package + CLI)
pipeline/plugins/         pipeline plugins in the uv workspace: city packs (pixelworld-city-sf)
packages/grid/            coordinates, projection, rotations, cell model
packages/world-format/    chunk + manifest codecs (TS)
packages/style/           style-pack validation, palette, material tables
packages/generators/      terrain and object meshes (buildings, networks, vegetation, landmarks), client scatter
packages/bake/            WebGL2 baker: shadow, G-buffer and composite passes
packages/runtime/         chunk streaming, tile cache, bake worker + service, compositor, camera, fog fields (internal to the engine)
packages/engine/          the public world view (library.md §7): createWorldView, layers (fog), entities, controllers (the rover), queries
packages/sim/             ambient traffic: routes, vehicle simulation, vehicle models, the traffic layer (flight†, building†, cell occupancy†)
packages/pixelworld/      the npm package `pixelworld` (docs/npm.md): entry points over the packages above, built to dist/ with the bake worker
apps/web/                 the reference viewer, a client of the engine: URL parameters, HUD, layer panel, levels, debug API; bench.html
apps/editor/              editor v0: focus areas and pins against `pixelworld serve` (overrides, landmark placement†)
examples/                 apps built only on the public packages: minimal-viewer (a world, the rover, traffic)
examples/consumers/       projects that use the packed npm package: Vite, webpack 5, plain ESM (tools/consumers.mjs runs them)
tools/                    headless tools (Playwright): hero-bake.mjs, bench.mjs, consumers.mjs; pack-check.mjs
e2e/                      Playwright golden-image and behaviour tests
```

## 12. Testing and quality

- **Pipeline:** pytest on small fixture regions. Stage outputs are checked against snapshots.
- **Format:** cross-language round-trip tests on golden chunk files.
- **Bake:** golden-image tests in headless Chromium on SwiftShader, with a small tolerance (`e2e/`). Behaviour tests check that every rotation is hole-free, that sub-pixel scrolling moves the image rigidly (no shimmer), and that occluded players show a silhouette. GPU rasterization isn't guaranteed to be bit-identical across devices, so goldens come from software rendering only. Hero assets are baked offline only, so they are pixel-exact.
- **Art review:** each milestone ends with a screenshot review at 1× zoom against a style reference sheet.
- **Performance budgets:** targets are 60 fps compositing on a mid-range laptop and recent phones, and tile bake time low enough that streaming never shows holes at normal driving speed. M0 measurements are in [roadmap.md](roadmap.md#m0-results); the benchmark page below measures them on any machine.

### Benchmarks

`apps/web/bench.html` measures tile bakes, frames and memory on the machine and GPU it runs on.

- **On your desktop:** run `pnpm bench`. It starts the dev server and opens http://localhost:5173/bench.html (if `pnpm dev` is already running, open that address instead). Press **Run**, keep the tab in front (browsers slow animation frames in background tabs) and don't edit sources meanwhile (the dev server would reload the page). It takes a few minutes. Then **Copy text** or **Copy JSON**. The report's GPU line names the renderer the bake worker got; if it says SwiftShader or llvmpipe, the browser isn't using the GPU (check `chrome://gpu`).
- **Headless:** `pnpm bench:headless` (`tools/bench.mjs`) runs the page in Playwright's Chromium on SwiftShader and prints the report. Options: `--out report.json` (also writes `report.txt`), `--cases sw-drive,sf-walk`, `--size 1280x720`, `--gpu --headed` for the system GPU in a window, `--url` for a running server.
- **Cases:** the Southwest's driving level at Grand Canyon Village (rotation 2) and walking level on the Strip; San Francisco's driving level over the Outer Sunset, in fog, and walking level at Alamo Square. Each loads the app in an iframe on a 1280×720 canvas with the tile cache off and `bench=1`, which keeps every tile's timings (without it the app is unchanged), at zoom 3, then 2, then 1. Each zoom bakes the tiles its wider view adds.
- **Measures:**
  - **Tile bakes:** mesh (the tile's geometry and objects, built in the bake worker on the CPU) plus bake (the GPU passes, until the pixels are read back), per tile, as the running app bakes them. Each case's first tile compiles the shaders and is reported apart.
  - **Frames,** with no layers, traffic, fog and both: `draw` redraws one frame 20 times, waiting for the GPU each time; `frame` is the 95th-percentile interval between animation frames over 1.5 s while the layers move (60 Hz displays cap it at 16.7 ms); `cpu` is the main thread's time per frame (compositor and traffic simulation).
  - **Memory** after each zoom: baked tile textures on the GPU, the page's JavaScript heap (Chromium only, without the worker's), chunks loaded and vehicle sprites.

**Software baseline** (SwiftShader, 4 cores, headless Chromium 153, 9 November 2026, the committed packages): per tile, median and 95th percentile of mesh + bake over all zooms.

| Case | Tiles | Tile median / p95 | Mesh median | First tile | Draw, no layers, 3× / 1× | Tile textures at 1× |
|---|---|---|---|---|---|---|
| Southwest, driving, Grand Canyon Village | 17 | 1.8 / 2.7 s | 19 ms | 3.0 s | 22 / 82 ms | 46 MB |
| Southwest, walking, the Strip | 14 | 9.3 / 25.2 s | 5.3 s | 11.0 s | 18 / 71 ms | 32 MB |
| San Francisco, driving, Outer Sunset | 16 | 7.8 / 12.1 s | 1.6 s | 9.7 s | 27 / 18 ms (44 with fog) | 33 MB |
| San Francisco, walking, Alamo Square | 16 | 4.7 / 9.9 s | 1.8 s | 3.4 s | 9 / 72 ms | 37 MB |

- **Reading it:** software rendering shares four cores between the bake worker and the page, which keeps redrawing while tiles stream in, so these bakes are slower than M1.6's isolated measurements (256–322 ms) and their draw times are noisy. The page's heap stayed at 51 MB. The desktop budget is 50 ms per tile on a GPU (M1.6). A GPU speeds up only the bake part: the mesh part is JavaScript on the CPU, and on the walking levels it is already most of a tile's time here (the Strip's casino towers take seconds per tile).
