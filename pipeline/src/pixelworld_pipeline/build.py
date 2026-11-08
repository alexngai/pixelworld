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
from typing import Any

import numpy as np
import shapely

from . import ground as ground_stage
from . import importance as importance_stage
from . import micro as micro_stage
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
from .layout import UniformLayout, WarpedLayout, WarpSpec
from .region import Region
from .sources import overture
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
# Road and path classes, lowest priority first. A world numbers the classes it
# uses in this order, so the classic four keep ids 1-4 (secondary..motorway).
ROAD_ORDER = (
    "service",
    "unclassified",
    "living_street",
    "residential",
    "tertiary",
    "secondary",
    "primary",
    "trunk",
    "motorway",
)
PATH_ORDER = ("path", "cycleway", "steps", "footway", "sidewalk", "crosswalk", "pedestrian")
# Typical full widths in metres (D-050); one carriageway where roads are mapped
# as two (motorways, divided boulevards). Region specs override them (widths:).
ROAD_WIDTH_M = {
    "motorway": 16.0,
    "trunk": 14.0,
    "primary": 14.0,
    "secondary": 12.0,
    "tertiary": 10.0,
    "residential": 8.0,
    "living_street": 6.0,
    "unclassified": 7.0,
    "service": 5.0,
}
PATH_WIDTH_M = {
    "pedestrian": 8.0,
    "crosswalk": 4.0,
    "sidewalk": 3.0,
    "footway": 3.0,
    "steps": 3.0,
    "cycleway": 2.5,
    "path": 2.0,
}


def package_heroes(region: Region, region_path: Path | None, out_dir: Path) -> list[dict] | None:
    """Copy hero landmarks' offline bakes and paint-overs into the package
    (heroes/<id>/), one manifest entry per landmark and rotation (D-053)."""
    import hashlib
    import shutil

    from . import landmarks as registry

    heroes = [lm for lm in (region.objects or {}).get("landmarks", []) if lm.get("hero")]
    if not heroes or region_path is None:
        return None
    root = registry.registry_dir(Path(region_path))
    out: list[dict] = []
    if root is not None:
        for lm in heroes:
            for f in registry.hero_files(root, lm["id"], region.id):
                r = f["rotation"]
                dest = out_dir / "heroes" / lm["id"]
                dest.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(f["bake"], dest / f"bake-r{r}.png")
                shutil.copyfile(f["paint"], dest / f"paint-r{r}.png")
                digest = hashlib.sha256(
                    f["bake"].read_bytes() + f["paint"].read_bytes()
                ).hexdigest()
                m = f["meta"]
                out.append(
                    {
                        "id": lm["id"],
                        "rotation": r,
                        "left": int(m["left"]),
                        "top": int(m["top"]),
                        "width": int(m["width"]),
                        "height": int(m["height"]),
                        "depthBase": float(m["depthBase"]),
                        "bake": f"heroes/{lm['id']}/bake-r{r}.png",
                        "paint": f"heroes/{lm['id']}/paint-r{r}.png",
                        "sha256": digest,
                    }
                )
    stale = out_dir / "heroes"
    if not out and stale.exists():
        shutil.rmtree(stale)
    return out or None


def refresh_heroes(region_path: Path, out_dir: Path) -> list[dict]:
    """Re-package hero bakes and paint-overs into a built package, without a
    rebuild: the step after an artist edits a paint file (D-053)."""
    from .world_format import package_hash

    region = Region.load(region_path)
    manifest_path = out_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    heroes = package_heroes(region, region_path, out_dir)
    if heroes:
        manifest["heroes"] = heroes
    else:
        manifest.pop("heroes", None)
    manifest["packageHash"] = package_hash(manifest)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    report_path = out_dir / "build-report.json"
    if report_path.exists():
        report = json.loads(report_path.read_text())
        report["packageHash"] = manifest["packageHash"]
        report_path.write_text(json.dumps(report, indent=2) + "\n")
    return heroes or []


def bridge_decks_over_water(
    instances: list[dict],
    wet: np.ndarray,
    shape: tuple[int, int],
    on_road: np.ndarray | None = None,
    reach: int = 2,
) -> np.ndarray:
    """Cells under bridge landmarks (their footprints) that are water, and the
    road cells over water within `reach` cells of a deck: the road the bridge
    carries, drawn in steps where its line isn't a grid direction."""
    from rasterio import features
    from rasterio.transform import Affine

    polys = [
        shapely.Polygon(inst["fp"])
        for inst in instances
        if inst.get("fp") and inst["g"].startswith("landmark.bridge")
    ]
    if not polys:
        return np.zeros(shape, dtype=bool)
    # footprints are in cells: the identity transform rasterizes them on the grid
    mask = features.geometry_mask(polys, shape, Affine.identity(), invert=True, all_touched=True)
    from scipy import ndimage

    # land cover sees a deck over the water as built-up: thin gaps in the water
    # (a road or two cells wide, water on both sides) count as water here
    closed = ndimage.binary_closing(np.pad(wet, reach), iterations=reach)[
        reach:-reach, reach:-reach
    ]
    out = mask & closed
    if on_road is not None and reach > 0:
        near = ndimage.binary_dilation(mask, iterations=reach)
        out |= near & closed & on_road
    return out


def water_under_decks(
    under: np.ndarray,
    base: np.ndarray,
    shape: np.ndarray,
    water: np.ndarray,
    surface: np.ndarray,
    low: np.ndarray,
    road: road_stage.RoadLayer,
    road_hw: np.ndarray | None = None,
    micro: tuple[np.ndarray, int] | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, tuple[np.ndarray, int] | None]:
    """Over water a bridge's deck is the road (D-056): the cells `under` it
    lose their road (mask, class and width, changed in place) and turn back
    into water at the level of the water around them: their own, else the
    highest within three cells, else `low` (their lowest corner). Micro-terrain
    was built with a road bed cut along the old road; it is flattened there to
    the new level, like every other water cell's, so the bed doesn't show
    through the water as streaks.

    Returns the new base, shape, water, surface and micro-terrain."""
    from scipy import ndimage

    road.mask[under] = 0
    road.cls[under] = 0
    if road_hw is not None:
        road_hw[under] = 0
    # the level of the water around (cells land cover took for land have none)
    lvl = np.where(water != NO_WATER, water, np.iinfo(np.int16).min).astype(np.int32)
    around = ndimage.grey_dilation(lvl, size=(7, 7))
    level = np.where(water != NO_WATER, water, around)
    level = np.where(level > np.iinfo(np.int16).min, level, low)
    base = np.where(under, level, base).astype(np.int16)
    shape = np.where(under, 0, shape).astype(np.uint8)
    water = np.where(under, base, water).astype(np.int16)
    surface = np.where(under, S["water"], surface).astype(surface.dtype)
    if micro is not None:
        mc, k = micro
        micro = (micro_stage.reflood(mc, water, k), k)
    return base, shape, water, surface, micro


def paved_band(on_road: np.ndarray, half_width: np.ndarray) -> np.ndarray:
    """Cells whose centre lies within the half-width (cells) of the nearest road
    cell's centre: the pavement of a road wider than its own cells."""
    from scipy import ndimage

    if not on_road.any():
        return np.zeros_like(on_road)
    dist, (iy, ix) = ndimage.distance_transform_edt(~on_road, return_indices=True)
    return dist <= half_width[iy, ix]


def class_ids(classes: list[str], order: tuple[str, ...]) -> dict[int, str]:
    """id → class for the classes a world uses, numbered in priority order."""
    unknown = set(classes) - set(order)
    if unknown:
        raise ValueError(f"unknown way classes {sorted(unknown)}; use some of {list(order)}")
    used = [c for c in order if c in set(classes)]
    return {i + 1: c for i, c in enumerate(used)}


def half_width_cells(
    width_m: np.ndarray, meters_per_cell: np.ndarray, spec: dict[str, Any]
) -> np.ndarray:
    """Per-cell half-width (u8, 1/32 cell) from the widest way's metres (D-050):
    scale × real width at the local scale, never narrower than minCells."""
    scale = float(spec.get("scale", 1.0))
    min_cells = float(spec.get("minCells", 0.1))
    hw = np.maximum(scale * width_m / 2.0 / meters_per_cell, min_cells / 2.0)
    return np.where(width_m > 0, np.clip(np.round(hw * 32.0), 1, 255), 0).astype(np.uint8)


CLIFF_DROP_METERS = 80.0
FOREST_ABOVE_METERS = 2300.0

ATTRIBUTION = {
    "usgs-3dep-lidar": {
        "name": "USGS 3D Elevation Program (3DEP) lidar point clouds",
        "license": "Public domain",
        "url": "https://www.usgs.gov/3d-elevation-program",
    },
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


def provinces(region: Region, layout=None) -> tuple[np.ndarray, dict[int, str]]:
    names = {0: region.default_province}
    lons, lats = (layout or region).cell_centers_lonlat()
    geo = np.zeros(lons.shape, dtype=np.uint8)
    for i, p in enumerate(region.provinces, start=1):
        names[i] = p.name
        inside = shapely.contains_xy(shapely.Polygon(p.polygon), lons, lats)
        geo[inside] = i
    return geo, names


def kept_ways(rows: list[dict], rules: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """The roads and paths that keep their real geometry when the network is
    straightened (`snap.roads.keep`, D-049), by id, each with the rule that
    keeps it: those lying wholly inside a rule's lon/lat box (`bounds`: west,
    south, east, north), such as a crooked street's block between its two
    cross streets. A rule's `width` (metres) overrides its roads' widths."""
    boxes = [(tuple(float(v) for v in rule["bounds"]), rule) for rule in rules]
    out: dict[str, dict[str, Any]] = {}
    if not boxes:
        return out
    for row in rows:
        x0, y0, x1, y1 = shapely.from_wkt(row["geometry"]).bounds
        for (w, s, e, n), rule in boxes:
            if w <= x0 and s <= y0 and x1 <= e and y1 <= n:
                out[row["id"]] = rule
                break
    return out


def rail_lines(
    layout, rows: list[dict], rules: list[dict[str, Any]], shift=None, simplify: float = 0.75
) -> list:
    """Rail segments as lines in cells (`sources.rails`, M3.5), each with the
    kind its first matching rule draws (`draw`: street, cable or train; rules
    match as overture.rail_matches), out of their tunnels. With the
    straightened roads' `shift`, they move with their streets: a vertex every
    half cell, so a track bends where its street was straightened, then
    simplified again (`simplify` cells) so it's drawn in long runs rather
    than wobbling from row to row."""
    out = []
    claimed: set[str] = set()
    for rule in rules:
        kind = road_stage.RAIL_KINDS[rule["draw"]]
        for row in rows:
            if row["id"] in claimed or not overture.rail_matches(rule, row):
                continue
            claimed.add(row["id"])
            parts = []
            for part in overture.rail_open_parts(row):
                coords = np.asarray(part.coords)
                xs, ys = layout.lonlat_to_cell(coords[:, 0], coords[:, 1])
                c = np.asarray(
                    shapely.segmentize(shapely.LineString(np.column_stack([xs, ys])), 0.5).coords
                )
                xs, ys = c[:, 0], c[:, 1]
                if shift is not None:
                    dx, dy = shift(xs, ys)
                    xs, ys = xs + dx, ys + dy
                c = np.asarray(
                    shapely.simplify(shapely.LineString(np.column_stack([xs, ys])), simplify).coords
                )
                parts.append((c[:, 0], c[:, 1]))
            if parts:
                out.append((row["id"], kind, parts))
    return out


def _lines_in_cells(layout, rows: list[dict], rank_of) -> list:
    out = []
    for row in rows:
        geom = shapely.from_wkt(row["geometry"])
        if layout.warped:
            # the warp bends long straight segments: map points ~1 km apart
            geom = shapely.segmentize(geom, 0.01)
        parts = list(geom.geoms) if hasattr(geom, "geoms") else [geom]
        cell_parts = []
        for part in parts:
            coords = np.asarray(part.coords)
            if len(coords) < 2:
                continue
            xs, ys = layout.lonlat_to_cell(coords[:, 0], coords[:, 1])
            cell_parts.append((xs, ys))
        if cell_parts:
            out.append((row["id"], rank_of(row), cell_parts))
    return out


def make_layout(region: Region, region_path: Path | None = None):
    if region.warp:
        spec = WarpSpec.from_dict(region.warp)
        places = None
        if spec.importance and region_path is not None:
            snap = importance_stage.load_snapshot(region_path)
            places = snap["places"] if snap else None
        return WarpedLayout(region, spec, places=places)
    return UniformLayout(region)


def build(region_path: Path, out_dir: Path, compress: bool = True, layout=None) -> dict:
    region = Region.load(region_path)
    layout = layout or make_layout(region, region_path)
    cx, cy = layout.cells
    if layout.warped:
        ws = layout.warp.stats
        print(f"region {region.id}: {cx}×{cy} cells, warped ({ws['method']}, {ws['folds']} folds)")
        for f in ws["focus"]:
            print(f"  focus {f['name']}: {f['achieved']} m/cell (target {f['target']})")
    else:
        print(f"region {region.id}: {cx}×{cy} cells at {region.meters_per_cell:g} m")

    # fetch (cached)
    dem = layout.corner_elevation(region.sources["dem"])
    dem_real = dem
    vref = vfac = None
    if layout.warped and layout.spec.vertical:
        dem, ref, rel = layout.relief(dem)
    landcover = layout.cell_landcover()
    release = region.sources["overture"]["release"]
    bbox = region.lonlat_envelope()
    road_spec = region.sources["roads"]
    road_ids = class_ids(road_spec["classes"], ROAD_ORDER)
    road_id = {c: i for i, c in road_ids.items()}
    road_rows = overture.roads(
        release, bbox, road_spec["classes"], road_spec.get("excludeSubclasses")
    )
    path_ids: dict[int, str] = {}
    path_rows: list[dict] = []
    if "paths" in region.sources:
        path_ids = class_ids(region.sources["paths"]["classes"], PATH_ORDER)
        path_rows = overture.paths(release, bbox, region.sources["paths"]["classes"])
    path_id = {c: i for i, c in path_ids.items()}
    river_rows = overture.rivers(release, bbox, region.sources["rivers"]["subtypes"])

    # heights in steps on the shared corner field
    step_m = meters_per_step(region.meters_per_cell, region.vertical_exaggeration)
    corner_m = dem
    if layout.warped and layout.spec.vertical:
        # per-cell relief mapping for the client (strata stay at real elevations)
        ref_cell = corner_stack(ref).mean(axis=0) / step_m
        rel_cell = corner_stack(rel).mean(axis=0)
        vref = np.clip(round_half_up(ref_cell * 16), -32768, 32767).astype(np.int16)
        vfac = np.clip(round_half_up(4096 / rel_cell), 1, 32767).astype(np.int16)
    if region.bilateral_cells > 0:
        corner_m = bilateral(dem, region.bilateral_cells, region.bilateral_meters)
    q = round_half_up(corner_m / step_m).astype(np.int64)

    # water
    terrain = region.terrain or {}
    min_lake_cells = round(terrain.get("minLakeArea", 0) / region.meters_per_cell**2)
    lake = drop_small(landcover == 80, min_lake_cells)
    if "maxLakeRelief" in terrain:
        lake = drop_sloped(lake, dem, terrain["maxLakeRelief"])
    river_lines = _lines_in_cells(layout, river_rows, lambda r: 1)
    river_layer = road_stage.rasterize(river_lines, (cy, cx))
    river = (river_layer.mask & road_stage.CONNECT_MASK) != 0
    if "riverWidthMeters" in terrain:
        river |= buffered_lines(
            river_lines, terrain["riverWidthMeters"] / 2 / region.meters_per_cell, (cy, cx)
        )
    q, water_level = apply_water(q, lake, river)

    # roads: snap, cut-and-fill on the corner field
    road_lines = _lines_in_cells(layout, road_rows, lambda r: road_id[r["class"]])
    road_lines_mapped = road_lines
    path_lines = _lines_in_cells(layout, path_rows, lambda r: path_id[overture.path_class(r)])
    snap = region.snap or {}
    road_shift = None
    deviation = None
    keep: dict[str, dict[str, Any]] = {}
    if "roads" in snap:
        # straighten the network toward the 8 grid directions (D-049)
        rs = snap["roads"] or {}
        keep = kept_ways(road_rows + path_rows, rs.get("keep") or [])
        # roads and paths straighten together, so crossings stay where they meet
        straight = road_stage.straighten(
            road_lines + path_lines,
            angle=float(rs.get("angle", 16.0)),
            simplify=float(rs.get("simplify", 0.75)),
            max_shift=float(rs.get("maxShift", 2.0)),
            shape=(cy, cx),
            keep=set(keep),
        )
        if keep:
            print(f"snap: {len(keep)} ways keep their real geometry")
        road_lines = straight.lines[: len(road_lines)]
        path_lines = straight.lines[len(road_lines) :]
        deviation = float(rs.get("deviation", 1.0))
        follow = float((snap.get("buildings") or {}).get("follow", 3.0))
        road_shift = straight.shift(follow)
        moved = np.hypot(*(straight.moved - straight.origin).T)
        print(
            f"snap: {straight.constrained}/{straight.edges} road edges made octilinear, "
            f"nodes moved p99 {np.percentile(moved, 99) if len(moved) else 0:.2f} cells"
        )
    widths = region.widths
    road_w = path_w = None
    if widths is not None:
        rw = ROAD_WIDTH_M | {k: float(v) for k, v in (widths.get("roads") or {}).items()}
        pw = PATH_WIDTH_M | {k: float(v) for k, v in (widths.get("paths") or {}).items()}
        road_w = {r["id"]: rw[r["class"]] for r in road_rows}
        path_w = {r["id"]: pw[overture.path_class(r)] for r in path_rows}
        # a kept road may be drawn narrower than its class (a crooked street's one lane)
        for seg_id in road_w.keys() & keep.keys():
            if "width" in keep[seg_id]:
                road_w[seg_id] = float(keep[seg_id]["width"])
    road_layer = road_stage.rasterize(road_lines, (cy, cx), deviation=deviation, widths=road_w)
    path_layer = (
        road_stage.rasterize(path_lines, (cy, cx), deviation=deviation, widths=path_w)
        if path_rows
        else None
    )
    road_hw = path_hw = None
    if widths is not None:
        mpc = layout.meters_per_cell()
        road_hw = half_width_cells(road_layer.width, mpc, widths)
        if path_layer is not None:
            path_hw = half_width_cells(path_layer.width, mpc, widths)
    heights = road_stage.road_heights(road_layer.mask, q)
    q = road_stage.apply_to_corners(q, road_layer.mask, heights)
    on_road = (road_layer.mask & road_stage.CONNECT_MASK) != 0
    # rails in the street (M3.5): street tracks along their roads' centre lines
    rail = None
    rail_rules = region.sources.get("rails") or []
    if rail_rules:
        classes = sorted({c for rule in rail_rules for c in rule.get("rail") or []})
        rail_rows = overture.rails(release, bbox, classes)
        rail = road_stage.rail_layer(
            rail_lines(layout, rail_rows, rail_rules, road_shift),
            (cy, cx),
            deviation=deviation,
            on_road=on_road,
        )
        print(f"rails: {int((rail != 0).sum())} cells from {len(rail_rows)} segments")

    # gridify
    base, shape = gridify_heights(q.astype(np.float64), steep="flat", max_offset=region.max_slope)
    is_water = ((water_level != NO_WATER) | river) & ~on_road
    low = cell_corner_heights(base, shape).min(axis=0)
    base = np.where(is_water, low, base).astype(np.int16)
    shape = np.where(is_water, 0, shape).astype(np.uint8)
    water = np.where(is_water, base, NO_WATER).astype(np.int16)

    # classes by real elevation: the smoothed field, unless relief is exaggerated
    exaggerated = layout.warped and bool(layout.spec.vertical)
    surface = classify(
        landcover,
        dem_real if exaggerated else corner_m,
        base,
        shape,
        water,
        step_m,
        cliff_slope=terrain.get("cliffSlope"),
        meters_per_cell=region.meters_per_cell,
    )
    # ground from land use (M3.5): park lawns where WorldCover sees grass or built-up land
    ground = region.ground or {}
    surface_names = SURFACES | ground_stage.SURFACES if ground else SURFACES
    surface_id = {name: i for i, name in surface_names.items()}
    if ground and layout.warped:
        raise ValueError("ground surfaces aren't supported on warped layouts yet")
    if ground.get("lawn"):
        lawn = ground_stage.lawn(
            region,
            surface,
            surface_names,
            dem_real if exaggerated else corner_m,
            ground["lawn"],
            road_shift,
        )
        surface[lawn] = surface_id["lawn"]
        print(f"ground: {int(lawn.sum())} lawn cells")
    geology, province_names = provinces(region, layout)
    # junctions are checked where they lie inside the grid (as first mapped)
    mapped = {seg_id: parts for seg_id, _, parts in road_lines_mapped}

    def junction_inside(seg_id: str, at: float) -> bool:
        parts = mapped.get(seg_id)
        if not parts:
            return False
        xs = np.concatenate([p[0] for p in parts])
        ys = np.concatenate([p[1] for p in parts])
        x, y = road_stage.point_at(xs, ys, at)
        return 0 <= x < cx and 0 <= y < cy

    report = road_stage.validate(
        road_layer,
        cell_corner_heights(base, shape),
        road_stage.junction_index(road_rows, junction_inside),
    )
    print(f"roads: {asdict(report)}")

    # micro-terrain (optional): K×K micro-cells per cell, constrained by the cell layers
    micro = None
    if region.micro is not None:
        k = int(region.micro["k"])
        dem_spec = region.sources["dem"] | region.micro.get("dem", {})
        micro_m = layout.corner_elevation(dem_spec, k)
        if layout.warped and layout.spec.vertical:
            micro_m = layout.relief(micro_m, k)[0]
        # smoothed surfaces (M3.5): {surface: metres}, a Gaussian over each surface's own ground
        sigma = None
        if region.micro.get("smooth"):
            sigma = np.zeros(surface.shape)
            for name, metres in region.micro["smooth"].items():
                (sid,) = ground_stage.surface_ids(surface_names, [name])
                sigma[surface == sid] = float(metres) / (region.meters_per_cell / k)
        mc = micro_stage.build_micro(
            micro_m,
            step_m,
            k,
            base,
            shape,
            water,
            road_layer.mask,
            None if road_hw is None else road_hw / 32.0,
            sigma,
        )
        micro = (mc, k)
        print(f"micro: K={k}, {mc.shape[1] - 1}×{mc.shape[0] - 1} micro-cells")

    # objects (optional): vegetation, buildings, landmarks as semantic groups
    instances = None
    object_counts: dict[str, int] = {}
    if region.objects is not None:
        steep_steps = max(1, round(OBJECT_MAX_SLOPE * region.vertical_exaggeration / STEP_WORLD))
        blocked = on_road | is_water | cliff_mask(base, shape, min_drop=steep_steps)
        if road_hw is not None:
            blocked |= paved_band(on_road, road_hw / 32.0)

        def drawn_steps(x: float, y: float, metres: float) -> float:
            if layout.warped:
                return layout.drawn_height(x, y, metres) / step_m
            return metres / step_m

        instances, object_counts = object_stage.place(
            region,
            blocked,
            road_rows,
            layout,
            drawn_steps,
            shift=road_shift,
            streets=road_lines,
            water=is_water,
        )
        print(f"objects: {object_counts}")
        # over water, a bridge's deck is the road: the water under it stays water (D-056)
        under = bridge_decks_over_water(
            instances, (water_level != NO_WATER) | river, road_layer.mask.shape, on_road
        )
        if under.any():
            base, shape, water, surface, micro = water_under_decks(
                under, base, shape, water, surface, low, road_layer, road_hw, micro
            )
            print(f"bridges: {int(under.sum())} cells of water under their decks")
    # yards (M3.5): the green behind and between houses, once the houses stand
    if ground.get("yard") and instances:
        paved = on_road | (water != NO_WATER)
        if road_hw is not None:
            paved |= paved_band(on_road, road_hw / 32.0)
        yard = ground_stage.yard_cells(
            surface,
            surface_names,
            instances,
            paved,
            region.meters_per_cell,
            ground["yard"],
            seed=object_stage._seed(region, "yard"),
        )
        surface[yard] = surface_id["yard"]
        print(f"ground: {int(yard.sum())} yard cells")
    attribution = [
        ATTRIBUTION[region.sources["dem"]["kind"]],
        ATTRIBUTION[region.sources["landcover"]["kind"]],
        ATTRIBUTION["overture"],
    ]
    if region.objects and "buildings" in region.objects:
        attribution.append(ATTRIBUTION["overture-buildings"])
        if region.objects["buildings"].get("lidar"):
            attribution.append(ATTRIBUTION["usgs-3dep-lidar"])
    if region.objects and (region.objects.get("typology") or {}).get("facts") == "datasf":
        from .sources.datasf import ATTRIBUTION as DATASF_ATTRIBUTION

        attribution.append(DATASF_ATTRIBUTION)
    if region.objects and any("canopy" in r for r in (region.objects.get("vegetation") or [])):
        from .sources.canopy import ATTRIBUTION as CANOPY_ATTRIBUTION

        attribution.append(CANOPY_ATTRIBUTION)

    sx, sy = layout.lonlat_to_cell([region.start[0]], [region.start[1]])
    warp_info = None
    chunk_scale = None
    if layout.warped:
        chunk_scale = layout.meters_per_cell()
        warp_info = {
            "method": layout.warp.stats["method"],
            "background": layout.spec.background,
            "focus": layout.warp.stats["focus"],
            "pins": len(layout.spec.pins),
            "vertical": layout.spec.vertical or None,
        }
    geo = None
    if region.levels:
        # warped maps bend between grid points: a finer grid keeps the
        # interpolation within ~2 cells even in stretched transition rings
        step = 4 if layout.warped else 16
        geo = (*layout.geo_grid(step), step)
    depiction = None
    dep = (region.objects or {}).get("depiction") or {}
    if dep.get("heightStretch") is not None or dep.get("scatter"):
        depiction = {}
        if dep.get("heightStretch") is not None:
            depiction["heightStretch"] = float(dep["heightStretch"])
        if dep.get("scatter"):
            # the client scatters vegetation by surface at this density (M3)
            depiction["scatter"] = float(dep["scatter"])
    heroes = package_heroes(region, region_path, out_dir)
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
        road_width=road_hw,
        path=None if path_layer is None else path_layer.mask,
        path_class=None if path_layer is None else path_layer.cls,
        path_width=path_hw,
        rail=rail,
        path_classes=path_ids or None,
        geology=geology,
        vref=vref,
        vfac=vfac,
        chunk_scale=chunk_scale,
        warp_info=warp_info,
        chunk_size=region.chunk_size,
        scale={
            "metersPerCell": region.meters_per_cell,
            "metersPerStep": round(step_m, 6),
            "elevationDatumMeters": 0,
            "verticalExaggeration": region.vertical_exaggeration,
        },
        surfaces=surface_names,
        road_classes=road_ids,
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
                **({"warp": layout.spec.digest()} if layout.warped else {}),
            },
        },
        render=region.render,
        objects=instances,
        micro=micro,
        geo=geo,
        level=region.level,
        levels=region.levels,
        depiction=depiction,
        heroes=heroes,
        compress=compress,
        clean=True,
    )
    build_report = {
        "packageHash": manifest["packageHash"],
        "cells": [cx, cy],
        "chunks": len(manifest["chunks"]),
        "heightRange": manifest["heightRange"],
        "inputs": {"roadSegments": len(road_rows), "riverLines": len(river_rows)},
        **({"warp": layout.warp.stats} if layout.warped else {}),
        **({"objects": object_counts} if instances is not None else {}),
        "roads": asdict(report) | {"ok": report.ok()},
        **(
            {"paths": {"segments": len(path_rows), "cells": int((path_layer.mask > 0).sum())}}
            if path_layer is not None
            else {}
        ),
        **(
            {
                "rails": {
                    kind: int(((rail >> road_stage.RAIL_KIND_SHIFT) == k).sum())
                    for kind, k in road_stage.RAIL_KINDS.items()
                }
            }
            if rail is not None
            else {}
        ),
        "surfaces": {
            surface_names[int(k)]: int(v)
            for k, v in zip(*np.unique(surface, return_counts=True), strict=True)
        },
    }
    (out_dir / "build-report.json").write_text(json.dumps(build_report, indent=2) + "\n")
    return build_report
