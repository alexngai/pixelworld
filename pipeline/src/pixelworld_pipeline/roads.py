"""Road networks on the cell grid: 8-direction snapping and cut-and-fill.

Layer encoding (u16 per cell, mirrors packages/grid ROAD_DIRS):
  bits 0-7   the road continues to the neighbour in DIRS[i]
  bits 8-11  a diagonal road between two other cells passes through corner i

Heights: roads get a smoothed, grade-limited profile (|Δh| ≤ 1 step between
connected cells), written into the shared corner-height field. Because road
cells take all their corners from that field, connected road cells always
meet without a cliff, whatever the terrain does next to them.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np

DIRS = ((0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1))
DIR_INDEX = {d: i for i, d in enumerate(DIRS)}
CROSSING_SHIFT = 8
CONNECT_MASK = 0xFF
# corner index from (corner x − cell x, corner y − cell y)
CORNER_INDEX = {(0, 0): 0, (1, 0): 1, (1, 1): 2, (0, 1): 3}


def trace_cells(xs: np.ndarray, ys: np.ndarray, step: float = 0.1) -> list[tuple[int, int]]:
    """Cells visited by a polyline in continuous cell coordinates, as a thin
    8-connected path (staircase corners replaced by diagonal moves)."""
    cells: list[tuple[int, int]] = []
    for i in range(len(xs) - 1):
        x0, y0, x1, y1 = xs[i], ys[i], xs[i + 1], ys[i + 1]
        n = max(1, int(np.ceil(np.hypot(x1 - x0, y1 - y0) / step)))
        t = np.arange(n + 1) / n
        for cx, cy in zip(
            np.floor(x0 + (x1 - x0) * t).astype(int),
            np.floor(y0 + (y1 - y0) * t).astype(int),
            strict=True,
        ):
            c = (int(cx), int(cy))
            if not cells or cells[-1] != c:
                cells.append(c)
    # remove staircase corners: A→B→C where A and C are diagonal neighbours
    thin: list[tuple[int, int]] = []
    for c in cells:
        if len(thin) >= 2:
            a = thin[-2]
            if abs(a[0] - c[0]) == 1 and abs(a[1] - c[1]) == 1:
                thin.pop()
        thin.append(c)
    return thin


@dataclass
class RoadLayer:
    mask: np.ndarray  # uint16 (cy, cx)
    cls: np.ndarray  # uint8 (cy, cx)
    # segment id → cells (inside the grid), for validation
    segment_cells: dict[str, list[tuple[int, int]]] = field(default_factory=dict)


def rasterize(
    lines: list[tuple[str, int, list[tuple[np.ndarray, np.ndarray]]]],
    shape: tuple[int, int],
) -> RoadLayer:
    """lines: (id, class rank ≥ 1, parts as (xs, ys) in cell coords)."""
    cy, cx = shape
    mask = np.zeros(shape, dtype=np.uint16)
    cls = np.zeros(shape, dtype=np.uint8)
    layer = RoadLayer(mask, cls)

    def inside(c: tuple[int, int]) -> bool:
        return 0 <= c[0] < cx and 0 <= c[1] < cy

    def mark(c: tuple[int, int], bit: int, rank: int) -> None:
        if inside(c):
            mask[c[1], c[0]] |= 1 << bit
            cls[c[1], c[0]] = max(int(cls[c[1], c[0]]), rank)

    for seg_id, rank, parts in lines:
        visited: list[tuple[int, int]] = []
        for xs, ys in parts:
            path = trace_cells(xs, ys)
            for a, b in zip(path, path[1:], strict=False):
                dx, dy = b[0] - a[0], b[1] - a[1]
                if max(abs(dx), abs(dy)) != 1 or not (inside(a) and inside(b)):
                    continue
                mark(a, DIR_INDEX[(dx, dy)], rank)
                mark(b, DIR_INDEX[(-dx, -dy)], rank)
                if dx and dy:  # diagonal: flag the corner for the two other cells
                    px, py = a[0] + (dx > 0), a[1] + (dy > 0)
                    for o in ((a[0] + dx, a[1]), (a[0], a[1] + dy)):
                        mark(o, CROSSING_SHIFT + CORNER_INDEX[(px - o[0], py - o[1])], rank)
            visited.extend(c for c in path if inside(c))
        layer.segment_cells[seg_id] = visited
    return layer


def _neighbor(a: np.ndarray, dx: int, dy: int, fill) -> np.ndarray:
    """Value of the neighbour at (x+dx, y+dy) for every cell (fill outside)."""
    out = np.full_like(a, fill)
    h, w = a.shape
    ys = slice(max(0, -dy), h - max(0, dy))
    xs = slice(max(0, -dx), w - max(0, dx))
    yn = slice(max(0, dy), h - max(0, -dy))
    xn = slice(max(0, dx), w - max(0, -dx))
    out[ys, xs] = a[yn, xn]
    return out


def road_heights(mask: np.ndarray, corners: np.ndarray, smooth_iterations: int = 8) -> np.ndarray:
    """Integer road height per cell (−32768 where there's no road).

    Starts from the cell's mean corner height, smooths along the network, then
    relaxes until every connected pair differs by at most one step.
    """
    on = (mask & CONNECT_MASK) != 0
    c = corners.astype(np.float64)
    h = (c[:-1, :-1] + c[:-1, 1:] + c[1:, 1:] + c[1:, :-1]) / 4
    conn = [((mask >> i) & 1).astype(bool) for i in range(8)]
    for _ in range(smooth_iterations):
        total = np.zeros_like(h)
        count = np.zeros_like(h)
        for i, (dx, dy) in enumerate(DIRS):
            nb = _neighbor(h, dx, dy, 0.0)
            total += np.where(conn[i], nb, 0)
            count += conn[i]
        h = np.where(count > 0, 0.5 * h + 0.5 * total / np.maximum(count, 1), h)
    hi = np.floor(h + 0.5).astype(np.int64)
    for _ in range(4 * max(mask.shape)):
        lo_bound = np.full_like(hi, np.iinfo(np.int64).min)
        hi_bound = np.full_like(hi, np.iinfo(np.int64).max)
        for i, (dx, dy) in enumerate(DIRS):
            nb = _neighbor(hi, dx, dy, 0)
            lo_bound = np.where(conn[i], np.maximum(lo_bound, nb - 1), lo_bound)
            hi_bound = np.where(conn[i], np.minimum(hi_bound, nb + 1), hi_bound)
        too_high = hi > hi_bound
        too_low = hi < lo_bound
        if not (too_high.any() or too_low.any()):
            break
        # move one step toward the allowed band; conflicting cells meet in the middle
        hi = np.where(too_high & ~too_low, hi - 1, hi)
        hi = np.where(too_low & ~too_high, hi + 1, hi)
        both = too_high & too_low
        hi = np.where(both, (lo_bound + hi_bound) // 2, hi)
    return np.where(on, hi, -32768)


def apply_to_corners(corners: np.ndarray, mask: np.ndarray, heights: np.ndarray) -> np.ndarray:
    """Set every corner touched by a road cell to the mean height of its road cells."""
    on = (mask & CONNECT_MASK) != 0
    hv = np.where(on, heights, 0).astype(np.float64)
    total = np.zeros(corners.shape, dtype=np.float64)
    count = np.zeros(corners.shape, dtype=np.float64)
    for oy in (0, 1):
        for ox in (0, 1):
            ys = slice(oy, oy + on.shape[0])
            xs = slice(ox, ox + on.shape[1])
            total[ys, xs] += hv
            count[ys, xs] += on
    out = corners.copy()
    touched = count > 0
    out[touched] = np.floor(total[touched] / count[touched] + 0.5)
    return out


@dataclass
class RoadReport:
    cells: int
    edges: int
    discontinuous_edges: int
    steep_edges: int
    components: int
    split_segments: int
    disconnected_junctions: int

    def ok(self) -> bool:
        return (
            self.discontinuous_edges == 0
            and self.split_segments == 0
            and self.disconnected_junctions == 0
        )


def validate(
    layer: RoadLayer,
    cell_corners: np.ndarray,
    junctions: dict[str, list[str]],
) -> RoadReport:
    """Check snapped roads are connected and drivable on the final terrain.

    cell_corners: (4, cy, cx) final corner heights. junctions: connector id →
    ids of the segments that meet there (only connectors inside the grid).
    """
    mask = layer.mask
    cy, cx = mask.shape
    parent: dict[tuple[int, int], tuple[int, int]] = {}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    ys, xs = np.nonzero(mask & CONNECT_MASK)
    for x, y in zip(xs.tolist(), ys.tolist(), strict=True):
        parent[(x, y)] = (x, y)
    edges = discontinuous = steep = 0
    # shared corners for each direction: (this cell's corners, neighbour's corners)
    shared = {
        0: ((0, 1), (3, 2)),
        2: ((1, 2), (0, 3)),
        4: ((2, 3), (1, 0)),
        6: ((3, 0), (2, 1)),
        1: ((1,), (3,)),
        3: ((2,), (0,)),
        5: ((3,), (1,)),
        7: ((0,), (2,)),
    }
    for x, y in zip(xs.tolist(), ys.tolist(), strict=True):
        m = int(mask[y, x])
        for i in range(4):  # E, SE, S, SW: each undirected edge once
            d = (1, 2, 3, 4)[i]
            if not (m >> d) & 1:
                continue
            dx, dy = DIRS[d]
            nx, ny = x + dx, y + dy
            if not (0 <= nx < cx and 0 <= ny < cy) or (nx, ny) not in parent:
                continue
            edges += 1
            parent[find((x, y))] = find((nx, ny))
            mine, theirs = shared[d]
            a = [int(cell_corners[k, y, x]) for k in mine]
            b = [int(cell_corners[k, ny, nx]) for k in theirs]
            if a != b:
                discontinuous += 1
            ma = float(cell_corners[:, y, x].mean())
            mb = float(cell_corners[:, ny, nx].mean())
            if abs(ma - mb) > 1.5:
                steep += 1
    components = len({find(k) for k in parent})

    def comp(cells):
        return {find(c) for c in cells if c in parent}

    split = sum(1 for cells in layer.segment_cells.values() if len(comp(cells)) > 1)
    disconnected = 0
    for seg_ids in junctions.values():
        roots = set()
        for s in seg_ids:
            roots |= comp(layer.segment_cells.get(s, []))
        if len(roots) > 1:
            disconnected += 1
    return RoadReport(
        cells=len(parent),
        edges=edges,
        discontinuous_edges=discontinuous,
        steep_edges=steep,
        components=components,
        split_segments=split,
        disconnected_junctions=disconnected,
    )


def junction_index(segments: list[dict]) -> dict[str, list[str]]:
    """connector id → segment ids, for connectors shared by 2+ segments."""
    by_connector: dict[str, list[str]] = defaultdict(list)
    for seg in segments:
        for conn in seg.get("connectors") or []:
            by_connector[conn["connector_id"]].append(seg["id"])
    return {k: sorted(v) for k, v in by_connector.items() if len(v) > 1}
