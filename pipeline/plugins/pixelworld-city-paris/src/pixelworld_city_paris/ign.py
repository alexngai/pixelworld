"""IGN's elevation models of France (D-084), read anonymously from the
Géoplateforme's WMS-Raster as float32 GeoTIFFs in Lambert-93 (EPSG:2154).

Two terrain sources (`pixelworld.sources`, role `terrain`):
- `ign-rgealti`: RGE ALTI®, the 1 m DTM of all of France (WMS layer
  ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES);
- `ign-lidar-hd-mnt`: the 50 cm DTM from the LiDAR HD programme, where it has
  been flown (Paris has; IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93).
  It keeps cuttings and trenches (the boulevard périphérique, railway cuts)
  that RGE ALTI smooths.

A region names one as its DEM:

    sources:
      dem: { kind: ign-rgealti, overview: 4 }

The overview is a decimation factor as for any source: the server resamples,
so `overview: 4` reads RGE ALTI at 4 m. Tiles are 2,000 pixels square on a
fixed Lambert-93 grid, cached under ign/ in the shared download cache.

Licence (checked 2026-11-10, second-region.md §8): IGN's catalogue records
for RGE ALTI 2.0 and LiDAR HD say "Licence Ouverte / Open License"
(Etalab 2.0); the Géoplateforme's terms apply the data's own licence, and the
Licence Ouverte where none is given.
"""

from __future__ import annotations

import math
import urllib.parse

import numpy as np
import rasterio
from rasterio.warp import Resampling, reproject, transform_bounds

from pixelworld_pipeline.sources.http import cache_dir, get
from pixelworld_pipeline.sources.rasters import RasterSource

WMS = "https://data.geopf.fr/wms-r/wms?"
LAMBERT93 = "EPSG:2154"
TILE = 2000  # pixels; the service allows up to 5010


class IGNElevation(RasterSource):
    """An IGN DTM layer of the Géoplateforme's WMS-Raster."""

    role = "terrain"
    deepest_overview = None  # the server resamples to any resolution

    def __init__(self, layer: str, native_m: float, title: str, url: str):
        self.layer = layer
        self.native_m = native_m
        self.attribution = {
            "name": f"IGN, {title} (Géoplateforme WMS-Raster, as fetched)",
            "license": "Licence Ouverte / Open Licence 2.0 (Etalab)",
            "url": url,
        }

    def tile_url(self, res: float, ix: int, iy: int) -> str:
        span = TILE * res
        x0, y0 = ix * span, iy * span
        q = {
            "SERVICE": "WMS",
            "VERSION": "1.3.0",
            "REQUEST": "GetMap",
            "LAYERS": self.layer,
            "STYLES": "",
            "CRS": LAMBERT93,
            "BBOX": f"{x0:.3f},{y0:.3f},{x0 + span:.3f},{y0 + span:.3f}",
            "WIDTH": str(TILE),
            "HEIGHT": str(TILE),
            "FORMAT": "image/geotiff",
        }
        return WMS + urllib.parse.urlencode(q)

    def fetch(self, bounds: tuple[float, float, float, float], res: float) -> list[str]:
        """Local GeoTIFFs at `res` metres covering a lon/lat box (downloaded once)."""
        x0, y0, x1, y1 = transform_bounds("EPSG:4326", LAMBERT93, *bounds)
        span = TILE * res
        out = []
        for iy in range(math.floor(y0 / span), math.ceil(y1 / span)):
            for ix in range(math.floor(x0 / span), math.ceil(x1 / span)):
                path = cache_dir("ign") / f"{self.layer}-{res:g}m-{ix}-{iy}.tif"
                if not path.exists():
                    data = get(self.tile_url(res, ix, iy), timeout=300)
                    if data[:4] not in (b"II*\x00", b"MM\x00*"):
                        raise RuntimeError(f"IGN WMS-R: not a GeoTIFF: {data[:200]!r}")
                    tmp = path.with_suffix(".part")
                    tmp.write_bytes(data)
                    # the service labels Lambert-93 with an unnamed datum: say it is EPSG:2154
                    with rasterio.open(tmp, "r+") as f:
                        f.crs = LAMBERT93
                    tmp.rename(path)
                out.append(str(path))
        return out

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
        for path in self.fetch(bounds, self.native_m * max(1, int(overview))):
            with rasterio.open(path) as src:
                reproject(
                    source=rasterio.band(src, 1),
                    destination=dst,
                    src_transform=src.transform,
                    src_crs=src.crs,
                    src_nodata=src.nodata,
                    dst_transform=transform,
                    dst_crs=crs,
                    dst_nodata=nodata,
                    init_dest_nodata=False,
                    resampling=resampling,
                )
        return []


RGE_ALTI = IGNElevation(
    "ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES",
    1.0,
    "RGE ALTI® 1 m",
    "https://cartes.gouv.fr/rechercher-une-donnee/dataset/IGNF_RGE-ALTI",
)
LIDAR_HD_MNT = IGNElevation(
    "IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93",
    0.5,
    "MNT LiDAR HD 50 cm",
    "https://cartes.gouv.fr/rechercher-une-donnee/dataset/IGNF_NUAGES-DE-POINTS-LIDAR-HD",
)
