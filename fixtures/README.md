# Committed world packages

World packages the dev app serves and the tests use. They are served as static files by the web app (`apps/web/vite.config.ts` sets this directory as Vite's `publicDir`).

## grand-canyon-m0

128×128 cells at a uniform 160 m per cell (no warp), with 2.5× vertical exaggeration (26.1 m per height step) and slope tiles up to 2 steps per cell. Covers the South Rim at Grand Canyon Village, the Colorado River near Phantom Ranch, and the North Rim near Bright Angel Point.

Regenerate:

```sh
cd pipeline && uv run python -m pixelworld_pipeline.fixtures.grand_canyon_m0
# try other exaggerations (1.0 = real slopes) into a scratch directory, then open
# http://localhost:5173/?world=/_try/
uv run python -m pixelworld_pipeline.fixtures.grand_canyon_m0 --exaggeration 3.5 --max-slope 3 --out ../fixtures/_try
```

`fixtures/_try/` is git-ignored.

Sources and licenses:
- Elevation: USGS 3D Elevation Program (3DEP) 1/3 arc-second DEM. Public domain.
- Colorado River centerline: © OpenStreetMap contributors, ODbL 1.0. Because of this, the package is a derivative database under the ODbL; see `docs/data-sources.md` §6.

Surface classes (woodland, forest, scrub, rock, sand) are generated from elevation and steepness for M0. Real land cover arrives in M1.

## southwest

The M1 region: the US Southwest at a uniform 400 m per cell, 2.5× vertical exaggeration and slope tiles up to 2 steps per cell. It's 1028×700 cells in 187 gzipped chunks: 0.63 MB with cells only, 3.97 MB with micro-terrain.

Since M1.6 the chunks also carry micro-terrain: 4×4 micro-cells (100 m) per cell, with quarter-step heights from the DEM's 60 m overview (`MHGT`, D-038). It's built from [`worlds/southwest/region.yaml`](../worlds/southwest/region.yaml):

```sh
cd pipeline && uv run pixelworld build ../worlds/southwest/region.yaml
```

`build-report.json` records the package hash, the road validation and the surface counts.

Sources and licenses:
- Elevation: USGS 3DEP 1 arc-second DEM. Public domain.
- Land cover: ESA WorldCover 2021. CC BY 4.0.
- Roads and rivers: © OpenStreetMap contributors via Overture Maps (release 2026-10-21.0). ODbL 1.0, so this package is a derivative database under the ODbL.

## exp-* (M1.5 pixel detail experiment)

Two small areas at three resolutions each, built from [`worlds/experiment/`](../worlds/experiment/). Every variant shares the same 160 m/cell layout on screen: finer cells are drawn smaller (`render.scale` in the manifest), so the variants line up for comparison.

| World | Cells | Drawn at | Cell on screen | Height step |
|---|---|---|---|---|
| `exp-desert-view-k1`, `exp-strip-k1` | 160 m | 1 | 32×16 px | 8 px |
| `exp-desert-view-k4`, `exp-strip-k4` | 40 m | 1/4 | 8×4 px | 2 px |
| `exp-desert-view-k8`, `exp-strip-k8` | 20 m | 1/8 | 4×2 px | 1 px |

Each package also has `objects.json.gz`: vegetation, buildings and landmarks as semantic-group instances (`docs/world-format.md`). Open one with `?world=/exp-strip-k8/`; add `&objects=0` for terrain only, `&palette=night` (or press T) for the night palette.

```sh
cd pipeline
for f in ../worlds/experiment/*.yaml; do uv run pixelworld build "$f"; done
```

`exp-strip-k8` reports one split road segment and two disconnected junctions at 20 m cells, so the build exits with status 1; the package is still written.

Sources and licenses: as for `southwest`, plus the USGS 3DEP 1/3 arc-second DEM (public domain) and Overture Maps buildings (OpenStreetMap, Esri Community Maps, Microsoft and Google Open Buildings footprints; ODbL 1.0).
