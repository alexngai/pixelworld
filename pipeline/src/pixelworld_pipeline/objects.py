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
    """Projected-metre ↔ cell conversions and lookups for one region build."""

    def __init__(self, region: Region, blocked: np.ndarray):
        self.region = region
        self.west, self.north, self.cx, self.cy = region.grid
        self.m = region.meters_per_cell
        self.blocked = blocked
        self.landcover, self.lc_px = rasters.landcover_fine(region)
        # placement lattice anchored to the spec's envelope, not the cell grid
        self.envelope = region._projected_envelope()

    def to_cells(self, xs: np.ndarray, ys: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return (np.asarray(xs) - self.west) / self.m, (self.north - np.asarray(ys)) / self.m

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


def scatter(p: Placement, rule: dict[str, Any], occupied, tag: str = "") -> list[dict]:
    """Jittered-lattice scatter where the land cover matches, thinned by density."""
    spacing = float(rule["spacing"])
    density = float(rule.get("density", 1.0))
    codes = _codes(rule["landcover"])
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
    cx, cy = p.to_cells(coords[:, 0], coords[:, 1])
    return [[round(float(x), 2), round(float(y), 2)] for x, y in zip(cx, cy, strict=True)]


def place_buildings(
    p: Placement, spec: dict[str, Any], rows: list[dict], parts: list[dict], clear
) -> tuple[list[dict], list]:
    """Footprint instances (buildings, and parts of buildings that have them)."""
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

    def add(row: dict, cls: str | None, height_m: float) -> None:
        geom = p.project(shapely.from_wkt(row["geometry"]))
        for poly in list(geom.geoms) if hasattr(geom, "geoms") else [geom]:
            if poly.geom_type != "Polygon" or poly.area < min_area:
                continue
            c = poly.centroid
            cx, cy = p.to_cells(np.array([c.x]), np.array([c.y]))
            if not p.inside(cx, cy)[0] or clear(c.x, c.y):
                continue
            polys.append(poly)
            out.append(
                {
                    "g": building_group(cls, height_m, tower_m),
                    "x": round(float(cx[0]), 3),
                    "y": round(float(cy[0]), 3),
                    "s": _stable_int(row["id"]),
                    "fp": _footprint(p, poly, tolerance),
                    "hm": round(height_m, 1),
                }
            )

    small_house_m2 = float(spec.get("houseMaxArea", 0))
    for row in rows:
        cls = row.get("class")
        if cls is None and small_house_m2 > 0:
            # ML-derived footprints carry no class; small ones in a city are houses
            area = p.project(shapely.from_wkt(row["geometry"])).area
            if area <= small_house_m2:
                cls = "house"
        height = _height(row, _kind(cls))
        my_parts = parts_by_building.get(row["id"], []) if row.get("has_parts") else []
        if my_parts:
            add(row, cls, min(height, podium_m))
            for part in sorted(my_parts, key=lambda r: r["id"]):
                add(part, cls, _height(part, "other"))
        else:
            add(row, cls, height)
    return out, polys


def place(region: Region, blocked: np.ndarray, road_rows: list[dict]) -> tuple[list[dict], dict]:
    """All instances for a region, plus counts per group for the build report."""
    spec = region.objects or {}
    p = Placement(region, blocked)
    instances: list[dict] = []

    landmarks = spec.get("landmarks", [])
    clear_zones = []
    for lm in landmarks:
        xs, ys = transform_points("EPSG:4326", region.crs, [lm["lon"]], [lm["lat"]])
        clear_zones.append((xs[0], ys[0], float(lm.get("clear", 0))))

    def clear(x: float, y: float) -> bool:
        return any(math.hypot(x - lx, y - ly) < r for lx, ly, r in clear_zones)

    building_polys = []
    if "buildings" in spec:
        release = region.sources["overture"]["release"]
        bbox = region.lonlat_envelope()
        rows = overture.buildings(release, bbox)
        parts = overture.building_parts(release, bbox)
        found, building_polys = place_buildings(p, spec["buildings"], rows, parts, clear)
        instances += found
    tree = shapely.STRtree(building_polys) if building_polys else None

    def occupied(xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        hit = np.zeros(len(xs), dtype=bool)
        if tree is not None:
            idx, _ = tree.query(shapely.points(xs, ys), predicate="within")
            hit[idx] = True
        for lx, ly, r in clear_zones:
            hit |= np.hypot(xs - lx, ys - ly) < max(r, 1.0)
        return hit

    for i, rule in enumerate(spec.get("vegetation", [])):
        instances += scatter(p, rule, occupied, f"{i}")
    for i, rule in enumerate(spec.get("streetTrees", [])):
        instances += street_trees(p, rule, road_rows, occupied, f"{i}")
    for k, lm in enumerate(landmarks):
        lx, ly, _ = clear_zones[k]
        cx, cy = p.to_cells(np.array([lx]), np.array([ly]))
        inst = {"g": lm["group"], "x": round(float(cx[0]), 3), "y": round(float(cy[0]), 3), "s": k}
        if "hm" in lm:
            inst["hm"] = float(lm["hm"])
        instances.append(inst)

    for inst in instances:
        inst["x"] = round(inst["x"], 3)
        inst["y"] = round(inst["y"], 3)
    counts: dict[str, int] = {}
    for inst in instances:
        counts[inst["g"]] = counts.get(inst["g"], 0) + 1
    return instances, dict(sorted(counts.items()))
