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
