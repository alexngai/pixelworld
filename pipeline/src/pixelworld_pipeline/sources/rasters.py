"""Raster sources read from cloud-optimized GeoTIFF overviews over HTTP.

A region names its rasters by kind (`sources.dem.kind`, `sources.landcover.kind`),
and each kind is a source adapter: a `RasterSource` found through the plugin
registry (entry point group `pixelworld.sources`; see plugins.py and
docs/plugins.md). There are two roles:

- `terrain`: elevation in metres. Built in: USGS 3DEP 1 and 1/3 arc-second.
- `landcover`: ESA WorldCover class codes (WORLDCOVER). Built in: WorldCover 2021.

The built-in sources publish 1°–3° tiles with internal overviews, so a 400 km
region at hundreds of metres per cell needs only a few megabytes per tile. An
adapter lists the GeoTIFFs covering a lon/lat box (`tiles`); this module
reprojects them onto the region's grid, caches the result, and samples them
for warped layouts. An adapter that isn't tiled GeoTIFFs overrides `read_into`.
"""

from __future__ import annotations

import hashlib
import json
import math
import warnings
from collections.abc import Iterable

import numpy as np
import rasterio
from rasterio.errors import RasterioIOError
from rasterio.warp import Resampling, reproject

from .. import plugins, progress
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


def _gdal_path(url: str) -> str:
    """What GDAL opens: remote files through /vsicurl/ (range reads), local ones as they are."""
    return "/vsicurl/" + url if url.startswith(("http://", "https://")) else url


def _warp_tiles(
    urls: Iterable[str],
    dst: np.ndarray,
    transform,
    crs,
    overview: int,
    resampling: Resampling,
    dst_nodata,
) -> list[str]:
    """Reproject each GeoTIFF onto dst in turn (a later tile wins where they
    overlap); returns the ones that couldn't be opened."""
    missing = []
    level = _overview_level(overview)
    with rasterio.Env(**GDAL_ENV):
        for url in urls:
            try:
                kwargs = {} if level is None else {"overview_level": level}
                src = rasterio.open(_gdal_path(url), **kwargs)
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
                    dst_crs=crs,
                    dst_nodata=dst_nodata,
                    init_dest_nodata=False,
                    resampling=resampling,
                )
    return missing


# ---- source adapters ------------------------------------------------------------------------


class RasterSource(plugins.Source):
    """A raster source (entry point group `pixelworld.sources`), of role
    `terrain` (`sources.dem`, `micro.dem`) or `landcover` (`sources.landcover`).

    role: `terrain` (elevation in metres, float; gaps are NaN and get filled
      from their neighbours) or `landcover` (ESA WorldCover class codes, uint8;
      0 is no data).
    native_m: the source's pixel size in metres. Warped layouts read a pyramid
      of levels at native_m × 2^i, each from the overview that matches it.
    deepest_overview: the largest decimation factor the files' internal
      overviews reach (None: deep enough for every level). Coarser levels read
      that overview and average it down.
    attribution: the manifest's entry for it ({name, license, url}).

    Implement `tiles` for a source published as GeoTIFF tiles (cloud-optimized
    ones are read over HTTP range requests), or override `read_into` for
    anything else.
    """

    native_m: float = 0.0
    deepest_overview: int | None = None

    def tiles(self, bounds: tuple[float, float, float, float]) -> list[str]:
        """URLs (or local paths) of the GeoTIFFs covering a lon/lat box (west,
        south, east, north). Tiles that don't exist are skipped when read."""
        raise NotImplementedError(f"{type(self).__name__} lists no tiles")

    def read_into(
        self,
        dst: np.ndarray,
        transform,
        crs,
        bounds: tuple[float, float, float, float],
        overview: int,
        resampling: Resampling,
        nodata,
    ) -> list[str]:
        """Fill `dst` (pixels on the affine `transform` in `crs`) from the source,
        read at the overview with decimation factor `overview` (1: full
        resolution) and resampled with `resampling`. Pixels the source doesn't
        cover keep their value (`nodata`). `bounds` is the lon/lat box dst
        covers, with a margin. Returns what couldn't be read (missing tiles),
        for the build log."""
        return _warp_tiles(self.tiles(bounds), dst, transform, crs, overview, resampling, nodata)


Ref = str | dict


def source(ref: Ref, role: str | None = None, region: Region | None = None, *, where=None):
    """The raster source a spec block (`{kind, …options}`) or a bare kind names,
    opened for the region and checked to have `role` (by default, its own)."""
    kind, _ = plugins.split_ref(ref, where)
    return plugins.open_source(role or plugins.role_of(kind) or "terrain", ref, region, where=where)


# built-in kinds whose output changed under the same spec: their caches are written anew
CACHE_TAGS = {"copernicus-glo30-ground": "|town3"}  # the opening only in town (D-115)


def _ref_key(ref: Ref) -> str:
    """A spec block's part of a cache key: its kind, and its options if it has any
    (so caches written before options existed still match)."""
    kind, options = plugins.split_ref(ref)
    return (
        kind + (json.dumps(options, sort_keys=True) if options else "") + CACHE_TAGS.get(kind, "")
    )


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


class USGS3DEP(RasterSource):
    """USGS 3D Elevation Program DEMs (public domain): 1°×1° cloud-optimized
    GeoTIFFs on the National Map's S3 bucket. US only: the first terrain source."""

    role = "terrain"

    def __init__(self, kind: str, native_m: float, title: str, deepest_overview: int | None = None):
        self.kind = kind
        self.native_m = native_m
        self.deepest_overview = deepest_overview
        self.attribution = {
            "name": f"USGS 3D Elevation Program (3DEP) {title} DEM",
            "license": "Public domain",
            "url": "https://www.usgs.gov/3d-elevation-program",
        }

    def tiles(self, bounds: tuple[float, float, float, float]) -> list[str]:
        return usgs_3dep_tiles(bounds, self.kind)


# the 1 arc-second DEM's overviews stop at 8× (240 m)
USGS_3DEP_1ARCSEC = USGS3DEP("usgs-3dep-1arcsec", 30.0, "1 arc-second", deepest_overview=8)
USGS_3DEP_13ARCSEC = USGS3DEP("usgs-3dep-13arcsec", 10.0, "1/3 arc-second")


def copernicus_glo30_tiles(bounds: tuple[float, float, float, float]) -> list[str]:
    w, s, e, n = bounds
    urls = []
    for lat in range(math.floor(s), math.ceil(n)):
        for lon in range(math.floor(w), math.ceil(e)):
            ns = f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}_00"
            ew = f"{'E' if lon >= 0 else 'W'}{abs(lon):03d}_00"
            name = f"Copernicus_DSM_COG_10_{ns}_{ew}_DEM"
            urls.append(f"https://copernicus-dem-30m.s3.amazonaws.com/{name}/{name}.tif")
    return urls


class CopernicusGLO30(RasterSource):
    """Copernicus DEM GLO-30: a 30 m surface model of the whole world, 1°×1°
    cloud-optimized GeoTIFFs on AWS (D-107). A surface model: in a dense city
    or a forest it stands on roofs and canopy; `copernicus-glo30-ground`
    takes them off. Tiles over the sea don't exist and are skipped."""

    role = "terrain"
    native_m = 30.0
    deepest_overview = 8
    attribution = {
        "name": (
            "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence "
            "and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; "
            "all rights reserved. The organisations in charge of the Copernicus programme by law "
            "or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30."
        ),
        "license": "Copernicus DEM licence (GLO-30): free, worldwide, adaptation allowed",
        "url": "https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM",
    }

    def tiles(self, bounds: tuple[float, float, float, float]) -> list[str]:
        return copernicus_glo30_tiles(bounds)


# how far the surface model may stand on a canopy outside town (D-115)
CANOPY_M = 12.0


def ground_filter(
    a: np.ndarray, k: int, built: np.ndarray | None = None, trees: np.ndarray | None = None
) -> np.ndarray:
    """A surface model's ground: a grey opening (the lowest value in each k×k
    window, then the highest of those) that takes off what stands narrower
    than the window (buildings, trees), then a 3×3 mean. Water (≤ 0.5 m) and
    gaps (NaN) are left as they are and don't pull the shore down (D-107).

    With `built` (built-up land on the same grid), the opening is kept whole
    only in town: built-up land at least 3 pixels across (a road or a row of
    houses over a hill isn't), widened by a pixel and feathered over three.
    Elsewhere it may lower the surface by at most `CANOPY_M` under `trees`
    and not at all on open ground, so it doesn't plane off summits and ridges
    (D-115)."""
    from scipy import ndimage

    if k < 3:
        return a
    water = ~(a > 0.5)
    b = ndimage.grey_erosion(np.where(water, np.inf, a), size=(k, k))
    b = ndimage.grey_dilation(np.where(water, -np.inf, b), size=(k, k))
    b = np.where(np.isfinite(b), b, a)
    ok = np.isfinite(b)
    weight = ndimage.uniform_filter(ok.astype(float), 3)
    mean = ndimage.uniform_filter(np.where(ok, b, 0.0), 3) / np.maximum(weight, 1e-9)
    ground = np.where(water | ~ok, a, mean)
    if built is None:
        return ground
    # ponytail: one canopy height for every wood; read the canopy map if hills' woods vary
    cap = CANOPY_M * trees if trees is not None else 0.0
    country = np.minimum(a, np.maximum(ground, a - cap))
    # town is built-up land 3 pixels across or more: a road, a dual carriageway
    # or a row of houses over a hill isn't
    square = np.ones((3, 3), bool)
    town = ndimage.binary_dilation(ndimage.binary_opening(built, square), square)
    w = ndimage.uniform_filter(town.astype(float), 3)
    return w * ground + (1.0 - w) * country


class CopernicusGLO30Ground(CopernicusGLO30):
    """GLO-30 with buildings taken off by `ground_filter` over a 210 m window,
    on its own 1″ grid before it's warped onto the region's, where ESA
    WorldCover 2021 says the land is built up; outside town only a canopy's
    height comes off its trees, and open hills keep GLO-30 as it is (D-115).
    Measured in Kowloon against the Lands Department's 5 m DTM with the
    filter everywhere: an RMSE of 7.9 m on flat streets (12.3 m unfiltered),
    15.4 m on slopes over 15° (13.4 m unfiltered) (D-107). On Hong Kong
    Island's 183 surveyed summits, the filter everywhere read 36 m low
    (median), GLO-30 as it is 5 m (D-115)."""

    window_m = 210.0

    def read_into(self, dst, transform, crs, bounds, overview, resampling, nodata) -> list[str]:
        from rasterio.transform import from_origin

        pad = 2 * self.window_m / 111_000  # degrees, past the window's reach
        w, s, e, n = bounds[0] - pad, bounds[1] - pad, bounds[2] + pad, bounds[3] + pad
        step = overview / 3600  # GLO-30's 1″ pixels at this overview (wider in longitude past 50°)
        grid = np.full((math.ceil((n - s) / step), math.ceil((e - w) / step)), np.nan, np.float32)
        grid_transform = from_origin(w, n, step, step)
        missing = _warp_tiles(
            self.tiles((w, s, e, n)),
            grid,
            grid_transform,
            "EPSG:4326",
            overview,
            Resampling.nearest,
            np.nan,
        )
        k = int(round(self.window_m / (self.native_m * overview))) | 1
        ground = grid
        if k >= 3:  # under 3 pixels at this overview, the window takes nothing off
            cover = np.zeros(grid.shape, np.uint8)
            missing += _warp_tiles(
                esa_worldcover_tiles((w, s, e, n)),
                cover,
                grid_transform,
                "EPSG:4326",
                overview,
                Resampling.mode,
                0,
            )
            if not cover.any():
                progress.log("terrain: no WorldCover here, so no town to filter: GLO-30 as it is")
            ground = ground_filter(grid, k, built=cover == 50, trees=np.isin(cover, (10, 95)))
        reproject(
            source=ground,
            destination=dst,
            src_transform=grid_transform,
            src_crs="EPSG:4326",
            src_nodata=np.nan,
            dst_transform=transform,
            dst_crs=crs,
            dst_nodata=nodata,
            init_dest_nodata=False,
            resampling=resampling,
        )
        return missing


COPERNICUS_GLO30 = CopernicusGLO30()
COPERNICUS_GLO30_GROUND = CopernicusGLO30Ground()


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
    src = source(spec, "terrain", region, where="sources.dem")
    overview = int(spec.get("overview", 4))
    # average when shrinking the source; bilinear when cells are finer than it
    resampling = Resampling[spec.get("resampling", "average")]
    params = f"{_ref_key(spec)}|{overview}"
    if resampling != Resampling.average:
        params += f"|{resampling.name}"
    if k != 1:
        params += f"|micro{k}"
    path = _cache_path(region, "dem", params)
    if path.exists():
        return np.load(path)
    cx, cy = region.cells
    dst = np.full((cy * k + 1, cx * k + 1), np.nan, dtype=np.float32)
    west, north, _, _ = region.grid
    pm = region.meters_per_cell / k  # corner spacing; pixel centres sit on the corners
    transform = rasterio.Affine(pm, 0, west - pm / 2, 0, -pm, north + pm / 2)
    missing = src.read_into(
        dst, transform, region.crs, region.lonlat_envelope(), overview, resampling, np.nan
    )
    if missing:
        progress.log(f"dem: {len(missing)} tiles missing (outside coverage?)")
    gaps = int(np.isnan(dst).sum())
    if gaps:
        progress.log(f"dem: filling {gaps} empty corners")
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


class ESAWorldCover(RasterSource):
    """ESA WorldCover 2021 (CC BY 4.0): 10 m land cover in 3°×3° cloud-optimized
    GeoTIFFs on AWS, global: the built-in landcover source."""

    role = "landcover"
    native_m = 10.0
    attribution = {
        "name": "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data "
        "(2021) processed by ESA WorldCover consortium",
        "license": "CC BY 4.0",
        "url": "https://esa-worldcover.org",
    }

    def tiles(self, bounds: tuple[float, float, float, float]) -> list[str]:
        return esa_worldcover_tiles(bounds)


ESA_WORLDCOVER_2021 = ESAWorldCover()
# GLO-30's ground reads WorldCover's built-up land (D-115)
CopernicusGLO30Ground.attribution = [CopernicusGLO30.attribution, ESAWorldCover.attribution]


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
    src = source(spec, "landcover", region, where="sources.landcover")
    overview = int(spec.get("overview", 16))
    path = _cache_path(region, "landcover", f"{_ref_key(spec)}|{overview}")
    if path.exists():
        return np.load(path)
    cx, cy = region.cells
    dst = np.zeros((cy, cx), dtype=np.uint8)
    missing = src.read_into(
        dst,
        region.cell_transform(),
        region.crs,
        region.lonlat_envelope(),
        overview,
        Resampling.mode,
        0,
    )
    if missing:
        progress.log(f"landcover: {len(missing)} tiles missing")
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
    src = source(spec, "landcover", region, where="sources.landcover")
    m = region.meters_per_cell
    factor = max(1, round(m / meters))
    px = m / factor
    path = _cache_path(region, "landcover-fine", f"{_ref_key(spec)}|{px}")
    if path.exists():
        return np.load(path), px
    cx, cy = region.cells
    dst = np.zeros((cy * factor, cx * factor), dtype=np.uint8)
    west, north, _, _ = region.grid
    transform = rasterio.Affine(px, 0, west, 0, -px, north)
    missing = src.read_into(
        dst, transform, region.crs, region.lonlat_envelope(), 1, Resampling.nearest, 0
    )
    if missing:
        progress.log(f"landcover (fine): {len(missing)} tiles missing")
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
_MAX_LEVEL = 4  # 16× native: the coarsest level points sample
# Where a source's `deepest_overview` is shallower than _MAX_LEVEL (the 1
# arc-second DEM stops at 8×, 240 m), a coarser level is read from that
# overview and averaged down while reprojecting.


def overview_factor(kind: Ref, res: float, region: Region | None = None) -> tuple[int, int]:
    """(the decimation factor a level at `res` stands for, the overview it is read from)."""
    src = source(kind, region=region)
    factor = max(1, int(round(res / src.native_m)))
    return factor, min(factor, src.deepest_overview or factor)


def _block(region: Region, kind: Ref, res: float, bx: int, by: int, mode: str) -> np.ndarray:
    """Pixels of block (bx, by) at resolution res, with a 1-pixel apron on every side."""
    size = BLOCK_PX + 2
    x0 = bx * BLOCK_PX * res - res
    y1 = (by + 1) * BLOCK_PX * res + res  # blocks count northward
    factor, read = overview_factor(kind, res, region)
    key = f"{_ref_key(kind)}|{res}|{bx}|{by}|{mode}"
    if read < factor:
        # averaged down from a finer overview (older caches hold these blocks empty:
        # the overview they asked for doesn't exist, so every tile read failed)
        key += f"|from{read}"
    path = CACHE_ROOT / "levels" / f"{hashlib.sha256(key.encode()).hexdigest()[:20]}.npy"
    path_tag = path.with_suffix(".tag")
    crs_tag = region.crs.to_proj4()
    if path.exists() and path_tag.exists() and path_tag.read_text() == f"{key}|{crs_tag}":
        return np.load(path)
    src = source(kind, region=region)
    is_dem = src.role == "terrain"
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
    resampling = Resampling.average if is_dem else Resampling.mode
    src.read_into(dst, transform, region.crs, env, read, resampling, np.nan if is_dem else 0)
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
    kind: Ref,
    x: np.ndarray,
    y: np.ndarray,
    spacing: np.ndarray,
) -> np.ndarray:
    """Sample a source at projected points (metres): bilinear for elevation,
    nearest for land cover, from the level that matches each point's spacing."""
    src = source(kind, region=region)
    is_dem = src.role == "terrain"
    native = src.native_m
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


def smoothed_dem(region: Region, kind: Ref, sigma_m: float, res: float = 480.0):
    """The whole region's elevation at `res`, Gaussian-smoothed (σ in metres), as
    (grid, x0, y1, res) for bilinear sampling: the reference for relief exaggeration."""
    key = (_grid_key(region), _ref_key(kind), sigma_m, res)
    if key not in _SMOOTHED:
        _SMOOTHED[key] = _smoothed_dem(region, kind, sigma_m, res)
    return _SMOOTHED[key]


def _smoothed_dem(region: Region, kind: Ref, sigma_m: float, res: float):
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
