# World package format (v0)

Status: v0, introduced in M0. It covers terrain only. Instances, networks, landmarks and labels are added in later versions (see [roadmap.md](roadmap.md)).

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
    "metersPerStep": 40,            // vertical scale
    "elevationDatumMeters": 0       // elevation at height step 0
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

- **Surface IDs are local to a package.** The contract between the pipeline and the client is the surface **name**. Style packs map surface names to materials.
- **Chunk coordinates:** chunk `(cx, cy)` covers cells `[cx·chunkSize, (cx+1)·chunkSize) × [cy·chunkSize, (cy+1)·chunkSize)`.

## Chunk file (`.pxwc`)

All integers are little-endian.

### Header (20 bytes)

| Offset | Type | Field |
|---|---|---|
| 0 | `char[4]` | magic `PXWC` |
| 4 | `u16` | format version (`0`) |
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

### Sections (v0)

All per-cell arrays are `size × size` and row-major: `y` (south) is the outer loop and `x` (east) the inner loop.

| Tag | Type | Required | Meaning |
|---|---|---|---|
| `BASE` | `i16[]` | yes | base height in steps |
| `SLOP` | `u8[]` | yes | slope corner mask, 0–14 (bit i = corner i raised one step; see `packages/grid/src/terrain.ts`) |
| `SURF` | `u8[]` | yes | surface ID (see `manifest.surfaces`) |
| `WATR` | `i16[]` | no | water surface height in steps; `-32768` = no water |

Readers must ignore unknown tags. Writers must not emit duplicate tags.

## Versioning

- **Adding a section** is backward compatible. Bump the version only if readers must understand it.
- **Changing the meaning or layout of an existing section** requires a version bump. Readers reject versions they don't know.
