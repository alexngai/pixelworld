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

    # ---- loading -------------------------------------------------------------

    @staticmethod
    def load(path: Path) -> Region:
        raw = yaml.safe_load(Path(path).read_text())
        return Region.from_dict(raw)

    @staticmethod
    def from_dict(raw: dict[str, Any]) -> Region:
        def need(key: str) -> Any:
            if key not in raw:
                raise RegionError(f"region spec is missing '{key}'")
            return raw[key]

        w, s, e, n = (float(v) for v in need("bounds"))
        if not (w < e and s < n):
            raise RegionError("bounds must be [west, south, east, north]")
        smoothing = raw.get("smoothing", {})
        geology = raw.get("geology", {})
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
        )
        if region.meters_per_cell <= 0 or region.vertical_exaggeration <= 0:
            raise RegionError("metersPerCell and verticalExaggeration must be positive")
        if not 1 <= region.max_slope <= 3:
            raise RegionError("maxSlope must be 1..3")
        if not (w <= region.start[0] <= e and s <= region.start[1] <= n):
            raise RegionError("start must lie inside bounds")
        return region

    def digest(self) -> str:
        """Stable hash of the spec, for cache keys and the manifest."""
        return hashlib.sha256(json.dumps(asdict(self), sort_keys=True).encode()).hexdigest()[:16]

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
