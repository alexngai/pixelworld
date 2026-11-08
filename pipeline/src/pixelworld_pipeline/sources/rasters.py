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


def _overview_level(factor: int) -> int | None:
    """rasterio overview_level for a decimation factor (1 → full resolution, 2 → 0, 4 → 1, ...)."""
    if factor == 1:
        return None
    level = int(round(math.log2(factor))) - 1
    if level < 0 or 2 ** (level + 1) != factor:
        raise ValueError(f"overview factor must be a power of two ≥ 2, got {factor}")
    return level


def _grid_key(region: Region) -> str:
    """What a raster read depends on: the grid geometry, not the rest of the spec."""
    west, north, cx, cy = region.grid
    return f"{region.crs.to_proj4()}|{west}|{north}|{cx}|{cy}|{region.meters_per_cell}"


def _cache_path(region: Region, name: str, params: str):
    key = hashlib.sha256(f"{_grid_key(region)}|{params}".encode()).hexdigest()[:16]
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
                kwargs = {} if level is None else {"overview_level": level}
                src = rasterio.open("/vsicurl/" + url, **kwargs)
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


# 3DEP DEM products: region-spec kind → (product directory, file prefix).
USGS_3DEP = {
    "usgs-3dep-1arcsec": ("1", "USGS_1_"),  # ~30 m
    "usgs-3dep-13arcsec": ("13", "USGS_13_"),  # ~10 m
}


def usgs_3dep_tiles(bounds: tuple[float, float, float, float], kind: str) -> list[str]:
    product, prefix = USGS_3DEP[kind]
    w, s, e, n = bounds
    urls = []
    for top in range(math.floor(s) + 1, math.ceil(n) + 1):
        for left in range(math.floor(w), math.ceil(e)):
            name = f"n{top:02d}w{-left:03d}"
            urls.append(
                f"https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/{product}/TIFF/current/"
                f"{name}/{prefix}{name}.tif"
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


def dem_corners(region: Region, k: int = 1, spec: dict | None = None) -> np.ndarray:
    """Elevation (m) at every cell corner, shape (cells_y + 1, cells_x + 1).

    With k > 1, at every micro-corner of K×K micro-cells per cell instead,
    shape (K·cells_y + 1, K·cells_x + 1); `spec` overrides the DEM source.
    """
    spec = spec or region.sources["dem"]
    if spec["kind"] not in USGS_3DEP:
        raise ValueError(f"unsupported DEM source {spec['kind']}")
    overview = int(spec.get("overview", 4))
    # average when shrinking the source; bilinear when cells are finer than it
    resampling = Resampling[spec.get("resampling", "average")]
    params = f"{spec['kind']}|{overview}"
    if resampling != Resampling.average:
        params += f"|{resampling.name}"
    if k != 1:
        params += f"|micro{k}"
    path = _cache_path(region, "dem", params)
    if path.exists():
        return np.load(path)
    cx, cy = region.cells
    dst = np.full((cy * k + 1, cx * k + 1), np.nan, dtype=np.float32)
    urls = usgs_3dep_tiles(region.lonlat_envelope(), spec["kind"])
    west, north, _, _ = region.grid
    pm = region.meters_per_cell / k  # corner spacing; pixel centres sit on the corners
    transform = rasterio.Affine(pm, 0, west - pm / 2, 0, -pm, north + pm / 2)
    missing = _warp_tiles(urls, dst, transform, region, overview, resampling, np.nan)
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


def landcover_fine(region: Region, meters: float = 10.0) -> tuple[np.ndarray, float]:
    """ESA WorldCover classes on a finer grid aligned with the region grid.

    Returns (classes, meters per pixel); pixel (j, i) covers cell coordinates
    [i·f, (i+1)·f) × [j·f, (j+1)·f) with f = meters / metersPerCell. Used to
    place objects at the source's own resolution, whatever the cell size.
    """
    spec = region.sources["landcover"]
    m = region.meters_per_cell
    factor = max(1, round(m / meters))
    px = m / factor
    path = _cache_path(region, "landcover-fine", f"{spec['kind']}|{px}")
    if path.exists():
        return np.load(path), px
    cx, cy = region.cells
    dst = np.zeros((cy * factor, cx * factor), dtype=np.uint8)
    west, north, _, _ = region.grid
    transform = rasterio.Affine(px, 0, west, 0, -px, north)
    missing = _warp_tiles(
        esa_worldcover_tiles(region.lonlat_envelope()),
        dst,
        transform,
        region,
        1,
        Resampling.nearest,
        0,
    )
    if missing:
        print(f"  landcover (fine): {len(missing)} tiles missing")
    path.parent.mkdir(parents=True, exist_ok=True)
    np.save(path, dst)
    return dst, px
