# World package format (v1)

Status: chunk format v1, which replaced v0's one-step slope mask with multi-step corner shapes; readers still accept v0. Manifest format v0. It covers terrain only. Instances, networks, landmarks and labels are added in later versions (see [roadmap.md](roadmap.md)).

A world package is a directory, or later an archive, containing:

```
manifest.json
chunks/<cx>_<cy>.pxwc
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
    { "x": 0, "y": 0, "path": "chunks/0_0.pxwc", "sha256": "…" }
  ],
  "scale": {
    "metersPerCell": 160,           // layout scale (uniform in v0; warped from M2)
    "metersPerStep": 26.13,         // real metres per height step
    "elevationDatumMeters": 0,      // elevation at height step 0
    "verticalExaggeration": 2.5     // optional; relative to true proportions, already applied
  },
  "surfaces": { "0": "none", "1": "rock", "5": "water" },   // id → name
  "style": "desert-southwest",      // default style pack
  "source": { "crs": "+proj=tmerc …", "bounds": [w, s, e, n] },
  "attribution": [
    { "name": "USGS 3D Elevation Program", "license": "Public domain", "url": "…" }
  ],
  "generator": { "name": "…", "version": "…", "params": { } }
}
```

- **Converting steps to metres:** `metres = step × metersPerStep + elevationDatumMeters`. `verticalExaggeration` is informational, since the pipeline already applied it when choosing `metersPerStep`. If it's missing, it's implied as `metersPerCell / √6 / metersPerStep`.
- **Surface IDs are local to a package.** The contract between the pipeline and the client is the surface **name**. Style packs map surface names to materials.
- **Chunk coordinates:** chunk `(cx, cy)` covers cells `[cx·chunkSize, (cx+1)·chunkSize) × [cy·chunkSize, (cy+1)·chunkSize)`.

## Chunk file (`.pxwc`)

All integers are little-endian.

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

Readers must ignore unknown tags. Writers must not emit duplicate tags.

**v0 chunks** have a `SLOP` section instead of `CRNR`: a 4-bit mask, 0–14, where bit i means corner i is one step above `BASE`. Readers convert it to a shape where each set bit becomes an offset of 1.

## Versioning

- **Adding a section** is backward compatible. Bump the version only if readers must understand it.
- **Changing the meaning or layout of an existing section** requires a version bump. Readers reject versions they don't know.
