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


def octilinear_path(
    a: tuple[int, int], b: tuple[int, int], deviation: float
) -> list[tuple[int, int]]:
    """Cells from a to b in long runs along the 8 grid directions (D-049).

    A straight or diagonal line is one run. Anything in between alternates an
    axis run and a diagonal run, in as few runs as keep the path within
    `deviation` cells of the straight line, so it reads as a few clean pixel
    lines rather than a zigzag of single steps.
    """
    dx, dy = b[0] - a[0], b[1] - a[1]
    sx, sy = (dx > 0) - (dx < 0), (dy > 0) - (dy < 0)
    n_diag = min(abs(dx), abs(dy))
    n_axis = max(abs(dx), abs(dy)) - n_diag
    axis = (sx, 0) if abs(dx) > abs(dy) else (0, sy)
    diag = (sx, sy)
    length = float(np.hypot(dx, dy))
    # a run of n_axis then n_diag strays n_axis·n_diag / length from the line;
    # split into chunks until each strays at most `deviation`
    chunks = 1
    if n_axis and n_diag:
        chunks = max(1, int(np.ceil(n_axis * n_diag / (length * max(deviation, 1e-6)))))
        chunks = min(chunks, n_axis, n_diag)
    out = [a]
    x, y = a
    for k in range(chunks):
        na = round((k + 1) * n_axis / chunks) - round(k * n_axis / chunks)
        nd = round((k + 1) * n_diag / chunks) - round(k * n_diag / chunks)
        # alternate the order so consecutive chunks join runs of one direction
        for step, n in ((axis, na), (diag, nd)) if k % 2 == 0 else ((diag, nd), (axis, na)):
            for _ in range(n):
                x, y = x + step[0], y + step[1]
                out.append((x, y))
    return out


def _douglas_peucker(pts: np.ndarray, tol: float) -> list[int]:
    """Indices of the points kept by Douglas–Peucker simplification (ends kept)."""
    keep = {0, len(pts) - 1}
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = pts[i], pts[j]
        ab = b - a
        n = float(np.hypot(*ab))
        rel = pts[i + 1 : j] - a
        if n < 1e-12:
            d = np.hypot(rel[:, 0], rel[:, 1])
        else:
            d = np.abs(ab[0] * rel[:, 1] - ab[1] * rel[:, 0]) / n
        k = int(np.argmax(d))
        if d[k] > tol:
            m = i + 1 + k
            keep.add(m)
            stack += [(i, m), (m, j)]
    return sorted(keep)


OCTI_NORMALS = [
    np.array([np.cos(np.radians(45 * k + 90)), np.sin(np.radians(45 * k + 90))]) for k in range(4)
]


@dataclass
class Straightened:
    lines: list
    origin: np.ndarray  # (n, 2) node positions before, in cells
    moved: np.ndarray  # (n, 2) node positions after
    constrained: int  # edges made octilinear
    edges: int

    def shift(self, radius: float):
        """A smooth displacement field (cells → cells) that follows the moved
        nodes within `radius` cells and fades out beyond, for objects that
        should keep their place along the roads."""
        from scipy.spatial import cKDTree

        tree = cKDTree(self.origin)
        delta = self.moved - self.origin
        sigma = radius / 2.0

        def fn(x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
            q = np.column_stack([np.ravel(x), np.ravel(y)])
            if len(self.origin) == 0 or len(q) == 0:
                return np.zeros(np.shape(x)), np.zeros(np.shape(y))
            k = min(8, len(self.origin))
            d, idx = tree.query(q, k=k, distance_upper_bound=radius)
            d = d.reshape(len(q), k)
            idx = idx.reshape(len(q), k)
            ok = np.isfinite(d)
            w = np.where(ok, np.exp(-0.5 * (np.where(ok, d, 0) / sigma) ** 2), 0.0)
            pad = np.vstack([delta, np.zeros((1, 2))])
            dd = pad[np.where(ok, idx, len(delta))]
            # near nodes take their movement; far from any node it fades to zero
            total = w.sum(axis=1) + 0.05
            sx = (w * dd[..., 0]).sum(axis=1) / total
            sy = (w * dd[..., 1]).sum(axis=1) / total
            return sx.reshape(np.shape(x)), sy.reshape(np.shape(y))

        return fn


def straighten(
    lines: list,
    angle: float = 12.0,
    simplify: float = 0.5,
    max_shift: float = 2.0,
    min_length: float = 1.0,
    shape: tuple[int, int] | None = None,
    keep: set[str] | None = None,
) -> Straightened:
    """Straighten a road network toward the 8 grid directions (D-049).

    Each road is simplified (Douglas–Peucker, `simplify` cells) between the
    vertices it shares with other roads. Every simplified edge within `angle`
    degrees of a grid direction becomes a constraint that it run exactly along
    it, and the nodes move as little as possible to satisfy all constraints at
    once, so a slightly rotated street grid becomes an aligned one rather than
    a set of streets with jogs. Junctions stay shared. A node pushed further
    than `max_shift` cells frees its edges' constraints and the solve repeats.
    With the grid `shape` (cy, cx), no node is pushed across a world edge it
    started inside (roads often run along the edge of a warped world).

    Ways whose ids are in `keep` keep their real geometry (a crooked street's
    hairpins): every vertex stays and none of their edges is constrained, so
    only the junctions they share with straightened roads move.
    """
    keep = keep or set()
    from scipy.sparse import coo_matrix, identity
    from scipy.sparse.linalg import spsolve

    def key(x: float, y: float) -> tuple[int, int]:
        return (round(x * 1e5), round(y * 1e5))

    uses: dict[tuple[int, int], int] = defaultdict(int)
    for _, _, parts in lines:
        for xs, ys in parts:
            ks = [key(x, y) for x, y in zip(xs, ys, strict=True)]
            for k in set(ks):
                uses[k] += 1
            uses[ks[0]] += 1
            uses[ks[-1]] += 1
    index: dict[tuple[int, int], int] = {}
    origin: list[tuple[float, float]] = []

    def node(x: float, y: float) -> int:
        k = key(x, y)
        if k not in index:
            index[k] = len(origin)
            origin.append((float(x), float(y)))
        return index[k]

    chains: list[tuple[str, int, list[list[int]]]] = []
    for seg_id, rank, parts in lines:
        out_parts = []
        for xs, ys in parts:
            pts = np.column_stack([xs, ys]).astype(np.float64)
            ks = [key(x, y) for x, y in pts]
            if seg_id in keep:
                chain = list(range(len(pts)))
            else:
                anchors = [i for i, k in enumerate(ks) if uses[k] >= 2]
                chain = [anchors[0]]
                for i, j in zip(anchors, anchors[1:], strict=False):
                    chain += [i + m for m in _douglas_peucker(pts[i : j + 1], simplify)[1:]]
            ids = [node(*pts[i]) for i in chain]
            ids = [n for k, n in enumerate(ids) if k == 0 or n != ids[k - 1]]
            out_parts.append(ids)
        chains.append((seg_id, rank, out_parts))

    p0 = np.asarray(origin, dtype=np.float64).reshape(-1, 2)
    n = len(p0)

    def edges_of(chain_list) -> set[tuple[int, int]]:
        return {
            (min(a, b), max(a, b))
            for _, _, ps in chain_list
            for c in ps
            for a, b in zip(c, c[1:], strict=False)
        }

    edge_set = sorted(edges_of(chains))
    kept = edges_of(c for c in chains if c[0] in keep)
    cand = []
    for a, b in edge_set:
        if (a, b) in kept:
            continue
        v = p0[b] - p0[a]
        length = float(np.hypot(*v))
        if length < min_length:
            continue
        theta = np.degrees(np.arctan2(v[1], v[0])) % 180.0
        k = int(round(theta / 45.0)) % 4
        dev = abs((theta - 45.0 * k + 90.0) % 180.0 - 90.0)
        if dev <= angle:
            cand.append((a, b, k))
    active = np.ones(len(cand), dtype=bool)
    p = p0.copy()
    alpha = 1e-6
    for _ in range(8):
        rows, cols, vals = [], [], []
        for r, (a, b, k) in enumerate(c for c, on in zip(cand, active, strict=True) if on):
            nx, ny = OCTI_NORMALS[k]
            rows += [r, r, r, r]
            cols += [2 * b, 2 * b + 1, 2 * a, 2 * a + 1]
            vals += [nx, ny, -nx, -ny]
        m = int(active.sum())
        if m == 0:
            p = p0.copy()
            break
        C = coo_matrix((vals, (rows, cols)), shape=(m, 2 * n)).tocsr()
        A = (C.T @ C + alpha * identity(2 * n)).tocsc()
        x = spsolve(A, alpha * p0.ravel())
        p = np.asarray(x).reshape(n, 2)
        far = np.hypot(*(p - p0).T) > max_shift
        if not far.any():
            break
        bad = np.array([far[a] or far[b] for a, b, _ in cand]) & active
        active &= ~bad
    if shape is not None:
        hi = np.array([shape[1], shape[0]], dtype=np.float64) - 1e-6
        inside = (p0 >= 0) & (p0 <= hi)
        p = np.where(inside, np.clip(p, 0.0, hi), p)
    new_lines = [
        (seg_id, rank, [(p[c, 0].copy(), p[c, 1].copy()) for c in ps if len(c) >= 1])
        for seg_id, rank, ps in chains
    ]
    return Straightened(new_lines, p0, p, int(active.sum()), len(edge_set))


def along_edge(path: list[tuple[int, int]], shape: tuple[int, int]) -> list[tuple[int, int]]:
    """A cell path whose brief excursions outside the grid run along its edge.

    A line that hugs the world's edge can stray less than a cell outside it
    between two inside cells (a vertex mapped just past the edge). Steps
    through outside cells aren't drawn, so the road would end on both sides of
    the excursion and come apart inside the grid. A run of outside cells that
    starts and ends inside and stays within one cell of the edge moves onto the
    edge cells instead. Paths that leave the grid, or stray further, keep their
    outside cells (and stay undrawn there).
    """
    cy, cx = shape

    def inside(c: tuple[int, int]) -> bool:
        return 0 <= c[0] < cx and 0 <= c[1] < cy

    def near(c: tuple[int, int]) -> bool:
        return -1 <= c[0] <= cx and -1 <= c[1] <= cy

    out: list[tuple[int, int]] = []
    i, n = 0, len(path)
    while i < n:
        if inside(path[i]):
            out.append(path[i])
            i += 1
            continue
        j = i
        while j < n and not inside(path[j]):
            j += 1
        run = path[i:j]
        if i > 0 and j < n and all(near(c) for c in run):
            # clamping moves each step by at most one cell per axis, so the
            # path stays 8-connected; repeated cells are dropped
            for x, y in run:
                c = (min(max(x, 0), cx - 1), min(max(y, 0), cy - 1))
                if c != out[-1]:
                    out.append(c)
            if path[j] == out[-1]:
                out.pop()
        else:
            out.extend(run)
        i = j
    return out


def cell_path(xs: np.ndarray, ys: np.ndarray, deviation: float | None) -> list[tuple[int, int]]:
    """The cells a polyline (cell coordinates) is drawn through: long
    octilinear runs between its vertices' cells with `deviation`
    (octilinear_path), else traced cell by cell (trace_cells)."""
    if deviation is None:
        return trace_cells(xs, ys)
    verts = [(int(np.floor(x)), int(np.floor(y))) for x, y in zip(xs, ys, strict=True)]
    path = verts[:1]
    for va, vb in zip(verts, verts[1:], strict=False):
        if va != vb:
            path += octilinear_path(va, vb, deviation)[1:]
    return path


# What a rail cell draws (RAIL layer bits 12-15, M3.5): a street's pair of
# tracks, the same with cable-car slots, a train's track on its ballast.
RAIL_KINDS = {"street": 1, "cable": 2, "train": 3}
RAIL_KIND_SHIFT = 12


def onto_roads(path: list[tuple[int, int]], on_road: np.ndarray) -> list[tuple[int, int]]:
    """A cell path moved onto the road cells it runs beside: each cell that
    isn't a road moves to a road cell among its 8 neighbours (if any): the
    same way as the cell before it where it can, so a track between two
    carriageways keeps to one of them, else the nearest. Repeats are dropped,
    the gaps left are bridged in king steps and staircase corners cut."""
    h, w = on_road.shape

    def road(c: tuple[int, int]) -> bool:
        return 0 <= c[0] < w and 0 <= c[1] < h and bool(on_road[c[1], c[0]])

    moved: list[tuple[int, int]] = []
    last = (0, 0)
    for c in path:
        if road(c):
            last = (0, 0)
        else:
            keep = (c[0] + last[0], c[1] + last[1])
            if last != (0, 0) and road(keep):
                to = keep
            else:
                near = [
                    (dx * dx + dy * dy, (c[0] + dx, c[1] + dy))
                    for dy in (-1, 0, 1)
                    for dx in (-1, 0, 1)
                    if (dx or dy) and road((c[0] + dx, c[1] + dy))
                ]
                to = min(near)[1] if near else c
            last = (to[0] - c[0], to[1] - c[1])
            c = to
        if not moved or moved[-1] != c:
            moved.append(c)
    out: list[tuple[int, int]] = []
    for i, b in enumerate(moved):
        a = moved[i - 1] if i else b
        far = max(abs(b[0] - a[0]), abs(b[1] - a[1])) > 1
        for c in octilinear_path(a, b, 1.0)[1:] if far else [b]:
            # cut staircase corners: A→B→C where A and C are diagonal neighbours
            if len(out) >= 2 and abs(out[-2][0] - c[0]) == 1 and abs(out[-2][1] - c[1]) == 1:
                out.pop()
            out.append(c)
    return out


def rail_layer(
    lines: list[tuple[str, int, list[tuple[np.ndarray, np.ndarray]]]],
    shape: tuple[int, int],
    deviation: float | None = None,
    on_road: np.ndarray | None = None,
) -> np.ndarray:
    """Rails per cell (u16, M3.5): connections to neighbours in bits 0-7, as
    for roads, and what is drawn there (RAIL_KINDS) in bits 12-15, the highest
    kind where lines of several kinds meet.

    lines: (id, kind, parts in cells). With `on_road`, street and cable-car
    tracks run along the roads they're in (onto_roads), on their drawn centre
    lines (a street's two tracks often merge into one there); trains keep
    their own cells."""
    cy, cx = shape
    out = np.zeros(shape, dtype=np.uint16)

    def inside(c: tuple[int, int]) -> bool:
        return 0 <= c[0] < cx and 0 <= c[1] < cy

    for _seg_id, kind, parts in lines:
        for xs, ys in parts:
            path = along_edge(cell_path(xs, ys, deviation), shape)
            if on_road is not None and kind != RAIL_KINDS["train"]:
                path = onto_roads(path, on_road)
            for c in path:
                if inside(c):
                    old = int(out[c[1], c[0]]) >> RAIL_KIND_SHIFT
                    out[c[1], c[0]] = (out[c[1], c[0]] & CONNECT_MASK) | (
                        max(old, kind) << RAIL_KIND_SHIFT
                    )
            for a, b in zip(path, path[1:], strict=False):
                dx, dy = b[0] - a[0], b[1] - a[1]
                if max(abs(dx), abs(dy)) != 1 or not (inside(a) and inside(b)):
                    continue
                out[a[1], a[0]] |= 1 << DIR_INDEX[(dx, dy)]
                out[b[1], b[0]] |= 1 << DIR_INDEX[(-dx, -dy)]
    return drop_rungs(out)


def drop_rungs(rail: np.ndarray) -> np.ndarray:
    """Rail connections without the rungs between parallel tracks: a link
    between two cells that both run at right angles to it (where tracks in
    neighbouring cells step across to each other) would draw a rail straight
    across the street. Crossings and corners keep their links: a track carries
    on through one of their two cells along the link, or one of them doesn't
    run across it."""
    out = rail.copy()
    h, w = rail.shape
    ys, xs = np.nonzero(rail & CONNECT_MASK)
    for y, x in zip(ys.tolist(), xs.tolist(), strict=True):
        m = int(rail[y, x])
        for i in range(4):  # N, NE, E, SE: each link once, from its west / north end
            if not (m >> i) & 1:
                continue
            dx, dy = DIRS[i]
            nx, ny = x + dx, y + dy
            if not (0 <= nx < w and 0 <= ny < h):
                continue
            across = (1 << ((i + 2) % 8)) | (1 << ((i + 6) % 8))
            n = int(rail[ny, nx])
            # a track that carries on through either end is a crossing, not a rung
            through = (m >> ((i + 4) % 8)) & 1 or (n >> i) & 1
            if m & across and n & across and not through:
                out[y, x] &= ~np.uint16(1 << i)
                out[ny, nx] &= ~np.uint16(1 << ((i + 4) % 8))
    return out


@dataclass
class RoadLayer:
    mask: np.ndarray  # uint16 (cy, cx)
    cls: np.ndarray  # uint8 (cy, cx)
    # widest way through each cell, metres (0 where none or widths weren't given)
    width: np.ndarray | None = None
    # segment id → cells (inside the grid), for validation
    segment_cells: dict[str, list[tuple[int, int]]] = field(default_factory=dict)


def rasterize(
    lines: list[tuple[str, int, list[tuple[np.ndarray, np.ndarray]]]],
    shape: tuple[int, int],
    deviation: float | None = None,
    widths: dict[str, float] | None = None,
    rank_of=None,
) -> RoadLayer:
    """lines: (id, class rank ≥ 1, parts as (xs, ys) in cell coords).

    With `deviation`, each polyline edge becomes long octilinear runs
    (octilinear_path) between the cells of its vertices; otherwise the line is
    traced cell by cell (trace_cells). A line straying just past the grid's edge
    and back runs along the edge (along_edge). `widths` (segment id → metres) records the
    widest way in each cell. The class number written to a cell is the line's
    class; with `rank_of` (class → priority) the higher-priority class wins,
    else the larger number does."""
    cy, cx = shape
    mask = np.zeros(shape, dtype=np.uint16)
    cls = np.zeros(shape, dtype=np.uint8)
    width = np.zeros(shape, dtype=np.float32) if widths is not None else None
    layer = RoadLayer(mask, cls, width=width)
    rank = rank_of or (lambda c: c)

    def inside(c: tuple[int, int]) -> bool:
        return 0 <= c[0] < cx and 0 <= c[1] < cy

    def mark(c: tuple[int, int], bit: int, klass: int, w: float = 0.0) -> None:
        if inside(c):
            mask[c[1], c[0]] |= 1 << bit
            old = int(cls[c[1], c[0]])
            if old == 0 or rank(klass) > rank(old):
                cls[c[1], c[0]] = klass
            if width is not None and w > width[c[1], c[0]]:
                width[c[1], c[0]] = w

    for seg_id, klass, parts in lines:
        w = float(widths.get(seg_id, 0.0)) if widths is not None else 0.0
        visited: list[tuple[int, int]] = []
        for xs, ys in parts:
            path = along_edge(cell_path(xs, ys, deviation), shape)
            for a, b in zip(path, path[1:], strict=False):
                dx, dy = b[0] - a[0], b[1] - a[1]
                if max(abs(dx), abs(dy)) != 1 or not (inside(a) and inside(b)):
                    continue
                mark(a, DIR_INDEX[(dx, dy)], klass, w)
                mark(b, DIR_INDEX[(-dx, -dy)], klass, w)
                if dx and dy:  # diagonal: flag the corner for the two other cells
                    px, py = a[0] + (dx > 0), a[1] + (dy > 0)
                    for o in ((a[0] + dx, a[1]), (a[0], a[1] + dy)):
                        mark(o, CROSSING_SHIFT + CORNER_INDEX[(px - o[0], py - o[1])], klass, w)
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
    relaxes until every pair of neighbouring road cells (connected or not)
    differs by at most one step.
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
    # Every pair of neighbouring road cells stays within one step, connected or
    # not: parallel carriageways and crossings share corners, and a bigger gap
    # there would split a road cell into terraces.
    near = [on & _neighbor(on, dx, dy, False) for dx, dy in DIRS]
    for _ in range(4 * max(mask.shape)):
        lo_bound = np.full_like(hi, np.iinfo(np.int64).min)
        hi_bound = np.full_like(hi, np.iinfo(np.int64).max)
        for i, (dx, dy) in enumerate(DIRS):
            nb = _neighbor(hi, dx, dy, 0)
            lo_bound = np.where(near[i], np.maximum(lo_bound, nb - 1), lo_bound)
            hi_bound = np.where(near[i], np.minimum(hi_bound, nb + 1), hi_bound)
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
            # more than 1.5 steps per cell travelled (diagonal neighbours are √2 apart)
            if abs(ma - mb) > 1.5 * (1.4142135623730951 if dx and dy else 1.0):
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


def junction_index(segments: list[dict], inside=None) -> dict[str, list[str]]:
    """connector id → segment ids, for connectors shared by 2+ segments.

    inside(segment id, at) → bool, if given, keeps only connectors that lie in
    the grid (`at` is the connector's position along the segment, 0..1): roads
    that meet beyond the world's edge can't be checked inside it.
    """
    by_connector: dict[str, list[str]] = defaultdict(list)
    for seg in segments:
        for conn in seg.get("connectors") or []:
            if inside is not None and not inside(seg["id"], float(conn.get("at") or 0.0)):
                continue
            by_connector[conn["connector_id"]].append(seg["id"])
    return {k: sorted(v) for k, v in by_connector.items() if len(v) > 1}


def point_at(xs: np.ndarray, ys: np.ndarray, at: float) -> tuple[float, float]:
    """The point a fraction `at` of the way along a polyline (by length)."""
    d = np.hypot(np.diff(xs), np.diff(ys))
    total = float(d.sum())
    if total <= 0:
        return float(xs[0]), float(ys[0])
    target = min(max(at, 0.0), 1.0) * total
    cum = np.concatenate([[0.0], np.cumsum(d)])
    i = int(np.clip(np.searchsorted(cum, target, side="right") - 1, 0, len(d) - 1))
    t = (target - cum[i]) / d[i] if d[i] > 0 else 0.0
    return float(xs[i] + (xs[i + 1] - xs[i]) * t), float(ys[i] + (ys[i + 1] - ys[i]) * t)
