"""Build the M0 Grand Canyon fixture world package.

    uv run python -m pixelworld_pipeline.fixtures.grand_canyon_m0

Throwaway for M0 (the real staged pipeline arrives in M1). It:
  1. reads a window of the USGS 3DEP 1/3 arc-second DEM over HTTP range requests,
  2. averages it onto a 129x129 grid of cell corners in a local transverse
     Mercator projection (uniform 160 m per cell, no warp),
  3. gridifies to height steps (base + corner shape, cliffs where too steep),
  4. burns in the Colorado River from OpenStreetMap (Overpass),
  5. classifies surfaces from elevation and steepness, and
  6. writes fixtures/grand-canyon-m0/ in world format v0.

Raw downloads are cached in pipeline/.cache/ (not committed).
"""

from __future__ import annotations

import argparse
import json
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.transform import Affine
from rasterio.warp import Resampling, reproject
from rasterio.warp import transform as transform_points

from ..gridify import (
    bilateral,
    cell_corner_heights,
    cliff_mask,
    corner_stack,
    gridify_heights,
    meters_per_step,
    smooth,
)
from ..world_format import NO_WATER, write_package

REPO = Path(__file__).resolve().parents[4]
CACHE = REPO / "pipeline" / ".cache" / "grand-canyon-m0"
OUT = REPO / "fixtures" / "grand-canyon-m0"
USER_AGENT = "pixelworld-pipeline/0.0 (+https://github.com/alexngai/pixelworld)"

# Centered between Grand Canyon Village (South Rim) and Bright Angel Point (North Rim).
CENTER_LAT = 36.115
CENTER_LON = -112.12
CELLS = 128
METERS_PER_CELL = 160.0
# Vertical exaggeration relative to true proportions (1.0 = real slopes). Every
# height difference is multiplied by this; metres per step are derived from it.
VERTICAL_EXAGGERATION = 2.5  # ≈ 26.1 m per step at 160 m per cell (M0 used 1.63 = 40 m)
CHUNK_SIZE = 64
SMOOTH_SIGMA = 0.0  # cells; Gaussian smoothing of corner heights before quantizing
BILATERAL = (1.5, 48.0)  # (cells, metres): edge-preserving smoothing; (0, 0) disables
CLIFF_DROP_METERS = 80.0  # real drop that makes a cell "cliffy" for surface classes
MAX_SLOPE = 2  # steepest slope tile, in steps of rise per cell (1..3); steeper → terrace + cliff
STEEP_MODE = "flat"  # how cells steeper than MAX_SLOPE are represented (see gridify)

DEM_URL = (
    "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current/"
    "n37w113/USGS_13_n37w113.tif"
)
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

SURFACES = {0: "none", 1: "rock", 2: "woodland", 3: "forest", 4: "scrub", 5: "water", 6: "sand"}
S = {name: i for i, name in SURFACES.items()}


def local_crs() -> CRS:
    return CRS.from_proj4(
        f"+proj=tmerc +lat_0={CENTER_LAT} +lon_0={CENTER_LON} +k=1 +x_0=0 +y_0=0 "
        "+datum=WGS84 +units=m +no_defs"
    )


def corner_transform() -> Affine:
    """Raster transform whose pixel centers sit exactly on cell corners."""
    half = CELLS / 2 * METERS_PER_CELL
    west, north = -half, half
    m = METERS_PER_CELL
    return Affine(m, 0, west - m / 2, 0, -m, north + m / 2)


def fetch_corner_heights() -> np.ndarray:
    """Corner elevations in meters, shape (CELLS+1, CELLS+1), row 0 = north."""
    cache = CACHE / f"corners_{CELLS}_{int(METERS_PER_CELL)}.npy"
    if cache.exists():
        return np.load(cache)
    dst = np.full((CELLS + 1, CELLS + 1), np.nan, dtype=np.float32)
    with rasterio.Env(
        GDAL_HTTP_USERAGENT=USER_AGENT,
        GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
        CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
    ):
        with rasterio.open("/vsicurl/" + DEM_URL) as src:
            reproject(
                source=rasterio.band(src, 1),
                destination=dst,
                src_transform=src.transform,
                src_crs=src.crs,
                src_nodata=src.nodata,
                dst_transform=corner_transform(),
                dst_crs=local_crs(),
                dst_nodata=np.nan,
                resampling=Resampling.average,
            )
    if np.isnan(dst).any():
        raise RuntimeError(f"DEM has {int(np.isnan(dst).sum())} missing corners")
    CACHE.mkdir(parents=True, exist_ok=True)
    np.save(cache, dst)
    return dst


def bounds_lonlat() -> tuple[float, float, float, float]:
    half = CELLS / 2 * METERS_PER_CELL
    xs = [-half, half, half, -half]
    ys = [half, half, -half, -half]
    lons, lats = transform_points(local_crs(), "EPSG:4326", xs, ys)
    return min(lons), min(lats), max(lons), max(lats)


def fetch_river() -> list[list[tuple[float, float]]]:
    """Colorado River centerlines (lon, lat) from OpenStreetMap via Overpass."""
    cache = CACHE / "colorado_river.json"
    if not cache.exists():
        w, s, e, n = bounds_lonlat()
        query = (
            "[out:json][timeout:60];"
            f'way["waterway"="river"]["name"="Colorado River"]({s},{w},{n},{e});out geom;'
        )
        req = urllib.request.Request(
            OVERPASS_URL,
            data=urllib.parse.urlencode({"data": query}).encode(),
            headers={"User-Agent": USER_AGENT},
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = resp.read()
        CACHE.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(body)
    data = json.loads(cache.read_text())
    return [[(p["lon"], p["lat"]) for p in el["geometry"]] for el in data["elements"]]


def rasterize_lines(lines: list[list[tuple[float, float]]]) -> np.ndarray:
    """Cells touched by the given lon/lat polylines (sampled every 10 m)."""
    mask = np.zeros((CELLS, CELLS), dtype=bool)
    half = CELLS / 2 * METERS_PER_CELL
    for line in lines:
        lons, lats = zip(*line, strict=True)
        xs, ys = transform_points("EPSG:4326", local_crs(), list(lons), list(lats))
        pts = np.column_stack([xs, ys])
        for (x0, y0), (x1, y1) in zip(pts[:-1], pts[1:], strict=True):
            n = max(1, int(np.hypot(x1 - x0, y1 - y0) / 10))
            t = np.linspace(0, 1, n + 1)
            px = x0 + (x1 - x0) * t
            py = y0 + (y1 - y0) * t
            cx = np.floor((px + half) / METERS_PER_CELL).astype(int)
            cy = np.floor((half - py) / METERS_PER_CELL).astype(int)
            ok = (cx >= 0) & (cy >= 0) & (cx < CELLS) & (cy < CELLS)
            mask[cy[ok], cx[ok]] = True
    return mask


def classify(
    corner_m: np.ndarray,
    base: np.ndarray,
    shape: np.ndarray,
    river: np.ndarray,
    step_m: float,
) -> np.ndarray:
    """Procedural surface classes for M0 (real land cover arrives in M1).

    Thresholds are in real metres so the classes don't change with exaggeration.
    """
    cs = corner_stack(corner_m)
    elev = cs.mean(axis=0)
    relief = cs.max(axis=0) - cs.min(axis=0)
    cliff = cliff_mask(base, shape, min_drop=max(1, round(CLIFF_DROP_METERS / step_m)))
    gentle = ~cliff & (relief < 60)

    surface = np.full(base.shape, S["rock"], dtype=np.uint8)
    surface[gentle & (elev >= 1980)] = S["woodland"]
    surface[gentle & (elev >= 2350)] = S["forest"]
    surface[gentle & (elev >= 1050) & (elev <= 1350)] = S["scrub"]

    near_river = np.zeros_like(river)
    near_river[1:, :] |= river[:-1, :]
    near_river[:-1, :] |= river[1:, :]
    near_river[:, 1:] |= river[:, :-1]
    near_river[:, :-1] |= river[:, 1:]
    surface[near_river & ~river & ~cliff & (elev < 900)] = S["sand"]
    surface[river] = S["water"]
    return surface


def build(
    out_dir: Path,
    sigma: float = SMOOTH_SIGMA,
    steep: str = STEEP_MODE,
    bilateral_params: tuple[float, float] = BILATERAL,
    exaggeration: float = VERTICAL_EXAGGERATION,
    max_slope: int = MAX_SLOPE,
) -> dict:
    step_m = meters_per_step(METERS_PER_CELL, exaggeration)
    corner_m = smooth(fetch_corner_heights(), sigma)
    if bilateral_params[0] > 0:
        corner_m = bilateral(corner_m, *bilateral_params)
    base, shape = gridify_heights(corner_m / step_m, steep=steep, max_offset=max_slope)

    river = rasterize_lines(fetch_river())
    # River cells become flat water at their lowest corner.
    lowest = cell_corner_heights(base, shape).min(axis=0)
    base = np.where(river, lowest, base).astype(np.int16)
    shape = np.where(river, 0, shape).astype(np.uint8)
    water = np.where(river, base, NO_WATER).astype(np.int16)

    surface = classify(corner_m, base, shape, river, step_m)
    w, s, e, n = bounds_lonlat()
    return write_package(
        out_dir,
        world_id="grand-canyon-m0",
        name="Grand Canyon (M0 slice)",
        base=base,
        shape=shape,
        surface=surface,
        water=water,
        chunk_size=CHUNK_SIZE,
        scale={
            "metersPerCell": METERS_PER_CELL,
            "metersPerStep": round(step_m, 6),
            "elevationDatumMeters": 0,
            "verticalExaggeration": exaggeration,
        },
        surfaces=SURFACES,
        style="desert-southwest",
        attribution=[
            {
                "name": "USGS 3D Elevation Program (3DEP) 1/3 arc-second DEM",
                "license": "Public domain",
                "url": "https://www.usgs.gov/3d-elevation-program",
            },
            {
                "name": "© OpenStreetMap contributors (Colorado River)",
                "license": "ODbL 1.0",
                "url": "https://www.openstreetmap.org/copyright",
            },
        ],
        source={
            "crs": local_crs().to_proj4(),
            "bounds": [round(v, 5) for v in (w, s, e, n)],
        },
        generator={
            "name": "pixelworld_pipeline.fixtures.grand_canyon_m0",
            "version": "0",
            "params": {
                "centerLat": CENTER_LAT,
                "centerLon": CENTER_LON,
                "cells": CELLS,
                "resampling": "average",
                "smoothSigmaCells": sigma,
                "bilateral": {
                    "sigmaCells": bilateral_params[0],
                    "sigmaMeters": bilateral_params[1],
                },
                "steepMode": steep,
                "maxSlopeSteps": max_slope,
            },
        },
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--sigma", type=float, default=SMOOTH_SIGMA)
    parser.add_argument("--steep", choices=["flat", "slope"], default=STEEP_MODE)
    parser.add_argument("--bilateral", type=float, nargs=2, default=BILATERAL)
    parser.add_argument(
        "--exaggeration",
        type=float,
        default=VERTICAL_EXAGGERATION,
        help="vertical exaggeration relative to true proportions (1.0 = real slopes)",
    )
    parser.add_argument(
        "--max-slope",
        type=int,
        choices=[1, 2, 3],
        default=MAX_SLOPE,
        help="steepest slope tile in steps of rise per cell; steeper terrain becomes cliffs",
    )
    args = parser.parse_args()
    manifest = build(
        args.out,
        args.sigma,
        args.steep,
        tuple(args.bilateral),
        args.exaggeration,
        args.max_slope,
    )
    print(f"wrote {args.out} ({manifest['cellsX']}x{manifest['cellsY']} cells)")


if __name__ == "__main__":
    main()
