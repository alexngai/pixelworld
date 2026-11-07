# Fixture world packages

Small committed world packages used by M0 development and tests. They are served as static files by the web app (`apps/web/vite.config.ts` sets this directory as Vite's `publicDir`).

## grand-canyon-m0

128×128 cells at a uniform 160 m per cell (no warp) and 40 m per height step. Covers the South Rim at Grand Canyon Village, the Colorado River near Phantom Ranch, and the North Rim near Bright Angel Point.

Regenerate:

```sh
cd pipeline && uv run python -m pixelworld_pipeline.fixtures.grand_canyon_m0
```

Sources and licenses:
- Elevation: USGS 3D Elevation Program (3DEP) 1/3 arc-second DEM. Public domain.
- Colorado River centerline: © OpenStreetMap contributors, ODbL 1.0. Because of this, the package is a derivative database under the ODbL; see `docs/data-sources.md` §6.

Surface classes (woodland, forest, scrub, rock, sand) are generated from elevation and steepness for M0. Real land cover arrives in M1.
