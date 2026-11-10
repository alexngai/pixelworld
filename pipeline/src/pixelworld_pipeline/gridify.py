"""Turn continuous corner heights into the RCT-style cell model.

Cell model (see packages/grid/src/terrain.ts): base height in steps plus a
4-bit mask of corners raised one step. Corners: c0=(x,y) NW, c1=(x+1,y) NE,
c2=(x+1,y+1) SE, c3=(x,y+1) SW, with y growing south.
"""

from __future__ import annotations

import math

import numpy as np

from .world_format import MAX_CORNER_OFFSET, pack_shape, unpack_shape

# Height of one step in cell units at true proportions (packages/grid STEP_WORLD).
STEP_WORLD = 1 / math.sqrt(6)


def meters_per_step(meters_per_cell: float, vertical_exaggeration: float) -> float:
    """Vertical resolution for a given exaggeration.

    At exaggeration 1 a step is as tall, relative to a cell's width, as the real
    terrain (meters_per_cell * STEP_WORLD). Exaggeration E divides that, so
    every height difference spans E times as many steps.
    """
    if vertical_exaggeration <= 0:
        raise ValueError("vertical exaggeration must be positive")
    return meters_per_cell * STEP_WORLD / vertical_exaggeration


def vertical_exaggeration(meters_per_cell: float, meters_per_step: float) -> float:
    """Inverse of meters_per_step."""
    return meters_per_cell * STEP_WORLD / meters_per_step


def round_half_up(a: np.ndarray) -> np.ndarray:
    """Deterministic rounding (half-up), easy to reproduce in other languages."""
    return np.floor(np.asarray(a, dtype=np.float64) + 0.5).astype(np.int32)


def corner_stack(corner_heights: np.ndarray) -> np.ndarray:
    """(H+1, W+1) corner grid -> (4, H, W) per-cell corners in c0..c3 order."""
    c = corner_heights
    return np.stack([c[:-1, :-1], c[:-1, 1:], c[1:, 1:], c[1:, :-1]])


def smooth(a: np.ndarray, sigma: float) -> np.ndarray:
    """Separable Gaussian blur with edge padding (no scipy dependency)."""
    if sigma <= 0:
        return np.asarray(a, dtype=np.float64)
    r = max(1, int(np.ceil(3 * sigma)))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    out = np.asarray(a, dtype=np.float64)
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[axis] = (r, r)
        padded = np.pad(out, pad, mode="edge")
        out = np.apply_along_axis(lambda v: np.convolve(v, k, mode="valid"), axis, padded)
    return out


def bilateral(a: np.ndarray, sigma_space: float, sigma_range: float, radius: int = 2) -> np.ndarray:
    """Edge-preserving smoothing: flattens gentle benches, keeps cliffs sharp.

    Neighbours contribute by distance (sigma_space, cells) and by height
    difference (sigma_range, same units as `a`), so large steps don't blur.
    """
    a = np.asarray(a, dtype=np.float64)
    padded = np.pad(a, radius, mode="edge")
    num = np.zeros_like(a)
    den = np.zeros_like(a)
    h, w = a.shape
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            nb = padded[radius + dy : radius + dy + h, radius + dx : radius + dx + w]
            wt = np.exp(-(dx * dx + dy * dy) / (2 * sigma_space**2)) * np.exp(
                -((nb - a) ** 2) / (2 * sigma_range**2)
            )
            num += wt * nb
            den += wt
    return num / den


def gridify_heights(
    corner_steps: np.ndarray, steep: str = "flat", max_offset: int = 1
) -> tuple[np.ndarray, np.ndarray]:
    """Quantize continuous corner heights (in steps) to (base, shape) per cell.

    Cells whose rounded corners span at most `max_offset` steps become slope
    tiles that share corner heights with their neighbours, so slopes are
    continuous. Steeper cells can't match all neighbours; mismatches render as
    cliffs. For those, `steep` chooses:

      "flat":  flat at the rounded mean height (stepped terraces), or
      "slope": a slope of at most `max_offset` steps clamped around the mean.

    Returns (base int16 = lowest corner, shape uint8 = packed corner offsets).
    """
    if not 1 <= max_offset <= MAX_CORNER_OFFSET:
        raise ValueError(f"max_offset must be 1..{MAX_CORNER_OFFSET}")
    q = round_half_up(corner_steps)
    cs = corner_stack(q)  # (4, H, W)
    lo = cs.min(axis=0)
    hi = cs.max(axis=0)
    representable = (hi - lo) <= max_offset
    offsets = cs - lo

    mean_f = corner_stack(corner_steps).mean(axis=0)
    if steep == "flat":
        steep_base = round_half_up(mean_f)
        steep_offsets = np.zeros_like(offsets)
    elif steep == "slope":
        clamp_base = round_half_up(mean_f - max_offset / 2)
        steep_offsets = np.clip(cs - clamp_base, 0, max_offset)
        rise = steep_offsets.min(axis=0)  # renormalize so the lowest corner is 0
        steep_offsets = steep_offsets - rise
        steep_base = clamp_base + rise
    else:
        raise ValueError(f"unknown steep mode {steep!r}")
    base = np.where(representable, lo, steep_base)
    offsets = np.where(representable, offsets, steep_offsets)
    return base.astype(np.int16), pack_shape(offsets)


def cell_corner_heights(base: np.ndarray, shape: np.ndarray) -> np.ndarray:
    """(H, W) base/shape -> (4, H, W) integer corner heights."""
    return base.astype(np.int32) + unpack_shape(shape).astype(np.int32)


def cliff_mask(base: np.ndarray, shape: np.ndarray, min_drop: int = 2) -> np.ndarray:
    """Cells with at least one edge dropping by >= min_drop steps to a neighbour."""
    c = cell_corner_heights(base, shape)
    h, w = base.shape
    out = np.zeros((h, w), dtype=bool)
    # edges: (corner pair in this cell, neighbour offset, neighbour corner pair)
    edges = [
        ((0, 1), (0, -1), (3, 2)),
        ((1, 2), (1, 0), (0, 3)),
        ((2, 3), (0, 1), (1, 0)),
        ((3, 0), (-1, 0), (2, 1)),
    ]
    for (a, b), (dx, dy), (na, nb) in edges:
        mine = np.minimum(c[a], c[b])
        nbr = np.full((h, w), np.iinfo(np.int32).max, dtype=np.int64)
        ys = slice(max(0, dy), h + min(0, dy))
        xs = slice(max(0, dx), w + min(0, dx))
        yd = slice(max(0, -dy), h + min(0, -dy))
        xd = slice(max(0, -dx), w + min(0, -dx))
        nbr[yd, xd] = np.maximum(c[na][ys, xs], c[nb][ys, xs])
        out |= (mine - nbr) >= min_drop
    return out
