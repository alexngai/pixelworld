"""High Resolution Canopy Height Maps (WRI and Meta, 1 m, CC BY 4.0): tree
heights for placing trees where they really stand (M3).

The global map is a set of cloud-optimized GeoTIFFs in EPSG:3857, one per
quadkey tile, listed in tiles.geojson. Windows are read over HTTPS (GDAL's
/vsicurl/) and cached per region box under .cache/canopy.
"""

from __future__ import annotations

import hashlib
import json

import numpy as np
from rasterio.warp import transform as transform_points

from .http import CACHE_ROOT, SSL_CONTEXT

BASE = "https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/"
ATTRIBUTION = {
    "name": "High Resolution Canopy Height Maps by WRI and Meta",
    "license": "CC BY 4.0",
    "url": "https://sustainability.atmeta.com/blog/2024/04/22/using-artificial-intelligence-to-map-the-earths-forests/",
}


def _index() -> list[dict]:
    path = CACHE_ROOT / "canopy" / "tiles.geojson"
    if not path.exists():
        import urllib.request

        req = urllib.request.Request(
            BASE + "tiles.geojson", headers={"User-Agent": "pixelworld-pipeline"}
        )
        with urllib.request.urlopen(req, timeout=300, context=SSL_CONTEXT) as r:
            data = r.read()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return json.loads(path.read_text())["features"]


def tiles_for(box: tuple[float, float, float, float]) -> list[str]:
    """Quadkeys of the tiles that intersect a lon/lat box."""
    w, s, e, n = box
    out = []
    for f in _index():
        cs = f["geometry"]["coordinates"][0]
        xs = [c[0] for c in cs]
        ys = [c[1] for c in cs]
        if min(xs) <= e and max(xs) >= w and min(ys) <= n and max(ys) >= s:
            out.append(f["properties"]["tile"])
    return sorted(out)


class CanopyGrid:
    """Canopy height (m) windows over a lon/lat box, sampled at projected points."""

    def __init__(self, box: tuple[float, float, float, float]):
        self.windows: list[tuple[np.ndarray, tuple[float, float, float, float]]] = []
        key = hashlib.sha256(f"{box}".encode()).hexdigest()[:16]
        for tile in tiles_for(box):
            cache = CACHE_ROOT / "canopy" / f"{tile}-{key}.npz"
            if cache.exists():
                d = np.load(cache)
                self.windows.append((d["h"], tuple(d["bounds"])))
                continue
            import rasterio
            from rasterio.warp import transform_bounds
            from rasterio.windows import from_bounds

            env = {
                "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
                "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
            }
            with rasterio.Env(**env), rasterio.open(f"/vsicurl/{BASE}chm/{tile}.tif") as ds:
                b = transform_bounds("EPSG:4326", ds.crs, *box)
                win = from_bounds(*b, ds.transform).round_offsets().round_lengths()
                h = ds.read(1, window=win, boundless=True, fill_value=0)
                wb = ds.window_bounds(win)  # (left, bottom, right, top) in EPSG:3857
            cache.parent.mkdir(parents=True, exist_ok=True)
            np.savez_compressed(cache, h=h, bounds=np.array(wb))
            self.windows.append((h, wb))

    def sample(self, xs: np.ndarray, ys: np.ndarray, crs) -> np.ndarray:
        """Canopy height (m) at projected points of `crs`; 0 where there is no data."""
        out = np.zeros(len(xs))
        if not len(xs):
            return out
        mx, my = transform_points(crs, "EPSG:3857", list(map(float, xs)), list(map(float, ys)))
        mx = np.asarray(mx)
        my = np.asarray(my)
        for h, (left, bottom, right, top) in self.windows:
            rows, cols = h.shape
            c = ((mx - left) / (right - left) * cols).astype(np.int64)
            r = ((top - my) / (top - bottom) * rows).astype(np.int64)
            ok = (c >= 0) & (c < cols) & (r >= 0) & (r < rows)
            out[ok] = np.maximum(out[ok], h[r[ok], c[ok]])
        return out
