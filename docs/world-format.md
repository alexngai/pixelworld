# World package format (v1)

Status: chunk format v1, which replaced v0's one-step slope mask with multi-step corner shapes; readers still accept v0. Manifest format v0. It covers terrain, roads and geology (M1). Instances, landmarks and labels are added in later versions (see [roadmap.md](roadmap.md)).

A world package is a directory, or later an archive, containing:

```
manifest.json
chunks/<cx>_<cy>.pxwc      (or .pxwc.gz)
build-report.json           (optional, written by the pipeline; not read by clients)
```

The geo pipeline (Python) writes packages and the client (TypeScript) reads them. The codecs live in `pipeline/src/pixelworld_pipeline/world_format.py` and `packages/world-format/`. Both are tested against the shared golden files in `testdata/world-format/`.

## Manifest (`manifest.json`)

```jsonc
{
  "format": "pixelworld-world",
  "formatVersion": 0,
  "id": "grand-canyon-m0",
  "name": "Grand Canyon (M0 slice)",
  "chunkSize": 64,                  // cells per chunk side
  "cellsX": 128,                    // grid extent in cells
  "cellsY": 128,
  "chunks": [
    { "x": 0, "y": 0, "path": "chunks/0_0.pxwc.gz", "sha256": "…",
      "heightRange": [2, 31],       // lowest/highest corner height in the chunk (steps)
      "metersPerCell": 102.4 }      // optional (M2): mean real metres per cell in a warped world
  ],
  "scale": {
    "metersPerCell": 160,           // layout scale (uniform in v0; warped from M2)
    "metersPerStep": 26.13,         // real metres per height step
    "elevationDatumMeters": 0,      // elevation at height step 0
    "verticalExaggeration": 2.5     // optional; relative to true proportions, already applied
  },
  "heightRange": [2, 57],           // lowest/highest corner height in the world (steps)
  "surfaces": { "0": "none", "1": "rock", "5": "water" },   // id → name
  "roadClasses": { "1": "secondary", "4": "motorway" },      // id → name (RCLS), numbered by priority
  "pathClasses": { "5": "sidewalk", "6": "crosswalk" },      // optional (D-050): id → name (PCLS)
  "geology": { "0": "basin-and-range", "1": "colorado-plateau" }, // id → province (GEOL)
  "start": { "x": 193, "y": 388 },  // suggested starting cell
  "style": "desert-southwest",      // default style pack
  "source": { "crs": "+proj=tmerc …", "bounds": [w, s, e, n] },
  "attribution": [
    { "name": "USGS 3D Elevation Program", "license": "Public domain", "url": "…" }
  ],
  "generator": { "name": "…", "version": "…", "params": { } },
  "render": { "scale": 0.125, "tileSize": 512 },  // optional (M1.5): render units per cell; bake tile edge in cells
  "objects": { "path": "objects.json.gz", "sha256": "…", "count": 9401 },  // optional (M1.5)
  "micro": { "k": 4 },              // optional (M1.6): every chunk has an MHGT section
  "warp": { "method": "v2", "background": 500, "focus": [ … ], "pins": 0, "vertical": { … } },  // optional (M2), informational
  "depiction": { "heightStretch": 1.0, "scatter": 1.0 },  // optional (D-047, D-054): how objects are drawn at this level
  "level": "drive",                 // optional (D-046): this package's scale level
  "levels": [ { "name": "fly", "world": "southwest-fly", "label": "Flying" }, … ],  // optional: every level of the region
  "geo": { "path": "geo.i32.gz", "step": 4, "size": [290, 179], "sha256": "…" },  // optional (D-048)
  "heroes": [ { "id": "strat-tower", "rotation": 0, "left": -2046, "top": 3969, "width": 17, "height": 151,
                "depthBase": 564, "bake": "heroes/strat-tower/bake-r0.png",
                "paint": "heroes/strat-tower/paint-r0.png", "sha256": "…" }, … ],  // optional (M3, D-053)
  "packageHash": "…"                // SHA-256 of this manifest without the field
}
```

- **Converting steps to metres:** `metres = step × metersPerStep + elevationDatumMeters`. `verticalExaggeration` is informational, since the pipeline already applied it when choosing `metersPerStep`. If it's missing, it's implied as `metersPerCell / √6 / metersPerStep`.
- **Optional fields:** `heightRange`, the chunk `heightRange`s, `roadClasses`, `geology`, `start` and `packageHash` are all optional, so M0 manifests stay valid. Clients use the height ranges to place and depth-sort tiles before any chunk is loaded. Without them, a client has to load every chunk first.
- **Package hash:** `packageHash` is the SHA-256 of the manifest's canonical JSON (sorted keys, without `packageHash`). The manifest already lists every chunk's SHA-256, so identical inputs and code give an identical hash. Clients key their baked-tile caches on it.
- **Surface IDs are local to a package.** The contract between the pipeline and the client is the surface **name**. Style packs map surface names to materials. Road classes and geology provinces work the same way.
- **Warped worlds (optional, M2, D-040):** cells are laid out by an elastic map, so real metres per cell vary.
  - **Local scale:** `chunks[].metersPerCell` records the mean per chunk.
  - **Summary:** `warp` summarises the layout (focus targets and what they achieved).
  - **Nominal scale:** `scale.metersPerCell` stays the base scale that heights and steepness rules are expressed in.
  - **Objects:** instances carry `m`, their local metres per cell, and a dam carries `top`, its crest height in steps.
- **Micro-terrain (optional, D-038):** `micro.k` (2, 4 or 8; the Southwest uses 4) means every chunk carries micro-corner heights (`MHGT`). Height ranges in the manifest and chunk refs cover micro-terrain too.
- **Render scale (optional, D-032):** `render.scale` in (0, 1] draws each cell at that fraction of a 32×16 px tile, and heights shrink by the same factor. Fine experiment worlds use it to stand in for micro-terrain. `render.tileSize` overrides the bake tile edge (default 32 cells).
- **Objects (optional, D-034):** `objects.path` points to a gzipped JSON file, `{ "version": 1, "instances": [...] }`. Each instance has:
  - `g`: semantic group
  - `x`, `y`: position in cells
  - `s`: seed, which picks the variant
  - optional `r`: quarter-turns
  - optional `fp`: footprint polygon in cells
  - optional `hm`: real or depicted height in metres
  - optional `top`: absolute top height in steps (dam crests, bridge decks)
  - optional `id`: landmark registry id (D-051), on a landmark and each of its parts
  - optional `rs`, `fm`, `fc`, `rc`: Overture roof shape, facade material, facade colour and roof colour, as hints for the building generator (M3)

  Objects with `fp` or `hm` are unique; the rest are instanced per variant. Groups resolve through the style pack (D-030). Decorative scatter is not stored: clients add it by surface, scaled by `depiction.scatter` (D-054).
- **Scale levels (optional, D-046):**
  - `level` names this package's level.
  - `levels` lists every level of the region, this one included. `world` is a sibling package's id, which is also its directory next to this one.
  - `depiction.heightStretch` overrides the style pack's object height stretch for this level (D-047).
  - Instances drawn bigger than real carry a smaller `m`: an object is drawn as if its local metres per cell were `m`.
- **Hero landmarks (optional, M3, D-053):** `heroes` has one entry per landmark and rotation. Both images sit at absolute screen pixels (`left`, `top`) of that rotation's projection and share its size.
  - **`bake`:** an RGBA PNG of the landmark baked alone: R is the palette index, G and B are depth (`depthBase + (G·256 + B) / 256`, larger is closer), and A is coverage.
  - **`paint`:** an 8-bit indexed PNG in the style palette, where index 0 keeps the baked pixel.
  - **Use:** clients stamp painted pixels into every tile bake, only where the tile shows the landmark at the bake's depth, or, beyond its silhouette, empty ground or what lies behind it.
  - **Hash:** `sha256` covers both files.
- **Geo grid (optional, D-048):** `geo.path` is a gzipped file of little-endian int32 microdegrees, shape `(ny, nx, 2)` as (lon, lat), where `size` is `[nx, ny]`.
  - **Points:** they sit at cell corners `x = min(i·step, cellsX)` and `y = min(j·step, cellsY)`; positions in between are bilinear.
  - **Coding:** each row is delta-coded along x, with the first point absolute.
  - **Use:** clients convert between cells and lon/lat with it, both ways, to carry a place from one level to another.
- **Chunk coordinates:** chunk `(cx, cy)` covers cells `[cx·chunkSize, (cx+1)·chunkSize) × [cy·chunkSize, (cy+1)·chunkSize)`.

## Chunk file (`.pxwc`)

All integers are little-endian. A chunk file may be stored gzip-compressed (`.pxwc.gz`). Readers detect the gzip magic bytes (`1f 8b`), so the suffix is informational. The pipeline writes deterministic gzip (mtime 0), and `sha256` covers the compressed bytes.

### Header (20 bytes)

| Offset | Type | Field |
|---|---|---|
| 0 | `char[4]` | magic `PXWC` |
| 4 | `u16` | format version (`1`; readers also accept `0`) |
| 6 | `u16` | flags (reserved, `0`) |
| 8 | `i32` | chunk x |
| 12 | `i32` | chunk y |
| 16 | `u16` | size: cells per side (64 in production; tests use smaller) |
| 18 | `u16` | section count |

### Section table

Starts at offset 20. There is one 12-byte entry per section:

| Type | Field |
|---|---|
| `char[4]` | tag |
| `u32` | offset from the start of the file |
| `u32` | byte length |

Section payloads follow the table, each starting on a 4-byte boundary.

### Sections (v1)

All per-cell arrays are `size × size` and row-major: `y` (south) is the outer loop and `x` (east) the inner loop.

| Tag | Type | Required | Meaning |
|---|---|---|---|
| `BASE` | `i16[]` | yes | base height in steps |
| `CRNR` | `u8[]` | yes | corner shape: each corner's height above `BASE`, 0–3 steps, packed two bits per corner (corner i in bits 2i..2i+1; see `packages/grid/src/terrain.ts`). At least one corner is 0, because `BASE` is the lowest corner. |
| `SURF` | `u8[]` | yes | surface ID (see `manifest.surfaces`) |
| `WATR` | `i16[]` | no | water surface height in steps; `-32768` = no water |
| `ROAD` | `u16[]` | no | road network. Bits 0–7: the road continues to the neighbour in direction i (N, NE, E, SE, S, SW, W, NW; see `ROAD_DIRS`). Bits 8–11: a diagonal road between two other cells passes through corner i of this cell. |
| `RCLS` | `u8[]` | no | road class ID (see `manifest.roadClasses`); 0 = none |
| `GEOL` | `u8[]` | no | geology province ID (see `manifest.geology`); picks the strata set for rock and cliffs |
| `MHGT` | `i16[]` | no | micro-terrain (M1.6, D-038): see below |
| `VREF` | `i16[]` | no | vertical caricature (M2, D-041): relief reference height in 1/16 steps (default 0) |
| `VFAC` | `i16[]` | no | vertical caricature: 1/R in 1/4096 units (default 4096 = none). A drawn height h is the real height `ref + (h − ref)·VFAC/4096` |
| `RWID` | `u8[]` | no | real widths (D-050): half-width of the widest road through the cell, in 1/32 cell. 0 = draw at the style's fixed width. Clients draw a road at least as wide as the style's width for its class. |
| `PATH` | `u16[]` | no | path network (footways, sidewalks, crosswalks, …), encoded like `ROAD` |
| `PCLS` | `u8[]` | no | path class ID (see `manifest.pathClasses`); 0 = none |
| `PWID` | `u8[]` | no | path half-width, in 1/32 cell |

Optional sections are omitted when they hold only their default value (no water, no roads, province 0). Readers must ignore unknown tags. Writers must not emit duplicate tags.

**Micro-terrain (`MHGT`).**
- **Contents:** the height of every micro-corner when the world has `manifest.micro` (K micro-cells per cell edge). The values are in micro-steps of 1/K step.
- **Layout:** `(K·size + 1)²` values, row-major. The last row and column repeat the neighbouring chunk's first, so a chunk is complete on its own. Past the world edge, the edge corners are repeated.
- **Encoding:** rows are delta-coded. The first value of a row is absolute and each following value is the difference from its left neighbour, with 16-bit wrap-around.
- **K** follows from the section length.
- **Micro-cells** are derived from their four corners, with the same rule in the pipeline (`world_format.micro_cells`) and the client (`microCellCorners`):
  - If the corners span at most 3 micro-steps, the micro-cell is a slope tile on them.
  - Otherwise it's flat at their mean, rounded half up.
- **Role of the cell layers:** they stay the gameplay summary; micro-terrain is what's drawn and what vehicles drive on.

**v0 chunks** have a `SLOP` section instead of `CRNR`: a 4-bit mask, 0–14, where bit i means corner i is one step above `BASE`. Readers convert it to a shape where each set bit becomes an offset of 1.

## Versioning

- **Adding a section** is backward compatible. Bump the version only if readers must understand it.
- **Changing the meaning or layout of an existing section** requires a version bump. Readers reject versions they don't know.
