"""USGS 3DEP lidar point clouds (public domain), read as Entwine Point Tiles
from the public AWS bucket, for building heights and massing (M3, D-052).

An EPT dataset is an octree of LAZ tiles: depth d holds points spaced about
(root cube edge / span / 2^d). Reading every node down to a modest depth over
an area gives an even, thinned sample of the whole survey, enough for a height
grid of a few metres. Tiles and hierarchy files are cached under .cache/lidar.

It is the built-in source of role `heights` (`usgs-3dep-lidar`, D-110):
`sources.heights: { kind: usgs-3dep-lidar, project: <an EPT project> }`.
"""

from __future__ import annotations

import hashlib
import io
import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from rasterio.transform import Affine
from rasterio.warp import transform as transform_points

from ..plugins import Source
from ..region import RegionError
from ..schema import Key, Str
from .http import CACHE_ROOT, SSL_CONTEXT

BUCKET = "https://usgs-lidar-public.s3.amazonaws.com/"
GROUND = 2
# above-ground structure: buildings (6) where a survey classifies them, else the
# unclassified returns (1), which inside a footprint are mostly roof
STRUCTURE = (1, 6)


def _get(url: str, path: Path) -> bytes:
    if path.exists():
        return path.read_bytes()
    req = urllib.request.Request(url, headers={"User-Agent": "pixelworld-pipeline"})
    with urllib.request.urlopen(req, timeout=120, context=SSL_CONTEXT) as r:
        data = r.read()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def _json(project: str, name: str) -> dict:
    return json.loads(_get(f"{BUCKET}{project}/{name}", CACHE_ROOT / "lidar" / project / name))


def node_bounds(cube: list[float], key: str) -> tuple[float, float, float, float]:
    """(x0, y0, x1, y1) of an octree node D-X-Y-Z inside the root cube."""
    d, x, y, _ = (int(v) for v in key.split("-"))
    size = (cube[3] - cube[0]) / 2**d
    return (
        cube[0] + x * size,
        cube[1] + y * size,
        cube[0] + (x + 1) * size,
        cube[1] + (y + 1) * size,
    )


def nodes(project: str, box: tuple[float, float, float, float], max_depth: int) -> list[str]:
    """Keys of the nodes (with points) down to max_depth that intersect box
    (EPSG:3857 metres, x0 y0 x1 y1)."""
    meta = _json(project, "ept.json")
    cube = meta["bounds"]
    out: list[str] = []
    pending = ["0-0-0-0"]
    hier = _json(project, "ept-hierarchy/0-0-0-0.json")
    while pending:
        key = pending.pop()
        count = hier.get(key)
        if count == -1:  # the subtree's counts live in their own file
            hier |= _json(project, f"ept-hierarchy/{key}.json")
            count = hier.get(key)
        if not count:
            continue
        x0, y0, x1, y1 = node_bounds(cube, key)
        if x1 < box[0] or x0 > box[2] or y1 < box[1] or y0 > box[3]:
            continue
        out.append(key)
        d, x, y, z = (int(v) for v in key.split("-"))
        if d < max_depth:
            for dx in (0, 1):
                for dy in (0, 1):
                    for dz in (0, 1):
                        child = f"{d + 1}-{2 * x + dx}-{2 * y + dy}-{2 * z + dz}"
                        if child in hier:
                            pending.append(child)
    return sorted(out)


def read_node(project: str, key: str) -> np.ndarray:
    """(n, 4) float64: x, y (EPSG:3857), z (m), classification."""
    cache = CACHE_ROOT / "lidar" / project / "points" / f"{key}.npy"
    if cache.exists():
        return np.load(cache)
    import laspy

    data = _get(
        f"{BUCKET}{project}/ept-data/{key}.laz",
        CACHE_ROOT / "lidar" / project / "laz" / f"{key}.laz",
    )
    las = laspy.read(io.BytesIO(data))
    pts = np.column_stack([las.x, las.y, las.z, np.asarray(las.classification, dtype=np.float64)])
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.save(cache, pts)
    (CACHE_ROOT / "lidar" / project / "laz" / f"{key}.laz").unlink(missing_ok=True)
    return pts


@dataclass
class HeightGrid:
    """Height of buildings above the ground on a regular grid in the region's CRS."""

    heights: np.ndarray  # (rows, cols) metres above ground where lidar saw a building, else 0
    covered: np.ndarray  # (rows, cols) bool: the survey has points here
    transform: Affine  # pixel → projected metres (rows run north to south)
    res: float

    def window(self, bounds: tuple[float, float, float, float]):
        """(row0, row1, col0, col1) of grid cells covering projected bounds."""
        inv = ~self.transform
        c0, r0 = inv @ (bounds[0], bounds[3])
        c1, r1 = inv @ (bounds[2], bounds[1])
        rows, cols = self.heights.shape
        return (
            max(0, int(np.floor(r0))),
            min(rows, int(np.ceil(r1))),
            max(0, int(np.floor(c0))),
            min(cols, int(np.ceil(c1))),
        )


def height_grid(
    project: str,
    lonlat_box: tuple[float, float, float, float],
    crs,
    res: float = 4.0,
    max_depth: int = 6,
) -> HeightGrid | None:
    """Building heights above ground (m) on a res-metre grid over a lon/lat box,
    or None where the survey has no points."""
    tag = f"{project}|{lonlat_box}|{crs.to_proj4()}|{res}|{max_depth}"
    key = hashlib.sha256(tag.encode()).hexdigest()[:16]
    cache = CACHE_ROOT / "lidar" / "grids" / f"{project}-{key}.npz"
    meta_path = cache.with_suffix(".tag")
    if cache.exists() and meta_path.exists() and meta_path.read_text() == tag:
        d = np.load(cache)
        return HeightGrid(d["heights"], d["covered"], Affine(*d["transform"][:6]), float(d["res"]))

    w, s, e, n = lonlat_box
    mx, my = transform_points("EPSG:4326", "EPSG:3857", [w, e], [s, n])
    keys = nodes(project, (min(mx), min(my), max(mx), max(my)), max_depth)
    with ThreadPoolExecutor(8) as pool:
        parts = list(pool.map(lambda k: read_node(project, k), keys))
    pts = np.concatenate(parts) if parts else np.zeros((0, 4))
    inside = (
        (pts[:, 0] >= min(mx))
        & (pts[:, 0] <= max(mx))
        & (pts[:, 1] >= min(my))
        & (pts[:, 1] <= max(my))
    )
    pts = pts[inside]
    if len(pts) == 0:
        return None  # the survey doesn't cover this box
    px, py = transform_points("EPSG:3857", crs, pts[:, 0].tolist(), pts[:, 1].tolist())
    px = np.asarray(px)
    py = np.asarray(py)
    x0, y1 = float(px.min()), float(py.max())
    cols = int(np.ceil((px.max() - x0) / res)) + 1
    rows = int(np.ceil((y1 - py.min()) / res)) + 1
    col = ((px - x0) / res).astype(np.int64)
    row = ((y1 - py) / res).astype(np.int64)
    cls = pts[:, 3].astype(np.int64)
    z = pts[:, 2]
    covered = np.zeros((rows, cols), bool)
    covered[row, col] = True
    # ground: the lowest ground return per cell, gaps filled from the nearest cell
    from scipy import ndimage

    ground = np.full((rows, cols), np.inf)
    g = cls == GROUND
    np.minimum.at(ground, (row[g], col[g]), z[g])
    have = np.isfinite(ground)
    if have.any():
        _, (ir, ic) = ndimage.distance_transform_edt(~have, return_indices=True)
        ground = ground[ir, ic]
    else:
        ground = np.zeros((rows, cols))
    top = np.full((rows, cols), -np.inf)
    b = np.isin(cls, STRUCTURE)
    np.maximum.at(top, (row[b], col[b]), z[b])
    heights = np.where(np.isfinite(top), np.maximum(top - ground, 0.0), 0.0)
    tr = Affine(res, 0, x0, 0, -res, y1)
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        cache, heights=heights, covered=covered, transform=np.array(tr)[:6], res=res
    )
    meta_path.write_text(tag)
    return HeightGrid(heights, covered, tr, res)


class HeightSource(Source):
    """The contract of role `heights`: building heights above the ground, for
    massing (`objects.buildings.lidar`)."""

    role = "heights"

    def height_grid(
        self, lonlat_box: tuple[float, float, float, float], crs, res: float, max_depth: int
    ) -> HeightGrid | None:
        """Heights above ground (m) on a res-metre grid in `crs` over a lon/lat box,
        or None where there is no data. `max_depth` is how fine to read (a source
        may ignore it)."""
        raise NotImplementedError


class USGSLidar(HeightSource):
    """USGS 3DEP lidar (EPT on AWS). Option `project` (required): the EPT
    project's name, e.g. USGS_LPC_NV_LasVegas_QL1_2016_LAS_2018."""

    attribution = {
        "name": "USGS 3D Elevation Program (3DEP) lidar point clouds",
        "license": "Public domain",
        "url": "https://www.usgs.gov/3d-elevation-program",
    }

    options_schema = {
        "project": Key(
            Str(),
            "The USGS 3DEP lidar project (e.g. `USGS_LPC_NV_LasVegas_QL1_2016_LAS_2018`).",
            required=True,
        )
    }

    def __init__(self, region=None, options=None):
        super().__init__(region, options)
        self.project = str(self.options.pop("project", "") or "")
        if not self.project:
            raise RegionError("sources.heights: usgs-3dep-lidar needs `project:` (an EPT project)")
        if self.options:
            unknown = ", ".join(sorted(self.options))
            raise RegionError(f"sources.heights: unknown usgs-3dep-lidar options {unknown}")

    def height_grid(self, lonlat_box, crs, res, max_depth):
        return height_grid(self.project, lonlat_box, crs, res, max_depth)

    def summary(self) -> str:
        return f"USGS 3DEP lidar {self.project}"
