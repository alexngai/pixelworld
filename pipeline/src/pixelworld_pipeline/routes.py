"""Routes for ambient traffic (D-060): polylines in cell coordinates that
vehicles follow, written as `routes.json.gz` next to a built package.

Routes are made from the package itself, so a package can get fresh routes
without rebuilding its chunks (`pixelworld routes <region.yaml>`):

- **Roads** are traced from the drawn road layer (the chunks' ROAD bits), so
  vehicles follow the drawn roads exactly: every polyline runs through cell
  centres along the drawn connections, and a polyline ends at a junction
  (a cell with other than two connections) or a dead end.
- **Bridge decks:** over water the deck carries the road and the road layer
  stops at the water (D-056). Each bridge landmark's deck gets a route along
  its line, at the deck's height, joining the road cells at its two ends; a
  road along a deck over land takes the deck's height too.
- **Rail** comes from the features source (Overture's: sources/transit.py). Street-running lines
  (cable cars, streetcars, light rail on the street) are matched onto the
  drawn road graph; other lines (trains) are laid in octilinear runs like
  roads, but not drawn.
- **Ferries** are Overture water segments, simplified, at the water's level.

Every polyline vertex carries a height in steps: the drawn surface (micro-
terrain where the package has it), or a bridge deck's. Vertices are dropped
where the rest interpolate within a small tolerance.
"""

from __future__ import annotations

import gzip
import hashlib
import heapq
import json
import math
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import shapely

from . import roads as road_stage
from .world_format import (
    GEO_FILE,
    MICRO_MAX_OFFSET,
    NO_WATER,
    PIECES,
    decode_chunk,
    decode_geo,
    decode_objects,
    package_hash,
    unpack_shape,
)

ROUTES_FILE = "routes.json.gz"
ROUTES_VERSION = 1
DIRS = road_stage.DIRS

# Overture rail class → vehicle kind; classes not listed get no routes
# (subways run underground; "unknown" is mostly yards and spurs).
RAIL_KINDS = {
    "tram": "streetcar",
    "light_rail": "lightrail",
    "standard_gauge": "train",
    "narrow_gauge": "train",
}
# kinds that run in the street: matched onto the drawn roads
STREET_KINDS = {"cablecar", "streetcar", "lightrail"}
SKIP_FLAGS = {"is_tunnel", "is_disused", "is_abandoned"}


# ---- the package -------------------------------------------------------------


@dataclass
class Package:
    """The layers of a built package that routes are made from, as whole-world
    arrays indexed [y, x]."""

    manifest: dict[str, Any]
    road: np.ndarray  # uint16 connectivity (ROAD)
    road_class: np.ndarray  # uint8 (RCLS)
    road_width: np.ndarray  # uint8 half-width, 1/32 cell (RWID)
    water: np.ndarray  # int16 water level, NO_WATER = none
    corners: np.ndarray  # (4, H, W) int corner heights
    micro: np.ndarray | None  # (K·H + 1, K·W + 1) micro-corner heights
    k: int
    instances: list[dict]
    # centre-line pieces of the roads (D-082), (H, W, PIECES) uint32, or None
    road_pieces: np.ndarray | None = None

    def on_road_line(self, cells: list[tuple[int, int]]) -> np.ndarray:
        """Points along a chain of road cells: each cell's centre, moved onto the
        nearest of the cell's centre-line pieces where it has them (D-082), so
        vehicles keep to the drawn road on angled streets. The chain's ends stay
        at their cells' centres, where routes meet."""
        xy = np.array(cells, np.float64) + 0.5
        if self.road_pieces is None:
            return xy
        for i in range(1, len(cells) - 1):
            x, y = cells[i]
            best = None
            for p in self.road_pieces[y, x].tolist():
                if not p:
                    break
                a = np.array([p & 0xFF, (p >> 8) & 0xFF], np.float64) / 255.0
                b = np.array([(p >> 16) & 0xFF, (p >> 24) & 0xFF], np.float64) / 255.0
                v = b - a
                t = float(np.clip(np.dot(0.5 - a, v) / max(float(np.dot(v, v)), 1e-12), 0.0, 1.0))
                q = a + v * t
                d = float(np.hypot(*(q - 0.5)))
                if best is None or d < best[0]:
                    best = (d, q)
            if best is not None:
                xy[i] = (x + best[1][0], y + best[1][1])
        return xy

    @property
    def shape(self) -> tuple[int, int]:
        return self.road.shape

    def surface_height(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        """Drawn surface height (steps) at points, as the client samples it
        (TerrainGrid.surfaceHeightAt): the micro-cell's triangle, else the cell's."""
        xs = np.asarray(xs, dtype=np.float64)
        ys = np.asarray(ys, dtype=np.float64)
        h, w = self.shape
        if self.micro is not None:
            k = self.k
            px, py = xs * k, ys * k
            mx = np.clip(np.floor(px), 0, w * k - 1).astype(np.int64)
            my = np.clip(np.floor(py), 0, h * k - 1).astype(np.int64)
            m = self.micro
            c = np.stack([m[my, mx], m[my, mx + 1], m[my + 1, mx + 1], m[my + 1, mx]]).astype(
                np.float64
            )
            lo, hi = c.min(axis=0), c.max(axis=0)
            flat = np.floor(c.sum(axis=0) / 4 + 0.5)
            cap = (self.manifest.get("micro") or {}).get("maxSlope", MICRO_MAX_OFFSET)
            c = np.where(hi - lo > cap, flat, c)
            fx = np.clip(px - mx, 0, 1)
            fy = np.clip(py - my, 0, 1)
            return _triangle_height(c, fx, fy) / k
        cx = np.clip(np.floor(xs), 0, w - 1).astype(np.int64)
        cy = np.clip(np.floor(ys), 0, h - 1).astype(np.int64)
        c = self.corners[:, cy, cx].astype(np.float64)
        return _triangle_height(c, np.clip(xs - cx, 0, 1), np.clip(ys - cy, 0, 1))

    def water_level(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        """Water level (steps) at points, NaN where there's no water."""
        h, w = self.shape
        cx = np.clip(np.floor(xs), 0, w - 1).astype(np.int64)
        cy = np.clip(np.floor(ys), 0, h - 1).astype(np.int64)
        lv = self.water[cy, cx].astype(np.float64)
        return np.where(lv == NO_WATER, np.nan, lv)


def _triangle_height(c: np.ndarray, fx: np.ndarray, fy: np.ndarray) -> np.ndarray:
    """packages/grid triangleHeight, vectorized: c is (4, n) corner heights."""
    h0, h1, h2, h3 = c
    d02 = np.abs(h0 - h2)
    d13 = np.abs(h1 - h3)
    split0 = np.where(d02 != d13, d02 < d13, ~(h1 + h3 > h0 + h2))
    a = np.where(
        fx >= fy, h0 + (h1 - h0) * fx + (h2 - h1) * fy, h0 + (h3 - h0) * fy + (h2 - h3) * fx
    )
    b = np.where(
        fx + fy <= 1,
        h0 + (h1 - h0) * fx + (h3 - h0) * fy,
        h2 + (h3 - h2) * (1 - fx) + (h1 - h2) * (1 - fy),
    )
    return np.where(split0, a, b)


def load_package(out_dir: Path) -> Package:
    manifest = json.loads((out_dir / "manifest.json").read_text())
    w, h = int(manifest["cellsX"]), int(manifest["cellsY"])
    size = int(manifest["chunkSize"])
    nx, ny = -(-w // size), -(-h // size)
    full = (ny * size, nx * size)
    road = np.zeros(full, np.uint16)
    rcls = np.zeros(full, np.uint8)
    rwid = np.zeros(full, np.uint8)
    water = np.full(full, NO_WATER, np.int16)
    base = np.zeros(full, np.int16)
    shape = np.zeros(full, np.uint8)
    pieces = np.zeros((*full, PIECES), np.uint32)
    any_pieces = False
    k = int((manifest.get("micro") or {}).get("k", 0))
    micro = np.zeros((ny * size * k + 1, nx * size * k + 1), np.int32) if k else None
    for ref in manifest["chunks"]:
        c = decode_chunk((out_dir / ref["path"]).read_bytes())
        ys = slice(c.y * size, (c.y + 1) * size)
        xs = slice(c.x * size, (c.x + 1) * size)
        road[ys, xs] = c.road
        rcls[ys, xs] = c.road_class
        rwid[ys, xs] = c.road_width
        water[ys, xs] = c.water
        base[ys, xs] = c.base
        shape[ys, xs] = c.shape
        for slot in range(PIECES):
            got = getattr(c, f"road_seg{slot}")
            if got is not None and got.any():
                pieces[ys, xs, slot] = got
                any_pieces = True
        if micro is not None and c.micro_corners is not None:
            s = size * k
            micro[c.y * s : (c.y + 1) * s + 1, c.x * s : (c.x + 1) * s + 1] = c.micro_corners
    corners = base[None, :h, :w].astype(np.int32) + unpack_shape(shape[:h, :w]).astype(np.int32)
    instances: list[dict] = []
    if manifest.get("objects"):
        instances = decode_objects((out_dir / manifest["objects"]["path"]).read_bytes())
    return Package(
        manifest=manifest,
        road=road[:h, :w],
        road_class=rcls[:h, :w],
        road_width=rwid[:h, :w],
        water=water[:h, :w],
        corners=corners,
        micro=None if micro is None else micro[: h * k + 1, : w * k + 1],
        k=k,
        instances=instances,
        road_pieces=pieces[:h, :w] if any_pieces else None,
    )


# ---- lon/lat to cells through the package's geo grid ---------------------------


class GeoInverse:
    """Cells from lon/lat by inverting the package's geo grid (D-048): the
    bilinear map the client uses, solved by Newton steps from the nearest grid
    point. Works for warped levels without rebuilding their layout."""

    def __init__(self, out_dir: Path, manifest: dict[str, Any]):
        geo = manifest.get("geo")
        if not geo:
            raise ValueError("routes need the package's geo grid (manifest.geo)")
        nx, ny = geo["size"]
        self.lon, self.lat = decode_geo((out_dir / geo.get("path", GEO_FILE)).read_bytes(), nx, ny)
        step = int(geo["step"])
        self.gx = np.minimum(np.arange(nx) * step, manifest["cellsX"]).astype(np.float64)
        self.gy = np.minimum(np.arange(ny) * step, manifest["cellsY"]).astype(np.float64)
        self.kx = math.cos(math.radians(float(np.mean(self.lat))))
        from scipy.spatial import cKDTree

        pts = np.stack([self.lon.ravel() * self.kx, self.lat.ravel()], axis=1)
        self.tree = cKDTree(pts)

    def _sample(self, x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        fi = np.interp(x, self.gx, np.arange(len(self.gx)))
        fj = np.interp(y, self.gy, np.arange(len(self.gy)))
        i = np.clip(np.floor(fi).astype(np.int64), 0, len(self.gx) - 2)
        j = np.clip(np.floor(fj).astype(np.int64), 0, len(self.gy) - 2)
        u, v = fi - i, fj - j

        def bil(a: np.ndarray) -> np.ndarray:
            return (
                a[j, i] * (1 - u) * (1 - v)
                + a[j, i + 1] * u * (1 - v)
                + a[j + 1, i + 1] * u * v
                + a[j + 1, i] * (1 - u) * v
            )

        return bil(self.lon), bil(self.lat)

    def cells(self, lons: np.ndarray, lats: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        lons = np.asarray(lons, np.float64)
        lats = np.asarray(lats, np.float64)
        _, idx = self.tree.query(np.stack([lons * self.kx, lats], axis=1))
        j, i = np.divmod(idx, self.lon.shape[1])
        x, y = self.gx[i].copy(), self.gy[j].copy()
        for _ in range(8):
            # differences toward the inside at the grid's far edges
            ex = np.where(x + 0.25 > self.gx[-1], -0.25, 0.25)
            ey = np.where(y + 0.25 > self.gy[-1], -0.25, 0.25)
            lo, la = self._sample(x, y)
            lox, lax = self._sample(x + ex, y)
            loy, lay = self._sample(x, y + ey)
            a, b = (lox - lo) / ex, (loy - lo) / ey
            c, d = (lax - la) / ex, (lay - la) / ey
            det = a * d - b * c
            det = np.where(np.abs(det) < 1e-18, 1e-18, det)
            rx, ry = lons - lo, lats - la
            x = x + (d * rx - b * ry) / det
            y = y + (-c * rx + a * ry) / det
        return x, y


# ---- graphs on the cell grid ---------------------------------------------------


def adjacency(mask: np.ndarray) -> dict[tuple[int, int], list[tuple[int, int]]]:
    """Cell graph of a connectivity layer (bits 0–7 as in ROAD): an edge where
    both cells point at each other. A road cut at a bridge's water (D-056)
    leaves its last cells pointing into the water; those links are dropped."""
    h, w = mask.shape
    adj: dict[tuple[int, int], set[tuple[int, int]]] = defaultdict(set)
    for i, (dx, dy) in enumerate(DIRS):
        ys, xs = np.nonzero(mask & (1 << i))
        nx, ny = xs + dx, ys + dy
        ok = (nx >= 0) & (nx < w) & (ny >= 0) & (ny < h)
        back = 1 << road_stage.DIR_INDEX[(-dx, -dy)]
        ok[ok] &= (mask[ny[ok], nx[ok]] & back) != 0
        for x, y, x2, y2 in zip(xs[ok], ys[ok], nx[ok], ny[ok], strict=True):
            a, b = (int(x), int(y)), (int(x2), int(y2))
            adj[a].add(b)
            adj[b].add(a)
    return {c: sorted(n, key=lambda p: (p[1], p[0])) for c, n in adj.items()}


def trace(
    adj: dict[tuple[int, int], list[tuple[int, int]]],
    forced: set[tuple[int, int]] | None = None,
) -> list[list[tuple[int, int]]]:
    """Chains of cells between junctions: cells with other than two neighbours,
    and `forced` cells. Loops without a junction start at their first cell.
    Every graph edge is in exactly one chain; the order is deterministic."""
    order = sorted(adj, key=lambda p: (p[1], p[0]))
    junction = {c for c in order if len(adj[c]) != 2} | (forced or set()) & set(adj)
    seen: set[tuple[tuple[int, int], tuple[int, int]]] = set()

    def walk(a: tuple[int, int], b: tuple[int, int]) -> list[tuple[int, int]]:
        path = [a, b]
        seen.add((a, b))
        seen.add((b, a))
        prev, cur = a, b
        while cur not in junction:
            nxt = next((n for n in adj[cur] if n != prev and (cur, n) not in seen), None)
            if nxt is None:
                break
            seen.add((cur, nxt))
            seen.add((nxt, cur))
            path.append(nxt)
            prev, cur = cur, nxt
            if cur == a:
                break
        return path

    chains = []
    for c in order:
        if c in junction:
            for n in adj[c]:
                if (c, n) not in seen:
                    chains.append(walk(c, n))
    for c in order:  # loops with no junction on them
        for n in adj[c]:
            if (c, n) not in seen:
                junction.add(c)
                chains.append(walk(c, n))
    return chains


def mark_path(mask: np.ndarray, cells: list[tuple[int, int]]) -> None:
    """Set the connectivity bits between consecutive (8-adjacent) cells."""
    h, w = mask.shape
    for a, b in zip(cells, cells[1:], strict=False):
        dx, dy = b[0] - a[0], b[1] - a[1]
        if max(abs(dx), abs(dy)) != 1:
            continue
        if not (0 <= a[0] < w and 0 <= a[1] < h and 0 <= b[0] < w and 0 <= b[1] < h):
            continue
        mask[a[1], a[0]] |= 1 << road_stage.DIR_INDEX[(dx, dy)]
        mask[b[1], b[0]] |= 1 << road_stage.DIR_INDEX[(-dx, -dy)]


def match_to_graph(
    adj: dict[tuple[int, int], list[tuple[int, int]]],
    cells_xy: np.ndarray,
    tree,
    line_xy: np.ndarray,
    corridor: float = 2.5,
) -> list[tuple[int, int]] | None:
    """The drawn road cells a street-running line follows: the cheapest path
    in the road graph from the road cell nearest its start to the one nearest
    its end, through cells within `corridor` of the line, where a step costs
    its length times 1 + (distance to the line)². None when there is none."""
    line = shapely.LineString(line_xy)
    d0, i0 = tree.query(line_xy[0])
    d1, i1 = tree.query(line_xy[-1])
    if d0 > corridor or d1 > corridor:
        return None
    start = (int(cells_xy[i0][0]), int(cells_xy[i0][1]))
    goal = (int(cells_xy[i1][0]), int(cells_xy[i1][1]))
    near = tree.query_ball_point(line_xy, corridor + 0.75)
    allowed = {(int(cells_xy[i][0]), int(cells_xy[i][1])) for ids in near for i in ids}
    pts = np.array([(c[0] + 0.5, c[1] + 0.5) for c in allowed])
    dist = dict(zip(allowed, shapely.distance(shapely.points(pts), line), strict=True))
    best = {start: 0.0}
    prev: dict[tuple[int, int], tuple[int, int]] = {}
    heap = [(0.0, start)]
    while heap:
        cost, c = heapq.heappop(heap)
        if c == goal:
            break
        if cost > best.get(c, math.inf):
            continue
        for n in adj.get(c, ()):
            if n not in allowed or dist[n] > corridor:
                continue
            step = math.hypot(n[0] - c[0], n[1] - c[1]) * (1 + dist[n] ** 2)
            if cost + step < best.get(n, math.inf):
                best[n] = cost + step
                prev[n] = c
                heapq.heappush(heap, (cost + step, n))
    if goal not in best:
        return None
    path = [goal]
    while path[-1] != start:
        path.append(prev[path[-1]])
    return path[::-1]


# ---- bridge decks --------------------------------------------------------------


@dataclass
class Deck:
    id: str
    a: np.ndarray  # axis ends (cells)
    b: np.ndarray
    half: float  # half-width (cells)
    top: float  # deck height (steps)
    band: shapely.Geometry
    ap: tuple[float, float] = (0.0, 0.0)  # approaches at a and at b (cells, D-131)
    az: tuple[float, float] = (0.0, 0.0)  # the ground where they land (steps)

    def height(self, s: np.ndarray) -> np.ndarray:
        """The deck's height at distances s along it from a: level between its
        anchorages, coming down each approach to the ground it lands on."""
        s = np.asarray(s, np.float64)
        out = np.full(s.shape, self.top)
        (la, lb), (za, zb), L = self.ap, self.az, self.length
        if la > 0:
            sel = s < la
            out[sel] = za + (self.top - za) * np.clip(s[sel], 0, la) / la
        if lb > 0:
            sel = s > L - lb
            out[sel] = zb + (self.top - zb) * np.clip(L - s[sel], 0, lb) / lb
        return out

    def along(self, xy: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """(distance along the axis from a, signed distance across) of points."""
        d = self.b - self.a
        L = float(np.hypot(*d))
        u = d / max(L, 1e-9)
        rel = np.asarray(xy, np.float64) - self.a
        return rel @ u, rel @ np.array([-u[1], u[0]])

    @property
    def length(self) -> float:
        return float(np.hypot(*(self.b - self.a)))


def bridge_decks(instances: list[dict]) -> list[Deck]:
    """One deck per bridge landmark: its line (`ln`, else the long axis of its
    footprint), half-width and deck height (`top`)."""
    groups: dict[str, list[dict]] = defaultdict(list)
    for inst in instances:
        if inst["g"].startswith("landmark.bridge") and inst.get("top") is not None:
            groups[inst.get("id") or f"{inst['x']:.2f},{inst['y']:.2f}"].append(inst)
    decks = []
    for key in sorted(groups):
        parts = groups[key]
        polys = [shapely.Polygon(p["fp"]) for p in parts if p.get("fp")]
        band = shapely.union_all(polys) if polys else None
        ln = parts[0].get("ln")
        if ln:
            a, b = np.array(ln[:2], np.float64), np.array(ln[2:], np.float64)
            half = float(parts[0].get("lw", 0.5))
        elif band is not None:
            rect = np.asarray(band.minimum_rotated_rectangle.exterior.coords)[:4]
            e0, e1 = rect[1] - rect[0], rect[2] - rect[1]
            if np.hypot(*e0) >= np.hypot(*e1):
                a, b = (rect[0] + rect[3]) / 2, (rect[1] + rect[2]) / 2
                half = float(np.hypot(*e1)) / 2
            else:
                a, b = (rect[0] + rect[1]) / 2, (rect[3] + rect[2]) / 2
                half = float(np.hypot(*e0)) / 2
        else:
            continue
        if band is None:
            band = shapely.LineString([a, b]).buffer(half, cap_style="flat")
        top = max(float(p["top"]) for p in parts)
        ap = tuple(parts[0].get("ap") or (0.0, 0.0))
        az = tuple(parts[0].get("az") or (0.0, 0.0))
        decks.append(Deck(key, a, b, half, top, band, ap, az))
    return decks


def deck_links(
    decks: list[Deck], adj: dict[tuple[int, int], list[tuple[int, int]]], min_gap: float = 2.0
) -> list[tuple[Deck, tuple[int, int], tuple[int, int]]]:
    """Where a deck carries a road over a gap in the road layer (water, D-056):
    the road cells either side of each gap along the deck's band, as
    (deck, cell before, cell after)."""
    if not adj:
        return []
    cells = np.array(sorted(adj, key=lambda p: (p[1], p[0])), dtype=np.float64)
    out = []
    for deck in decks:
        t, n = deck.along(cells + 0.5)
        near = (np.abs(n) <= deck.half + 1.0) & (t >= -3) & (t <= deck.length + 3)
        idx = np.nonzero(near)[0]
        if len(idx) < 2:
            continue
        order = idx[np.argsort(t[idx], kind="stable")]
        ts = t[order]
        for g in np.nonzero(np.diff(ts) > min_gap)[0]:
            # the cell nearest the axis among those at the gap's two edges
            lo = order[(ts >= ts[g] - 1.0) & (ts <= ts[g])]
            hi = order[(ts >= ts[g + 1]) & (ts <= ts[g + 1] + 1.0)]
            # nearest the axis, then nearest the gap
            p = lo[np.argmin(np.abs(n[lo]) + 0.01 * (ts[g] - t[lo]))]
            q = hi[np.argmin(np.abs(n[hi]) + 0.01 * (t[hi] - ts[g + 1]))]
            out.append((deck, tuple(int(v) for v in cells[p]), tuple(int(v) for v in cells[q])))
    return out


def deck_heights(
    decks: list[Deck], xy: np.ndarray, h: np.ndarray, heading: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Heights with a deck's where a vertex is on a deck's band and its line
    runs along the deck (within 30°); a road crossing under it keeps its own.
    Returns the heights and a mask of vertices on a deck."""
    out = h.copy()
    on = np.zeros(len(h), bool)
    if not decks or not len(xy):
        return out, on
    pts = shapely.points(xy)
    for deck in decks:
        inside = shapely.contains(deck.band.buffer(0.3), pts)
        if not inside.any():
            continue
        d = deck.b - deck.a
        axis = math.atan2(d[1], d[0])
        # along the deck by the segment leaving a vertex or the one arriving at it,
        # so the vertex where a road turns off the deck stays on it
        arriving = np.concatenate([heading[:1], heading[:-1]])
        diff = np.minimum(
            np.abs(((heading - axis + math.pi / 2) % math.pi) - math.pi / 2),
            np.abs(((arriving - axis + math.pi / 2) % math.pi) - math.pi / 2),
        )
        sel = inside & (diff < math.radians(30))
        s, _ = deck.along(xy[sel])
        out[sel] = np.maximum(out[sel], deck.height(s))
        on |= sel
    return out, on


# ---- polylines -----------------------------------------------------------------


def headings(xy: np.ndarray) -> np.ndarray:
    """Direction (radians) of a polyline at each vertex: of the segment
    leaving it, the last vertex taking the one arriving."""
    d = np.diff(xy, axis=0)
    a = np.arctan2(d[:, 1], d[:, 0])
    return np.append(a, a[-1:]) if len(a) else np.zeros(len(xy))


def simplify(
    xyh: np.ndarray, keep: np.ndarray | None = None, tol_xy=0.02, tol_h=0.15
) -> np.ndarray:
    """Indices of the vertices to keep: Douglas–Peucker where a vertex matters
    if it is off the line in plan (> tol_xy cells) or in height (> tol_h steps)
    at its place along it. `keep` forces vertices."""
    n = len(xyh)
    if n <= 2:
        return np.arange(n)
    flags = np.zeros(n, bool)
    flags[0] = flags[-1] = True
    if keep is not None:
        flags |= keep
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        a, b = xyh[i], xyh[j]
        seg = b[:2] - a[:2]
        L2 = float(seg @ seg)
        p = xyh[i + 1 : j]
        t = np.clip(((p[:, :2] - a[:2]) @ seg) / L2, 0, 1) if L2 > 0 else np.zeros(len(p))
        q = a[:2] + t[:, None] * seg
        dxy = np.hypot(*(p[:, :2] - q).T)
        dh = np.abs(p[:, 2] - (a[2] + t * (b[2] - a[2])))
        err = np.maximum(dxy / tol_xy, dh / tol_h)
        inner = np.nonzero(flags[i + 1 : j])[0]
        if len(inner):
            m = i + 1 + int(inner[0])
        elif err.max() > 1:
            m = i + 1 + int(np.argmax(err))
        else:
            continue
        flags[m] = True
        stack.append((i, m))
        stack.append((m, j))
    return np.nonzero(flags)[0]


def _r2(v: float) -> float:
    r = round(float(v), 2)
    return 0.0 if r == 0 else r


class RouteSet:
    """Routes and their junction nodes, built up network by network."""

    def __init__(self) -> None:
        self.nodes: list[list[float]] = []
        self.node_index: dict[tuple[str, tuple[int, int]], int] = {}
        self.routes: list[dict[str, Any]] = []

    def node(self, net: str, cell: tuple[int, int], h: float) -> int:
        key = (net, cell)
        if key not in self.node_index:
            self.node_index[key] = len(self.nodes)
            self.nodes.append([_r2(cell[0] + 0.5), _r2(cell[1] + 0.5), _r2(h)])
        return self.node_index[key]

    def add(
        self,
        pkg: Package,
        decks: list[Deck],
        net: str,
        xy: np.ndarray,
        a: int | None,
        b: int | None,
        props: dict[str, Any],
        heights: np.ndarray | None = None,
    ) -> None:
        if heights is None:
            heights = pkg.surface_height(xy[:, 0], xy[:, 1])
        h, on_deck = deck_heights(decks, xy, heights, headings(xy))
        xyh = np.column_stack([xy, h])
        kept = simplify(xyh, keep=np.r_[False, np.diff(on_deck.astype(np.int8)) != 0])
        route = {"net": net, **props}
        if a is not None:
            route["a"] = a
            route["b"] = b
        route["pts"] = [_r2(v) for v in xyh[kept].ravel()]
        if on_deck.any():
            route["deck"] = True
        self.routes.append(route)


def _chain_props(pkg: Package, cells: list[tuple[int, int]], names: dict[int, str]) -> dict:
    xs = np.array([c[0] for c in cells])
    ys = np.array([c[1] for c in cells])
    cls = pkg.road_class[ys, xs]
    inner = cls[1:-1] if len(cls) > 2 else cls
    inner = inner[inner > 0]
    if len(inner):
        vals, counts = np.unique(inner, return_counts=True)
        klass = int(vals[np.argmax(counts)])
    else:
        nz = cls[cls > 0]
        klass = int(nz.min()) if len(nz) else 0
    props: dict[str, Any] = {"cls": names.get(klass, "road")}
    wid = pkg.road_width[ys, xs]
    wid = wid[wid > 0]
    if len(wid):
        props["w"] = _r2(float(np.median(wid)) / 32)
    return props


def road_routes(pkg: Package, decks: list[Deck], out: RouteSet) -> dict[str, int]:
    """Routes along the drawn roads, plus bridge decks joining them over water."""
    names = {int(k): v for k, v in (pkg.manifest.get("roadClasses") or {}).items()}
    adj = adjacency(pkg.road & road_stage.CONNECT_MASK)
    links = deck_links(decks, adj)
    forced = {c for _, p, q in links for c in (p, q)}
    chains = trace(adj, forced)

    def h_at(c: tuple[int, int]) -> float:
        return float(pkg.surface_height(np.array([c[0] + 0.5]), np.array([c[1] + 0.5]))[0])

    for cells in chains:
        xy = pkg.on_road_line(cells)
        a = out.node("road", cells[0], h_at(cells[0]))
        b = out.node("road", cells[-1], h_at(cells[-1]))
        out.add(pkg, decks, "road", xy, a, b, _chain_props(pkg, cells, names))
    for deck, p, q in links:
        pa = np.array(p, np.float64) + 0.5
        pb = np.array(q, np.float64) + 0.5
        # onto the axis and along it: the deck's own line, not the grid's
        ta, _ = deck.along(pa[None])
        tb, _ = deck.along(pb[None])
        u = (deck.b - deck.a) / max(deck.length, 1e-9)
        ea = deck.a + u * float(ta[0])
        eb = deck.a + u * float(tb[0])
        n = max(2, int(math.ceil(np.hypot(*(eb - ea)))))
        mid = ea + (eb - ea) * (np.arange(n + 1) / n)[:, None]
        xy = np.vstack([pa, mid, pb])
        # its ends at the road's height there: the deck's where the road is on its band
        band = deck.band.buffer(0.3)
        hp = deck.top if band.contains(shapely.Point(pa)) else h_at(p)
        hq = deck.top if band.contains(shapely.Point(pb)) else h_at(q)
        heights = np.full(len(xy), deck.top)
        heights[0], heights[-1] = hp, hq
        props = _chain_props(pkg, [p, q], names) | {"bridge": deck.id}
        a = out.node("road", p, hp)
        b = out.node("road", q, hq)
        route_xy = xy
        out.add(pkg, [], "road", route_xy, a, b, props, heights=heights)
        out.routes[-1]["deck"] = True
    return {"chains": len(chains), "deckLinks": len(links), "roadCells": len(adj)}


# ---- rail and ferries ------------------------------------------------------------


def classify_rail(rows: list[dict], rules: dict[str, Any]) -> list[tuple[dict, str]]:
    """(segment, vehicle kind) for the rail segments that get routes.

    Tram networks (segments joined end to end) carrying no route name anywhere
    take `unnamedTram` when the region sets it (San Francisco: its cable cars,
    which Overture records as unnamed tram lines); otherwise trams are
    streetcars."""
    kinds = RAIL_KINDS | dict(rules.get("classes") or {})
    unnamed = rules.get("unnamedTram")
    rail = [r for r in rows if r["subtype"] == "rail"]
    named_net: dict[int, bool] = {}
    if unnamed:
        trams = [r for r in rail if r["class"] == "tram"]
        parent = list(range(len(trams)))

        def find(i: int) -> int:
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        ends: dict[tuple[float, float], int] = {}
        for i, r in enumerate(trams):
            cs = shapely.get_coordinates(shapely.from_wkt(r["geometry"]))
            for c in (cs[0], cs[-1]):
                key = (round(float(c[0]), 6), round(float(c[1]), 6))
                if key in ends:
                    parent[find(i)] = find(ends[key])
                else:
                    ends[key] = i
        named = {find(i) for i, r in enumerate(trams) if r.get("name")}
        named_net = {id(r): find(i) in named for i, r in enumerate(trams)}
    out = []
    for r in rail:
        if SKIP_FLAGS & set(r.get("flags") or []):
            continue
        kind = kinds.get(r["class"] or "")
        if kind is None:
            continue
        if r["class"] == "tram" and unnamed and not named_net.get(id(r), True):
            kind = unnamed
        out.append((r, kind))
    return out


def _lines_cells(geo: GeoInverse, wkt: str, densify: float) -> list[np.ndarray]:
    g = shapely.segmentize(shapely.from_wkt(wkt), densify)
    parts = list(g.geoms) if hasattr(g, "geoms") else [g]
    out = []
    for part in parts:
        c = shapely.get_coordinates(part)
        if len(c) < 2:
            continue
        x, y = geo.cells(c[:, 0], c[:, 1])
        out.append(np.column_stack([x, y]))
    return out


def rail_routes(
    pkg: Package,
    decks: list[Deck],
    geo: GeoInverse,
    segs: list[tuple[dict, str]],
    out: RouteSet,
    min_length: float = 3.0,
) -> dict[str, int]:
    """Rail routes by vehicle kind: street-running kinds on the drawn roads
    where they follow them, everything else in octilinear runs."""
    from scipy.spatial import cKDTree

    h, w = pkg.shape
    road_adj = adjacency(pkg.road & road_stage.CONNECT_MASK)
    road_cells = np.array(sorted(road_adj, key=lambda p: (p[1], p[0])), dtype=np.float64)
    tree = cKDTree(road_cells + 0.5) if len(road_cells) else None
    masks: dict[str, np.ndarray] = {}
    raster: dict[str, list] = defaultdict(list)
    matched = 0
    deg = 0.0003  # ~30 m: densify before mapping, so warped levels bend the line
    lines_by_seg = []
    for row, kind in sorted(segs, key=lambda t: t[0]["id"]):
        for line in _runs_inside(_lines_cells(geo, row["geometry"], deg), w, h):
            lines_by_seg.append((row, kind, line))
    for row, kind, line in single_track(lines_by_seg):
        mask = masks.setdefault(kind, np.zeros((h, w), np.uint16))
        path = None
        if kind in STREET_KINDS and tree is not None:
            path = match_to_graph(road_adj, road_cells, tree, line)
        if path is not None:
            mark_path(mask, path)
            matched += 1
        else:
            raster[kind].append((row["id"], 1, [(line[:, 0], line[:, 1])]))
    counts: dict[str, int] = {"matched": matched}
    for kind in sorted(set(masks) | set(raster)):
        mask = masks.setdefault(kind, np.zeros((h, w), np.uint16))
        if raster.get(kind):
            layer = road_stage.rasterize(raster[kind], (h, w), deviation=1.0)
            mask |= layer.mask & road_stage.CONNECT_MASK
        adj = adjacency(mask)
        chains = [c for c in trace(adj) if len(c) >= 2]
        # networks shorter than min_length cells in all are crossovers and stubs
        comp = _components(chains)
        length = defaultdict(float)
        for i, cells in enumerate(chains):
            length[comp[i]] += _cells_length(cells)
        n = 0
        net = f"rail:{kind}"
        for i, cells in enumerate(chains):
            if length[comp[i]] < min_length:
                continue
            xy = np.array(cells, np.float64) + 0.5
            hh = pkg.surface_height(xy[:, 0], xy[:, 1])
            a = out.node(net, cells[0], float(hh[0]))
            b = out.node(net, cells[-1], float(hh[-1]))
            out.add(pkg, decks, "rail", xy, a, b, {"kind": kind}, heights=hh)
            n += 1
        counts[kind] = n
    return counts


def single_track(
    lines: list[tuple[dict, str, np.ndarray]], gap: float = 0.8, share: float = 0.6
) -> list[tuple[dict, str, np.ndarray]]:
    """One track of each double (or wider) track: lines are taken longest
    first, and a line mostly (`share` of its length) within `gap` cells of the
    lines already taken, of the same kind, is left out. At a few metres apart,
    parallel tracks would otherwise draw ladders of crossovers on the grid."""
    order = sorted(
        range(len(lines)),
        key=lambda i: (-shapely.LineString(lines[i][2]).length, lines[i][0]["id"], i),
    )
    taken: dict[str, list[shapely.Geometry]] = defaultdict(list)
    keep = []
    for i in order:
        row, kind, xy = lines[i]
        line = shapely.LineString(xy)
        if taken[kind]:
            near = shapely.union_all(taken[kind]).buffer(gap)
            pts = shapely.points(shapely.get_coordinates(shapely.segmentize(line, 0.5)))
            if shapely.contains(near, pts).mean() >= share:
                continue
        taken[kind].append(line)
        keep.append(i)
    return [lines[i] for i in sorted(keep)]


def _runs_inside(lines: list[np.ndarray], w: int, h: int, pad: float = 0.0) -> list[np.ndarray]:
    """The parts of polylines inside the world (at least two vertices each)."""
    out = []
    for line in lines:
        inside = (
            (line[:, 0] >= pad)
            & (line[:, 0] < w - pad)
            & (line[:, 1] >= pad)
            & (line[:, 1] < h - pad)
        )
        cuts = np.nonzero(np.diff(inside.astype(np.int8)))[0] + 1
        for run in np.split(np.arange(len(line)), cuts):
            if len(run) >= 2 and inside[run[0]]:
                out.append(line[run])
    return out


def _cells_length(cells: list[tuple[int, int]]) -> float:
    return float(
        sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(cells, cells[1:], strict=False))
    )


def _components(chains: list[list[tuple[int, int]]]) -> list[int]:
    parent: dict[tuple[int, int], tuple[int, int]] = {}

    def find(c):
        parent.setdefault(c, c)
        while parent[c] != c:
            parent[c] = parent[parent[c]]
            c = parent[c]
        return c

    for cells in chains:
        for c in cells[1:]:
            ra, rb = find(cells[0]), find(c)
            if ra != rb:
                parent[rb] = ra
    roots = [find(cells[0]) for cells in chains]
    ids: dict[tuple[int, int], int] = {}
    return [ids.setdefault(r, len(ids)) for r in roots]


def ferry_routes(
    pkg: Package, geo: GeoInverse, rows: list[dict], out: RouteSet, min_length: float = 6.0
) -> int:
    """Ferry lines, simplified, at the water's level where there is water."""
    h, w = pkg.shape
    n = 0
    for row in sorted(rows, key=lambda r: r["id"]):
        if row["subtype"] != "water":
            continue
        runs = _runs_inside(_lines_cells(geo, row["geometry"], 0.002), w, h, pad=0.5)
        if runs:
            xy = max(runs, key=len)  # the longest run inside the world
            keep = shapely.simplify(shapely.LineString(xy), 0.5)
            xy = shapely.get_coordinates(keep)
            if len(xy) < 2 or shapely.LineString(xy).length < min_length:
                continue
            # densify so the heights follow the water and the shore
            xy = shapely.get_coordinates(shapely.segmentize(shapely.LineString(xy), 1.0))
            lv = pkg.water_level(xy[:, 0], xy[:, 1])
            hh = np.where(np.isnan(lv), pkg.surface_height(xy[:, 0], xy[:, 1]), lv)
            props = {"kind": "ferry"}
            if row.get("name"):
                props["name"] = row["name"]
            out.add(pkg, [], "ferry", xy, None, None, props, heights=hh)
            n += 1
    return n


# ---- the file ------------------------------------------------------------------


def encode_routes(doc: dict[str, Any]) -> bytes:
    blob = json.dumps(doc, separators=(",", ":"), sort_keys=True)
    return gzip.compress(blob.encode(), compresslevel=9, mtime=0)


def decode_routes(blob: bytes) -> dict[str, Any]:
    if blob[:2] == b"\x1f\x8b":
        blob = gzip.decompress(blob)
    doc = json.loads(blob)
    if doc.get("version") != ROUTES_VERSION:
        raise ValueError(f"routes version {doc.get('version')} is not {ROUTES_VERSION}")
    return doc


def make_routes(
    out_dir: Path, transit_rows: list[dict] | None = None, rules: dict[str, Any] | None = None
) -> tuple[dict[str, Any], dict[str, Any]]:
    """The routes document of a built package, and a report."""
    rules = rules or {}
    pkg = load_package(out_dir)
    decks = bridge_decks(pkg.instances)
    out = RouteSet()
    report: dict[str, Any] = {"roads": road_routes(pkg, decks, out), "decks": [d.id for d in decks]}
    if transit_rows and not pkg.manifest.get("geo"):
        # Overture's lines are placed through the geo grid, which every package
        # built since D-076 has; an older one gets road routes only
        from . import progress

        progress.log(
            "routes: this package has no geo grid, so its rail and ferry lines are "
            "left out; rebuild it (pixelworld build) to get them"
        )
        report["transit"] = "skipped: the package has no geo grid"
    elif transit_rows:
        geo = GeoInverse(out_dir, pkg.manifest)
        rail_rules = rules.get("rail", {})
        if rail_rules is not False:
            segs = classify_rail(transit_rows, rail_rules or {})
            report["rail"] = rail_routes(pkg, decks, geo, segs, out)
        if rules.get("ferries", True) is not False:
            report["ferries"] = ferry_routes(pkg, geo, transit_rows, out)
    doc = {"version": ROUTES_VERSION, "nodes": out.nodes, "routes": out.routes}
    report["routes"] = len(out.routes)
    return doc, report


def write_routes(out_dir: Path, doc: dict[str, Any]) -> dict[str, Any]:
    """Write routes.json.gz and point the manifest at it (packageHash updated)."""
    blob = encode_routes(doc)
    (out_dir / ROUTES_FILE).write_bytes(blob)
    manifest_path = out_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    counts: dict[str, int] = defaultdict(int)
    for r in doc["routes"]:
        counts[r.get("kind", r["net"])] += 1
    manifest["routes"] = {
        "path": ROUTES_FILE,
        "sha256": hashlib.sha256(blob).hexdigest(),
        "version": ROUTES_VERSION,
        "count": len(doc["routes"]),
    }
    manifest["packageHash"] = package_hash(manifest)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    report_path = out_dir / "build-report.json"
    if report_path.exists():
        report = json.loads(report_path.read_text())
        report["packageHash"] = manifest["packageHash"]
        report["routes"] = dict(sorted(counts.items()))
        report_path.write_text(json.dumps(report, indent=2) + "\n")
    return manifest["routes"]


def refresh_routes(
    region_path: Path, out_dir: Path, spec: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Routes for a built package, without rebuilding it: the region's rail
    and ferry lines (Overture, cached) and the package's own roads. `spec` is
    the resolved spec, when it isn't read from `region_path`."""
    from . import plugins
    from .landmarks import expand
    from .region import Region, load_region

    if spec is None:
        region, spec, _ = load_region(Path(region_path))
    else:
        region = Region.from_dict(expand(spec, Path(region_path)))
    rules = spec.get("routes") or {}
    rows = plugins.source(region, "features").transit(region.lonlat_envelope())
    doc, report = make_routes(out_dir, rows, rules)
    report["manifest"] = write_routes(out_dir, doc)
    return report
