"""Micro-terrain (M1.6, D-037): K×K micro-cells inside every cell.

Micro-cells use the same model as cells (a base height plus up to three steps
of corner offsets, flat terraces where steeper) on a K-times finer grid, with
heights in micro-steps of 1/K step. The cell layers stay the gameplay summary;
micro-terrain is what gets drawn and what vehicles drive on.

Constraints from the cell layers keep the two consistent:
- water cells are flat at their water level;
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
    """Set the micro-corners of every water cell to its level (micro-steps)."""
    if not (water != NO_WATER).any():
        return q
    level = np.where(water != NO_WATER, water.astype(np.float64) * k, np.inf)
    at = corner_min(expand(level, k), np.inf)
    return np.where(np.isfinite(at), at, q)


def reflood(micro_corners: np.ndarray, water: np.ndarray, k: int) -> np.ndarray:
    """Finished micro-corners (int16) flattened again to the water's level, for
    cells that turned to water after micro-terrain was built (bridge decks over
    water, D-056): the road bed cut there must not show through the water.
    Idempotent where the water hasn't changed."""
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
    Micro-cells follow from world_format.micro_cells.
    """
    cy, cx = base.shape
    if corner_m.shape != (cy * k + 1, cx * k + 1):
        raise ValueError(f"micro corners {corner_m.shape} don't match {cy}×{cx} cells at K={k}")
    q = corner_m / (step_m / k)
    if smooth is not None and (smooth > 0).any():
        q = smooth_cells(q, smooth, k)
    q = flatten_water(q, water, k)
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
    q = flatten_water(q, water, k)  # water wins where a road bed touches a shore
    return round_half_up(q).astype(np.int16)
