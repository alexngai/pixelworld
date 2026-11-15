"""Micro-terrain (M1.6, D-037): K×K micro-cells inside every cell.

Micro-cells use the same model as cells (a base height plus up to three steps
of corner offsets, flat terraces where steeper) on a K-times finer grid, with
heights in micro-steps of 1/K step. The cell layers stay the gameplay summary;
micro-terrain is what gets drawn and what vehicles drive on.

Constraints from the cell layers keep the two consistent:
- water is a flat plane the client draws at each water body's level, and
  the ground under it sinks below the level, so the shoreline is where the
  ground crosses it (D-094);
- roads run on a bed cut along the line between connected road-cell centres,
  following the cells' road profile, so road decals sit on smooth ground;
- sidewalks and crossings beside a road lie on its profile too where the
  ground under them would step (M3.5), so a pavement band doesn't cross a
  terrace the road was cut through.
"""

from __future__ import annotations

import numpy as np

from .gridify import cell_corner_heights, round_half_up
from .roads import CONNECT_MASK, DIRS
from .world_format import MICRO_MAX_OFFSET, NO_WATER

# Road beds cover micro-corners within this distance (cells) of a road's centre
# line: a bench about half a cell wide, wider than any road decal.
ROAD_BED_RADIUS = 0.3
# How far (cells) beyond its road's bed a sidewalk may lie and still follow it
PATH_BED_REACH = 1.5

# Water (D-094): the client draws water as a flat plane at its level over the
# water cells and their neighbours (plane_levels), and the micro-terrain
# shapes the ground under it (shape_shore), so shorelines follow the map at
# micro-cell resolution rather than the cells' staircase.
SHORE_SLOPE = 1.0  # micro-steps of depth per micro-cell out from the shore
SHORE_DEPTH = 3  # micro-steps: the deepest bed under the plane
# A natural bank stays a micro-step above the water for SHORE_LIP micro-cells,
# then rises SHORE_BANK per micro-cell: with the waterline's two micro-steps
# (one above, one under), no micro-cell on it spans more than a slope tile's
# 3, even across its diagonal, so the bank draws as slopes, not terraces.
SHORE_LIP = 1.0
SHORE_BANK = 1.4
SHORE_BANK_TOP = 6  # micro-steps above the water: higher ground stands behind the bank as a cliff
SHORE_SMOOTH = 0.5  # cells: the Gaussian that rounds water known only by its cells
SHORE_FAR = 64.0  # micro-cells: distances are clipped here
SHORE_FINE_PIXELS = 12e6  # the shoreline raster's budget: finer when it fits


def expand(cells: np.ndarray, k: int) -> np.ndarray:
    """Per-cell values → per-micro-cell values."""
    return np.repeat(np.repeat(cells, k, axis=0), k, axis=1)


def corner_min(micro_cells: np.ndarray, fill: float) -> np.ndarray:
    """Per-micro-cell values → per-micro-corner minimum over the touching micro-cells."""
    h, w = micro_cells.shape
    p = np.full((h + 2, w + 2), fill, dtype=np.float64)
    p[1:-1, 1:-1] = micro_cells
    return np.minimum.reduce([p[:-1, :-1], p[:-1, 1:], p[1:, :-1], p[1:, 1:]])


def flatten_water(q: np.ndarray, water: np.ndarray, k: int) -> np.ndarray:
    """Set the micro-corners of every water cell a micro-step under its level
    (micro-steps): a flat bed under the plane the client draws there."""
    if not (water != NO_WATER).any():
        return q
    level = np.where(water != NO_WATER, water.astype(np.float64) * k, np.inf)
    at = corner_min(expand(level, k), np.inf)
    return np.where(np.isfinite(at), at - 1, q)


def plane_levels(water: np.ndarray, road_mask: np.ndarray) -> np.ndarray:
    """The level (steps) of the water plane the client draws over each cell,
    NO_WATER for none: a water cell's own, else the highest of its 8
    neighbours', but none on a dry road cell. Mirrors fieldVertex's water
    plane (packages/bake shaders), which also leaves out a neighbour's
    micro-cells whose ground lies more than SHORE_DEPTH under the plane:
    not its shore (shape_shore)."""
    from scipy import ndimage

    has = water != NO_WATER
    if not has.any():
        return water
    nb = ndimage.maximum_filter(water, size=3, mode="constant", cval=NO_WATER)
    road = (road_mask & 0x0FFF) != 0
    return np.where(has, water, np.where(road, NO_WATER, nb)).astype(np.int16)


def shore_field(
    shape: tuple[int, int],
    k: int,
    water_cells: np.ndarray,
    areas: list | None = None,
    lines: list | None = None,
    half_width: float = 0.5,
) -> np.ndarray:
    """Signed distance (micro-cells) from every micro-corner to the shoreline,
    negative in water, shape (K·cy + 1, K·cx + 1).

    areas: water polygons in cell coordinates. lines: river centre lines
    (`(id, rank, [(xs, ys), ...])` in cells), water half_width cells either
    side. Water cells with neither within 2 cells (a lake the map lacks, or a
    world without shoreline data) are rounded by a Gaussian of SHORE_SMOOTH
    cells, so their shores don't follow the cells' staircase. Shorelines are
    drawn on a grid up to 4 times finer than the micro-corners, so they land
    within a fraction of a micro-cell of the data.
    """
    import shapely
    from rasterio import features
    from rasterio.transform import Affine
    from scipy import ndimage

    cy, cx = shape
    s = int(max(1, min(4, np.sqrt(SHORE_FINE_PIXELS / ((cy * k + 1) * (cx * k + 1))))))
    ks = k * s
    rows, cols = cy * ks + 1, cx * ks + 1
    # pixel centres on the fine corners: pixel (c, r) lies at cell (c / ks, r / ks)
    t = Affine(1 / ks, 0, -0.5 / ks, 0, 1 / ks, -0.5 / ks)

    def burn(geoms, all_touched=False) -> np.ndarray:
        return features.rasterize(
            ((g, 1) for g in geoms),
            (rows, cols),
            transform=t,
            dtype="uint8",
            all_touched=all_touched,
        ).astype(bool)

    wet = np.zeros((rows, cols), dtype=bool)
    if areas:
        wet |= burn(areas)
    river = [
        shapely.LineString(np.column_stack([xs, ys]))
        for _id, _rank, parts in lines or []
        for xs, ys in parts
        if len(xs) >= 2
    ]
    if river:
        wet |= ndimage.distance_transform_edt(~burn(river, all_touched=True)) <= half_width * ks
    cells = water_cells.copy()
    if wet.any():
        mapped = wet[: cy * ks, : cx * ks].reshape(cy, ks, cx, ks).any(axis=(1, 3))
        cells &= ~ndimage.binary_dilation(mapped, iterations=2)
    if cells.any():
        ys = np.minimum(np.arange(rows) // ks, cy - 1)
        xs = np.minimum(np.arange(cols) // ks, cx - 1)
        fine = cells[ys][:, xs].astype(np.float32)
        wet |= ndimage.gaussian_filter(fine, SHORE_SMOOTH * ks) > 0.5
    if not wet.any() or wet.all():
        return np.full((cy * k + 1, cx * k + 1), -SHORE_FAR if wet.any() else SHORE_FAR)
    inside = ndimage.distance_transform_edt(wet)
    outside = ndimage.distance_transform_edt(~wet)
    sd = np.where(wet, 0.5 - inside, outside - 0.5) / s
    return np.clip(sd[::s, ::s], -SHORE_FAR, SHORE_FAR)


def shape_shore(
    q: np.ndarray,
    shore: np.ndarray,
    water: np.ndarray,
    road_mask: np.ndarray,
    k: int,
    bank: np.ndarray | None = None,
) -> np.ndarray:
    """Shape the ground under and around the water planes (micro-steps): wet
    micro-corners sink under every plane drawn over them, SHORE_SLOPE deeper
    per micro-cell out from the shore up to SHORE_DEPTH, so the shoreline is
    where the ground crosses the plane; dry ones stand at least a micro-step
    above it. Corners touching a road cell stay dry: roads keep their beds.
    Beside the water cells, ground more than SHORE_DEPTH + 1 micro-steps
    under a plane (below a dam, at a cliff's foot) isn't its shore: it's left
    as it is, and the baker draws no plane over it (plane_levels).

    bank: per cell, ground that slopes into the water (parks, beaches, woods)
    rather than meeting it in a wall (quays, rock): a micro-step above the
    water for SHORE_LIP micro-cells, then SHORE_BANK per micro-cell up until
    it meets the ground, so the shore draws as slope tiles, not terraces. It
    reaches past the planes, from the nearest one's level, up to
    SHORE_BANK_TOP above it; ground higher still stands behind it."""
    plane = plane_levels(water, road_mask)
    lv = expand(np.where(plane != NO_WATER, plane.astype(np.float64) * k, np.inf), k)
    lo = corner_min(lv, np.inf)
    hi = -corner_min(np.where(np.isfinite(lv), -lv, np.inf), np.inf)
    road = expand((road_mask & 0x0FFF) != 0, k)
    by_road = corner_min(np.where(road, 0.0, 1.0), 1.0) == 0
    in_water = corner_min(np.where(expand(water != NO_WATER, k), 0.0, 1.0), 1.0) == 0
    shore_of = in_water | (q >= lo - SHORE_DEPTH - 1)
    wet = (shore < 0) & np.isfinite(lo) & ~by_road & shore_of
    dry = ~wet & np.isfinite(hi) & shore_of
    depth = np.clip(1 + np.floor(-shore * SHORE_SLOPE), 1, SHORE_DEPTH)
    q = np.where(wet, lo - depth, q)
    q = np.where(dry, np.maximum(q, hi + 1), q)
    if bank is not None and np.isfinite(hi).any():
        from scipy import ndimage

        # the nearest plane's level, as far out as a bank reaches
        reach = SHORE_LIP + (SHORE_BANK_TOP - 1) / SHORE_BANK  # micro-cells
        dist, (iy, ix) = ndimage.distance_transform_edt(plane == NO_WATER, return_indices=True)
        near = np.where(
            dist <= np.ceil(reach / k) + 1, plane[iy, ix].astype(np.float64) * k, np.inf
        )
        near = expand(near, k)
        level = -corner_min(np.where(np.isfinite(near), -near, np.inf), np.inf)
        soft = (corner_min(np.where(expand(bank, k), 1.0, 0.0), 1.0) == 1) & ~wet & ~by_road
        rise = 1 + SHORE_BANK * np.maximum(shore - SHORE_LIP, 0)
        soft &= np.isfinite(level) & (shore >= 0) & (rise <= SHORE_BANK_TOP)
        q = np.where(soft, np.minimum(q, level + rise), q)
    return q


def reflood(micro_corners: np.ndarray, water: np.ndarray, k: int) -> np.ndarray:
    """Finished micro-corners (int16) sunk under the water's level again, for
    cells that turned to water after micro-terrain was built (bridge decks over
    water, D-056; `water` holds only them): the road bed cut there must not
    show through the water."""
    q = flatten_water(micro_corners.astype(np.float64), water, k)
    return round_half_up(q).astype(np.int16)


def road_segments(
    mask: np.ndarray,
    centre_h: np.ndarray,
    half_width: np.ndarray | None = None,
    margin: float = 0.0,
) -> list[tuple[float, ...]]:
    """(ax, ay, ha, bx, by, hb, r) centre-to-centre segments of connected road
    cells (cells, steps); r is the bed radius: the road's half-width where
    known (D-050), at least ROAD_BED_RADIUS, plus `margin`."""
    out = []
    ys, xs = np.nonzero(mask & CONNECT_MASK)
    h, w = mask.shape
    for y, x in zip(ys.tolist(), xs.tolist(), strict=True):
        m = int(mask[y, x])
        for i, (dx, dy) in enumerate(DIRS):
            nx, ny = x + dx, y + dy
            # each connection once (from its lower-index end), inside the grid
            if not (m >> i) & 1 or not (0 <= nx < w and 0 <= ny < h):
                continue
            if (ny, nx) < (y, x):
                continue
            out.append(
                (
                    x + 0.5,
                    y + 0.5,
                    float(centre_h[y, x]),
                    nx + 0.5,
                    ny + 0.5,
                    float(centre_h[ny, nx]),
                    margin
                    + (
                        ROAD_BED_RADIUS
                        if half_width is None
                        else max(
                            ROAD_BED_RADIUS, float(half_width[y, x]), float(half_width[ny, nx])
                        )
                    ),
                )
            )
    return out


def cut_road_beds(
    q: np.ndarray, segments: list[tuple[float, ...]], k: int, radius: float = ROAD_BED_RADIUS
) -> np.ndarray:
    """Set micro-corners near road centre lines to the road profile (micro-steps)."""
    return _cut_beds(q, segments, k, radius)[0]


def follow_beds(
    q: np.ndarray,
    segments: list[tuple[float, ...]],
    paths: list[tuple[float, ...]],
    k: int,
    reach: float = PATH_BED_REACH,
) -> np.ndarray:
    """Road beds (`segments`, as cut_road_beds takes them) cut into `q`, and
    carried on under the paths beside them (`paths`, segments of the same
    form whose radius covers every micro-cell their band lies on): each path
    segment takes the road segment nearest its middle, within `reach` cells
    of that road's bed, and the micro-corners under it that the beds don't
    cover take that road's profile where they lie along it. A sidewalk then
    follows its road along and across, rather than the ground's terrace
    steps, and one between two roads follows its own. Paths further from any
    road keep their ground."""
    from scipy.spatial import cKDTree

    out, bed = _cut_beds(q, segments, k)
    if not segments or not paths:
        return out
    roads = np.asarray([s[:7] for s in segments], dtype=np.float64)
    a, b = roads[:, 0:2], roads[:, 3:5]
    tree = cKDTree(0.5 * (a + b))
    best = np.full(q.shape, np.inf)
    target = np.zeros(q.shape)
    hc, wc = q.shape

    def along(px, py, j):
        # where points lie along road segment j (0..1), and how far from it
        v = b[j] - a[j]
        t = np.clip(((px - a[j, 0]) * v[0] + (py - a[j, 1]) * v[1]) / float(v @ v), 0.0, 1.0)
        return t, np.hypot(px - a[j, 0] - v[0] * t, py - a[j, 1] - v[1] * t)

    for ax, ay, _, bx, by, _, r in paths:
        mx, my = 0.5 * (ax + bx), 0.5 * (ay + by)
        near = tree.query_ball_point((mx, my), reach + 1.0)
        if not near:
            continue
        dist = [float(along(np.array(mx), np.array(my), j)[1]) - roads[j, 6] for j in near]
        j = near[int(np.argmin(dist))]
        if min(dist) > reach:
            continue
        x0 = max(0, int(np.floor((min(ax, bx) - r) * k)))
        x1 = min(wc - 1, int(np.ceil((max(ax, bx) + r) * k)))
        y0 = max(0, int(np.floor((min(ay, by) - r) * k)))
        y1 = min(hc - 1, int(np.ceil((max(ay, by) + r) * k)))
        if x1 < x0 or y1 < y0:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) / k, np.arange(y0, y1 + 1) / k)
        vx, vy = bx - ax, by - ay
        s = np.clip(((gx - ax) * vx + (gy - ay) * vy) / (vx * vx + vy * vy), 0.0, 1.0)
        d = np.hypot(gx - ax - vx * s, gy - ay - vy * s)
        # only where the ground under the pavement steps: a terrace (a micro-cell
        # too steep to slope) touching the band; smooth ground stays as it is
        h = round_half_up(out[y0 : y1 + 1, x0 : x1 + 1])
        quad = (h[:-1, :-1], h[:-1, 1:], h[1:, 1:], h[1:, :-1])
        # ponytail: the default cap even where micro.maxSlope raises it (D-136), so a
        # bed may be cut under ground the client draws as a slope; thread it if roads show it
        steep = np.maximum.reduce(quad) - np.minimum.reduce(quad) > MICRO_MAX_OFFSET
        core = d <= r - 1.0 / k
        if not (steep & (core[:-1, :-1] | core[:-1, 1:] | core[1:, 1:] | core[1:, :-1])).any():
            continue
        sub = best[y0 : y1 + 1, x0 : x1 + 1]
        take = (d <= r) & (d < sub)
        sub[take] = d[take]
        t, _ = along(gx, gy, j)
        ha, hb = roads[j, 2], roads[j, 5]
        target[y0 : y1 + 1, x0 : x1 + 1][take] = ((ha + (hb - ha) * t) * k)[take]
    take = np.isfinite(best) & ~bed
    out[take] = target[take]
    return out


def _cut_beds(
    q: np.ndarray, segments: list[tuple[float, ...]], k: int, radius: float = ROAD_BED_RADIUS
) -> tuple[np.ndarray, np.ndarray]:
    """cut_road_beds, and the micro-corners it set (the bed)."""
    q = q.copy()
    best = np.full(q.shape, np.inf)
    target = np.zeros(q.shape)
    hc, wc = q.shape
    for seg in segments:
        ax, ay, ha, bx, by, hb = seg[:6]
        r = seg[6] if len(seg) > 6 else radius
        x0 = max(0, int(np.floor((min(ax, bx) - r) * k)))
        x1 = min(wc - 1, int(np.ceil((max(ax, bx) + r) * k)))
        y0 = max(0, int(np.floor((min(ay, by) - r) * k)))
        y1 = min(hc - 1, int(np.ceil((max(ay, by) + r) * k)))
        if x1 < x0 or y1 < y0:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) / k, np.arange(y0, y1 + 1) / k)
        vx, vy = bx - ax, by - ay
        t = np.clip(((gx - ax) * vx + (gy - ay) * vy) / (vx * vx + vy * vy), 0.0, 1.0)
        d = np.hypot(gx - ax - vx * t, gy - ay - vy * t)
        sub_best = best[y0 : y1 + 1, x0 : x1 + 1]
        take = (d <= r) & (d < sub_best)
        sub_best[take] = d[take]
        target[y0 : y1 + 1, x0 : x1 + 1][take] = ((ha + (hb - ha) * t) * k)[take]
    on = np.isfinite(best)
    q[on] = target[on]
    return q, on


def corner_mean(micro_cells: np.ndarray) -> np.ndarray:
    """Per-micro-cell values → per-micro-corner mean over the touching micro-cells
    (those inside the grid)."""
    h, w = micro_cells.shape
    v = np.zeros((h + 2, w + 2))
    n = np.zeros((h + 2, w + 2))
    v[1:-1, 1:-1] = micro_cells
    n[1:-1, 1:-1] = 1.0
    quads = ((slice(None, -1), slice(None, -1)), (slice(None, -1), slice(1, None)))
    quads += ((slice(1, None), slice(None, -1)), (slice(1, None), slice(1, None)))
    total = sum(v[q] for q in quads)
    count = sum(n[q] for q in quads)
    return total / count


def smooth_cells(q: np.ndarray, sigma: np.ndarray, k: int) -> np.ndarray:
    """Smooth micro-corner heights inside the cells where `sigma` (per cell,
    in micro-cells) is positive: a Gaussian of those cells' own heights
    (normalized, so ground outside doesn't leak in), blended in by the share
    of each corner's micro-cells that are smoothed. Lawns then read as one
    slope rather than as the elevation model's noise, which exaggerated
    relief turns into gullies."""
    from scipy import ndimage

    out = q.copy()
    for s in np.unique(sigma[sigma > 0]):
        w = corner_mean(expand((sigma == s).astype(np.float64), k))
        num = ndimage.gaussian_filter(q * w, float(s), mode="nearest")
        den = ndimage.gaussian_filter(w, float(s), mode="nearest")
        smooth = np.where(den > 1e-9, num / np.maximum(den, 1e-9), q)
        out += w * (smooth - q)
    return out


def build_micro(
    corner_m: np.ndarray,
    step_m: float,
    k: int,
    base: np.ndarray,
    shape: np.ndarray,
    water: np.ndarray,
    road_mask: np.ndarray,
    road_half_width: np.ndarray | None = None,
    smooth: np.ndarray | None = None,
    path_mask: np.ndarray | None = None,
    path_half_width: np.ndarray | None = None,
    bed_margin: float = 0.0,
    shore: np.ndarray | None = None,
    bank: np.ndarray | None = None,
) -> np.ndarray:
    """Integer micro-corner heights (micro-steps) from micro-corner elevations.

    corner_m: elevation (m) at every micro-corner, shape (K·cy + 1, K·cx + 1).
    base/shape/water/road_mask: the finished cell layers, shape (cy, cx).
    smooth: optional per-cell smoothing (Gaussian sigma in micro-cells, 0 for
    none), applied before roads and water are cut in.
    path_mask/path_half_width: paths that lie on the road beds beside them
    (sidewalks and crossings; follow_beds).
    bed_margin: cells added to every road bed's radius. Roads drawn along
    their centre lines (D-082) lie up to about 0.7 cell off the centre-to-
    centre line their bed follows, so their beds widen to stay under them.
    shore: signed distance (micro-cells) to the shoreline at every micro-corner
    (shore_field), negative in water; from the water cells when None.
    bank: per cell, ground that slopes into the water (shape_shore).
    Micro-cells follow from world_format.micro_cells.
    """
    cy, cx = base.shape
    if corner_m.shape != (cy * k + 1, cx * k + 1):
        raise ValueError(f"micro corners {corner_m.shape} don't match {cy}×{cx} cells at K={k}")
    q = corner_m / (step_m / k)
    if smooth is not None and (smooth > 0).any():
        q = smooth_cells(q, smooth, k)
    if shore is None:
        shore = shore_field(base.shape, k, water != NO_WATER)
    q = shape_shore(q, shore, water, road_mask, k, bank)
    centre = cell_corner_heights(base, shape).mean(axis=0)
    beds = road_segments(road_mask, centre, road_half_width, bed_margin)
    if path_mask is not None and (path_mask & CONNECT_MASK).any():
        # every micro-cell a path's band lies on: its half-width and a micro-cell more
        hw = np.zeros(path_mask.shape) if path_half_width is None else path_half_width
        segs = [
            (*s[:6], max(hw[int(s[1]), int(s[0])], hw[int(s[4]), int(s[3])]) + 1.0 / k)
            for s in road_segments(path_mask, np.zeros(path_mask.shape))
        ]
        q = follow_beds(q, beds, segs, k)
    else:
        q = cut_road_beds(q, beds, k)
    q = shape_shore(
        q, shore, water, road_mask, k, bank
    )  # the shore wins where a road bed reaches it
    return round_half_up(q).astype(np.int16)
