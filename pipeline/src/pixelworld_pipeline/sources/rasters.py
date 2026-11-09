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


# ---- point sampling for warped layouts (M2) ------------------------------------------------
#
# A warped world samples rasters at arbitrary projected points whose spacing
# varies (fine in focus areas, coarse elsewhere). Sources are read as a
# pyramid of levels (native resolution × 2^i); each point uses the coarsest
# level no coarser than its local sample spacing, so averaging/mode
# resampling acts as the prefilter. Levels are fetched in fixed blocks of
# BLOCK_PX pixels aligned to the projected grid, cached one file per block,
# so re-solving a warp re-uses almost all downloads.

BLOCK_PX = 512
_NATIVE = {"usgs-3dep-1arcsec": 30.0, "usgs-3dep-13arcsec": 10.0, "esa-worldcover-2021": 10.0}
_MAX_LEVEL = 4  # 16× native: the coarsest level points sample
# The deepest overview (decimation factor) a source's COGs carry, where it is
# shallower than _MAX_LEVEL: the 1 arc-second DEM stops at 8× (240 m). A coarser
# level is read from that overview and averaged down while reprojecting.
_DEEPEST_OVERVIEW = {"usgs-3dep-1arcsec": 8}


def overview_factor(kind: str, res: float) -> tuple[int, int]:
    """(the decimation factor a level at `res` stands for, the overview it is read from)."""
    factor = max(1, int(round(res / _NATIVE[kind])))
    return factor, min(factor, _DEEPEST_OVERVIEW.get(kind, factor))


def _block(region: Region, kind: str, res: float, bx: int, by: int, mode: str) -> np.ndarray:
    """Pixels of block (bx, by) at resolution res, with a 1-pixel apron on every side."""
    size = BLOCK_PX + 2
    x0 = bx * BLOCK_PX * res - res
    y1 = (by + 1) * BLOCK_PX * res + res  # blocks count northward
    factor, read = overview_factor(kind, res)
    key = f"{kind}|{res}|{bx}|{by}|{mode}"
    if read < factor:
        # averaged down from a finer overview (older caches hold these blocks empty:
        # the overview they asked for doesn't exist, so every tile read failed)
        key += f"|from{read}"
    path = CACHE_ROOT / "levels" / f"{hashlib.sha256(key.encode()).hexdigest()[:20]}.npy"
    path_tag = path.with_suffix(".tag")
    crs_tag = region.crs.to_proj4()
    if path.exists() and path_tag.exists() and path_tag.read_text() == f"{key}|{crs_tag}":
        return np.load(path)
    is_dem = kind in USGS_3DEP
    dst = np.full((size, size), np.nan if is_dem else 0, dtype=np.float32 if is_dem else np.uint8)
    transform = rasterio.Affine(res, 0, x0, 0, -res, y1)
    # tiles overlapping the block, from its lon/lat envelope
    from rasterio.warp import transform as tp

    xs = [x0, x0 + size * res]
    ys = [y1 - size * res, y1]
    lons, lats = tp(
        region.crs, "EPSG:4326", [xs[0], xs[1], xs[0], xs[1]], [ys[0], ys[0], ys[1], ys[1]]
    )
    env = (min(lons) - 0.01, min(lats) - 0.01, max(lons) + 0.01, max(lats) + 0.01)
    urls = usgs_3dep_tiles(env, kind) if is_dem else esa_worldcover_tiles(env)
    resampling = Resampling.average if is_dem else Resampling.mode
    _warp_tiles(urls, dst, transform, region, read, resampling, np.nan if is_dem else 0)
    if is_dem and np.isnan(dst).any():
        # gaps past the data's edge: grow from valid pixels, then the mean
        if np.isnan(dst).all():
            dst[:] = 0.0
        else:
            try:
                dst = fill_nan_nearest(dst, max_iter=16).astype(np.float32)
            except RuntimeError:
                dst = np.where(np.isnan(dst), np.nanmean(dst), dst).astype(np.float32)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.save(path, dst)
    path_tag.write_text(f"{key}|{crs_tag}")
    return dst


def sample_points(
    region: Region,
    kind: str,
    x: np.ndarray,
    y: np.ndarray,
    spacing: np.ndarray,
) -> np.ndarray:
    """Sample a source at projected points (metres): bilinear for elevation,
    nearest for land cover, from the level that matches each point's spacing."""
    is_dem = kind in USGS_3DEP
    native = _NATIVE[kind]
    x = np.asarray(x, dtype=np.float64).ravel()
    y = np.asarray(y, dtype=np.float64).ravel()
    spacing = np.asarray(spacing, dtype=np.float64)
    spacing = spacing.ravel() if spacing.size == x.size else np.broadcast_to(spacing, x.shape)
    level = np.clip(np.floor(np.log2(np.maximum(spacing, native) / native)), 0, _MAX_LEVEL).astype(
        int
    )
    out = np.zeros(x.shape, dtype=np.float64 if is_dem else np.uint8)
    for lv in np.unique(level):
        res = native * 2.0**lv
        sel = np.nonzero(level == lv)[0]
        span = BLOCK_PX * res
        bx = np.floor(x[sel] / span).astype(np.int64)
        by = np.floor(y[sel] / span).astype(np.int64)
        keys = by * 1_000_003 + bx
        for key in np.unique(keys):
            pick = sel[keys == key]
            kbx, kby = int(bx[keys == key][0]), int(by[keys == key][0])
            grid = _block(region, kind, res, kbx, kby, "level")
            # fractional pixel coordinates inside the block (pixel centres at +0.5)
            px = (x[pick] - (kbx * span - res)) / res - 0.5
            py = ((kby + 1) * span + res - y[pick]) / res - 0.5
            if is_dem:
                i0 = np.clip(np.floor(px).astype(int), 0, grid.shape[1] - 2)
                j0 = np.clip(np.floor(py).astype(int), 0, grid.shape[0] - 2)
                fx = np.clip(px - i0, 0, 1)
                fy = np.clip(py - j0, 0, 1)
                g = grid.astype(np.float64)
                out[pick] = (
                    g[j0, i0] * (1 - fx) * (1 - fy)
                    + g[j0, i0 + 1] * fx * (1 - fy)
                    + g[j0 + 1, i0] * (1 - fx) * fy
                    + g[j0 + 1, i0 + 1] * fx * fy
                )
            else:
                i = np.clip(np.round(px).astype(int), 0, grid.shape[1] - 1)
                j = np.clip(np.round(py).astype(int), 0, grid.shape[0] - 1)
                out[pick] = grid[j, i]
    return out


_SMOOTHED: dict[tuple, tuple] = {}


def smoothed_dem(region: Region, kind: str, sigma_m: float, res: float = 480.0):
    """The whole region's elevation at `res`, Gaussian-smoothed (σ in metres), as
    (grid, x0, y1, res) for bilinear sampling: the reference for relief exaggeration."""
    key = (_grid_key(region), kind, sigma_m, res)
    if key not in _SMOOTHED:
        _SMOOTHED[key] = _smoothed_dem(region, kind, sigma_m, res)
    return _SMOOTHED[key]


def _smoothed_dem(region: Region, kind: str, sigma_m: float, res: float):
    from ..gridify import smooth

    x0, y0, x1, y1 = region._projected_envelope()
    margin = 3 * sigma_m
    nx = int(np.ceil((x1 - x0 + 2 * margin) / res)) + 1
    ny = int(np.ceil((y1 - y0 + 2 * margin) / res)) + 1
    gx0, gy1 = x0 - margin, y1 + margin
    xs = gx0 + (np.arange(nx) + 0.5) * res
    ys = gy1 - (np.arange(ny) + 0.5) * res
    gx, gy = np.meshgrid(xs, ys)
    elev = sample_points(region, kind, gx, gy, np.full(gx.size, res)).reshape(ny, nx)
    return smooth(elev, sigma_m / res), gx0, gy1, res


def sample_grid(grid_info, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Bilinear sample of a (grid, x0, y1, res) raster at projected points."""
    grid, gx0, gy1, res = grid_info
    px = (np.asarray(x) - gx0) / res - 0.5
    py = (gy1 - np.asarray(y)) / res - 0.5
    i0 = np.clip(np.floor(px).astype(int), 0, grid.shape[1] - 2)
    j0 = np.clip(np.floor(py).astype(int), 0, grid.shape[0] - 2)
    fx = np.clip(px - i0, 0, 1)
    fy = np.clip(py - j0, 0, 1)
    return (
        grid[j0, i0] * (1 - fx) * (1 - fy)
        + grid[j0, i0 + 1] * fx * (1 - fy)
        + grid[j0 + 1, i0] * (1 - fx) * fy
        + grid[j0 + 1, i0 + 1] * fx * fy
    )
