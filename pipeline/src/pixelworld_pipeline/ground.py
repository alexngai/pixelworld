"""Ground surfaces from land use (M3.5): park lawns and residential yards.

ESA WorldCover sees an irrigated park lawn and a dry hillside as the same
grassland, and a block of houses with green backyards as built-up land. A
region spec's optional `ground` section tells them apart:

    ground:
      lawn:   # parks, golf courses, pitches and gardens (Overture base land_use)
        landUse: [park, golf_course, fairway, pitch, grass, garden, cemetery]
        over: [grass, desert, urban, farmland]   # the surfaces a lawn replaces
        keep: [grassland, scrub, heath, beach]   # natural land (base `land`) left as it is
        maxSlope: 0.2      # a park steeper than this (median) stays wild
        slopeMeters: 50    # slopes measured over about this distance
        wooded: { over: [woodland], maxCover: 0.5 }  # tree cover, where the canopy map is open
        paved: [pedestrian]  # land use inside a park left as it is (courts, plazas)
        spread: { over: [grass], meters: 20 }  # into the open grass around a lawn
      yard:   # backyards and front gardens, beside houses (after objects)
        near: [building.rowhouse, building.house, building.residential, building.apartment]
        over: [urban, grass, desert]
        reachMeters: 15    # cells this close to houses' footprints
        paved: 0.2         # share of yard cells left paved

Land-use polygons move with the straightened roads (D-049), as buildings do,
so a park stays between its streets. Micro-terrain can be smoothed per
surface (`micro.smooth`: {surface: metres}), so lawns read as smooth slopes.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import shapely

from .region import Region
from .sources import overture

# Surface ids for the ground classes, after build.SURFACES (ids are local to a
# package; the name is the contract with the style pack).
SURFACES = {12: "lawn", 13: "yard"}


def cell_slope(corner_m: np.ndarray, meters_per_cell: float, window_m: float = 0.0) -> np.ndarray:
    """Per-cell slope (real rise over run) from corner elevations in metres,
    after averaging the corners over about `window_m` metres."""
    from scipy import ndimage

    n = max(1, round(window_m / meters_per_cell))
    z = ndimage.uniform_filter(corner_m, n, mode="nearest") if n > 1 else corner_m
    c0, c1, c2, c3 = z[:-1, :-1], z[:-1, 1:], z[1:, 1:], z[1:, :-1]
    gx = ((c1 - c0) + (c2 - c3)) / (2.0 * meters_per_cell)
    gy = ((c3 - c0) + (c2 - c1)) / (2.0 * meters_per_cell)
    return np.hypot(gx, gy)


def drawn_cell_points(
    region: Region, shape: tuple[int, int], shift=None
) -> tuple[np.ndarray, np.ndarray]:
    """Projected metres under every cell centre as drawn: where the data that
    is drawn there came from, the straightened roads' shift undone (D-049)."""
    from .objects import Placement

    cy, cx = shape
    gx, gy = np.meshgrid(np.arange(cx) + 0.5, np.arange(cy) + 0.5)
    p = Placement(region, np.zeros(shape, dtype=bool), None, shift)
    xs, ys = p.from_cells(gx.ravel(), gy.ravel())
    return xs.reshape(shape), ys.reshape(shape)


def project_rows(region: Region, rows: list[dict]) -> list:
    """The rows' lon/lat polygons in projected metres (valid, non-empty)."""
    from .objects import Placement

    p = Placement(region, np.zeros((1, 1), dtype=bool))
    out = []
    for r in rows:
        g = p.project(shapely.from_wkt(r["geometry"]))
        g = g if g.is_valid else g.buffer(0)
        if not g.is_empty:
            out.append(g)
    return out


def points_in(polys: list, xs: np.ndarray, ys: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(point index, polygon index) for every point (flattened) inside a polygon."""
    if not polys or not xs.size:
        return np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.int64)
    tree = shapely.STRtree(polys)
    pts, idx = tree.query(shapely.points(xs.ravel(), ys.ravel()), predicate="within")
    return pts.astype(np.int64), idx.astype(np.int64)


def surface_ids(names: dict[int, str], wanted: list[str]) -> list[int]:
    by_name = {n: i for i, n in names.items()}
    unknown = [w for w in wanted if w not in by_name]
    if unknown:
        raise ValueError(f"unknown surfaces {unknown}; use some of {sorted(by_name)}")
    return [by_name[w] for w in wanted]


def gentle_land(
    members: tuple[np.ndarray, np.ndarray], count: int, slope: np.ndarray, max_slope: float
) -> np.ndarray:
    """Cells inside an area (park, golf course, …) whose cells' median slope
    is at most `max_slope`. A park is a lawn or a wild hill as a whole, so a
    lawn isn't patched with wild grass where its ground steepens."""
    pts, idx = members
    out = np.zeros(slope.shape, dtype=bool)
    if not pts.size:
        return out
    flat = slope.ravel()
    order = np.argsort(idx, kind="stable")
    pts, idx = pts[order], idx[order]
    cuts = np.searchsorted(idx, np.arange(count + 1))
    gentle = np.zeros(count, dtype=bool)
    for k in range(count):
        cells = pts[cuts[k] : cuts[k + 1]]
        gentle[k] = cells.size > 0 and float(np.median(flat[cells])) <= max_slope
    out.ravel()[pts[gentle[idx]]] = True
    return out


def lawn_cells(
    surface: np.ndarray,
    names: dict[int, str],
    gentle: np.ndarray,
    wild: np.ndarray,
    rule: dict[str, Any],
    cover: np.ndarray | None = None,
) -> np.ndarray:
    """Cells that are lawn: in gentle parkland (see gentle_land), on a surface
    the rule replaces, not natural land left wild (steep parks stay wild
    grass, golden in summer). With `wooded` ({over, maxCover}) and the canopy
    `cover` per cell, tree-covered cells where the canopy map shows the
    ground open are lawn too: a park's trees then stand on its lawn."""
    out = gentle & ~wild & np.isin(surface, surface_ids(names, list(rule.get("over", ["grass"]))))
    wooded = rule.get("wooded")
    if wooded and cover is not None:
        under = np.isin(surface, surface_ids(names, list(wooded.get("over", ["woodland"]))))
        out |= gentle & ~wild & under & (cover < float(wooded.get("maxCover", 0.5)))
    return out


def spread_lawn(
    lawn: np.ndarray,
    surface: np.ndarray,
    names: dict[int, str],
    wild: np.ndarray,
    spread: dict[str, Any],
    meters_per_cell: float,
) -> np.ndarray:
    """Lawn grown into the cells around it of the surfaces `spread.over`
    names (open grass), up to `spread.meters` away: the verges and edge
    strips between a park's mapped outline and its streets."""
    from scipy import ndimage

    reach = round(float(spread.get("meters", 0.0)) / meters_per_cell)
    if reach < 1 or not lawn.any():
        return lawn
    may = ~wild & np.isin(surface, surface_ids(names, list(spread.get("over", ["grass"]))))
    return ndimage.binary_dilation(lawn, iterations=reach, mask=may | lawn)


def canopy_cover(
    region: Region,
    canopy,
    xs: np.ndarray,
    ys: np.ndarray,
    where: np.ndarray,
    height: float = 3.0,
    n: int = 4,
) -> np.ndarray:
    """Share of each cell (where `where`) under canopy at least `height`
    metres tall, from n×n samples across the cell (projected metres at
    cell centres in xs, ys)."""
    out = np.zeros(xs.shape)
    iy, ix = np.nonzero(where)
    if not iy.size:
        return out
    m = region.meters_per_cell
    offs = (np.arange(n) + 0.5) / n - 0.5
    ox, oy = np.meshgrid(offs * m, offs * m)
    sx = (xs[iy, ix][:, None] + ox.ravel()[None, :]).ravel()
    sy = (ys[iy, ix][:, None] + oy.ravel()[None, :]).ravel()
    h = canopy.sample(sx, sy, region.crs).reshape(iy.size, n * n)
    out[iy, ix] = (h >= height).mean(axis=1)
    return out


def lawn(
    region: Region,
    surface: np.ndarray,
    names: dict[int, str],
    corner_m: np.ndarray,
    rule: dict[str, Any],
    shift=None,
    canopy=None,
) -> np.ndarray:
    """The lawn rule on a region (uniform layouts): Overture's land use and
    natural land, sampled where each cell is drawn."""
    release = region.sources["overture"]["release"]
    bbox = region.lonlat_envelope()
    xs, ys = drawn_cell_points(region, surface.shape, shift)
    parks = project_rows(region, overture.land_use(release, bbox, list(rule["landUse"])))
    slope = cell_slope(corner_m, region.meters_per_cell, float(rule.get("slopeMeters", 50.0)))
    gentle = gentle_land(
        points_in(parks, xs, ys), len(parks), slope, float(rule.get("maxSlope", 0.2))
    )
    wild = np.zeros(surface.shape, dtype=bool)
    if rule.get("keep"):
        natural = project_rows(region, overture.land(release, bbox, list(rule["keep"])))
        pts, _ = points_in(natural, xs, ys)
        wild.ravel()[pts] = True
    if rule.get("paved"):
        # courts and plazas inside a park (land use `pedestrian`) stay as they are (D-097)
        courts = project_rows(region, overture.land_use(release, bbox, list(rule["paved"])))
        pts, _ = points_in(courts, xs, ys)
        wild.ravel()[pts] = True
    cover = None
    wooded = rule.get("wooded")
    if wooded:
        if canopy is None:
            from .sources.canopy import CanopyGrid

            canopy = CanopyGrid(region.lonlat_envelope())
        under = np.isin(surface, surface_ids(names, list(wooded.get("over", ["woodland"]))))
        cover = canopy_cover(
            region, canopy, xs, ys, gentle & ~wild & under, float(wooded.get("canopy", 3.0))
        )
    out = lawn_cells(surface, names, gentle, wild, rule, cover)
    if rule.get("spread"):
        out = spread_lawn(out, surface, names, wild, rule["spread"], region.meters_per_cell)
    return out


def water_area_cells(region: Region, shape: tuple[int, int], classes: list[str]) -> np.ndarray:
    """Cells whose centre lies in an Overture water area of `classes` (ponds,
    moats, lakes): still water beside land cover's, which misses a pond in a
    garden or a castle's moat (D-097). Uniform layouts; cells as laid out."""
    release = region.sources["overture"]["release"]
    polys = project_rows(region, overture.water_areas(release, region.lonlat_envelope(), classes))
    out = np.zeros(shape, dtype=bool)
    if polys:
        xs, ys = drawn_cell_points(region, shape)
        pts, _ = points_in(polys, xs, ys)
        out.ravel()[pts] = True
    return out


def footprint_cover(
    instances: list[dict], groups, shape: tuple[int, int], supersample: int = 4
) -> np.ndarray:
    """Share of each cell under the footprints of instances whose group
    `groups(g)` accepts (footprints in cells, as drawn)."""
    from rasterio import features
    from rasterio.transform import Affine

    polys = [
        shapely.Polygon(inst["fp"])
        for inst in instances
        if inst.get("fp") and len(inst["fp"]) >= 3 and groups(inst["g"])
    ]
    cy, cx = shape
    if not polys:
        return np.zeros(shape)
    ss = supersample
    polys = [p if p.is_valid else p.buffer(0) for p in polys]
    fine = features.rasterize(
        ((p, 1) for p in polys if not p.is_empty),
        out_shape=(cy * ss, cx * ss),
        transform=Affine.scale(1.0 / ss),
        fill=0,
        dtype=np.uint8,
    )
    return fine.reshape(cy, ss, cx, ss).mean(axis=(1, 3))


def yard_cells(
    surface: np.ndarray,
    names: dict[int, str],
    instances: list[dict],
    blocked: np.ndarray,
    meters_per_cell: float,
    rule: dict[str, Any],
    seed: int = 0,
) -> np.ndarray:
    """Backyards and front gardens: open cells (not road, pavement or water)
    on a surface the rule replaces, near houses (`near`: group prefixes)
    where houses outweigh other buildings around. A share (`paved`) of them,
    picked by seed, stays paved: patios, driveways, a garage court."""
    prefixes = tuple(rule.get("near", ["building.residential"]))

    def homes(g: str) -> bool:
        return g.startswith(prefixes)

    def others(g: str) -> bool:
        return g.startswith("building") and not g.startswith(prefixes)

    from scipy import ndimage

    r = max(1, round(float(rule.get("reachMeters", 15.0)) / meters_per_cell))
    size = 2 * r + 1
    res = ndimage.uniform_filter(footprint_cover(instances, homes, surface.shape), size)
    other = ndimage.uniform_filter(footprint_cover(instances, others, surface.shape), size)
    over = np.isin(surface, surface_ids(names, list(rule.get("over", ["urban"]))))
    out = over & ~blocked & (res > 1e-6) & (res >= other)
    paved = float(rule.get("paved", 0.0))
    if paved > 0:
        out &= np.random.default_rng(seed).random(surface.shape) >= paved
    return out
