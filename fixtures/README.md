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

The US Southwest on the M2 elastic map, built from [`worlds/southwest/region.yaml`](../worlds/southwest/region.yaml) and its warp, [`warp.yaml`](../worlds/southwest/warp.yaml).

- **Size:** 1155×709 cells in 228 gzipped chunks. The chunks are 5.62 MB and `objects.json.gz` is 0.30 MB.
- **Scale:** cells are about 500 m in the open desert. Focus areas are finer: 100 m on the Las Vegas Strip and at Hoover Dam, 250 m on Lake Mead, 150 m at Grand Canyon Village and Desert View. The manifest records each focus area's achieved scale and every chunk's metres per cell.
- **Relief:** 2.5× vertical exaggeration (65.3 m per height step), with local relief exaggerated where cells are magnified (D-041). The `VREF`/`VFAC` layers keep strata at real elevations.
- **Micro-terrain:** 4×4 micro-cells per cell (`MHGT`, D-038).
- **Objects:** buildings around the Strip, plus four landmarks: the Strat, the Welcome to Fabulous Las Vegas sign, Hoover Dam and the Desert View Watchtower.

```sh
cd pipeline && uv run pixelworld build ../worlds/southwest/region.yaml
# or edit the warp interactively: http://localhost:5180 (pnpm --filter @pixelworld/editor dev)
uv run pixelworld serve ../worlds/southwest/region.yaml
```

`build-report.json` records the package hash, the warp's statistics (folds, anisotropy, focus results, solve time), the road validation, the object counts and the surface counts.

Before M2 this package was uniform: 1028×700 cells at 400 m (M1, 0.63 MB), then with micro-terrain (M1.6, 3.97 MB).

This is the driving level of the region's three scale levels (D-046). Its manifest lists them, and `geo.i32.gz` holds the lon/lat of every 4th cell corner, so the client (L key) can move to the same place in another level.

## southwest-fly, southwest-walk

The Southwest's other scale levels, built from [`fly.yaml`](../worlds/southwest/fly.yaml) and [`walk.yaml`](../worlds/southwest/walk.yaml). Both extend `region.yaml`.

- **southwest-fly:** the whole region at 1.5 km per cell in open desert, with every focus area 4× coarser than driving: the Strip and Hoover Dam at 400 m, the canyon rim at 600 m.
  - **Size:** 339×219 cells, 0.51 MB.
  - **Generalization:** motorways and trunks only.
  - **Objects:** towers of 80 m or more drawn 3× their size, where they don't overlap a taller one; landmarks drawn 5× (not the dam).
- **southwest-walk:** the Las Vegas Strip at a uniform 20 m per cell, with 4×4 micro-cells from the 10 m DEM.
  - **Size:** 182×412 cells, 0.52 MB.
  - **Objects:** every building footprint, trees, palms and the two Strip landmarks, at true proportions (`heightStretch` 1).
  - **Roads:** the build exits with status 1 because of the road report it shares with the M1.5 Strip experiment (one split segment, two disconnected junctions at 20 m cells). The package is still written.

```sh
cd pipeline
for f in fly region walk; do uv run pixelworld build ../worlds/southwest/$f.yaml; done
```

Sources and licenses: as for `southwest`. The walking level also uses the USGS 3DEP 1/3 arc-second DEM (public domain).

Sources and licenses:
- Elevation: USGS 3DEP 1 arc-second DEM. Public domain.
- Land cover: ESA WorldCover 2021. CC BY 4.0.
- Roads and rivers: © OpenStreetMap contributors via Overture Maps (release 2026-10-21.0). ODbL 1.0, so this package is a derivative database under the ODbL.
- Buildings: Overture Maps buildings (OpenStreetMap, Esri Community Maps, Microsoft and Google Open Buildings footprints). ODbL 1.0.
- Importance (`worlds/southwest/importance.json`, used to build the warp, not shipped in the package): Wikidata. CC0.

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
