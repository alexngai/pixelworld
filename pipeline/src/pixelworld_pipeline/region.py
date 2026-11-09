"""Region specs (worlds/<id>/region.yaml) and the region's cell grid geometry."""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import yaml
from rasterio.crs import CRS
from rasterio.transform import Affine
from rasterio.warp import transform as transform_points


class RegionError(ValueError):
    pass


def _merge(base: dict[str, Any], over: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for k, v in over.items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def load_spec(path: Path) -> dict[str, Any]:
    """Read a region spec; `extends: other.yaml` merges this file over another
    (mappings merge key by key, anything else replaces; null removes a section)."""
    return resolve_spec(yaml.safe_load(Path(path).read_text()), Path(path).parent)


def resolve_spec(raw: dict[str, Any], base_dir: Path) -> dict[str, Any]:
    """A spec's references to other files (`extends:`, `warp: warp.yaml`) read
    from `base_dir`; returns a new dict (`raw` is left as it is)."""
    if not isinstance(raw, dict):
        raise RegionError(f"a region spec is a mapping, not {type(raw).__name__}")
    raw = dict(raw)
    # `warp: warp.yaml` keeps the editor-managed warp (focus areas, pins) in its own file
    if isinstance(raw.get("warp"), str):
        raw["warp"] = yaml.safe_load((Path(base_dir) / raw["warp"]).read_text())
    parent = raw.pop("extends", None)
    if parent is None:
        return raw
    return _merge(load_spec(Path(base_dir) / parent), raw)


@dataclass(frozen=True)
class Province:
    name: str
    polygon: tuple[tuple[float, float], ...]  # lon/lat ring


@dataclass(frozen=True)
class Region:
    id: str
    name: str
    bounds: tuple[float, float, float, float]  # west, south, east, north (lon/lat)
    meters_per_cell: float
    vertical_exaggeration: float
    max_slope: int
    chunk_size: int
    style: str
    start: tuple[float, float]  # lon, lat
    bilateral_cells: float
    bilateral_meters: float
    sources: dict[str, Any]
    default_province: str
    provinces: tuple[Province, ...] = field(default_factory=tuple)
    # How the world is drawn: {"scale": render units per cell, "tileSize": cells}.
    render: dict[str, Any] | None = None
    # Object placement rules (vegetation, buildings, landmarks); see objects.py.
    objects: dict[str, Any] | None = None
    # Micro-terrain (M1.6): {"k": 4, "dem": {...source override...}}.
    micro: dict[str, Any] | None = None
    # Elastic map (M2): {"background", "focus": [...], "pins": [...], "vertical": {...}}.
    warp: dict[str, Any] | None = None
    # Terrain rules for fine cells: {cliffSlope, minLakeArea (m²), maxLakeRelief (m),
    # riverWidthMeters}.
    terrain: dict[str, Any] | None = None
    # Scale levels (D-046): this world's level name, and every level of the region
    # as [{name, world, label}], `world` being the sibling package's id.
    level: str | None = None
    levels: list[dict[str, Any]] | None = None
    # Isometric snapping (D-049): {"roads": {angle, simplify, deviation, maxShift},
    # "buildings": {angle, follow}}; roads straighten toward the 8 grid directions.
    snap: dict[str, Any] | None = None
    # Real widths (D-050): {"scale", "minCells", "roads": {class: m}, "paths": {class: m}};
    # without it roads draw at the style pack's fixed width.
    widths: dict[str, Any] | None = None
    # Ground surfaces from land use (M3.5): {"lawn": {...}, "yard": {...}}; see ground.py.
    ground: dict[str, Any] | None = None

    # ---- loading -------------------------------------------------------------

    @staticmethod
    def load(path: Path) -> Region:
        from .landmarks import expand

        return Region.from_dict(expand(load_spec(Path(path)), Path(path)))

    @staticmethod
    def from_dict(raw: dict[str, Any]) -> Region:
        def need(key: str) -> Any:
            if key not in raw:
                raise RegionError(f"region spec is missing '{key}'")
            return raw[key]

        w, s, e, n = (float(v) for v in need("bounds"))
        if not (w < e and s < n):
            raise RegionError("bounds must be [west, south, east, north]")
        smoothing = raw.get("smoothing") or {}
        geology = raw.get("geology") or {}
        start = need("start")
        region = Region(
            id=str(need("id")),
            name=str(need("name")),
            bounds=(w, s, e, n),
            meters_per_cell=float(need("metersPerCell")),
            vertical_exaggeration=float(raw.get("verticalExaggeration", 2.5)),
            max_slope=int(raw.get("maxSlope", 2)),
            chunk_size=int(raw.get("chunkSize", 64)),
            style=str(need("style")),
            start=(float(start["lon"]), float(start["lat"])),
            bilateral_cells=float(smoothing.get("bilateralCells", 0)),
            bilateral_meters=float(smoothing.get("bilateralMeters", 0)),
            sources=dict(need("sources")),
            default_province=str(geology.get("default", "default")),
            provinces=tuple(
                Province(str(p["name"]), tuple((float(a), float(b)) for a, b in p["polygon"]))
                for p in geology.get("provinces", [])
            ),
            render=dict(raw["render"]) if raw.get("render") else None,
            objects=dict(raw["objects"]) if raw.get("objects") else None,
            terrain=dict(raw["terrain"]) if raw.get("terrain") else None,
            micro=dict(raw["micro"]) if raw.get("micro") else None,
            warp=dict(raw["warp"]) if raw.get("warp") else None,
            level=str(raw["level"]) if raw.get("level") else None,
            levels=[dict(v) for v in raw["levels"]] if raw.get("levels") else None,
            snap=dict(raw["snap"]) if raw.get("snap") else None,
            widths=dict(raw["widths"]) if raw.get("widths") else None,
            ground=dict(raw["ground"]) if raw.get("ground") else None,
        )
        if region.meters_per_cell <= 0 or region.vertical_exaggeration <= 0:
            raise RegionError("metersPerCell and verticalExaggeration must be positive")
        if not 1 <= region.max_slope <= 3:
            raise RegionError("maxSlope must be 1..3")
        if not (w <= region.start[0] <= e and s <= region.start[1] <= n):
            raise RegionError("start must lie inside bounds")
        if region.micro is not None and int(region.micro.get("k", 0)) not in (2, 4, 8):
            raise RegionError("micro.k must be 2, 4 or 8")
        if region.levels is not None:
            names = [lv.get("name") for lv in region.levels]
            if any(not lv.get("name") or not lv.get("world") for lv in region.levels):
                raise RegionError("each level needs a name and a world (package id)")
            if len(set(names)) != len(names):
                raise RegionError("level names must be unique")
            if region.level is not None and region.level not in names:
                raise RegionError(f"level '{region.level}' is not in levels")
        if region.render is not None:
            scale = region.render.get("scale")
            if not (isinstance(scale, (int, float)) and 0 < scale <= 1):
                raise RegionError("render.scale must be in (0, 1]")
        return region

    def digest(self) -> str:
        """Stable hash of the spec, for cache keys and the manifest.

        Optional sections that are absent are left out, so adding new optional
        fields doesn't change the digest (and cached inputs) of older specs.
        """
        body = {k: v for k, v in asdict(self).items() if v is not None}
        return hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:16]

    # ---- grid geometry ----------------------------------------------------------

    @property
    def crs(self) -> CRS:
        w, s, e, n = self.bounds
        lat0 = (s + n) / 2
        lon0 = (w + e) / 2
        return CRS.from_proj4(
            f"+proj=tmerc +lat_0={lat0} +lon_0={lon0} +k=1 +x_0=0 +y_0=0 "
            "+datum=WGS84 +units=m +no_defs"
        )

    def _projected_envelope(self) -> tuple[float, float, float, float]:
        w, s, e, n = self.bounds
        t = np.linspace(0, 1, 33)
        lons = np.concatenate(
            [w + (e - w) * t, np.full_like(t, e), e - (e - w) * t, np.full_like(t, w)]
        )
        lats = np.concatenate(
            [np.full_like(t, s), s + (n - s) * t, np.full_like(t, n), n - (n - s) * t]
        )
        xs, ys = transform_points("EPSG:4326", self.crs, lons.tolist(), lats.tolist())
        return min(xs), min(ys), max(xs), max(ys)

    @property
    def grid(self) -> tuple[float, float, int, int]:
        """(west, north, cells_x, cells_y) of the projected grid, snapped to whole cells."""
        m = self.meters_per_cell
        x0, y0, x1, y1 = self._projected_envelope()
        west = math.floor(x0 / m) * m
        north = math.ceil(y1 / m) * m
        cells_x = math.ceil((x1 - west) / m)
        cells_y = math.ceil((north - y0) / m)
        return west, north, cells_x, cells_y

    @property
    def cells(self) -> tuple[int, int]:
        _, _, cx, cy = self.grid
        return cx, cy

    def corner_transform(self) -> Affine:
        """Raster transform whose pixel centres sit on cell corners ((cy+1) × (cx+1))."""
        west, north, _, _ = self.grid
        m = self.meters_per_cell
        return Affine(m, 0, west - m / 2, 0, -m, north + m / 2)

    def cell_transform(self) -> Affine:
        """Raster transform whose pixels are the cells (cy × cx)."""
        west, north, _, _ = self.grid
        m = self.meters_per_cell
        return Affine(m, 0, west, 0, -m, north)

    def lonlat_to_cell(self, lons, lats) -> tuple[np.ndarray, np.ndarray]:
        """Continuous cell coordinates (x east, y south) for lon/lat points."""
        west, north, _, _ = self.grid
        xs, ys = transform_points("EPSG:4326", self.crs, list(lons), list(lats))
        m = self.meters_per_cell
        return (np.asarray(xs) - west) / m, (north - np.asarray(ys)) / m

    def cell_centers_lonlat(self) -> tuple[np.ndarray, np.ndarray]:
        west, north, cx, cy = self.grid
        m = self.meters_per_cell
        gx, gy = np.meshgrid(west + (np.arange(cx) + 0.5) * m, north - (np.arange(cy) + 0.5) * m)
        lons, lats = transform_points(
            self.crs, "EPSG:4326", gx.ravel().tolist(), gy.ravel().tolist()
        )
        return np.asarray(lons).reshape(cy, cx), np.asarray(lats).reshape(cy, cx)

    def lonlat_envelope(self, pad_deg: float = 0.02) -> tuple[float, float, float, float]:
        """Lon/lat bounds covering the whole projected grid (for fetching sources)."""
        west, north, cx, cy = self.grid
        m = self.meters_per_cell
        xs = [west, west + cx * m, west, west + cx * m]
        ys = [north, north, north - cy * m, north - cy * m]
        lons, lats = transform_points(self.crs, "EPSG:4326", xs, ys)
        return (min(lons) - pad_deg, min(lats) - pad_deg, max(lons) + pad_deg, max(lats) + pad_deg)
