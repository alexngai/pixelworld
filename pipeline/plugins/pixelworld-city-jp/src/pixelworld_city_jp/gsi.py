"""Japan's elevation from the Geospatial Information Authority of Japan (GSI,
国土地理院): its elevation tiles (地理院タイル 標高タイル), PNG tiles on the Web
Mercator grid, read anonymously (D-089).

One terrain source (`pixelworld.sources`, role `terrain`), `gsi-dem`, reads
three of GSI's DEMs, finest first:
- DEM1A (`dem1a_png`, 1 m, to zoom 17): from airborne lidar, where flown;
- DEM5A (`dem5a_png`, 5 m, to zoom 15): airborne lidar, most cities;
- DEM10B (`dem_png`, 10 m, to zoom 14): all of Japan, from contours.

A region names it as its DEM:

    sources:
      dem: { kind: gsi-dem, overview: 4 }

The overview is a decimation factor as for any source: the tiles are read at
the zoom whose pixels are just finer than 1 m × overview (zoom 17 for 1 m,
15 for 4 m at Kyoto's latitude), from the finest DEM with a tile there; a
tile that is missing or has holes (water, the edge of a survey) is filled
from the next DEM's. Each DEM's tiles are mosaicked in Web Mercator and
reprojected onto the region's grid, the coarser first. Tiles are cached under
gsi/<DEM>/<z>/<x>/<y>.png in the shared download cache (an empty file marks a
tile the server doesn't have).

Each pixel is 24 bits, x = R·2¹⁶ + G·2⁸ + B: below 2²³ the height is 0.01·x
metres, 2²³ is no data, above it 0.01·(x − 2²⁴) (below sea level).

Licence (GSI's content terms, revised 2025-11-20, checked 2026-11-11;
second-region.md §9): Public Data License 1.0, compatible with CC BY 4.0,
credited "出典：国土地理院ウェブサイト"; processed data must say so
("地理院タイル（標高タイル）を加工して作成") and mustn't be presented as GSI's.
"""

from __future__ import annotations

import math
import urllib.error
import warnings

import numpy as np
from rasterio.errors import NotGeoreferencedWarning
from rasterio.io import MemoryFile
from rasterio.transform import Affine
from rasterio.warp import Resampling, reproject

from pixelworld_pipeline.sources.http import cache_dir, get
from pixelworld_pipeline.sources.rasters import RasterSource

TILES = "https://cyberjapandata.gsi.go.jp/xyz/{dem}/{z}/{x}/{y}.png"
# (tile set, its deepest zoom), finest first
DEMS = (("dem1a_png", 17), ("dem5a_png", 15), ("dem_png", 14))
WEB_MERCATOR = "EPSG:3857"
HALF = 20037508.342789244  # half the Web Mercator world, metres
TILE = 256
NO_DATA = 1 << 23


def decode(png: bytes) -> np.ndarray:
    """A tile's heights in metres (float32, NaN where it has no data)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", NotGeoreferencedWarning)
        with MemoryFile(png) as mem, mem.open() as f:
            rgb = f.read([1, 2, 3]).astype(np.int64)
    x = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]
    h = np.where(x < NO_DATA, x, x - (1 << 24)) * 0.01
    h[x == NO_DATA] = np.nan
    return h.astype(np.float32)


def tile_xy(lon: float, lat: float, z: int) -> tuple[int, int]:
    """The Web Mercator tile holding a point at zoom z."""
    k = 1 << z
    x = (lon + 180) / 360 * k
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * k
    return min(int(x), k - 1), min(int(y), k - 1)


def zoom_for(res: float, lat: float) -> int:
    """The coarsest zoom whose pixels are at most `res` metres on the ground."""
    ground = 2 * HALF * math.cos(math.radians(lat)) / TILE  # metres per pixel at zoom 0
    return max(0, min(DEMS[0][1], math.ceil(math.log2(ground / res))))


def tile(dem: str, z: int, x: int, y: int) -> np.ndarray | None:
    """A tile's heights (None where the server has no tile), cached."""
    path = cache_dir("gsi") / dem / str(z) / str(x) / f"{y}.png"
    if path.exists():
        data = path.read_bytes()
    else:
        try:
            data = get(TILES.format(dem=dem, z=z, x=x, y=y), timeout=60)
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            data = b""
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return decode(data) if data else None


def mosaic(tiles: dict[tuple[int, int], np.ndarray], z: int) -> tuple[np.ndarray, Affine]:
    """Tiles of one zoom as one array in Web Mercator, NaN between them."""
    x0, y0 = min(x for x, _ in tiles), min(y for _, y in tiles)
    nx = max(x for x, _ in tiles) - x0 + 1
    ny = max(y for _, y in tiles) - y0 + 1
    out = np.full((ny * TILE, nx * TILE), np.nan, dtype=np.float32)
    for (x, y), a in tiles.items():
        out[(y - y0) * TILE : (y - y0 + 1) * TILE, (x - x0) * TILE : (x - x0 + 1) * TILE] = a
    size = 2 * HALF / (1 << z) / TILE
    return out, Affine(size, 0, -HALF + x0 * TILE * size, 0, -size, HALF - y0 * TILE * size)


class GSIElevation(RasterSource):
    """GSI's DEM1A, DEM5A and DEM10B elevation tiles, finest first."""

    role = "terrain"
    native_m = 1.0
    deepest_overview = None  # every zoom is served
    attribution = {
        "name": (
            "出典：国土地理院ウェブサイト (地理院タイル 標高タイル: DEM1A, DEM5A, DEM10B). "
            "地理院タイル（標高タイル（基盤地図情報数値標高モデル））を加工して作成 "
            "(processed: mosaicked, resampled onto the world's grid and gaps filled; "
            "not GSI's data as published)"
        ),
        "license": "Public Data License 1.0 (PDL 1.0), compatible with CC BY 4.0",
        "url": "https://maps.gsi.go.jp/development/ichiran.html",
    }

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
        w, s, e, n = bounds
        zoom = zoom_for(self.native_m * max(1, int(overview)), (s + n) / 2)
        (xa, ya), (xb, yb) = tile_xy(w, n, zoom), tile_xy(e, s, zoom)
        want = {(x, y) for x in range(xa, xb + 1) for y in range(ya, yb + 1)}
        layers = []  # finest first
        gaps: list[tuple[int, int]] = []
        z = zoom
        for dem, deepest in DEMS:
            # a coarser DEM fills the gaps, from the tile at its own zoom holding each
            dz = max(0, z - min(zoom, deepest))
            z -= dz
            want = {(x >> dz, y >> dz) for x, y in want}
            got, gaps = {}, []
            for x, y in sorted(want):
                a = tile(dem, z, x, y)
                if a is None or np.isnan(a).any():
                    gaps.append((x, y))
                if a is not None and not np.isnan(a).all():
                    got[(x, y)] = a
            if got:
                layers.append(mosaic(got, z))
            if not gaps:
                break
            want = set(gaps)
        for a, src_transform in reversed(layers):
            reproject(
                source=a,
                destination=dst,
                src_transform=src_transform,
                src_crs=WEB_MERCATOR,
                src_nodata=np.nan,
                dst_transform=transform,
                dst_crs=crs,
                dst_nodata=nodata,
                init_dest_nodata=False,
                resampling=resampling,
            )
        return [f"{DEMS[-1][0]}/{z}/{x}/{y}" for x, y in gaps]


GSI_DEM = GSIElevation()
