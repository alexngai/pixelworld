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

from . import objects as object_stage
from . import roads as road_stage
from .gridify import (
    STEP_WORLD,
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
    "usgs-3dep-13arcsec": {
        "name": "USGS 3D Elevation Program (3DEP) 1/3 arc-second DEM",
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
    "overture-buildings": {
        "name": "Overture Maps Foundation buildings theme: © OpenStreetMap contributors, "
        "Esri Community Maps contributors, Microsoft, Google Open Buildings",
        "license": "ODbL 1.0",
        "url": "https://docs.overturemaps.org/attribution/",
    },
}
# Objects avoid cells steeper than this (rise over run), whatever the cell size.
OBJECT_MAX_SLOPE = 0.6


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


def drop_small(mask: np.ndarray, min_cells: int) -> np.ndarray:
    """Remove 8-connected components smaller than min_cells (e.g. shadows read as water)."""
    if min_cells <= 1 or not mask.any():
        return mask
    labels, n = label_components(mask)
    sizes = np.bincount(labels.ravel(), minlength=n + 1)
    keep = sizes >= min_cells
    keep[0] = False
    return keep[labels]


def drop_sloped(mask: np.ndarray, corner_m: np.ndarray, max_relief: float) -> np.ndarray:
    """Remove water bodies whose ground spans more than max_relief metres.

    Lakes are flat; "water" on a canyon wall is a shadow misread by land cover.
    """
    if not mask.any():
        return mask
    labels, n = label_components(mask)
    cells = corner_stack(corner_m)
    lo = np.full(n + 1, np.inf)
    hi = np.full(n + 1, -np.inf)
    np.minimum.at(lo, labels.ravel(), cells.min(axis=0).ravel())
    np.maximum.at(hi, labels.ravel(), cells.max(axis=0).ravel())
    keep = (hi - lo) <= max_relief
    keep[0] = False
    return keep[labels]


def buffered_lines(lines: list, radius_cells: float, shape: tuple[int, int]) -> np.ndarray:
    """Cells whose centre lies within radius_cells of any line (wide rivers)."""
    cy, cx = shape
    geoms = [
        shapely.LineString(np.column_stack([xs, ys]))
        for _id, _rank, parts in lines
        for xs, ys in parts
        if len(xs) >= 2
    ]
    if not geoms:
        return np.zeros(shape, dtype=bool)
    area = shapely.union_all([g.buffer(radius_cells) for g in geoms])
    gx, gy = np.meshgrid(np.arange(cx) + 0.5, np.arange(cy) + 0.5)
    return shapely.contains_xy(area, gx, gy)


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
    cliff_slope: float | None = None,
    meters_per_cell: float = 0.0,
) -> np.ndarray:
    """Surface classes from ESA WorldCover, elevation and steepness.

    By default cliffs are drops of CLIFF_DROP_METERS and only bare-looking
    cover turns to rock. With cliff_slope (rise over run) every cell that
    steep becomes rock whatever its cover, which suits fine cells where the
    canyon walls are many cells wide.
    """
    elev = corner_stack(corner_m).mean(axis=0)
    drop_m = CLIFF_DROP_METERS if cliff_slope is None else cliff_slope * meters_per_cell
    cliff = cliff_mask(base, shape, min_drop=max(1, round(drop_m / step_m)))
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
    bare_like = np.isin(lc, (0, 20, 30, 60)) if cliff_slope is None else lc != 70
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
    terrain = region.terrain or {}
    min_lake_cells = round(terrain.get("minLakeArea", 0) / region.meters_per_cell**2)
    lake = drop_small(landcover == 80, min_lake_cells)
    if "maxLakeRelief" in terrain:
        lake = drop_sloped(lake, dem, terrain["maxLakeRelief"])
    river_lines = _lines_in_cells(region, river_rows, lambda r: 1)
    river_layer = road_stage.rasterize(river_lines, (cy, cx))
    river = (river_layer.mask & road_stage.CONNECT_MASK) != 0
    if "riverWidthMeters" in terrain:
        river |= buffered_lines(
            river_lines, terrain["riverWidthMeters"] / 2 / region.meters_per_cell, (cy, cx)
        )
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

    surface = classify(
        landcover,
        corner_m,
        base,
        shape,
        water,
        step_m,
        cliff_slope=terrain.get("cliffSlope"),
        meters_per_cell=region.meters_per_cell,
    )
    geology, province_names = provinces(region)
    report = road_stage.validate(
        road_layer,
        cell_corner_heights(base, shape),
        road_stage.junction_index(road_rows),
    )
    print(f"roads: {asdict(report)}")

    # objects (optional): vegetation, buildings, landmarks as semantic groups
    instances = None
    object_counts: dict[str, int] = {}
    if region.objects is not None:
        steep_steps = max(1, round(OBJECT_MAX_SLOPE * region.vertical_exaggeration / STEP_WORLD))
        blocked = on_road | is_water | cliff_mask(base, shape, min_drop=steep_steps)
        instances, object_counts = object_stage.place(region, blocked, road_rows)
        print(f"objects: {object_counts}")
    attribution = [
        ATTRIBUTION[region.sources["dem"]["kind"]],
        ATTRIBUTION[region.sources["landcover"]["kind"]],
        ATTRIBUTION["overture"],
    ]
    if region.objects and "buildings" in region.objects:
        attribution.append(ATTRIBUTION["overture-buildings"])

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
        attribution=attribution,
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
        render=region.render,
        objects=instances,
        compress=compress,
        clean=True,
    )
    build_report = {
        "packageHash": manifest["packageHash"],
        "cells": [cx, cy],
        "chunks": len(manifest["chunks"]),
        "heightRange": manifest["heightRange"],
        "inputs": {"roadSegments": len(road_rows), "riverLines": len(river_rows)},
        **({"objects": object_counts} if instances is not None else {}),
        "roads": asdict(report) | {"ok": report.ok()},
        "surfaces": {
            SURFACES[int(k)]: int(v)
            for k, v in zip(*np.unique(surface, return_counts=True), strict=True)
        },
    }
    (out_dir / "build-report.json").write_text(json.dumps(build_report, indent=2) + "\n")
    return build_report
