"""Micro-terrain (M1.6, D-037): K×K micro-cells inside every cell.

Micro-cells use the same model as cells (a base height plus up to three steps
of corner offsets, flat terraces where steeper) on a K-times finer grid, with
heights in micro-steps of 1/K step. The cell layers stay the gameplay summary;
micro-terrain is what gets drawn and what vehicles drive on.

Constraints from the cell layers keep the two consistent:
- water cells are flat at their water level;
- roads run on a bed cut along the line between connected road-cell centres,
  following the cells' road profile, so road decals sit on smooth ground.
"""

from __future__ import annotations

import numpy as np

from .gridify import cell_corner_heights, round_half_up
from .roads import CONNECT_MASK, DIRS
from .world_format import NO_WATER

# Road beds cover micro-corners within this distance (cells) of a road's centre
# line: a bench about half a cell wide, wider than any road decal.
ROAD_BED_RADIUS = 0.3


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
    mask: np.ndarray, centre_h: np.ndarray, half_width: np.ndarray | None = None
) -> list[tuple[float, ...]]:
    """(ax, ay, ha, bx, by, hb, r) centre-to-centre segments of connected road
    cells (cells, steps); r is the bed radius: the road's half-width where
    known (D-050), at least ROAD_BED_RADIUS."""
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
                    ROAD_BED_RADIUS
                    if half_width is None
                    else max(ROAD_BED_RADIUS, float(half_width[y, x]), float(half_width[ny, nx])),
                )
            )
    return out


def cut_road_beds(
    q: np.ndarray, segments: list[tuple[float, ...]], k: int, radius: float = ROAD_BED_RADIUS
) -> np.ndarray:
    """Set micro-corners near road centre lines to the road profile (micro-steps)."""
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
    return q


def build_micro(
    corner_m: np.ndarray,
    step_m: float,
    k: int,
    base: np.ndarray,
    shape: np.ndarray,
    water: np.ndarray,
    road_mask: np.ndarray,
    road_half_width: np.ndarray | None = None,
) -> np.ndarray:
    """Integer micro-corner heights (micro-steps) from micro-corner elevations.

    corner_m: elevation (m) at every micro-corner, shape (K·cy + 1, K·cx + 1).
    base/shape/water/road_mask: the finished cell layers, shape (cy, cx).
    Micro-cells follow from world_format.micro_cells.
    """
    cy, cx = base.shape
    if corner_m.shape != (cy * k + 1, cx * k + 1):
        raise ValueError(f"micro corners {corner_m.shape} don't match {cy}×{cx} cells at K={k}")
    q = corner_m / (step_m / k)
    q = flatten_water(q, water, k)
    centre = cell_corner_heights(base, shape).mean(axis=0)
    q = cut_road_beds(q, road_segments(road_mask, centre, road_half_width), k)
    q = flatten_water(q, water, k)  # water wins where a road bed touches a shore
    return round_half_up(q).astype(np.int16)
