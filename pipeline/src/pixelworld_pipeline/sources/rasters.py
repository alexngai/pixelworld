"""Raster sources read from cloud-optimized GeoTIFF overviews over HTTP.

Both sources publish 1°–3° tiles with internal overviews, so a 400 km region
at hundreds of metres per cell needs only a few megabytes per tile.
"""

from __future__ import annotations

import hashlib
import math
import warnings
from collections.abc import Iterable

import numpy as np
import rasterio
from rasterio.errors import RasterioIOError
from rasterio.warp import Resampling, reproject

from ..region import Region
from .http import CACHE_ROOT, USER_AGENT

GDAL_ENV = dict(
    GDAL_HTTP_USERAGENT=USER_AGENT,
    GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
    CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
    GDAL_HTTP_MAX_RETRY="4",
    GDAL_HTTP_RETRY_DELAY="2",
)


def _overview_level(factor: int) -> int:
    """rasterio overview_level for a decimation factor (0 → 2×, 1 → 4×, ...)."""
    level = int(round(math.log2(factor))) - 1
    if level < 0 or 2 ** (level + 1) != factor:
        raise ValueError(f"overview factor must be a power of two ≥ 2, got {factor}")
    return level


def _cache_path(region: Region, name: str, params: str):
    key = hashlib.sha256(f"{region.digest()}|{params}".encode()).hexdigest()[:16]
    return CACHE_ROOT / region.id / f"{name}-{key}.npy"


def _warp_tiles(
    urls: Iterable[str],
    dst: np.ndarray,
    transform,
    region: Region,
    overview: int,
    resampling: Resampling,
    dst_nodata,
) -> list[str]:
    missing = []
    level = _overview_level(overview)
    with rasterio.Env(**GDAL_ENV):
        for url in urls:
            try:
                src = rasterio.open("/vsicurl/" + url, overview_level=level)
            except RasterioIOError:
                missing.append(url)
                continue
            with src:
                reproject(
                    source=rasterio.band(src, 1),
                    destination=dst,
                    src_transform=src.transform,
                    src_crs=src.crs,
                    src_nodata=src.nodata,
                    dst_transform=transform,
                    dst_crs=region.crs,
                    dst_nodata=dst_nodata,
                    init_dest_nodata=False,
                    resampling=resampling,
                )
    return missing


def usgs_3dep_1arcsec_tiles(bounds: tuple[float, float, float, float]) -> list[str]:
    w, s, e, n = bounds
    urls = []
    for top in range(math.floor(s) + 1, math.ceil(n) + 1):
        for left in range(math.floor(w), math.ceil(e)):
            name = f"n{top:02d}w{-left:03d}"
            urls.append(
                "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1/TIFF/current/"
                f"{name}/USGS_1_{name}.tif"
            )
    return urls


def fill_nan_nearest(a: np.ndarray, max_iter: int = 64) -> np.ndarray:
    """Fill NaNs by repeatedly averaging valid 4-neighbours (small gaps at tile edges)."""
    a = a.copy()
    for _ in range(max_iter):
        bad = np.isnan(a)
        if not bad.any():
            return a
        p = np.pad(a, 1, mode="edge")
        stack = np.stack([p[:-2, 1:-1], p[2:, 1:-1], p[1:-1, :-2], p[1:-1, 2:]])
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            fill = np.nanmean(stack, axis=0)
        a[bad] = fill[bad]
    raise RuntimeError("DEM has a large gap that couldn't be filled")


def dem_corners(region: Region) -> np.ndarray:
    """Elevation (m) at every cell corner, shape (cells_y + 1, cells_x + 1)."""
    spec = region.sources["dem"]
    if spec["kind"] != "usgs-3dep-1arcsec":
        raise ValueError(f"unsupported DEM source {spec['kind']}")
    overview = int(spec.get("overview", 4))
    path = _cache_path(region, "dem", f"{spec['kind']}|{overview}")
    if path.exists():
        return np.load(path)
    cx, cy = region.cells
    dst = np.full((cy + 1, cx + 1), np.nan, dtype=np.float32)
    urls = usgs_3dep_1arcsec_tiles(region.lonlat_envelope())
    missing = _warp_tiles(
        urls, dst, region.corner_transform(), region, overview, Resampling.average, np.nan
    )
    if missing:
        print(f"  dem: {len(missing)} tiles missing (outside coverage?)")
    gaps = int(np.isnan(dst).sum())
    if gaps:
        print(f"  dem: filling {gaps} empty corners")
        dst = fill_nan_nearest(dst).astype(np.float32)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.save(path, dst)
    return dst


def esa_worldcover_tiles(bounds: tuple[float, float, float, float]) -> list[str]:
    w, s, e, n = bounds
    urls = []
    for lat in range(math.floor(s / 3) * 3, math.ceil(n / 3) * 3, 3):
        for lon in range(math.floor(w / 3) * 3, math.ceil(e / 3) * 3, 3):
            ns = f"N{lat:02d}" if lat >= 0 else f"S{-lat:02d}"
            ew = f"E{lon:03d}" if lon >= 0 else f"W{-lon:03d}"
            urls.append(
                "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
                f"ESA_WorldCover_10m_2021_v200_{ns}{ew}_Map.tif"
            )
    return urls


# ESA WorldCover 2021 class codes.
WORLDCOVER = {
    10: "tree",
    20: "shrub",
    30: "grass",
    40: "crop",
    50: "built",
    60: "bare",
    70: "snow",
    80: "water",
    90: "wetland",
    95: "mangrove",
    100: "moss",
}


def landcover_cells(region: Region) -> np.ndarray:
    """ESA WorldCover class per cell (mode of the overview pixels), shape (cy, cx)."""
    spec = region.sources["landcover"]
    if spec["kind"] != "esa-worldcover-2021":
        raise ValueError(f"unsupported land cover source {spec['kind']}")
    overview = int(spec.get("overview", 16))
    path = _cache_path(region, "landcover", f"{spec['kind']}|{overview}")
    if path.exists():
        return np.load(path)
    cx, cy = region.cells
    dst = np.zeros((cy, cx), dtype=np.uint8)
    urls = esa_worldcover_tiles(region.lonlat_envelope())
    missing = _warp_tiles(urls, dst, region.cell_transform(), region, overview, Resampling.mode, 0)
    if missing:
        print(f"  landcover: {len(missing)} tiles missing")
    path.parent.mkdir(parents=True, exist_ok=True)
    np.save(path, dst)
    return dst
