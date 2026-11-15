"""Object placement: vegetation, street trees, buildings and landmarks.

The pipeline only names semantic groups (D-030); the style pack decides what
each group looks like. Placement happens in projected metres from the region's
fixed envelope with seeds that don't depend on the cell size, so worlds built
from the same spec at different resolutions get the same objects.

Region spec (all sections optional):

    objects:
      buildings:
        minArea: 30
        towerMeters: 45
        podiumMeters: 15
        tiers: true      # stacked parts (setback tiers) drawn from the ground (default: dropped)
        # footprints that are likely trees, dropped where they stand in a park
        # (these are the defaults; `implausible: null` keeps every footprint)
        implausible: { maxArea: 200, minHeight: 8, minAspect: 2.5, landUse: [park, ...] }
      vegetation:   # scatter by ESA WorldCover class, or where the canopy map has trees
        - { group: tree.pinyon-juniper, landcover: [tree], spacing: 22, density: 0.8 }
        - { group: tree, canopy: 3, spacing: 12, byLandcover: { tree: [tree.cypress] } }
      streetTrees:  # rows along roads of the given classes (optionally by name)
        - { group: tree.palm, roads: [primary], name: Las Vegas Boulevard, spacing: 60, offset: 16 }
        # or on the verge past the drawn asphalt, where the canopy map has trees
        - { group: tree.street, roads: [residential], canopy: 3, spacing: 12, kerb: 2 }
      streetProps:  # street furniture: rows as streetTrees, or at junctions
        - { group: prop.streetlight, roads: [primary], spacing: 40, offset: 9 }
        - { group: prop.signal, roads: [primary], at: junctions, offset: 10 }
        # strung across the street (over the road, turned across it), along
        # the stretch of a named street inside a lon/lat box
        - { group: prop.lanterns, roads: [tertiary], name: Grant Avenue, across: true,
            spacing: 14, bounds: [-122.4075, 37.7900, -122.4040, 37.7985] }
      landmarks:
        - { group: landmark.tower.lookout, lon: -111.8261, lat: 36.0441, hm: 60, clear: 20 }
      pools:        # the map's water areas as objects on their own outlines (D-138)
        - { group: landmark.pool, classes: [hot_spring, spring], minArea: 4 }
      depiction:    # how big things are drawn at this scale level (D-047)
        heightStretch: 2.5                          # overrides the style pack's
        buildings: { scale: 2, minHeightMeters: 60 } # oversize; keep only tall ones
        landmarks: { scale: 4 }                     # or `scale:` on one landmark

Implausible footprints (M3.5): a speck of a footprint with no class, type or
name, standing much taller than it is wide inside a park, is almost always a
tree that machine-made footprints read as a building (a 45 m², 22 m "apartment
block" in Alamo Square). Real park buildings carry a class or a name (the
conservatory, a museum), have parts, or are low (restrooms, kiosks), so they
stay. The parks are Overture land-use polygons: the `landUse` list, else the
region's `ground.lawn.landUse`, else PARK_LAND_USE.

A depiction scale s draws an object as if its local metres per cell were m / s:
footprint and height grow by s about the object's anchor. Oversized buildings
are placed tallest first and skipped where they'd overlap one already placed,
so a coarse level keeps the skyline's landmarks rather than a smear of boxes.
"""

from __future__ import annotations

import hashlib
import math
from typing import Any

import numpy as np
import shapely
from rasterio.warp import transform as transform_points

from . import plugins, progress
from .region import Region
from .sources import rasters
from .world_format import NO_WATER

LANDCOVER_CODES = {name: code for code, name in rasters.WORLDCOVER.items()}
RESIDENTIAL = {
    "house",
    "residential",
    "detached",
    "semidetached_house",
    "apartments",
    "terrace",
    "bungalow",
    "dormitory",
    "static_caravan",
}
DEFAULT_HEIGHT = {"residential": 6.0, "small": 3.0, "other": 8.0}
SMALL = {"garage", "garages", "shed", "carport", "hut", "roof", "kiosk", "toilets"}
FLOOR_METERS = 3.5
# Overture land-use classes where a lone, tall speck of a footprint is more
# likely a tree than a building (when the region names no lawn classes)
PARK_LAND_USE = [
    "park",
    "dog_park",
    "village_green",
    "golf_course",
    "pitch",
    "recreation_ground",
    "grass",
    "garden",
    "cemetery",
    "grave_yard",
    "meadow",
]
# the implausible-footprint rule's defaults (see the module docstring)
IMPLAUSIBLE = {"maxArea": 200.0, "minHeight": 8.0, "minAspect": 2.5}


# a pool's outline is simplified this much (metres): voxels are a sixteenth of a cell
POOL_SIMPLIFY_M = 0.25


def pools(
    p: Placement, rule: dict[str, Any], water_level: np.ndarray | None, seen: set[str]
) -> list[dict]:
    """Hot pools and springs as objects (D-138): every water area of the map
    of the rule's classes (and ids), at least `minArea` m², becomes an object
    of the rule's group on its own outline (its largest part), so a generator
    can draw what water can't: a hot pool's rings of colour. One that holds
    water cells stands at their level (`z0`), over the water plane; a smaller
    one stands on the ground as a footprint does. An area takes the first rule
    it matches (`seen`)."""
    rows = plugins.source(p.region, "features").water_areas(
        p.region.lonlat_envelope(), list(rule["classes"])
    )
    ids = set(rule.get("ids") or [])
    min_area = float(rule.get("minArea", 0.0))
    out: list[dict] = []
    for r in rows:
        if r["id"] in seen or (ids and r["id"] not in ids):
            continue
        geom = p.project(shapely.from_wkt(r["geometry"]))
        parts = [g for g in getattr(geom, "geoms", [geom]) if g.geom_type == "Polygon"]
        if not parts:
            continue
        poly = max(parts, key=lambda g: g.area)
        if poly.area < min_area:
            continue
        fp = _footprint(p, poly, POOL_SIMPLIFY_M)
        if len(fp) < 3:
            continue
        seen.add(r["id"])
        cx, cy = p.to_cells(np.array([poly.centroid.x]), np.array([poly.centroid.y]))
        inst = {
            "g": rule["group"],
            "x": float(cx[0]),
            "y": float(cy[0]),
            "s": _stable_int(r["id"]) & 0x7FFFFFFF,
            "fp": fp,
        }
        level = pool_level(fp, water_level)
        if level is not None:
            inst["z0"] = float(level)
        out.append(inst)
    return out


def pool_level(fp: list[list[float]], water_level: np.ndarray | None) -> int | None:
    """The water level (steps) of the cells whose centres a pool's outline
    (cells) holds: the highest, where they stand in more than one body of
    water; None where it holds none."""
    if water_level is None:
        return None
    ring = shapely.Polygon(fp)
    x0, y0, x1, y1 = ring.bounds
    h, w = water_level.shape
    xs = np.arange(max(0, math.floor(x0)), min(w, math.ceil(x1)))
    ys = np.arange(max(0, math.floor(y0)), min(h, math.ceil(y1)))
    if not len(xs) or not len(ys):
        return None
    gx, gy = np.meshgrid(xs, ys)
    inside = shapely.contains_xy(ring, gx.ravel() + 0.5, gy.ravel() + 0.5)
    levels = water_level[gy.ravel()[inside], gx.ravel()[inside]]
    levels = levels[levels != NO_WATER]
    return int(levels.max()) if len(levels) else None


def bed_pools(
    instances: list[dict], groups: set[str], micro_corners: np.ndarray, k: int
) -> np.ndarray:
    """Pools lie flat (D-138): the micro-corners (micro-steps, 1/k step) under
    a pool's outline sink to a bed at its level, so its rings show whole
    rather than half under the finer ground than its cells'. A pool on water
    keeps its level (`z0`, steps), its bed a micro-step under it; one on dry
    ground takes the lowest micro-corner under its outline as its level.
    Returns the new micro-corners; the pools' `z0` are set in place."""
    q = micro_corners.copy()
    h, w = q.shape
    for inst in instances:
        if inst["g"] not in groups or "fp" not in inst:
            continue
        ring = shapely.Polygon(inst["fp"])
        x0, y0, x1, y1 = ring.bounds
        cols = np.arange(max(0, math.ceil(x0 * k)), min(w, math.floor(x1 * k) + 1))
        rows = np.arange(max(0, math.ceil(y0 * k)), min(h, math.floor(y1 * k) + 1))
        if not len(cols) or not len(rows):
            continue
        gi, gj = np.meshgrid(cols, rows)
        inside = shapely.contains_xy(ring, gi.ravel() / k, gj.ravel() / k)
        if not inside.any():
            continue  # smaller than a micro-cell: it stands as a footprint does
        ii, jj = gi.ravel()[inside], gj.ravel()[inside]
        if "z0" in inst:
            bed = round(inst["z0"] * k) - 1
        else:
            bed = int(q[jj, ii].min())
            inst["z0"] = round(bed / k, 3)
        q[jj, ii] = np.minimum(q[jj, ii], bed)
    return q


def _seed(region: Region, name: str) -> int:
    """Seed from the bounds and a rule name only (not the cell size)."""
    key = f"{region.bounds}|{name}".encode()
    return int.from_bytes(hashlib.sha256(key).digest()[:8], "little")


def _stable_int(text: str) -> int:
    return int.from_bytes(hashlib.sha256(text.encode()).digest()[:4], "little")


class Placement:
    """Projected-metre ↔ cell conversions and lookups for one region build.

    With a warped layout, positions go through the elastic map and footprints
    are stamped rigidly (the local similarity at their anchor), never sheared.
    """

    def __init__(self, region: Region, blocked: np.ndarray, layout=None, shift=None):
        self.region = region
        # cells → cells displacement that follows straightened roads (D-049)
        self.shift = shift
        self.layout = layout if layout is not None and layout.warped else None
        self.west, self.north, _, _ = region.grid
        self.cx, self.cy = blocked.shape[1], blocked.shape[0]
        self.m = region.meters_per_cell
        self.blocked = blocked
        self._landcover = None
        self._cell_landcover = None
        # placement lattice anchored to the spec's envelope, not the cell grid
        self.envelope = region._projected_envelope()

    @property
    def landcover(self):
        if self.layout is not None:
            raise ValueError("land-cover scatter isn't supported on warped layouts yet")
        if self._landcover is None:
            self._landcover = rasters.landcover_fine(self.region)
        return self._landcover[0]

    @property
    def lc_px(self) -> float:
        self.landcover  # noqa: B018 (loads it)
        return self._landcover[1]

    @property
    def cell_landcover(self) -> np.ndarray:
        """WorldCover class per cell, as the cell's surface is classified from."""
        if self.layout is not None:
            raise ValueError("land-cover groups aren't supported on warped layouts yet")
        if self._cell_landcover is None:
            self._cell_landcover = rasters.landcover_cells(self.region)
        return self._cell_landcover

    def from_cells(self, cx: np.ndarray, cy: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Cells as drawn (after the road shift) → projected metres: to_cells
        undone, the shift by a few fixed-point steps (it is smooth)."""
        if self.layout is not None:
            raise ValueError("placing from cells isn't supported on warped layouts yet")
        ox = np.asarray(cx, dtype=np.float64)
        oy = np.asarray(cy, dtype=np.float64)
        bx, by = ox, oy
        if self.shift is not None:
            for _ in range(4):
                dx, dy = self.shift(bx, by)
                bx, by = ox - dx, oy - dy
        return self.west + bx * self.m, self.north - by * self.m

    def to_cells(
        self, xs: np.ndarray, ys: np.ndarray, shift: bool = True
    ) -> tuple[np.ndarray, np.ndarray]:
        """Projected metres → cells; with `shift`, objects move with their roads."""
        if self.layout is not None:
            L = self.layout
            cx, cy = L.warp.to_cells(np.asarray(xs) - L.x0, L.y1 - np.asarray(ys))
        else:
            cx = (np.asarray(xs) - self.west) / self.m
            cy = (self.north - np.asarray(ys)) / self.m
        if shift and self.shift is not None:
            dx, dy = self.shift(cx, cy)
            return cx + dx, cy + dy
        return cx, cy

    def similarity(self, x: float, y: float) -> np.ndarray:
        """2×2 map from projected metres (x east, y north) to cells near (x, y):
        the closest similarity to the local Jacobian (uniform: 1/m, y flipped)."""
        h = 10.0
        # the map itself, not the road-following shift (that moves objects whole)
        cx, cy = self.to_cells(np.array([x, x + h, x]), np.array([y, y, y + h]), shift=False)
        j = np.array([[cx[1] - cx[0], cx[2] - cx[0]], [cy[1] - cy[0], cy[2] - cy[0]]]) / h
        # j maps (east, north) → (cell x, cell y) with a reflection (north is −y); similarity of j·F
        f = np.array([[1.0, 0.0], [0.0, -1.0]])
        a = j @ f
        scale = 0.5 * math.hypot(a[0, 0] + a[1, 1], a[1, 0] - a[0, 1])
        theta = math.atan2(a[1, 0] - a[0, 1], a[0, 0] + a[1, 1])
        rot = np.array([[math.cos(theta), -math.sin(theta)], [math.sin(theta), math.cos(theta)]])
        return scale * rot @ f

    def scale_at(self, x: float, y: float) -> float:
        """Local metres per cell."""
        return 1.0 / math.sqrt(abs(np.linalg.det(self.similarity(x, y))))

    def project(self, geom):
        """Lon/lat shapely geometry → projected metres."""

        def fn(coords: np.ndarray) -> np.ndarray:
            xs, ys = transform_points(
                "EPSG:4326", self.region.crs, coords[:, 0].tolist(), coords[:, 1].tolist()
            )
            return np.column_stack([xs, ys])

        return shapely.transform(geom, fn)

    def inside(self, cx: np.ndarray, cy: np.ndarray) -> np.ndarray:
        return (cx >= 0) & (cy >= 0) & (cx < self.cx) & (cy < self.cy)

    def free(self, cx: np.ndarray, cy: np.ndarray) -> np.ndarray:
        ok = self.inside(cx, cy)
        ix = np.clip(cx.astype(np.int64), 0, self.cx - 1)
        iy = np.clip(cy.astype(np.int64), 0, self.cy - 1)
        return ok & ~self.blocked[iy, ix]

    def landcover_at(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        h, w = self.landcover.shape
        i = np.clip(((np.asarray(xs) - self.west) / self.lc_px).astype(np.int64), 0, w - 1)
        j = np.clip(((self.north - np.asarray(ys)) / self.lc_px).astype(np.int64), 0, h - 1)
        return self.landcover[j, i]


def _codes(names: list[str]) -> set[int]:
    try:
        return {LANDCOVER_CODES[n] for n in names}
    except KeyError as e:
        raise ValueError(
            f"unknown land cover class {e}; use one of {sorted(LANDCOVER_CODES)}"
        ) from None


def scatter(p: Placement, rule: dict[str, Any], occupied, tag: str = "", canopy=None) -> list[dict]:
    """Jittered-lattice scatter where the land cover matches, thinned by density.
    A rule with `canopy: <metres>` keeps points where the canopy height map
    (WRI/Meta, 1 m) is at least that tall instead (M3): trees where trees are."""
    spacing = float(rule["spacing"])
    density = float(rule.get("density", 1.0))
    codes = _codes(rule["landcover"]) if "landcover" in rule else None
    x0, y0, x1, y1 = p.envelope
    gx = np.arange(math.floor(x0 / spacing), math.ceil(x1 / spacing))
    gy = np.arange(math.floor(y0 / spacing), math.ceil(y1 / spacing))
    rng = np.random.default_rng(_seed(p.region, f"scatter|{tag}|{rule['group']}"))
    ii, jj = np.meshgrid(gx, gy)
    n = ii.size
    jitter = rng.uniform(0.15, 0.85, size=(2, n))
    keep_roll = rng.uniform(size=n)
    seeds = rng.integers(0, 2**31, size=n)
    rots = rng.integers(0, 4, size=n)
    xs = (ii.ravel() + jitter[0]) * spacing
    ys = (jj.ravel() + jitter[1]) * spacing
    cx, cy = p.to_cells(xs, ys)
    ok = p.free(cx, cy) & (keep_roll < density)
    if "canopy" in rule:
        cand = np.nonzero(ok)[0]
        tall = np.zeros(n, dtype=bool)
        if canopy is not None and len(cand):
            tall[cand] = canopy.sample(xs[cand], ys[cand], p.region.crs) >= float(rule["canopy"])
        ok &= tall
    else:
        ok &= np.isin(p.landcover_at(xs, ys), list(codes))
    ok &= ~occupied(xs, ys)
    keep = np.nonzero(ok)[0]
    groups = _groups_by_landcover(p, rule, cx[keep], cy[keep], seeds[keep])
    return [
        {
            "g": g,
            "x": float(cx[k]),
            "y": float(cy[k]),
            "s": int(seeds[k]),
            "r": int(rots[k]),
        }
        for k, g in zip(keep, groups, strict=True)
    ]


def _groups_by_landcover(
    p: Placement, rule: dict[str, Any], cx: np.ndarray, cy: np.ndarray, seeds: np.ndarray
) -> list[str]:
    """Each kept point's group: the rule's, or with `byLandcover` ({class:
    [groups]}), one of the groups listed for the land cover of the cell it
    stands in (picked by its seed). That is the class the cell's surface, and
    so the client's scatter, comes from: canopy trees in a park's woodland are
    the park's species, not street trees."""
    by = rule.get("byLandcover")
    if not by or not len(cx):
        return [rule["group"]] * len(cx)
    _codes(list(by))  # check the class names
    lc = p.cell_landcover
    h, w = lc.shape
    ix = np.clip(np.floor(cx).astype(np.int64), 0, w - 1)
    iy = np.clip(np.floor(cy).astype(np.int64), 0, h - 1)
    names = [rasters.WORLDCOVER.get(int(c), "") for c in lc[iy, ix]]
    out = []
    for name, s in zip(names, seeds, strict=True):
        choice = by.get(name)
        if isinstance(choice, str):
            choice = [choice]
        out.append(choice[int(s) % len(choice)] if choice else rule["group"])
    return out


class DrawnRoads:
    """The road network as the terrain draws it: connections, class and
    half-width per cell (rasterized from the straightened lines exactly as the
    build does), for objects that stand beside the asphalt."""

    def __init__(self, region: Region, shape: tuple[int, int], streets: list, road_rows: list):
        from . import roads as road_stage
        from .build import ROAD_WIDTH_M, half_width_cells

        snap = region.snap or {}
        deviation = float((snap["roads"] or {}).get("deviation", 1.0)) if "roads" in snap else None
        cls_of = {r["id"]: r["class"] for r in road_rows}
        widths = region.widths
        rw = ROAD_WIDTH_M | {k: float(v) for k, v in ((widths or {}).get("roads") or {}).items()}
        layer = road_stage.rasterize(
            streets,
            shape,
            deviation=deviation,
            widths={sid: rw[cls_of[sid]] for sid, _, _ in streets if sid in cls_of},
        )
        self.mask = layer.mask & road_stage.CONNECT_MASK
        # class number (as rasterized: the larger wins) → class name
        self.cls = layer.cls
        self.names = {k: cls_of[sid] for sid, k, _ in streets if sid in cls_of}
        m = region.meters_per_cell
        if widths is not None and layer.width is not None:
            self.hw = half_width_cells(layer.width, np.full(shape, m), widths) / 32.0
        else:
            self.hw = np.where(layer.width > 0, layer.width / 2 / m, 0.0)
        self.dirs = road_stage.DIRS
        # the lines themselves: a drawn road runs through cell centres, up to
        # half a cell off the line its objects (and the real verge) follow
        self.lines = [
            shapely.LineString(np.column_stack([xs, ys]))
            for _, _, parts in streets
            for xs, ys in parts
            if len(xs) >= 2
        ]
        self.tree = shapely.STRtree(self.lines) if self.lines else None

    def line_offset(self, cx: np.ndarray, cy: np.ndarray, reach: float = 1.0) -> np.ndarray:
        """(n, 2): from each point to the nearest point on a road line within
        `reach` cells (zero where there is none)."""
        out = np.zeros((len(cx), 2))
        if self.tree is None or not len(cx):
            return out
        pts = shapely.points(cx, cy)
        idx = self.tree.query_nearest(pts, max_distance=reach, all_matches=False)
        if not idx.size:
            return out
        q, g = idx
        lines = np.asarray(self.lines, dtype=object)[g]
        near = shapely.line_interpolate_point(lines, shapely.line_locate_point(lines, pts[q]))
        out[q, 0] = shapely.get_x(near) - cx[q]
        out[q, 1] = shapely.get_y(near) - cy[q]
        return out

    def clearance(self, qx: np.ndarray, qy: np.ndarray, reach: int = 2) -> np.ndarray:
        """Distance (cells) from each point to the nearest drawn asphalt: half
        segments from road cell centres toward their connected neighbours,
        widened by the cell's half-width; negative on the asphalt."""
        h, w = self.mask.shape
        best = np.full(len(qx), np.inf)
        bx = np.floor(qx).astype(np.int64)
        by = np.floor(qy).astype(np.int64)
        for oy in range(-reach, reach + 1):
            for ox in range(-reach, reach + 1):
                ix, iy = bx + ox, by + oy
                inside = (ix >= 0) & (iy >= 0) & (ix < w) & (iy < h)
                ixc, iyc = np.clip(ix, 0, w - 1), np.clip(iy, 0, h - 1)
                bits = np.where(inside, self.mask[iyc, ixc], 0)
                hw = self.hw[iyc, ixc]
                cx0, cy0 = ix + 0.5, iy + 0.5
                for i, (dx, dy) in enumerate(self.dirs):
                    on = (bits >> i) & 1 == 1
                    if not on.any():
                        continue
                    # the half segment centre → centre + (dx, dy) / 2
                    ex, ey = 0.5 * dx, 0.5 * dy
                    t = np.clip(((qx - cx0) * ex + (qy - cy0) * ey) / (ex * ex + ey * ey), 0, 1)
                    d = np.hypot(qx - cx0 - t * ex, qy - cy0 - t * ey) - hw
                    best = np.where(on, np.minimum(best, d), best)
        return best


def sidewalk_trees(
    p: Placement,
    rule: dict[str, Any],
    roads: DrawnRoads,
    in_clear_zone,
    in_building,
    canopy,
    water: np.ndarray | None = None,
    tag: str = "",
) -> list[dict]:
    """Street trees where the canopy height map (WRI/Meta, 1 m) has them: rows
    along the straight stretches of drawn roads of the given classes, on the
    verge just past the asphalt (`kerb` metres past its drawn half-width, and
    at least `offset` metres from its centre line), `spacing` metres apart.

    Everything else keeps road cells clear, so canopy scatter puts trees in
    parks and backyards; these stand on a road cell's own verge. A spot is
    kept where the map shows a tree at least `canopy` metres tall within
    `search` metres of the same place beside the real road, out of buildings
    (as drawn) and landmarks' clear zones."""
    classes = set(rule["roads"])
    spacing = float(rule.get("spacing", 12))
    kerb = float(rule.get("kerb", 2.0))
    offset = float(rule.get("offset", 0.0))
    search = float(rule.get("search", 3.0))
    density = float(rule.get("density", 1.0))
    m = p.m
    mask = roads.mask
    want = np.isin(roads.cls, [k for k, name in roads.names.items() if name in classes])
    cols: list[list[np.ndarray]] = [[], [], [], [], [], []]  # x, y, normal x, y, centre x, y
    for i, (dx, dy) in enumerate(roads.dirs[:4]):
        # straight stretches only: the road runs on through the cell, no junction or bend
        through = want & (mask == ((1 << i) | (1 << (i + 4))))
        iy, ix = np.nonzero(through)
        if not len(ix):
            continue
        length = math.hypot(dx, dy)
        tx, ty = dx / length, dy / length
        n = max(1, round(length * m / spacing))
        d = np.maximum(offset / m, roads.hw[iy, ix] + kerb / m)
        for j in range(n):
            u = length * ((j + 0.5) / n - 0.5)
            for side in (-1.0, 1.0):
                nx, ny = -side * ty, side * tx
                for col, v in zip(
                    cols,
                    (
                        ix + 0.5 + u * tx + nx * d,
                        iy + 0.5 + u * ty + ny * d,
                        np.full(len(ix), nx),
                        np.full(len(ix), ny),
                        ix + 0.5 + u * tx,
                        iy + 0.5 + u * ty,
                    ),
                    strict=True,
                ):
                    col.append(v)
    if not cols[0]:
        return []
    ax, ay, nx, ny, ox, oy = (np.concatenate(c) for c in cols)
    order = np.lexsort((ax, ay))  # row-major, whatever order the directions came in
    ax, ay, nx, ny, ox, oy = (v[order] for v in (ax, ay, nx, ny, ox, oy))
    rng = np.random.default_rng(_seed(p.region, f"sidewalk|{tag}|{rule['group']}"))
    keep_roll = rng.uniform(size=ax.size)
    seeds = rng.integers(0, 2**31, size=ax.size)
    rots = rng.integers(0, 4, size=ax.size)
    ok = p.inside(ax, ay) & (keep_roll < density)
    if water is not None:
        ix = np.clip(ax.astype(np.int64), 0, p.cx - 1)
        iy = np.clip(ay.astype(np.int64), 0, p.cy - 1)
        ok &= ~water[iy, ix]
    k = np.nonzero(ok)[0]
    ok[k] = ~in_building(ax[k], ay[k]) & (roads.clearance(ax[k], ay[k]) >= 0.5 * kerb / m)
    k = np.nonzero(ok)[0]
    tall = np.zeros(ax.size, dtype=bool)
    if canopy is not None and len(k):
        # the same place beside the line the road was drawn from (half a cell
        # off the drawn axis at most), in real metres
        off = roads.line_offset(ox[k], oy[k])
        across = off[:, 0] * nx[k] + off[:, 1] * ny[k]
        x, y = p.from_cells(ax[k] + across * nx[k], ay[k] + across * ny[k])
        ok[k] &= ~in_clear_zone(x, y)
        # around that spot, across the road and along it (cells: y south)
        h = np.zeros(len(k))
        ex, ey = ny[k], nx[k]  # along the road, in metres east and north
        for a in (-spacing / 3, 0.0, spacing / 3):
            for t in (-search, 0.0, search):
                sx = x + t * nx[k] + a * ex
                sy = y - t * ny[k] + a * ey
                h = np.maximum(h, canopy.sample(sx, sy, p.region.crs))
        tall[k] = h >= float(rule["canopy"])
    ok &= tall
    return [
        {
            "g": rule["group"],
            "x": float(ax[j]),
            "y": float(ay[j]),
            "s": int(seeds[j]),
            "r": int(rots[j]),
        }
        for j in np.nonzero(ok)[0]
    ]


def _in_footprints(instances: list[dict]):
    """Test points (cells, as drawn) against the footprints placed so far."""
    polys = [shapely.Polygon(i["fp"]) for i in instances if "fp" in i and len(i["fp"]) >= 3]
    tree = shapely.STRtree(polys) if polys else None

    def fn(cx: np.ndarray, cy: np.ndarray) -> np.ndarray:
        hit = np.zeros(len(cx), dtype=bool)
        if tree is not None and len(cx):
            idx, _ = tree.query(shapely.points(cx, cy), predicate="within")
            hit[idx] = True
        return hit

    return fn


# the 16 directions modulo a half turn, in degrees from east (projected, y north)
_ALONG_ANGLES = (0.0, 26.57, 45.0, 63.43, 90.0, 116.57, 135.0, 153.43)


def along_turn(tx: float, ty: float, rule: dict[str, Any]) -> tuple[str, int]:
    """The group and quarter turns of a prop drawn along a line running
    (tx, ty) (projected, y north), for `along` (D-102, D-104). Its `group`
    is a model drawn along y (north-south), `diagonal` one drawn along
    x = y in cells (south-east), `slants` two drawn along (2, −1) and
    (1, −2) in cells (26.6° and 63.4° from east): each covers its
    direction and, turned a quarter, the one at right angles. A direction
    without its group takes the nearest one there is."""
    a = math.degrees(math.atan2(ty, tx)) % 180.0
    near = min(_ALONG_ANGLES, key=lambda d: min(abs(a - d), 180.0 - abs(a - d)))
    slants = list(rule.get("slants") or [])
    diagonal = rule.get("diagonal")
    if near in (26.57, 116.57) and slants:
        return slants[0], 0 if near == 26.57 else 1
    if near in (63.43, 153.43) and len(slants) > 1:
        return slants[1], 0 if near == 63.43 else 1
    if near in (45.0, 135.0) or (near not in (0.0, 90.0) and diagonal):
        if diagonal:
            # the nearest diagonal: 135 (south-east in cells) as drawn, 45 turned
            return diagonal, 0 if (near - 90.0) % 180.0 < 90.0 else 1
    return rule["group"], 0 if abs(ty) >= abs(tx) else 1


def street_trees(
    p: Placement, rule: dict[str, Any], road_rows: list[dict], occupied, tag: str = ""
) -> list[dict]:
    """Rows of trees (or props) on both sides of roads of the given classes.

    With `across`, one prop stands on the road's line at each step instead,
    over the road (road cells are otherwise kept clear) and turned a quarter
    where its road runs east-west, so a model drawn along x spans the street:
    lanterns strung across it. With `along`, one row on the road's left
    side, turned the same way so a model drawn along y runs with its road:
    utility poles whose wires reach to the next (D-102); with `diagonal`, that
    group stands where the road runs nearest a diagonal, and with `slants`
    two more at the 2:1 directions (see along_turn; D-103, D-104). `bounds` ([w, s, e,
    n], lon/lat) keeps a rule to one stretch of its roads.
    """
    classes = set(rule["roads"])
    spacing = float(rule["spacing"])
    offset = float(rule.get("offset", 12))
    across = bool(rule.get("across"))
    along = bool(rule.get("along"))
    codes = _codes(rule["landcover"]) if "landcover" in rule else None
    rng = np.random.default_rng(_seed(p.region, f"street|{tag}|{rule['group']}"))
    xs: list[float] = []
    ys: list[float] = []
    turns: list[int] = []
    groups: list[str] = []
    name = rule.get("name", "").lower()
    not_name = rule.get("notName", "").lower()
    if name or not_name:
        # names aren't in the road layer's columns; fetch them for this rule only
        road_rows = plugins.source(p.region, "features").streets(
            p.region.lonlat_envelope(), classes
        )
    for row in sorted(road_rows, key=lambda r: r["id"]):
        if row["class"] not in classes:
            continue
        called = ((row.get("names") or {}).get("primary") or "").lower()
        if (name and name not in called) or (not_name and not_name in called):
            continue
        line = p.project(shapely.from_wkt(row["geometry"]))
        parts = list(line.geoms) if hasattr(line, "geoms") else [line]
        for part in parts:
            length = part.length
            for d in np.arange(spacing / 2, length, spacing):
                a = part.interpolate(max(0.0, d - 1))
                b = part.interpolate(min(length, d + 1))
                tx, ty = b.x - a.x, b.y - a.y
                norm = math.hypot(tx, ty) or 1.0
                c = part.interpolate(d)
                if across:
                    # across a road running north-south is along x: no turn
                    xs.append(c.x)
                    ys.append(c.y)
                    turns.append(0 if abs(ty) >= abs(tx) else 1)
                    continue
                for side in (1,) if along else (-1, 1):
                    xs.append(c.x - side * ty / norm * offset)
                    ys.append(c.y + side * tx / norm * offset)
                    if along:
                        g, r = along_turn(tx, ty, rule)
                        groups.append(g)
                        turns.append(r)
    if not xs:
        return []
    ax, ay = np.asarray(xs), np.asarray(ys)
    cx, cy = p.to_cells(ax, ay)
    # over the road (or on a wall's line), only the world's edge, buildings and
    # landmarks keep props off
    over = across or bool(rule.get("_over"))
    ok = (p.inside(cx, cy) if over else p.free(cx, cy)) & ~occupied(ax, ay)
    if codes is not None:
        ok &= np.isin(p.landcover_at(ax, ay), list(codes))
    if "bounds" in rule:
        w, s, e, n = (float(v) for v in rule["bounds"])
        bx, by = transform_points("EPSG:4326", p.region.crs, [w, e], [s, n])
        ok &= (ax >= min(bx)) & (ax <= max(bx)) & (ay >= min(by)) & (ay <= max(by))
    seeds = rng.integers(0, 2**31, size=ax.size)
    rots = np.asarray(turns) if across or along else rng.integers(0, 4, size=ax.size)
    return [
        {
            "g": groups[k] if groups else rule["group"],
            "x": float(cx[k]),
            "y": float(cy[k]),
            "s": int(seeds[k]),
            "r": int(rots[k]),
        }
        for k in np.nonzero(ok)[0]
    ]


def _strokes(lines: list, max_turn: float = 30.0) -> list[np.ndarray]:
    """Streets as continuous lines (coordinate arrays): lines joined end to end
    where only two meet, and through a junction where one runs on into
    another, turning less than `max_turn` degrees; at each junction the
    straightest pairs join first."""
    parts = [g for ln in lines for g in (getattr(ln, "geoms", None) or [ln]) if g.length > 0]
    if not parts:
        return []
    merged = shapely.line_merge(shapely.MultiLineString(parts))
    segs = [np.asarray(g.coords) for g in getattr(merged, "geoms", [merged]) if g.length > 0]
    nodes: dict[tuple[float, float], list[tuple[int, int, np.ndarray]]] = {}
    for i, c in enumerate(segs):
        ln = shapely.LineString(c)
        for side in (0, 1):
            end = c[0] if side == 0 else c[-1]
            inner = ln.interpolate(
                min(5.0, ln.length / 2) if side == 0 else max(0, ln.length - 5.0)
            )
            d = np.array([inner.x, inner.y]) - end
            d = d / max(float(np.hypot(*d)), 1e-9)
            nodes.setdefault((round(end[0], 1), round(end[1], 1)), []).append((i, side, d))
    partner: dict[tuple[int, int], tuple[int, int]] = {}
    cos_max = math.cos(math.radians(max_turn))
    for ends in nodes.values():
        pairs = sorted(
            (float(np.dot(a[2], -b[2])), ka, kb)
            for ka, a in enumerate(ends)
            for kb, b in enumerate(ends)
            if ka < kb and a[0] != b[0]
        )
        for straight, ka, kb in reversed(pairs):
            ea, eb = ends[ka][:2], ends[kb][:2]
            if straight >= cos_max and ea not in partner and eb not in partner:
                partner[ea], partner[eb] = eb, ea
    out: list[np.ndarray] = []
    seen: set[int] = set()
    for i in range(len(segs)):
        if i in seen:
            continue
        # back to the chain's free end (or round a ring to where it started)
        line, enter = i, 0
        while (line, enter) in partner:
            j, sj = partner[(line, enter)]
            if j == i:
                break
            line, enter = j, 1 - sj
        coords: list[np.ndarray] = []
        while line not in seen:
            seen.add(line)
            c = segs[line] if enter == 0 else segs[line][::-1]
            coords.append(c if not coords else c[1:])
            nxt = partner.get((line, 1 - enter))
            if nxt is None:
                break
            line, enter = nxt
        out.append(np.vstack(coords))
    return out


def wired_props(
    p: Placement, rule: dict[str, Any], road_rows: list[dict], occupied, tag: str = ""
) -> list[dict]:
    """Props strung together (D-098), utility poles and their wires: along each
    street of the rule's road classes (_strokes), a prop every `spacing`
    metres on its left, `offset` metres from its centre line, turned as an
    `across` prop is (its x across the street); and between each two in a row,
    a span of the `wires` group, a line object from one to the next (`ln`, the
    props' positions in cells), drawn by its generator at any angle."""
    classes = set(rule["roads"])
    spacing = float(rule["spacing"])
    offset = float(rule.get("offset", 3.0))
    lines = [
        p.project(shapely.from_wkt(row["geometry"]))
        for row in sorted(road_rows, key=lambda r: r["id"])
        if row["class"] in classes
    ]
    rng = np.random.default_rng(_seed(p.region, f"wired|{tag}|{rule['group']}"))
    half = 0.06  # a span's footprint either side of its line, cells (about a voxel)
    out: list[dict] = []
    for stroke in _strokes(lines):
        ln = shapely.LineString(stroke)
        ds = np.arange(spacing / 2, ln.length, spacing)
        if not len(ds):
            continue
        c = shapely.line_interpolate_point(ln, ds)
        a = shapely.line_interpolate_point(ln, np.maximum(ds - 1, 0))
        b = shapely.line_interpolate_point(ln, np.minimum(ds + 1, ln.length))
        tx, ty = shapely.get_x(b) - shapely.get_x(a), shapely.get_y(b) - shapely.get_y(a)
        norm = np.maximum(np.hypot(tx, ty), 1e-9)
        ax = shapely.get_x(c) - ty / norm * offset
        ay = shapely.get_y(c) + tx / norm * offset
        cx, cy = p.to_cells(ax, ay)
        ok = p.inside(cx, cy) & ~occupied(ax, ay)
        if "bounds" in rule:
            w, s, e, n = (float(v) for v in rule["bounds"])
            bx, by = transform_points("EPSG:4326", p.region.crs, [w, e], [s, n])
            ok &= (ax >= min(bx)) & (ax <= max(bx)) & (ay >= min(by)) & (ay <= max(by))
        seeds = rng.integers(0, 2**31, size=len(ds) * 2)
        for k in np.nonzero(ok)[0]:
            out.append(
                {
                    "g": rule["group"],
                    "x": float(cx[k]),
                    "y": float(cy[k]),
                    "s": int(seeds[2 * k]),
                    "r": 0 if abs(ty[k]) >= abs(tx[k]) else 1,
                }
            )
            if k == 0 or not ok[k - 1]:
                continue
            pa, pb = np.array([cx[k - 1], cy[k - 1]]), np.array([cx[k], cy[k]])
            u = (pb - pa) / max(float(np.hypot(*(pb - pa))), 1e-9)
            nrm = np.array([u[1], -u[0]]) * half
            ring = [pa + nrm, pb + nrm, pb - nrm, pa - nrm]
            mid = 0.5 * (pa + pb)
            out.append(
                {
                    "g": rule["wires"],
                    "x": round(float(mid[0]), 3),
                    "y": round(float(mid[1]), 3),
                    "s": int(seeds[2 * k + 1]),
                    "fp": [[round(float(x), 3), round(float(y), 3)] for x, y in ring],
                    "ln": [round(float(v), 3) for v in (*pa, *pb)],
                    "lw": half,
                }
            )
    return out


def junction_props(
    p: Placement, rule: dict[str, Any], road_rows: list[dict], occupied, tag: str = ""
) -> list[dict]:
    """Props at junctions where 3+ segments of the given road classes meet (traffic
    signals): two per junction, on opposite corners `offset` metres out."""
    classes = set(rule["roads"])
    offset = float(rule.get("offset", 12))
    where: dict[str, tuple[float, float]] = {}
    count: dict[str, int] = {}
    for row in road_rows:
        if row["class"] not in classes:
            continue
        line = shapely.from_wkt(row["geometry"])
        if line.geom_type != "LineString":
            continue
        for conn in row.get("connectors") or []:
            at = float(conn.get("at") or 0.0)
            pt = line.interpolate(at, normalized=True)
            where[conn["connector_id"]] = (pt.x, pt.y)
            count[conn["connector_id"]] = count.get(conn["connector_id"], 0) + 1
    xs: list[float] = []
    ys: list[float] = []
    for cid in sorted(c for c, n in count.items() if n >= 3):
        lon, lat = where[cid]
        (x,), (y,) = transform_points("EPSG:4326", p.region.crs, [lon], [lat])
        for sx, sy in ((1, 1), (-1, -1)):
            xs.append(x + sx * offset * 0.7071)
            ys.append(y + sy * offset * 0.7071)
    if not xs:
        return []
    ax, ay = np.asarray(xs), np.asarray(ys)
    cx, cy = p.to_cells(ax, ay)
    ok = p.free(cx, cy) & ~occupied(ax, ay)
    rng = np.random.default_rng(_seed(p.region, f"junction|{tag}|{rule['group']}"))
    seeds = rng.integers(0, 2**31, size=ax.size)
    return [
        {"g": rule["group"], "x": float(cx[k]), "y": float(cy[k]), "s": int(seeds[k]), "r": 0}
        for k in np.nonzero(ok)[0]
    ]


def _height(row: dict, kind: str) -> float:
    if row.get("height"):
        return float(row["height"])
    if row.get("num_floors"):
        return float(row["num_floors"]) * FLOOR_METERS
    return DEFAULT_HEIGHT[kind]


def _kind(cls: str | None) -> str:
    if cls in RESIDENTIAL:
        return "residential"
    if cls in SMALL:
        return "small"
    return "other"


def building_group(cls: str | None, height_m: float, tower_m: float) -> str:
    if height_m >= tower_m:
        return "building.tower.hotel" if cls == "hotel" else "building.tower"
    if cls == "parking":
        return "building.parking"
    if _kind(cls) == "residential":
        return "building.residential"
    return "building.commercial"


def _footprint(p: Placement, poly, tolerance: float, ring=None) -> list[list[float]]:
    """A footprint's outline in cells; with `ring` (a hole of `poly`), that
    ring, placed exactly as the outline is."""
    ring = poly.simplify(tolerance).exterior if ring is None else ring
    coords = np.asarray(ring.coords)[:-1]
    if p.layout is None:
        cx, cy = p.to_cells(coords[:, 0], coords[:, 1], shift=False)
        if p.shift is not None:
            # moved whole, by its centroid's shift, so its shape stays rigid
            c = poly.centroid
            ox, oy = p.to_cells(np.array([c.x]), np.array([c.y]), shift=False)
            dx, dy = p.shift(ox, oy)
            cx, cy = cx + dx[0], cy + dy[0]
    else:
        # rigid stamp: the local similarity around the centroid, so shapes never shear
        c = poly.centroid
        ox, oy = p.to_cells(np.array([c.x]), np.array([c.y]))
        d = (coords - np.array([c.x, c.y])) @ p.similarity(c.x, c.y).T
        cx, cy = ox[0] + d[:, 0], oy[0] + d[:, 1]
    return [[round(float(x), 2), round(float(y), 2)] for x, y in zip(cx, cy, strict=True)]


# Overture roof shapes the building generator draws (anything else is flat)
ROOF_SHAPES = {"flat", "pyramidal", "dome", "hipped", "half_hipped", "gabled", "skillion"}


def _courtyards(p: Placement, poly, tolerance: float, min_area: float) -> list[list[list[float]]]:
    """A footprint's courtyards (its holes) in cells, placed as its outline is;
    those under `min_area` m² are left filled."""
    out = []
    for hole in poly.interiors:
        h = shapely.Polygon(hole)
        if h.area < min_area:
            continue
        ring = h.simplify(tolerance).exterior
        if len(ring.coords) >= 4:
            out.append(_footprint(p, poly, tolerance, ring))
    return out


def _moved_rings(rings: list, f) -> list:
    """Courtyard rings (`fh`) through the same transform as the outline: f maps
    an (n, 2) array of cells."""
    return [[[round(float(x), 2), round(float(y), 2)] for x, y in f(np.asarray(r))] for r in rings]


def _hints(row: dict) -> dict:
    """Shape and colour hints from Overture for the building generator (M3).
    `_roof` keeps any roof shape for typology rules (`roofs:`); like every
    `_` key it's left out of the package."""
    out: dict[str, Any] = {}
    if row.get("roof_shape") in ROOF_SHAPES:
        out["rs"] = row["roof_shape"]
    if isinstance(row.get("roof_shape"), str) and row["roof_shape"]:
        out["_roof"] = row["roof_shape"]
    for key, col in (("fc", "facade_color"), ("rc", "roof_color")):
        v = row.get(col)
        if isinstance(v, str) and v.startswith("#") and len(v) == 7:
            out[key] = v.lower()
    if row.get("facade_material"):
        out["fm"] = str(row["facade_material"])
    return out


def lidar_massing(
    geom, grid, overture_height: float | None, spec: dict[str, Any]
) -> tuple[float, list] | None:
    """Height (and tower parts) of a footprint from a lidar height grid (D-052).

    Returns None to keep the Overture height: when lidar covers less than half
    the footprint, or Overture has a height and lidar doesn't see one well above
    it (ML-estimated heights of large complexes can be far too low). Otherwise
    (podium height, [(tower polygon, height), ...]): tower parts are connected
    regions of at least `minTowerArea` m² whose roofs stand more than
    `towerGap` m above the footprint's median roof.
    """
    from rasterio import features
    from rasterio.transform import Affine
    from scipy import ndimage

    r0, r1, c0, c1 = grid.window(geom.bounds)
    if r1 <= r0 or c1 <= c0:
        return None
    sub = grid.heights[r0:r1, c0:c1]
    cov = grid.covered[r0:r1, c0:c1]
    tr = grid.transform @ Affine.translation(c0, r0)
    inside = features.geometry_mask([geom], sub.shape, tr, invert=True)
    if inside.sum() < 3 or cov[inside].mean() < 0.5:
        return None
    roof = inside & (sub > 2.0)
    if roof.sum() < max(2, 0.2 * inside.sum()):
        return None
    h = sub[roof]
    p50, p95 = float(np.percentile(h, 50)), float(np.percentile(h, 95))
    if overture_height and not (p95 > 1.5 * overture_height and p95 - overture_height > 15):
        return None
    cell_m2 = grid.res**2
    gap = float(spec.get("towerGap", 25.0))
    towers = []
    if roof.sum() * cell_m2 >= 3000 and p95 - p50 > gap:
        tall = roof & (sub > p50 + gap)
        tall = ndimage.binary_opening(tall)
        labels, n = ndimage.label(tall, structure=np.ones((3, 3)))
        min_area = float(spec.get("minTowerArea", 600.0))
        for k in range(1, n + 1):
            comp = labels == k
            if comp.sum() * cell_m2 < min_area:
                continue
            shapes = [
                shapely.geometry.shape(g)
                for g, v in features.shapes(comp.astype(np.uint8), mask=comp, transform=tr)
                if v == 1
            ]
            poly = shapely.union_all(shapes).simplify(grid.res * 0.75).intersection(geom)
            if poly.is_empty or poly.area < min_area:
                continue
            towers.append((poly, round(float(np.percentile(sub[comp], 95)), 1)))
    podium = max(4.0, p50) if towers else max(4.0, p95)
    return round(podium, 1), towers


def footprint_width(geom) -> float:
    """The narrow side of a footprint's smallest enclosing rectangle (metres)."""
    rect = shapely.minimum_rotated_rectangle(geom)
    if rect.geom_type != "Polygon":
        return 0.0
    xy = np.asarray(rect.exterior.coords)
    sides = np.hypot(*np.diff(xy[:3], axis=0).T)
    return float(sides.min())


def implausible_footprint(row: dict, geom, rule: dict[str, Any]) -> bool:
    """True for a footprint no building would have (by itself; the caller
    checks that it stands in a park): no class, type or name, no parts, at
    most `maxArea` m², and a stated height (Overture's, or its floors) of at
    least `minHeight` m and `minAspect` times its width."""
    if row.get("class") or row.get("subtype") or row.get("has_parts"):
        return False
    if ((row.get("names") or {}).get("primary") or "").strip():
        return False
    rule = IMPLAUSIBLE | rule
    if geom.area > float(rule["maxArea"]):
        return False
    if row.get("height"):
        height = float(row["height"])
    elif row.get("num_floors"):
        height = float(row["num_floors"]) * FLOOR_METERS
    else:
        return False  # a default height is plausible by construction
    if height < float(rule["minHeight"]):
        return False
    return height >= float(rule["minAspect"]) * footprint_width(geom)


def replaced_by_landmark(row: dict, replaces: set[str]) -> bool:
    """True if a landmark stands in for this building (by Overture id or name)."""
    if not replaces:
        return False
    if row["id"] in replaces:
        return True
    name = ((row.get("names") or {}).get("primary") or "").strip().lower()
    return bool(name) and name in replaces


def place_buildings(
    p: Placement,
    spec: dict[str, Any],
    rows: list[dict],
    parts: list[dict],
    clear,
    replaces: set[str] | None = None,
    heights: list | None = None,
    stats: dict | None = None,
    parks: list | None = None,
) -> tuple[list[dict], list]:
    """Footprint instances (buildings, and parts of buildings that have them).
    Buildings a landmark replaces (D-051) are left out, with their parts.
    With a lidar height grid (`heights`, D-052), buildings without a height (or
    with one far below what lidar sees) take lidar's, and large footprints whose
    roofs stand well above their podium get lidar-derived tower parts.
    Implausible footprints (`implausible_footprint`) whose centroid lies in
    one of the `parks` (projected polygons) are left out; `stats` counts those
    that would have been drawn."""
    min_area = float(spec.get("minArea", 30))
    courtyards = bool(spec.get("courtyards", False))
    tower_m = float(spec.get("towerMeters", 45))
    podium_m = float(spec.get("podiumMeters", 15))
    tolerance = float(spec.get("simplifyMeters", 2))
    implausible = spec.get("implausible", {})
    park_tree = shapely.STRtree(parks) if parks and implausible is not None else None
    out: list[dict] = []
    polys = []
    parts_by_building: dict[str, list[dict]] = {}
    # parts standing on others (Overture's setback tiers) are dropped, or with
    # `tiers` drawn from the ground (where they stand over their building's
    # footprint), so a setback tower keeps its upper tiers
    tiers = bool(spec.get("tiers"))
    for part in parts:
        if tiers or float(part.get("min_height") or 0) <= 3:
            parts_by_building.setdefault(part["building_id"], []).append(part)

    def placed(poly) -> tuple | None:
        """(projected centroid, cell x, cell y) of a polygon that is drawn
        (large enough, inside the grid, clear of landmarks), else None."""
        if poly.geom_type != "Polygon" or poly.area < min_area:
            return None
        c = poly.centroid
        cx, cy = p.to_cells(np.array([c.x]), np.array([c.y]))
        if not p.inside(cx, cy)[0] or clear(c.x, c.y):
            return None
        return c, cx, cy

    def in_park(geom) -> bool:
        hits = park_tree.query(geom.centroid, predicate="within")
        return len(hits) > 0

    def add(
        row: dict, cls: str | None, height_m: float, group: str, hints: dict, geom=None, name=""
    ) -> None:
        geom = geom if geom is not None else p.project(shapely.from_wkt(row["geometry"]))
        for poly in list(geom.geoms) if hasattr(geom, "geoms") else [geom]:
            at = placed(poly)
            if at is None:
                continue
            c, cx, cy = at
            polys.append(poly)
            inst = {
                "g": building_group(cls, height_m, tower_m),
                "x": round(float(cx[0]), 3),
                "y": round(float(cy[0]), 3),
                "s": _stable_int(row["id"]),
                "fp": _footprint(p, poly, tolerance),
                "hm": round(height_m, 1),
                "_grp": group,  # building id (parts join their building); see depict_buildings
                "_c": (float(c.x), float(c.y)),  # projected centroid (facts lookup, D-055)
                "_name": name,  # the building's Overture name (`names:` rules); parts share it
                "_cls": cls or "",  # its Overture class (`kinds:` rules); parts share it
                **hints,
            }
            if p.layout is not None:
                inst["m"] = round(p.scale_at(c.x, c.y), 2)
            if courtyards and poly.interiors:
                holes = _courtyards(p, poly, tolerance, min_area)
                if holes:
                    inst["fh"] = holes
            out.append(inst)

    small_house_m2 = float(spec.get("houseMaxArea", 0))
    skip = {r.lower() for r in (replaces or set())} | set(replaces or set())
    for row in rows:
        if replaced_by_landmark(row, skip):
            continue
        geom = p.project(shapely.from_wkt(row["geometry"]))
        if park_tree is not None and implausible_footprint(row, geom, implausible):
            if in_park(geom):
                if stats is not None and any(
                    placed(g) is not None for g in getattr(geom, "geoms", [geom])
                ):
                    stats["implausible"] = stats.get("implausible", 0) + 1
                continue
        cls = row.get("class")
        if cls is None and small_house_m2 > 0 and geom.area <= small_house_m2:
            # ML-derived footprints carry no class; small ones in a city are houses
            cls = "house"
        height = _height(row, _kind(cls))
        my_parts = parts_by_building.get(row["id"], []) if row.get("has_parts") else []
        if tiers:
            my_parts = [
                pt
                for pt in my_parts
                if float(pt.get("min_height") or 0) <= 3
                or geom.contains(p.project(shapely.from_wkt(pt["geometry"])).representative_point())
            ]
        hints = _hints(row)
        name = str((row.get("names") or {}).get("primary") or "")
        if heights and not my_parts:
            got = None
            for grid in heights:  # the first grid that covers the footprint
                got = lidar_massing(geom, grid, row.get("height"), spec.get("lidar") or {})
                if got is not None:
                    break
            if got is not None:
                podium, towers = got
                if stats is not None:
                    stats["lidarHeights"] = stats.get("lidarHeights", 0) + 1
                    stats["lidarTowers"] = stats.get("lidarTowers", 0) + len(towers)
                if towers:
                    add(row, cls, podium, row["id"], {}, geom, name)
                    for k, (poly, h) in enumerate(towers):
                        add({"id": f"{row['id']}#t{k}"}, cls, h, row["id"], hints, poly, name)
                else:
                    add(row, cls, podium, row["id"], hints, geom, name)
                continue
        if my_parts:
            add(row, cls, min(height, podium_m), row["id"], {}, geom, name)
            for part in sorted(my_parts, key=lambda r: r["id"]):
                add(part, cls, _height(part, "other"), row["id"], hints, name=name)
        else:
            if not row.get("height") and not row.get("num_floors"):
                # a default height: a facts source's may replace it (type_buildings)
                hints = {**hints, "_hdef": True}
            add(row, cls, height, row["id"], hints, geom, name)
    return out, polys


def park_polygons(region: Region, spec: dict[str, Any], boxes: list) -> list | None:
    """Projected park polygons for the implausible-footprint rule, over the
    buildings' lon/lat boxes; None where the spec turns the rule off."""
    from .ground import project_rows

    rule = spec.get("implausible", {})
    if rule is None:
        return None
    lawn = (region.ground or {}).get("lawn") or {}
    classes = list(rule.get("landUse") or lawn.get("landUse") or PARK_LAND_USE)
    source = plugins.source(region, "features")
    rows: dict[str, dict] = {}
    for box in boxes:
        for r in source.land_use(tuple(box), classes):
            rows[r["id"]] = r
    return project_rows(region, [rows[k] for k in sorted(rows)])


def type_buildings(
    region: Region, found: list[dict], spec: dict, streets, water, tower_m: float = 45.0
) -> list[dict]:
    """Building typologies (D-055): features, facts and the spec's rules. The
    facts come from the facts source the spec selects (`sources.facts`). A
    building Overture gives no height or floors takes the facts' `height`
    (D-084), and becomes a tower at `tower_m` or more. With `roofHints`, one
    Overture gives no roof shape takes the facts' `roof` as its generator's
    hint (D-100)."""
    from . import facts as facts_sources
    from . import typology

    facts = None
    source = facts_sources.open_facts(region)
    if source is not None:
        has = [i for i, inst in enumerate(found) if "_c" in inst]
        xs = np.array([found[i]["_c"][0] for i in has])
        ys = np.array([found[i]["_c"][1] for i in has])
        got = list(source.at(xs, ys))
        if len(got) != len(has):
            raise ValueError(f"facts source answered {len(got)} of {len(has)} points")
        facts = [None] * len(found)
        filled = roofed = 0
        roof_hints = bool(spec.get("roofHints"))
        for i, f in zip(has, got, strict=True):
            facts[i] = f
            if f and f.get("height") and found[i].pop("_hdef", False):
                found[i]["hm"] = round(float(f["height"]), 1)
                if found[i]["hm"] >= tower_m and found[i]["g"] in typology.GENERIC[:2]:
                    found[i]["g"] = "building.tower"
                filled += 1
            # the facts' roof shape as the generator's hint where Overture gives none (D-100)
            if roof_hints and f and f.get("roof") in ROOF_SHAPES and "rs" not in found[i]:
                found[i]["rs"] = f["roof"]
                roofed += 1
        known = sum(f is not None for f in got)
        progress.log(
            f"typology facts: {facts_sources.describe(source)}, "
            f"{known}/{len(has)} buildings with facts, {filled} heights from facts"
            + (f", {roofed} roof shapes from facts" if roof_hints else "")
        )
    feats = typology.features(found, streets, water, region.meters_per_cell, facts)
    grounds = sorted({str(c) for rule in spec.get("rules", []) for c in rule.get("grounds", [])})
    if grounds:
        _ground_features(region, found, feats, grounds)
    if any("bounds" in r for r in spec.get("rules", [])):
        # centroids in lon/lat, for rules kept to a neighbourhood's box
        has = [i for i, inst in enumerate(found) if "_c" in inst and feats[i]]
        lon, lat = transform_points(
            region.crs,
            "EPSG:4326",
            [found[i]["_c"][0] for i in has],
            [found[i]["_c"][1] for i in has],
        )
        for i, a, b in zip(has, lon, lat, strict=True):
            feats[i]["lonlat"] = (a, b)
    counts = typology.classify(found, spec, feats)
    progress.log(f"typology: {counts}")
    return found


def _ground_features(region: Region, found: list[dict], feats: list[dict], classes: list[str]):
    """The land-use class (Overture's, of `classes`) under each building's
    centroid, as the feature `ground` (`grounds:` rules, D-100): a temple's or
    a shrine's grounds (OSM's landuse=religious), a cemetery."""
    from .ground import project_rows

    rows = plugins.source(region, "features").land_use(tuple(region.lonlat_envelope()), classes)
    polys = project_rows(region, rows)
    if not polys:
        return
    kinds = [str(r.get("class") or "") for r in rows]
    tree = shapely.STRtree(polys)
    has = [i for i, inst in enumerate(found) if "_c" in inst and feats[i]]
    pts = shapely.points([found[i]["_c"] for i in has])
    hit, poly = tree.query(pts, predicate="within")
    for k, j in zip(hit.tolist(), poly.tolist(), strict=True):
        feats[has[k]]["ground"] = kinds[j]
    n = len(set(hit.tolist()))
    progress.log(f"typology grounds: {n} buildings in {len(polys)} areas of {classes}")


def snap_buildings(instances: list[dict], spec: dict[str, Any]) -> list[dict]:
    """Turn buildings to the nearest of the 8 grid directions (D-049).

    A building whose footprint edges run within `angle` degrees of a grid axis
    or diagonal turns about its anchor to run exactly along it (its parts turn
    with it), so its walls draw as clean pixel lines. Irregular footprints,
    whose edges agree on no direction, are left as they are.
    """
    limit = np.radians(float(spec.get("angle", 12.0)))
    groups: dict[str, list[dict]] = {}
    for inst in instances:
        groups.setdefault(inst["_grp"], []).append(inst)
    turn: dict[str, float] = {}
    for g, insts in groups.items():
        fp = np.asarray(insts[0]["fp"], dtype=np.float64)
        e = np.roll(fp, -1, axis=0) - fp
        length = np.hypot(e[:, 0], e[:, 1])
        if length.sum() <= 0:
            continue
        # edge directions modulo 45°: the 8-fold angle averages them
        z = (length * np.exp(8j * np.arctan2(e[:, 1], e[:, 0]))).sum() / length.sum()
        psi = np.angle(z) / 8.0
        if abs(z) >= 0.5 and 1e-4 < abs(psi) <= limit:
            turn[g] = -psi
    out = []
    for inst in instances:
        a = turn.get(inst["_grp"])
        if a is None:
            out.append(inst)
            continue
        root = groups[inst["_grp"]][0]
        c, s_ = np.cos(a), np.sin(a)
        rot = np.array([[c, -s_], [s_, c]])
        o = np.array([root["x"], root["y"]])
        fp = (np.asarray(inst["fp"]) - o) @ rot.T + o
        xy = rot @ (np.array([inst["x"], inst["y"]]) - o) + o
        new = {
            **inst,
            "x": round(float(xy[0]), 3),
            "y": round(float(xy[1]), 3),
            "fp": [[round(float(x), 2), round(float(y), 2)] for x, y in fp],
        }
        if inst.get("fh"):
            new["fh"] = _moved_rings(inst["fh"], lambda r, o=o, rot=rot: (r - o) @ rot.T + o)
        out.append(new)
    return out


_DIRS = ((0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1))


def road_strips(mask: np.ndarray, half_width: np.ndarray) -> list:
    """The drawn asphalt (D-050) as polygons in cells: each road cell's
    centre-to-neighbour strips, buffered by its half-width, as the client
    draws them."""
    out = []
    ys, xs = np.nonzero(mask & 0xFF)
    for y, x in zip(ys.tolist(), xs.tolist(), strict=True):
        m, r = int(mask[y, x]), float(half_width[y, x])
        if r <= 0:
            continue
        for i, (dx, dy) in enumerate(_DIRS):
            if (m >> i) & 1:
                a = (x + 0.5, y + 0.5)
                out.append(
                    shapely.LineString([a, (a[0] + 0.5 * dx, a[1] + 0.5 * dy)]).buffer(
                        r, quad_segs=2
                    )
                )
    return out


def clear_of_roads(
    instances: list[dict],
    strips: list,
    nudge: float,
    min_share: float = 0.05,
    min_area: float = 0.01,
) -> tuple[list[dict], dict[str, int]]:
    """Buildings moved off the drawn roads (D-049, D-050): the shift moves a
    building with its streets, and roads are drawn at their real width along
    straightened lines, so a footprint can end up over asphalt. A building
    whose footprint (with its parts) overlaps the asphalt by `min_share` of its
    area (and at least `min_area` cells²) moves away from it, whole, up to
    `nudge` cells: along the line from the overlap to its centre, by the
    smallest step that clears it. One still over the road after that is
    trimmed: each footprint loses the asphalt, keeping its largest piece."""
    stats = {"nudged": 0, "trimmed": 0}
    if not strips:
        return instances, stats
    tree = shapely.STRtree(strips)

    def asphalt(geom):
        hit = tree.query(geom, predicate="intersects")
        return shapely.union_all([strips[i] for i in hit]) if len(hit) else None

    def over(geom) -> float:
        a = asphalt(geom)
        return 0.0 if a is None else geom.intersection(a).area

    groups: dict[str, list[int]] = {}
    for i, inst in enumerate(instances):
        if inst.get("fp") and inst["g"].startswith("building"):
            groups.setdefault(inst.get("_grp", str(i)), []).append(i)
    out = list(instances)
    for members in groups.values():
        polys = [shapely.Polygon(out[i]["fp"]).buffer(0) for i in members]
        shape = shapely.union_all(polys)
        road = asphalt(shape)
        if road is None or shape.area <= 0:
            continue
        lap = shape.intersection(road)
        if lap.area < max(min_area, min_share * shape.area):
            continue
        away = np.array([shape.centroid.x - lap.centroid.x, shape.centroid.y - lap.centroid.y])
        length = float(np.hypot(*away))
        moved = None
        if length > 1e-6 and nudge > 0:
            away /= length
            for step in np.linspace(nudge / 8, nudge, 8):
                v = away * step
                if over(shapely.transform(shape, lambda c, v=v: c + v)) <= 0.1 * lap.area:
                    moved = v
                    break
        if moved is not None:
            stats["nudged"] += 1
            for i in members:
                inst = out[i]
                fp = np.asarray(inst["fp"]) + moved
                out[i] = {
                    **inst,
                    "x": round(float(inst["x"] + moved[0]), 3),
                    "y": round(float(inst["y"] + moved[1]), 3),
                    "fp": [[round(float(x), 2), round(float(y), 2)] for x, y in fp],
                }
                if inst.get("fh"):
                    out[i]["fh"] = _moved_rings(inst["fh"], lambda r, v=moved: r + v)
            continue
        stats["trimmed"] += 1
        for i, poly in zip(members, polys, strict=True):
            rest = poly.difference(road).simplify(0.02)
            pieces = list(rest.geoms) if hasattr(rest, "geoms") else [rest]
            pieces = [g for g in pieces if g.geom_type == "Polygon" and g.area > 0]
            if not pieces:
                continue  # wholly on the road: left as it is rather than lost
            best = max(pieces, key=lambda g: g.area)
            ring = np.asarray(best.exterior.coords)[:-1]
            out[i] = {**out[i], "fp": [[round(float(x), 2), round(float(y), 2)] for x, y in ring]}
    return out, stats


def depict_buildings(p: Placement, instances: list[dict], spec: dict[str, Any]) -> list[dict]:
    """Apply a level's building depiction: drop buildings lower than
    `minHeightMeters` and draw the rest `scale` times their size about the
    building's anchor (parts move with their building). Scaled-up buildings go
    tallest first; one that would overlap a building already placed is left out."""
    scale = float(spec.get("scale", 1.0))
    min_h = float(spec.get("minHeightMeters", 0.0))
    if scale == 1.0 and min_h <= 0.0:
        return [{k: v for k, v in inst.items() if not k.startswith("_")} for inst in instances]
    groups: dict[str, list[dict]] = {}
    for inst in instances:
        groups.setdefault(inst["_grp"], []).append(inst)
    tops = {g: max(i.get("hm", 0.0) for i in insts) for g, insts in groups.items()}
    keep: dict[str, list[dict]] = {}
    placed: list = []
    for g in sorted(groups, key=lambda g: (-tops[g], g)):
        if tops[g] < min_h:
            continue
        insts = groups[g]
        if scale == 1.0:
            keep[g] = insts
            continue
        ax, ay = insts[0]["x"], insts[0]["y"]
        moved = []
        for inst in insts:
            fp = (np.asarray(inst["fp"]) - (ax, ay)) * scale + (ax, ay)
            new = {
                **inst,
                "x": round(ax + (inst["x"] - ax) * scale, 3),
                "y": round(ay + (inst["y"] - ay) * scale, 3),
                "fp": [[round(float(x), 2), round(float(y), 2)] for x, y in fp],
                "m": round(inst.get("m", p.m) / scale, 2),
            }
            if inst.get("fh"):
                new["fh"] = _moved_rings(
                    inst["fh"], lambda r, ax=ax, ay=ay: (r - (ax, ay)) * scale + (ax, ay)
                )
            moved.append(new)
        if scale > 1.0:
            shape = shapely.union_all([shapely.Polygon(i["fp"]).buffer(0) for i in moved])
            if any(shape.intersection(o).area > 0.02 * min(shape.area, o.area) for o in placed):
                continue
            placed.append(shape)
        keep[g] = moved
    out = []
    for inst in instances:  # original order, so output is stable
        if inst["_grp"] in keep:
            out.extend(keep.pop(inst["_grp"]))
    for inst in out:
        for k in [k for k in inst if k.startswith("_")]:
            del inst[k]
    return out


def _street_axis(
    a: np.ndarray, b: np.ndarray, streets: list | None
) -> tuple[np.ndarray, np.ndarray] | None:
    """The axis of the street a bridge a→b carries: a line fitted through the
    nearest street points along the span (within 4 cells), as long as a→b and
    centred where a→b's middle falls on it; None where no street runs along."""
    if not streets:
        return None
    geoms = []
    for _, _, parts in streets:
        for xs, ys in parts:
            if len(xs) >= 2:
                geoms.append(shapely.LineString(np.column_stack([xs, ys])))
    if not geoms:
        return None
    tree = shapely.STRtree(geoms)
    pts = []
    for t in np.linspace(0.05, 0.95, 19):
        pt = a + t * (b - a)
        i = tree.query_nearest(shapely.Point(pt), max_distance=4.0)
        if len(i) == 0:
            continue
        g = geoms[int(i[0])]
        q = g.interpolate(g.project(shapely.Point(pt)))
        pts.append((q.x, q.y))
    if len(pts) < 5:
        return None
    q = np.asarray(pts)
    c = q.mean(axis=0)
    _, _, vt = np.linalg.svd(q - c)
    u = vt[0]
    if np.dot(u, b - a) < 0:
        u = -u
    half = 0.5 * float(np.hypot(*(b - a)))
    mid = c + u * float(np.dot(0.5 * (a + b) - c, u))
    return mid - half * u, mid + half * u


def dam_footprint(
    p: Placement,
    line,
    thickness_m: float,
    bulge: float = 0.15,
    snap_deg: float | None = None,
    streets: list | None = None,
) -> list[list[float]]:
    """An arch-dam footprint in cells: a band along the abutment line, bowed
    upstream (to the left of the line) by `bulge` of its length.

    With snap_deg (bridges), the line moves with its road (the shift field at
    its middle) and turns about its middle to the nearest of the 8 grid
    directions within that many degrees, as its road did (D-049); dams stay
    fitted to their canyon."""
    (lon0, lat0), (lon1, lat1) = line
    xs, ys = transform_points("EPSG:4326", p.region.crs, [lon0, lon1], [lat0, lat1])
    ax, ay = p.to_cells(np.array(xs), np.array(ys), shift=False)  # fitted to its canyon
    a = np.array([ax[0], ay[0]])
    b = np.array([ax[1], ay[1]])
    if snap_deg is not None:
        mid = 0.5 * (a + b)
        if p.shift is not None:
            dx, dy = p.shift(np.array([mid[0]]), np.array([mid[1]]))
            mid = mid + np.array([float(dx[0]), float(dy[0])])
        half_vec = 0.5 * (b - a)
        a, b = mid - half_vec, mid + half_vec
        # follow the road it carries, which snapping may or may not have straightened
        on_street = _street_axis(a, b, streets)
        if on_street is not None:
            a, b = on_street
        else:
            ang = math.atan2(half_vec[1], half_vec[0])
            target = round(ang / (math.pi / 4)) * (math.pi / 4)
            if abs(math.degrees(ang - target)) <= snap_deg:
                ang = target
            r = float(np.hypot(*half_vec))
            half_vec = np.array([math.cos(ang), math.sin(ang)]) * r
            a, b = mid - half_vec, mid + half_vec
    along = b - a
    length = float(np.hypot(*along))
    n = np.array([along[1], -along[0]]) / max(length, 1e-9)  # left of the line, in cells
    half = 0.5 * thickness_m / p.scale_at(0.5 * (xs[0] + xs[1]), 0.5 * (ys[0] + ys[1]))
    t = np.linspace(0, 1, 9)
    centre = (
        a[None, :] + t[:, None] * along[None, :] + (4 * bulge * length * t * (1 - t))[:, None] * n
    )
    outer = centre + half * n
    inner = centre - half * n
    ring = np.concatenate([outer, inner[::-1]])
    return [[round(float(x), 2), round(float(y), 2)] for x, y in ring]


def taken_cells(instances: list[dict], shape: tuple[int, int], ring: int = 1) -> np.ndarray:
    """Cells an object stands on: footprints (every cell they touch), and the
    cell of an object without one with `ring` cells around it (a landmark
    drawn bigger than its cell)."""
    from rasterio import features
    from rasterio.transform import Affine

    out = np.zeros(shape, dtype=bool)
    polys = [shapely.Polygon(inst["fp"]) for inst in instances if inst.get("fp")]
    if polys:
        out |= features.geometry_mask(
            polys, shape, Affine.identity(), invert=True, all_touched=True
        )
    h, w = shape
    for inst in instances:
        if inst.get("fp"):
            continue
        x, y = int(math.floor(inst["x"])), int(math.floor(inst["y"]))
        out[max(0, y - ring) : min(h, y + ring + 1), max(0, x - ring) : min(w, x + ring + 1)] = True
    return out


def lowrise(
    spec: dict[str, Any], built: np.ndarray, blocked: np.ndarray, taken: np.ndarray, mpc=None
) -> list[dict]:
    """Low-rise city blocks (`objects.lowrise`): on a coarse level single houses
    are far below a cell, so built-up land would read as an empty plain around
    its towers. Every `built` cell that isn't `blocked` (roads, water, cliffs)
    or `taken` by another object gets one instance of `group` covering the
    cell, which the style draws as blocks of low buildings between streets.

        lowrise: { group: city.blocks, heightMeters: 8 }

    `heightMeters` is the instances' real height (the generator varies it by
    block); mpc (warped layouts) gives each its local metres per cell."""
    group = str(spec.get("group", "city.blocks"))
    height = float(spec.get("heightMeters", 8.0))
    ys, xs = np.nonzero(built & ~blocked & ~taken)
    out = []
    for y, x in zip(ys.tolist(), xs.tolist(), strict=True):
        inst = {
            "g": group,
            "x": x + 0.5,
            "y": y + 0.5,
            "s": _stable_int(f"lowrise|{x}|{y}") & 0x7FFFFFFF,
            "fp": [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]],
            "hm": height,
        }
        if mpc is not None:
            inst["m"] = round(float(mpc[y, x]), 2)
        out.append(inst)
    return out


def reservoirs(
    region: Region, layout, shape: tuple[int, int], heights
) -> list[tuple[np.ndarray, np.ndarray, int]]:
    """Lakes held behind dams: a line landmark with `crestMeters` and `reservoir`
    (metres below its crest the water stands). For each, the cells just
    upstream of the dam, (xs, ys), where its lake meets it, and the level in
    steps the lake is raised to: the drawn height of crest − reservoir, rounded
    down so the water stays under the crest.

    heights(x, y, metres) → drawn height in steps at a projected point, as
    for dam crests."""
    out: list[tuple[np.ndarray, np.ndarray, int]] = []
    dams = [
        lm
        for lm in (region.objects or {}).get("landmarks") or []
        if "line" in lm and "reservoir" in lm and "crestMeters" in lm
    ]
    if not dams:
        return out
    p = Placement(region, np.zeros(shape, dtype=bool), layout)
    for lm in dams:
        fp = np.asarray(
            dam_footprint(
                p, lm["line"], float(lm.get("thicknessM", 60)), float(lm.get("bulge", 0.15))
            )
        )
        m = len(fp) // 2
        outer, inner = fp[:m], fp[m:][::-1]  # the upstream edge (where it bows), downstream
        n = outer - inner
        n /= np.maximum(np.hypot(n[:, 0], n[:, 1]), 1e-9)[:, None]
        # one to two and a half cells upstream of the upstream face
        reach = np.arange(0.5, 2.6, 0.5)
        pts = (outer[None, :, :] + reach[:, None, None] * n[None, :, :]).reshape(-1, 2)
        # the crest's height is taken where place() takes it: the line's middle
        (lon0, lat0), (lon1, lat1) = lm["line"]
        mx, my = transform_points(
            "EPSG:4326", region.crs, [0.5 * (lon0 + lon1)], [0.5 * (lat0 + lat1)]
        )
        surface = float(lm["crestMeters"]) - float(lm["reservoir"])
        level = math.floor(float(heights(mx[0], my[0], surface)) + 1e-9)
        out.append((pts[:, 0], pts[:, 1], level))
    return out


SEGMENT_CELLS = 12.0


# a bridge approach's grade: real metres down per metre along (D-131)
APPROACH_GRADE = 0.06


def bridge_approaches(
    fp: list,
    ground: np.ndarray,
    water: np.ndarray,
    top: float,
    slope: float,
    road: np.ndarray | None = None,
) -> tuple[list[list[float]], list[float], list[float]]:
    """A bridge's approaches (D-131): beyond each end of its line, over land, the
    deck comes down `slope` steps a cell until it meets the ground, as a viaduct
    carries a deck from its anchorage to the road on the bank (the Golden Gate's
    over Fort Point). With `road` (the road mask) it lands sooner where its road
    leaves the line (no road on the line or a cell either side), coming down
    steeper, so the road's traffic stays on it. Returns the footprint grown by
    them, each end's approach length (cells) and the ground where it lands
    (steps). An end with water or the grid's edge before the deck lands has none:
    it stays where it was.
    """
    ring = np.asarray(fp, dtype=np.float64)
    m = len(ring) // 2
    outer, inner = ring[:m], ring[m:][::-1]
    centre = 0.5 * (outer + inner)
    a, b = centre[0], centre[-1]
    half = float(np.hypot(*(outer[0] - centre[0])))
    length = float(np.hypot(*(b - a)))
    if length == 0 or slope <= 0:
        return fp, [0.0, 0.0], [0.0, 0.0]
    u = (b - a) / length
    h, w = ground.shape

    across = np.array([-u[1], u[0]])

    def on_road(p: np.ndarray) -> bool:
        for k in (0.0, -1.0, 1.0):
            x, y = math.floor(p[0] + across[0] * k), math.floor(p[1] + across[1] * k)
            if 0 <= x < w and 0 <= y < h and road[y, x]:
                return True
        return False

    def walk(end: np.ndarray, d: np.ndarray) -> tuple[float, float]:
        last = None  # the last step still on the road: (s, ground there)
        for s in np.arange(0.5, top / slope + 2.0, 0.5):
            p = end + d * s
            x, y = math.floor(p[0]), math.floor(p[1])
            if not (0 <= x < w and 0 <= y < h) or water[y, x]:
                break
            if road is not None and not on_road(p):
                return last if last is not None else (0.0, 0.0)
            last = (float(s), float(ground[y, x]))
            if top - slope * s <= float(ground[y, x]) + 0.5:
                return last
        return 0.0, 0.0

    (la, za), (lb, zb) = walk(a, -u), walk(b, u)
    if la == 0 and lb == 0:
        return fp, [0.0, 0.0], [0.0, 0.0]
    a2, b2 = a - u * la, b + u * lb
    nrm = np.array([u[1], -u[0]])
    t = np.linspace(0, 1, m)
    line = a2[None, :] + t[:, None] * (b2 - a2)[None, :]
    grown = np.concatenate([line + half * nrm, (line - half * nrm)[::-1]])
    return [[round(float(x), 2), round(float(y), 2)] for x, y in grown], [la, lb], [za, zb]


def line_segments(inst: dict, seg_cells: float) -> list[dict]:
    """A straight band landmark cut into pieces of at most seg_cells along its
    line (D-056). Every piece carries the whole line (`ln`: its ends, `lw`: its
    half-width, in cells), so a generator draws its part of the whole; a
    diagonal bridge in one piece would be a huge, mostly empty voxel box."""
    fp = np.asarray(inst["fp"], dtype=np.float64)
    m = len(fp) // 2
    outer, inner = fp[:m], fp[m:][::-1]
    centre = 0.5 * (outer + inner)
    a, b = centre[0], centre[-1]
    length = float(np.hypot(*(b - a)))
    half = float(np.hypot(*(outer[0] - centre[0])))
    n_seg = max(1, math.ceil(length / max(seg_cells, 1e-6)))
    u = (b - a) / max(length, 1e-9)
    nrm = np.array([u[1], -u[0]])
    out = []
    for j in range(n_seg):
        p0 = a + (b - a) * (j / n_seg)
        p1 = a + (b - a) * ((j + 1) / n_seg)
        ring = [p0 + half * nrm, p1 + half * nrm, p1 - half * nrm, p0 - half * nrm]
        piece = {
            **inst,
            "x": float((p0[0] + p1[0]) / 2),
            "y": float((p0[1] + p1[1]) / 2),
            "fp": [[round(float(x), 2), round(float(y), 2)] for x, y in ring],
            "ln": [round(float(v), 3) for v in (*a, *b)],
            "lw": round(half, 3),
        }
        out.append(piece)
    return out


def line_parts(p: Placement, lm: dict, k: int, heights, mid: tuple[float, float]) -> list[dict]:
    """Sub-objects of a line landmark (a dam's intake towers): each at a fraction
    `along` the line, `offset` metres to its upstream side (where a dam bows)."""
    out = []
    if not lm.get("parts"):
        return out
    (lon0, lat0), (lon1, lat1) = lm["line"]
    xs, ys = transform_points("EPSG:4326", p.region.crs, [lon0, lon1], [lat0, lat1])
    ax, ay = p.to_cells(np.array(xs), np.array(ys), shift=False)
    a = np.array([ax[0], ay[0]])
    along = np.array([ax[1], ay[1]]) - a
    n = np.array([along[1], -along[0]]) / max(float(np.hypot(*along)), 1e-9)
    per_cell = p.scale_at(*mid)
    for j, part in enumerate(lm["parts"]):
        c = (
            a
            + float(part.get("along", 0.5)) * along
            + n * float(part.get("offset", 0.0)) / per_cell
        )
        inst = {"g": part["group"], "x": float(c[0]), "y": float(c[1]), "s": k * 100 + j + 1}
        if "id" in lm:
            inst["id"] = lm["id"]  # a hero bake takes the landmark with all its parts
        if p.layout is not None:
            inst["m"] = round(per_cell, 2)
        if heights is not None and "crestMeters" in lm:
            top_m = float(lm["crestMeters"]) + float(part.get("aboveCrest", 0.0))
            inst["top"] = round(float(heights(*mid, top_m)), 2)
        elif "height" in part:
            inst["hm"] = float(part["height"])
        out.append(inst)
    return out


def place(
    region: Region,
    blocked: np.ndarray,
    road_rows: list[dict],
    layout=None,
    heights=None,
    shift=None,
    streets: list | None = None,
    water: np.ndarray | None = None,
    roads: tuple[np.ndarray, np.ndarray] | None = None,
    ground: np.ndarray | None = None,
    open_water: np.ndarray | None = None,
    on_road: np.ndarray | None = None,
    water_level: np.ndarray | None = None,
) -> tuple[list[dict], dict]:
    """All instances for a region, plus counts per group for the build report.

    heights(x, y, metres) → drawn height in steps at a projected point (dam crests).
    streets (the straightened road lines in cells) and water (a cell mask) feed
    the building typology (D-055). roads (the road mask and half-widths in
    cells) are what `snap.buildings.clearRoads` keeps buildings off. ground
    (cell heights, steps) and open_water (the water mask with the roads that cross
    it) and on_road (the road mask) shape bridges' approaches (`bridge_approaches`).
    water_level (steps per cell, NO_WATER where dry) puts pools on their water.
    """
    spec = region.objects or {}
    p = Placement(region, blocked, layout, shift)
    snap = (region.snap or {}).get("buildings")
    instances: list[dict] = []

    depiction = spec.get("depiction") or {}
    landmarks = spec.get("landmarks") or []
    clear_zones = []
    lm_scale = []
    for lm in landmarks:
        # dams are shaped to their canyon, so they keep their real size
        s = (
            1.0
            if "line" in lm
            else float(lm.get("scale", depiction.get("landmarks", {}).get("scale", 1.0)))
        )
        lm_scale.append(s)
        if "line" in lm and "lon" not in lm:
            (lon0, lat0), (lon1, lat1) = lm["line"]
            lm = {**lm, "lon": 0.5 * (lon0 + lon1), "lat": 0.5 * (lat0 + lat1)}
        xs, ys = transform_points("EPSG:4326", region.crs, [lm["lon"]], [lm["lat"]])
        clear_zones.append((xs[0], ys[0], float(lm.get("clear", 0)) * s))

    def clear(x: float, y: float) -> bool:
        return any(math.hypot(x - lx, y - ly) < r for lx, ly, r in clear_zones)

    replaces = {r for lm in landmarks for r in lm.get("replaces", [])}
    fp_landmarks: dict[int, Any] = {}
    lidar_stats: dict[str, int] = {}
    building_polys = []
    if spec.get("buildings") is not None:
        source = plugins.source(region, "features")
        bounds = spec["buildings"].get("bounds", region.lonlat_envelope())
        # one box, or a list of boxes (e.g. the Strip and Grand Canyon Village)
        boxes = bounds if isinstance(bounds[0], (list, tuple)) else [bounds]
        rows, parts, seen = [], [], set()
        for box in boxes:
            for r in source.buildings(tuple(box)):
                if r["id"] not in seen:
                    seen.add(r["id"])
                    rows.append(r)
            parts += source.building_parts(tuple(box))
        parts = list({pt["id"]: pt for pt in parts}.values())
        rows.sort(key=lambda r: r["id"])
        # landmarks drawn on the footprint of the building they replace (the
        # largest of its polygons), not on a box sized from their height
        for k, lm in enumerate(landmarks):
            if lm.get("footprint"):
                names = {r.lower() for r in lm.get("replaces", [])} | set(lm.get("replaces", []))
                polys = [
                    g
                    for r in rows
                    if replaced_by_landmark(r, names)
                    for geom in [p.project(shapely.from_wkt(r["geometry"]))]
                    for g in getattr(geom, "geoms", [geom])
                ]
                if polys:
                    fp_landmarks[k] = max(polys, key=lambda g: g.area)
        grids = []
        lidar_spec = spec["buildings"].get("lidar")
        if lidar_spec is not None:  # `lidar: {}` reads with the defaults
            heights = plugins.source(region, "heights")
            for box in boxes:
                g = heights.height_grid(
                    tuple(box),
                    region.crs,
                    float(lidar_spec.get("res", 4.0)),
                    int(lidar_spec.get("depth", 6)),
                )
                if g is not None:
                    grids.append(g)
        found, building_polys = place_buildings(
            p,
            spec["buildings"],
            rows,
            parts,
            clear,
            replaces,
            heights=grids or None,
            stats=lidar_stats,
            parks=park_polygons(region, spec["buildings"], boxes),
        )
        dropped = lidar_stats.pop("implausible", 0)
        if dropped:
            progress.log(f"buildings: dropped {dropped} implausible footprints in parks")
        if lidar_stats:
            progress.log(f"lidar: {lidar_stats}")
        if snap is not None:
            found = snap_buildings(found, snap)
        clear_spec = (snap or {}).get("clearRoads")
        if clear_spec and roads is not None:
            nudge = float(clear_spec.get("nudgeMeters", 5.0)) / p.m
            found, cleared = clear_of_roads(found, road_strips(*roads), nudge)
            progress.log(f"buildings off the roads: {cleared}")
        if spec.get("typology"):
            found = type_buildings(
                region,
                found,
                spec["typology"],
                streets,
                water,
                float(spec["buildings"].get("towerMeters", 45)),
            )
        instances += depict_buildings(p, found, depiction.get("buildings", {}))
    tree = shapely.STRtree(building_polys) if building_polys else None

    def occupied(xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        hit = np.zeros(len(xs), dtype=bool)
        if tree is not None:
            idx, _ = tree.query(shapely.points(xs, ys), predicate="within")
            hit[idx] = True
        return hit | in_clear_zone(xs, ys)

    def in_clear_zone(xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        hit = np.zeros(len(xs), dtype=bool)
        for lx, ly, r in clear_zones:
            hit |= np.hypot(xs - lx, ys - ly) < max(r, 1.0)
        return hit

    canopy = None
    rules = (spec.get("vegetation") or []) + (spec.get("streetTrees") or [])
    if any("canopy" in rule for rule in rules):
        canopy = plugins.source(region, "canopy").grid(region.lonlat_envelope())
    for i, rule in enumerate(spec.get("vegetation") or []):
        instances += scatter(p, rule, occupied, f"{i}", canopy)
    drawn = None
    for i, rule in enumerate(spec.get("streetTrees") or []):
        if "canopy" not in rule:
            instances += street_trees(p, rule, road_rows, occupied, f"{i}")
            continue
        if drawn is None:
            drawn = DrawnRoads(region, blocked.shape, streets or [], road_rows)
        instances += sidewalk_trees(
            p, rule, drawn, in_clear_zone, _in_footprints(instances), canopy, water, f"{i}"
        )
    # street furniture (M3): lights along roads, signals at major junctions
    for i, rule in enumerate(spec.get("streetProps") or []):
        if rule.get("at") == "junctions":
            instances += junction_props(p, rule, road_rows, occupied, f"j{i}")
        elif rule.get("wires"):
            instances += wired_props(p, rule, road_rows, occupied, f"w{i}")
        else:
            instances += street_trees(p, rule, road_rows, occupied, f"p{i}")
    # walls along Overture's barrier lines (D-104): segments one `spacing` apart on
    # the line, turned with it; over water's edge and cliffs too, off buildings
    for i, rule in enumerate(spec.get("walls") or []):
        rows = plugins.source(region, "features").barriers(
            region.lonlat_envelope(), list(rule["classes"])
        )
        line_rule = {**rule, "roads": list(rule["classes"]), "along": True, "offset": 0.0}
        line_rule["_over"] = True
        walls = street_trees(p, line_rule, rows, occupied, f"w{i}")
        progress.log(f"walls: {len(walls)} {rule['group']} on {len(rows)} {rule['classes']} lines")
        instances += walls
    for k, lm in enumerate(landmarks):
        lx, ly, _ = clear_zones[k]
        cx, cy = p.to_cells(np.array([lx]), np.array([ly]), shift="line" not in lm)
        inst = {"g": lm["group"], "x": round(float(cx[0]), 3), "y": round(float(cy[0]), 3), "s": k}
        if "id" in lm:
            inst["id"] = lm["id"]  # registry id: hero bakes find their landmark by it
        if "hm" in lm:
            inst["hm"] = float(lm["hm"])
        if p.layout is not None or lm_scale[k] != 1.0:
            local = p.scale_at(lx, ly) if p.layout is not None else p.m
            inst["m"] = round(local / lm_scale[k], 2)
        if "orient" in lm:
            inst["r"] = int(lm["orient"]) % 4
        if "line" not in lm and heights is not None and "baseMeters" in lm:
            # an anchored landmark's foot below its anchor's ground (a hall's stage down a slope)
            inst["z0"] = round(float(heights(lx, ly, float(lm["baseMeters"]))), 2)
        if k in fp_landmarks:
            poly = fp_landmarks[k]
            cx, cy = p.to_cells(np.array([poly.centroid.x]), np.array([poly.centroid.y]))
            inst["x"], inst["y"] = float(cx[0]), float(cy[0])
            inst["fp"] = _footprint(p, poly, float(spec["buildings"].get("simplifyMeters", 2)))
        if "line" in lm:
            snap_deg = None
            if lm.get("snap") and region.snap:
                snap_deg = float(region.snap.get("roads", {}).get("angle", 16.0))
            inst["fp"] = dam_footprint(
                p,
                lm["line"],
                float(lm.get("thicknessM", 60)),
                float(lm.get("bulge", 0.15)),
                snap_deg,
                streets,
            )
            if snap_deg is not None:
                fp = np.asarray(inst["fp"])
                inst["x"], inst["y"] = float(fp[:, 0].mean()), float(fp[:, 1].mean())
            elif lm["group"].startswith("landmark.dam"):
                # the abutment line and half-thickness, so the generator knows which
                # face is upstream (the line's left, where the dam bows)
                fp = np.asarray(inst["fp"])
                m = len(fp) // 2
                a = 0.5 * (fp[0] + fp[-1])
                b = 0.5 * (fp[m - 1] + fp[m])
                inst["ln"] = [round(float(v), 3) for v in (*a, *b)]
                inst["lw"] = round(float(np.hypot(*(fp[0] - a))), 3)
            if heights is not None and "crestMeters" in lm:
                inst["top"] = round(float(heights(lx, ly, float(lm["crestMeters"]))), 2)
            if heights is not None and "baseMeters" in lm:
                inst["z0"] = round(float(heights(lx, ly, float(lm["baseMeters"]))), 2)
            approaches = snap_deg is not None and ground is not None and open_water is not None
            if approaches and "top" in inst:
                # the deck comes down over land at its approach grade (real metres per metre)
                crest = float(lm["crestMeters"])
                drop = float(lm.get("approachGrade", APPROACH_GRADE)) * p.scale_at(lx, ly)
                slope = float(heights(lx, ly, crest)) - float(heights(lx, ly, crest - drop))
                fp, ap, az = bridge_approaches(
                    inst["fp"], ground, open_water, inst["top"], slope, on_road
                )
                if ap != [0.0, 0.0]:
                    inst["fp"] = fp
                    inst["ap"] = [round(v, 2) for v in ap]
                    inst["az"] = [round(v, 2) for v in az]
                    pts = np.asarray(fp)
                    inst["x"], inst["y"] = float(pts[:, 0].mean()), float(pts[:, 1].mean())
            instances += line_parts(p, lm, k, heights, (lx, ly))
            if snap_deg is not None:
                # long straight landmarks (bridges) go in pieces along their line
                instances += line_segments(inst, float(lm.get("segmentCells", SEGMENT_CELLS)))
                continue
        instances.append(inst)
    seen_pools: set[str] = set()
    for rule in spec.get("pools") or []:
        instances += pools(p, rule, water_level, seen_pools)

    for inst in instances:
        inst["x"] = round(inst["x"], 3)
        inst["y"] = round(inst["y"], 3)
    counts: dict[str, int] = {}
    for inst in instances:
        counts[inst["g"]] = counts.get(inst["g"], 0) + 1
    return instances, dict(sorted(counts.items()))
