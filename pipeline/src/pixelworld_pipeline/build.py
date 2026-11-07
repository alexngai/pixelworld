"""Build a world package from a region spec (M1: uniform scale, no warp).

Stages (docs/architecture.md §5): fetch (cached) → normalize (project to the
region grid) → semantics (water, land cover, roads, provinces) → gridify
(corner-height field → cells) → export. Deterministic: the same spec and
cached inputs always give the same package hash.
"""

from __future__ import annotations

import json
from collections import deque
from dataclasses import asdict
from pathlib import Path

import numpy as np
import shapely

from . import roads as road_stage
from .gridify import (
    bilateral,
    cell_corner_heights,
    cliff_mask,
    corner_stack,
    gridify_heights,
    meters_per_step,
    round_half_up,
)
from .region import Region
from .sources import overture, rasters
from .world_format import NO_WATER, write_package

SURFACES = {
    0: "none",
    1: "rock",
    2: "woodland",
    3: "forest",
    4: "scrub",
    5: "water",
    6: "sand",
    7: "desert",
    8: "grass",
    9: "farmland",
    10: "urban",
    11: "snow",
}
S = {name: i for i, name in SURFACES.items()}
ROAD_CLASSES = {1: "secondary", 2: "primary", 3: "trunk", 4: "motorway"}
ROAD_RANK = {name: i for i, name in ROAD_CLASSES.items()}
CLIFF_DROP_METERS = 80.0
FOREST_ABOVE_METERS = 2300.0

ATTRIBUTION = {
    "usgs-3dep-1arcsec": {
        "name": "USGS 3D Elevation Program (3DEP) 1 arc-second DEM",
        "license": "Public domain",
        "url": "https://www.usgs.gov/3d-elevation-program",
    },
    "esa-worldcover-2021": {
        "name": "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data "
        "(2021) processed by ESA WorldCover consortium",
        "license": "CC BY 4.0",
        "url": "https://esa-worldcover.org",
    },
    "overture": {
        "name": "© OpenStreetMap contributors, Overture Maps Foundation "
        "(transportation and base themes)",
        "license": "ODbL 1.0",
        "url": "https://overturemaps.org",
    },
}


def label_components(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """8-connected component labels (0 = background), labels in scan order."""
    labels = np.zeros(mask.shape, dtype=np.int32)
    h, w = mask.shape
    count = 0
    for y0, x0 in zip(*np.nonzero(mask), strict=True):
        if labels[y0, x0]:
            continue
        count += 1
        labels[y0, x0] = count
        queue = deque([(y0, x0)])
        while queue:
            y, x = queue.popleft()
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not labels[ny, nx]:
                        labels[ny, nx] = count
                        queue.append((ny, nx))
    return labels, count


def _cell_corner_view(q: np.ndarray):
    """Writable views of a corner field for each cell corner c0..c3."""
    return (q[:-1, :-1], q[:-1, 1:], q[1:, 1:], q[1:, :-1])


def apply_water(
    q: np.ndarray, lake: np.ndarray, river: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Flatten lakes to one level per water body and lower river corners.

    Returns the updated corner field and the water level per cell (steps).
    """
    q = q.copy()
    level = np.full(lake.shape, NO_WATER, dtype=np.int64)
    labels, n = label_components(lake)
    for k in range(1, n + 1):
        cells = labels == k
        touched = np.zeros(q.shape, dtype=bool)
        for view in _cell_corner_view(touched):
            view |= cells
        lake_level = int(np.floor(np.percentile(q[touched], 10)))
        q[touched] = lake_level
        level[cells] = lake_level
    river_only = river & ~lake
    if river_only.any():
        low = np.min(np.stack([v for v in _cell_corner_view(q)]), axis=0)
        target = np.full(q.shape, np.iinfo(np.int64).max, dtype=np.int64)
        for view in _cell_corner_view(target):
            np.minimum(view, np.where(river_only, low, np.iinfo(np.int64).max), out=view)
        q = np.where(target < np.iinfo(np.int64).max, np.minimum(q, target), q)
    return q, level


def classify(
    landcover: np.ndarray,
    corner_m: np.ndarray,
    base: np.ndarray,
    shape: np.ndarray,
    water: np.ndarray,
    step_m: float,
) -> np.ndarray:
    """Surface classes from ESA WorldCover, elevation and steepness."""
    elev = corner_stack(corner_m).mean(axis=0)
    cliff = cliff_mask(base, shape, min_drop=max(1, round(CLIFF_DROP_METERS / step_m)))
    lc = landcover
    out = np.full(lc.shape, S["desert"], dtype=np.uint8)
    out[lc == 10] = S["woodland"]
    out[(lc == 10) & (elev >= FOREST_ABOVE_METERS)] = S["forest"]
    out[np.isin(lc, (20, 90, 95, 100))] = S["scrub"]
    out[lc == 30] = S["grass"]
    out[lc == 40] = S["farmland"]
    out[lc == 50] = S["urban"]
    out[lc == 60] = S["desert"]
    out[lc == 70] = S["snow"]
    bare_like = np.isin(lc, (0, 20, 30, 60))
    out[cliff & bare_like] = S["rock"]
    out[water != NO_WATER] = S["water"]
    return out


def provinces(region: Region) -> tuple[np.ndarray, dict[int, str]]:
    names = {0: region.default_province}
    lons, lats = region.cell_centers_lonlat()
    geo = np.zeros(lons.shape, dtype=np.uint8)
    for i, p in enumerate(region.provinces, start=1):
        names[i] = p.name
        inside = shapely.contains_xy(shapely.Polygon(p.polygon), lons, lats)
        geo[inside] = i
    return geo, names


def _lines_in_cells(region: Region, rows: list[dict], rank_of) -> list:
    out = []
    for row in rows:
        geom = shapely.from_wkt(row["geometry"])
        parts = list(geom.geoms) if hasattr(geom, "geoms") else [geom]
        cell_parts = []
        for part in parts:
            coords = np.asarray(part.coords)
            if len(coords) < 2:
                continue
            xs, ys = region.lonlat_to_cell(coords[:, 0], coords[:, 1])
            cell_parts.append((xs, ys))
        if cell_parts:
            out.append((row["id"], rank_of(row), cell_parts))
    return out


def build(region_path: Path, out_dir: Path, compress: bool = True) -> dict:
    region = Region.load(region_path)
    cx, cy = region.cells
    print(f"region {region.id}: {cx}×{cy} cells at {region.meters_per_cell:g} m")

    # fetch (cached)
    dem = rasters.dem_corners(region).astype(np.float64)
    landcover = rasters.landcover_cells(region)
    release = region.sources["overture"]["release"]
    bbox = region.lonlat_envelope()
    road_rows = overture.roads(release, bbox, region.sources["roads"]["classes"])
    river_rows = overture.rivers(release, bbox, region.sources["rivers"]["subtypes"])

    # heights in steps on the shared corner field
    step_m = meters_per_step(region.meters_per_cell, region.vertical_exaggeration)
    corner_m = dem
    if region.bilateral_cells > 0:
        corner_m = bilateral(dem, region.bilateral_cells, region.bilateral_meters)
    q = round_half_up(corner_m / step_m).astype(np.int64)

    # water
    lake = landcover == 80
    river_layer = road_stage.rasterize(_lines_in_cells(region, river_rows, lambda r: 1), (cy, cx))
    river = (river_layer.mask & road_stage.CONNECT_MASK) != 0
    q, water_level = apply_water(q, lake, river)

    # roads: snap, cut-and-fill on the corner field
    road_layer = road_stage.rasterize(
        _lines_in_cells(region, road_rows, lambda r: ROAD_RANK[r["class"]]), (cy, cx)
    )
    heights = road_stage.road_heights(road_layer.mask, q)
    q = road_stage.apply_to_corners(q, road_layer.mask, heights)
    on_road = (road_layer.mask & road_stage.CONNECT_MASK) != 0

    # gridify
    base, shape = gridify_heights(q.astype(np.float64), steep="flat", max_offset=region.max_slope)
    is_water = ((water_level != NO_WATER) | river) & ~on_road
    low = cell_corner_heights(base, shape).min(axis=0)
    base = np.where(is_water, low, base).astype(np.int16)
    shape = np.where(is_water, 0, shape).astype(np.uint8)
    water = np.where(is_water, base, NO_WATER).astype(np.int16)

    surface = classify(landcover, corner_m, base, shape, water, step_m)
    geology, province_names = provinces(region)
    report = road_stage.validate(
        road_layer,
        cell_corner_heights(base, shape),
        road_stage.junction_index(road_rows),
    )
    print(f"roads: {asdict(report)}")

    sx, sy = region.lonlat_to_cell([region.start[0]], [region.start[1]])
    manifest = write_package(
        out_dir,
        world_id=region.id,
        name=region.name,
        base=base,
        shape=shape,
        surface=surface,
        water=water,
        road=road_layer.mask,
        road_class=road_layer.cls,
        geology=geology,
        chunk_size=region.chunk_size,
        scale={
            "metersPerCell": region.meters_per_cell,
            "metersPerStep": round(step_m, 6),
            "elevationDatumMeters": 0,
            "verticalExaggeration": region.vertical_exaggeration,
        },
        surfaces=SURFACES,
        road_classes=ROAD_CLASSES,
        provinces=province_names,
        start=(int(sx[0]), int(sy[0])),
        style=region.style,
        attribution=[
            ATTRIBUTION[region.sources["dem"]["kind"]],
            ATTRIBUTION[region.sources["landcover"]["kind"]],
            ATTRIBUTION["overture"],
        ],
        source={"crs": region.crs.to_proj4(), "bounds": list(region.bounds)},
        generator={
            "name": "pixelworld_pipeline.build",
            "version": "1",
            "params": {
                "region": region.digest(),
                "overtureRelease": release,
                "maxSlope": region.max_slope,
                "bilateral": [region.bilateral_cells, region.bilateral_meters],
            },
        },
        compress=compress,
        clean=True,
    )
    build_report = {
        "packageHash": manifest["packageHash"],
        "cells": [cx, cy],
        "chunks": len(manifest["chunks"]),
        "heightRange": manifest["heightRange"],
        "inputs": {"roadSegments": len(road_rows), "riverLines": len(river_rows)},
        "roads": asdict(report) | {"ok": report.ok()},
        "surfaces": {
            SURFACES[int(k)]: int(v)
            for k, v in zip(*np.unique(surface, return_counts=True), strict=True)
        },
    }
    (out_dir / "build-report.json").write_text(json.dumps(build_report, indent=2) + "\n")
    return build_report
