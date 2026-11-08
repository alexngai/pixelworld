"""Object placement: vegetation, street trees, buildings and landmarks.

The pipeline only names semantic groups (D-030); the style pack decides what
each group looks like. Placement happens in projected metres from the region's
fixed envelope with seeds that don't depend on the cell size, so worlds built
from the same spec at different resolutions get the same objects.

Region spec (all sections optional):

    objects:
      buildings: { minArea: 30, towerMeters: 45, podiumMeters: 15 }
      vegetation:   # scatter by ESA WorldCover class
        - { group: tree.pinyon-juniper, landcover: [tree], spacing: 22, density: 0.8 }
      streetTrees:  # rows along roads of the given classes (optionally by name)
        - { group: tree.palm, roads: [primary], name: Las Vegas Boulevard, spacing: 60, offset: 16 }
      landmarks:
        - { group: landmark.tower.lookout, lon: -111.8261, lat: 36.0441, hm: 60, clear: 20 }
      depiction:    # how big things are drawn at this scale level (D-047)
        heightStretch: 2.5                          # overrides the style pack's
        buildings: { scale: 2, minHeightMeters: 60 } # oversize; keep only tall ones
        landmarks: { scale: 4 }                     # or `scale:` on one landmark

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

from .region import Region
from .sources import overture, rasters

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
    return [
        {
            "g": rule["group"],
            "x": float(cx[k]),
            "y": float(cy[k]),
            "s": int(seeds[k]),
            "r": int(rots[k]),
        }
        for k in np.nonzero(ok)[0]
    ]


def street_trees(
    p: Placement, rule: dict[str, Any], road_rows: list[dict], occupied, tag: str = ""
) -> list[dict]:
    """Rows of trees on both sides of roads of the given classes."""
    classes = set(rule["roads"])
    spacing = float(rule["spacing"])
    offset = float(rule.get("offset", 12))
    codes = _codes(rule["landcover"]) if "landcover" in rule else None
    rng = np.random.default_rng(_seed(p.region, f"street|{tag}|{rule['group']}"))
    xs: list[float] = []
    ys: list[float] = []
    name = rule.get("name", "").lower()
    if name:
        # names aren't in the road layer's columns; fetch them for this rule only
        road_rows = overture.query(
            p.region.sources["overture"]["release"],
            "transportation",
            "segment",
            p.region.lonlat_envelope(),
            ["id", "class", "names", "geometry"],
            lambda r: r["class"] in classes,
            filter_tag=f"classes:{','.join(sorted(classes))}",
        )
    for row in sorted(road_rows, key=lambda r: r["id"]):
        if row["class"] not in classes:
            continue
        if name and name not in ((row.get("names") or {}).get("primary") or "").lower():
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
                for side in (-1, 1):
                    xs.append(c.x - side * ty / norm * offset)
                    ys.append(c.y + side * tx / norm * offset)
    if not xs:
        return []
    ax, ay = np.asarray(xs), np.asarray(ys)
    cx, cy = p.to_cells(ax, ay)
    ok = p.free(cx, cy) & ~occupied(ax, ay)
    if codes is not None:
        ok &= np.isin(p.landcover_at(ax, ay), list(codes))
    seeds = rng.integers(0, 2**31, size=ax.size)
    rots = rng.integers(0, 4, size=ax.size)
    return [
        {
            "g": rule["group"],
            "x": float(cx[k]),
            "y": float(cy[k]),
            "s": int(seeds[k]),
            "r": int(rots[k]),
        }
        for k in np.nonzero(ok)[0]
    ]


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


def _footprint(p: Placement, poly, tolerance: float) -> list[list[float]]:
    ring = poly.simplify(tolerance).exterior
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


def _hints(row: dict) -> dict:
    """Shape and colour hints from Overture for the building generator (M3)."""
    out: dict[str, Any] = {}
    if row.get("roof_shape") in ROOF_SHAPES:
        out["rs"] = row["roof_shape"]
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
) -> tuple[list[dict], list]:
    """Footprint instances (buildings, and parts of buildings that have them).
    Buildings a landmark replaces (D-051) are left out, with their parts.
    With a lidar height grid (`heights`, D-052), buildings without a height (or
    with one far below what lidar sees) take lidar's, and large footprints whose
    roofs stand well above their podium get lidar-derived tower parts."""
    min_area = float(spec.get("minArea", 30))
    tower_m = float(spec.get("towerMeters", 45))
    podium_m = float(spec.get("podiumMeters", 15))
    tolerance = float(spec.get("simplifyMeters", 2))
    out: list[dict] = []
    polys = []
    parts_by_building: dict[str, list[dict]] = {}
    for part in parts:
        if float(part.get("min_height") or 0) <= 3:
            parts_by_building.setdefault(part["building_id"], []).append(part)

    def add(
        row: dict, cls: str | None, height_m: float, group: str, hints: dict, geom=None
    ) -> None:
        geom = geom if geom is not None else p.project(shapely.from_wkt(row["geometry"]))
        for poly in list(geom.geoms) if hasattr(geom, "geoms") else [geom]:
            if poly.geom_type != "Polygon" or poly.area < min_area:
                continue
            c = poly.centroid
            cx, cy = p.to_cells(np.array([c.x]), np.array([c.y]))
            if not p.inside(cx, cy)[0] or clear(c.x, c.y):
                continue
            polys.append(poly)
            inst = {
                "g": building_group(cls, height_m, tower_m),
                "x": round(float(cx[0]), 3),
                "y": round(float(cy[0]), 3),
                "s": _stable_int(row["id"]),
                "fp": _footprint(p, poly, tolerance),
                "hm": round(height_m, 1),
                "_grp": group,  # building id (parts join their building); see depict_buildings
                **hints,
            }
            if p.layout is not None:
                inst["m"] = round(p.scale_at(c.x, c.y), 2)
            out.append(inst)

    small_house_m2 = float(spec.get("houseMaxArea", 0))
    skip = {r.lower() for r in (replaces or set())} | set(replaces or set())
    for row in rows:
        if replaced_by_landmark(row, skip):
            continue
        cls = row.get("class")
        if cls is None and small_house_m2 > 0:
            # ML-derived footprints carry no class; small ones in a city are houses
            area = p.project(shapely.from_wkt(row["geometry"])).area
            if area <= small_house_m2:
                cls = "house"
        height = _height(row, _kind(cls))
        my_parts = parts_by_building.get(row["id"], []) if row.get("has_parts") else []
        hints = _hints(row)
        if heights and not my_parts:
            geom = p.project(shapely.from_wkt(row["geometry"]))
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
                    add(row, cls, podium, row["id"], {}, geom)
                    for k, (poly, h) in enumerate(towers):
                        add({"id": f"{row['id']}#t{k}"}, cls, h, row["id"], hints, poly)
                else:
                    add(row, cls, podium, row["id"], hints, geom)
                continue
        if my_parts:
            add(row, cls, min(height, podium_m), row["id"], {})
            for part in sorted(my_parts, key=lambda r: r["id"]):
                add(part, cls, _height(part, "other"), row["id"], hints)
        else:
            add(row, cls, height, row["id"], hints)
    return out, polys


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
        out.append(
            {
                **inst,
                "x": round(float(xy[0]), 3),
                "y": round(float(xy[1]), 3),
                "fp": [[round(float(x), 2), round(float(y), 2)] for x, y in fp],
            }
        )
    return out


def depict_buildings(p: Placement, instances: list[dict], spec: dict[str, Any]) -> list[dict]:
    """Apply a level's building depiction: drop buildings lower than
    `minHeightMeters` and draw the rest `scale` times their size about the
    building's anchor (parts move with their building). Scaled-up buildings go
    tallest first; one that would overlap a building already placed is left out."""
    scale = float(spec.get("scale", 1.0))
    min_h = float(spec.get("minHeightMeters", 0.0))
    if scale == 1.0 and min_h <= 0.0:
        return [{k: v for k, v in inst.items() if k != "_grp"} for inst in instances]
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
        inst.pop("_grp", None)
    return out


def dam_footprint(p: Placement, line, thickness_m: float, bulge: float = 0.15) -> list[list[float]]:
    """An arch-dam footprint in cells: a band along the abutment line, bowed
    upstream (to the left of the line) by `bulge` of its length."""
    (lon0, lat0), (lon1, lat1) = line
    xs, ys = transform_points("EPSG:4326", p.region.crs, [lon0, lon1], [lat0, lat1])
    ax, ay = p.to_cells(np.array(xs), np.array(ys), shift=False)  # fitted to its canyon
    a = np.array([ax[0], ay[0]])
    b = np.array([ax[1], ay[1]])
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
) -> tuple[list[dict], dict]:
    """All instances for a region, plus counts per group for the build report.

    heights(x, y, metres) → drawn height in steps at a projected point (dam crests).
    """
    spec = region.objects or {}
    p = Placement(region, blocked, layout, shift)
    snap = (region.snap or {}).get("buildings")
    instances: list[dict] = []

    depiction = spec.get("depiction") or {}
    landmarks = spec.get("landmarks", [])
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
    lidar_stats: dict[str, int] = {}
    building_polys = []
    if "buildings" in spec:
        release = region.sources["overture"]["release"]
        bounds = spec["buildings"].get("bounds", region.lonlat_envelope())
        # one box, or a list of boxes (e.g. the Strip and Grand Canyon Village)
        boxes = bounds if isinstance(bounds[0], (list, tuple)) else [bounds]
        rows, parts, seen = [], [], set()
        for box in boxes:
            for r in overture.buildings(release, tuple(box)):
                if r["id"] not in seen:
                    seen.add(r["id"])
                    rows.append(r)
            parts += overture.building_parts(release, tuple(box))
        parts = list({pt["id"]: pt for pt in parts}.values())
        rows.sort(key=lambda r: r["id"])
        grids = []
        lidar_spec = spec["buildings"].get("lidar")
        if lidar_spec:
            from .sources import lidar as lidar_source

            for box in boxes:
                g = lidar_source.height_grid(
                    lidar_spec["project"],
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
        )
        if lidar_stats:
            print(f"lidar: {lidar_stats}")
        if snap is not None:
            found = snap_buildings(found, snap)
        instances += depict_buildings(p, found, depiction.get("buildings", {}))
    tree = shapely.STRtree(building_polys) if building_polys else None

    def occupied(xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        hit = np.zeros(len(xs), dtype=bool)
        if tree is not None:
            idx, _ = tree.query(shapely.points(xs, ys), predicate="within")
            hit[idx] = True
        for lx, ly, r in clear_zones:
            hit |= np.hypot(xs - lx, ys - ly) < max(r, 1.0)
        return hit

    canopy = None
    if any("canopy" in rule for rule in spec.get("vegetation", [])):
        from .sources.canopy import CanopyGrid

        canopy = CanopyGrid(region.lonlat_envelope())
    for i, rule in enumerate(spec.get("vegetation", [])):
        instances += scatter(p, rule, occupied, f"{i}", canopy)
    for i, rule in enumerate(spec.get("streetTrees", [])):
        instances += street_trees(p, rule, road_rows, occupied, f"{i}")
    # street furniture (M3): lights along roads, signals at major junctions
    for i, rule in enumerate(spec.get("streetProps", [])):
        if rule.get("at") == "junctions":
            instances += junction_props(p, rule, road_rows, occupied, f"j{i}")
        else:
            instances += street_trees(p, rule, road_rows, occupied, f"p{i}")
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
        if "line" in lm:
            inst["fp"] = dam_footprint(
                p, lm["line"], float(lm.get("thicknessM", 60)), float(lm.get("bulge", 0.15))
            )
            if heights is not None and "crestMeters" in lm:
                inst["top"] = round(float(heights(lx, ly, float(lm["crestMeters"]))), 2)
            instances += line_parts(p, lm, k, heights, (lx, ly))
        instances.append(inst)

    for inst in instances:
        inst["x"] = round(inst["x"], 3)
        inst["y"] = round(inst["y"], 3)
    counts: dict[str, int] = {}
    for inst in instances:
        counts[inst["g"]] = counts.get(inst["g"], 0) + 1
    return instances, dict(sorted(counts.items()))
