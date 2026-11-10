"""Where world cells come from: a uniform grid (M1) or an elastic map (M2).

The build only talks to a layout: how many cells, where a lon/lat lands, and
the elevation and land cover at cell corners and centres. UniformLayout keeps
the M1 code paths (rasters reprojected onto the cell grid), so uniform worlds
are unchanged; WarpedLayout samples sources through the warp's inverse map.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from rasterio.warp import transform as transform_points

from .region import Region
from .sources import rasters
from .sources.http import CACHE_ROOT
from .warp import Focus, Pin, ScaleField, Warp, solve


def geo_positions(cells: tuple[int, int], step: int) -> tuple[np.ndarray, np.ndarray]:
    """Cell-corner coordinates of the geo grid: every `step` cells, plus the far edge."""
    cx, cy = cells
    xs = np.unique(np.append(np.arange(0, cx, step), cx)).astype(np.float64)
    ys = np.unique(np.append(np.arange(0, cy, step), cy)).astype(np.float64)
    return xs, ys


def _geo_from_projected(region: Region, px: np.ndarray, py: np.ndarray):
    lons, lats = transform_points(region.crs, "EPSG:4326", px.ravel().tolist(), py.ravel().tolist())
    return np.asarray(lons).reshape(px.shape), np.asarray(lats).reshape(px.shape)


class UniformLayout:
    warped = False

    def __init__(self, region: Region):
        self.region = region
        self.cells = region.cells

    def lonlat_to_cell(self, lons, lats):
        return self.region.lonlat_to_cell(lons, lats)

    def cell_centers_lonlat(self):
        return self.region.cell_centers_lonlat()

    def corner_elevation(self, spec: dict, k: int = 1) -> np.ndarray:
        return rasters.dem_corners(self.region, k, spec).astype(np.float64)

    def cell_landcover(self) -> np.ndarray:
        return rasters.landcover_cells(self.region)

    def meters_per_cell(self) -> np.ndarray:
        cx, cy = self.cells
        return np.full((cy, cx), self.region.meters_per_cell)

    def geo_grid(self, step: int) -> tuple[np.ndarray, np.ndarray]:
        """(lons, lats) at cell corners every `step` cells (see geo_positions)."""
        west, north, _, _ = self.region.grid
        m = self.region.meters_per_cell
        gx, gy = np.meshgrid(*geo_positions(self.cells, step))
        return _geo_from_projected(self.region, west + gx * m, north - gy * m)


@dataclass
class WarpSpec:
    """Region spec `warp:` section."""

    background: float
    focus: list[dict[str, Any]] = field(default_factory=list)
    pins: list[dict[str, Any]] = field(default_factory=list)
    method: str = "v2"
    mesh_km: float = 2.0
    # relief exaggeration that keeps local proportions (see WarpedLayout.relief)
    vertical: dict[str, Any] = field(default_factory=dict)
    # automatic magnification from fame (importance.py)
    importance: dict[str, Any] = field(default_factory=dict)
    # multiplies every focus area's metres per cell: one knob that coarsens or
    # refines all focus areas together (scale levels, D-046)
    focus_scale: float = 1.0

    @staticmethod
    def from_dict(raw: dict[str, Any]) -> WarpSpec:
        return WarpSpec(
            background=float(raw["background"]),
            focus=list(raw.get("focus", [])),
            pins=list(raw.get("pins", [])),
            method=str(raw.get("method", "v2")),
            mesh_km=float(raw.get("meshKm", 2.0)),
            vertical=dict(raw.get("vertical", {})),
            importance=dict(raw.get("importance", {})),
            focus_scale=float(raw.get("focusScale", 1.0)),
        )

    def digest(self) -> str:
        body = dict(self.__dict__)
        if body["focus_scale"] == 1.0:
            del body["focus_scale"]  # older specs keep their digest
        body = json.dumps(body, sort_keys=True, default=str)
        return hashlib.sha256(body.encode()).hexdigest()[:16]


class WarpedLayout:
    """Cells laid out by an elastic map over the region's projected envelope."""

    warped = True

    def __init__(
        self,
        region: Region,
        spec: WarpSpec,
        warp: Warp | None = None,
        places: list[dict[str, Any]] | None = None,
    ):
        self.region = region
        self.spec = spec
        x0, y0, x1, y1 = region._projected_envelope()
        self.x0, self.y1 = x0, y1
        self.width_m, self.height_m = x1 - x0, y1 - y0
        self.places = places or []
        extra = None
        if spec.importance and self.places:
            from .importance import scale_grid

            extra = scale_grid(
                self.places,
                self._src,
                self.width_m,
                self.height_m,
                spec.background,
                spec.importance,
            )
        self.scale_field = ScaleField(spec.background, self.focus_areas(), extra)
        self.warp = warp or self._solve()
        self.cells = (math.ceil(self.warp.width), math.ceil(self.warp.height))
        self._corners: np.ndarray | None = None

    # ---- spec → solver -------------------------------------------------------------

    def _src(self, lons, lats) -> tuple[np.ndarray, np.ndarray]:
        """lon/lat → source frame metres (origin at the envelope's NW corner, y south)."""
        xs, ys = transform_points("EPSG:4326", self.region.crs, list(lons), list(lats))
        return np.asarray(xs) - self.x0, self.y1 - np.asarray(ys)

    def focus_areas(self) -> list[Focus]:
        out = []
        for f in self.spec.focus:
            sx, sy = self._src([f["lon"]], [f["lat"]])
            r = float(f["radiusKm"]) * 1000
            out.append(
                Focus(
                    str(f["name"]),
                    float(sx[0]),
                    float(sy[0]),
                    r,
                    float(f["metersPerCell"]) * self.spec.focus_scale,
                    float(f.get("falloffKm", f["radiusKm"])) * 1000,
                )
            )
        return out

    def pins(self) -> list[Pin]:
        out = []
        for p in self.spec.pins:
            sx, sy = self._src([p["lon"]], [p["lat"]])
            out.append(
                Pin(str(p["name"]), float(sx[0]), float(sy[0]), float(p["x"]), float(p["y"]))
            )
        return out

    def _solve(self) -> Warp:
        places = json.dumps(self.places, sort_keys=True) if self.spec.importance else ""
        # the solve depends on the region's envelope and the warp spec only
        key = f"{self.region.bounds}|{self.spec.digest()}|{places}"
        digest = hashlib.sha256(key.encode()).hexdigest()[:16]
        path = CACHE_ROOT / self.region.id / f"warp-{digest}.npz"
        if path.exists():
            data = np.load(path, allow_pickle=False)
            from .warp import Mesh

            mesh = Mesh.grid(self.width_m, self.height_m, self.spec.mesh_km * 1000)
            warp = Warp(mesh, data["uv"], float(data["w"]), float(data["h"]), self.spec.method)
            warp.stats = json.loads(str(data["stats"]))
            return warp
        warp = solve(
            self.width_m,
            self.height_m,
            self.scale_field,
            pins=self.pins(),
            method=self.spec.method,
            spacing_m=self.spec.mesh_km * 1000,
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez(path, uv=warp.uv, w=warp.width, h=warp.height, stats=json.dumps(warp.stats))
        return warp

    # ---- mapping -------------------------------------------------------------------

    def lonlat_to_cell(self, lons, lats):
        sx, sy = self._src(lons, lats)
        return self.warp.to_cells(sx, sy)

    def source_to_projected(self, sx, sy):
        return np.asarray(sx) + self.x0, self.y1 - np.asarray(sy)

    def corner_source(self, k: int = 1) -> tuple[np.ndarray, np.ndarray]:
        """Source-frame metres of every (micro-)corner, shape (K·cy + 1, K·cx + 1).

        Cell corners go through the inverse map; micro-corners are bilinear
        inside each cell (the warp is linear on triangles much larger than a cell).
        """
        cx, cy = self.cells
        if self._corners is None:
            gx, gy = np.meshgrid(
                np.arange(cx + 1, dtype=np.float64), np.arange(cy + 1, dtype=np.float64)
            )
            sx, sy = self.warp.to_source(gx, gy)
            self._corners = np.stack([sx, sy])
        c = self._corners
        if k == 1:
            return c[0], c[1]
        f = np.arange(k * cx + 1) / k
        g = np.arange(k * cy + 1) / k
        i = np.minimum(np.floor(f).astype(int), cx - 1)
        j = np.minimum(np.floor(g).astype(int), cy - 1)
        fx = (f - i)[None, :]
        fy = (g - j)[:, None]
        jj, ii = j[:, None], i[None, :]
        out = (
            c[:, jj, ii] * (1 - fx) * (1 - fy)
            + c[:, jj, ii + 1] * fx * (1 - fy)
            + c[:, jj + 1, ii] * (1 - fx) * fy
            + c[:, jj + 1, ii + 1] * fx * fy
        )
        return out[0], out[1]

    def corner_scale(self, k: int = 1) -> np.ndarray:
        """Local metres per cell at every (micro-)corner."""
        cx, cy = self.cells
        gx, gy = np.meshgrid(np.arange(k * cx + 1) / k, np.arange(k * cy + 1) / k)
        return self.warp.scale_at_cells(gx, gy)

    def meters_per_cell(self) -> np.ndarray:
        cx, cy = self.cells
        gx, gy = np.meshgrid(np.arange(cx) + 0.5, np.arange(cy) + 0.5)
        return self.warp.scale_at_cells(gx, gy)

    def geo_grid(self, step: int) -> tuple[np.ndarray, np.ndarray]:
        """(lons, lats) at cell corners every `step` cells (see geo_positions)."""
        gx, gy = np.meshgrid(*geo_positions(self.cells, step))
        sx, sy = self.warp.to_source(gx, gy)
        return _geo_from_projected(self.region, *self.source_to_projected(sx, sy))

    def cell_centers_lonlat(self):
        cx, cy = self.cells
        gx, gy = np.meshgrid(np.arange(cx) + 0.5, np.arange(cy) + 0.5)
        sx, sy = self.warp.to_source(gx, gy)
        px, py = self.source_to_projected(sx, sy)
        lons, lats = transform_points(
            self.region.crs, "EPSG:4326", px.ravel().tolist(), py.ravel().tolist()
        )
        return np.asarray(lons).reshape(cy, cx), np.asarray(lats).reshape(cy, cx)

    # ---- sources -------------------------------------------------------------------

    def corner_elevation(self, spec: dict, k: int = 1) -> np.ndarray:
        sx, sy = self.corner_source(k)
        px, py = self.source_to_projected(sx, sy)
        if k == 1:
            spacing = self.corner_scale(1)
        else:
            spacing = (
                np.repeat(np.repeat(self.corner_scale(1), k, 0)[: sx.shape[0]], k, 1)[
                    :, : sx.shape[1]
                ]
                / k
            )
        elev = rasters.sample_points(self.region, spec["kind"], px, py, spacing)
        return elev.reshape(sx.shape)

    def cell_landcover(self, sub: int = 3, water_votes: int = 3, band: int = 64) -> np.ndarray:
        """Land-cover class per cell from sub×sub samples spread over the cell.

        The most common class wins (ties go to the centre sample), as the
        uniform build's mode resampling does. Water (80) wins from `water_votes`
        samples, so a channel wider than a third of the cell (measured across the
        channel; transition-ring cells are stretched) stays connected. With
        centre samples only, a narrower strait (Boulder Canyon in Lake Mead at
        250 m cells) fell between cell centres and split the lake in two.
        """
        cx, cy = self.cells
        kind = self.region.sources["landcover"]["kind"]
        off = (np.arange(sub) + 0.5) / sub
        ox, oy = (a.ravel() for a in np.meshgrid(off, off))
        centre = (sub * sub) // 2
        out = np.empty((cy, cx), np.uint8)
        for y0 in range(0, cy, band):
            rows = min(band, cy - y0)
            gx, gy = np.meshgrid(np.arange(cx), np.arange(y0, y0 + rows))
            spacing = self.warp.scale_at_cells(gx + 0.5, gy + 0.5)[..., None]
            sx, sy = self.warp.to_source(gx[..., None] + ox, gy[..., None] + oy)
            px, py = self.source_to_projected(sx, sy)
            samples = rasters.sample_points(
                self.region, kind, px, py, np.broadcast_to(spacing, px.shape)
            ).reshape(rows, cx, sub * sub)
            classes = np.unique(samples)
            votes = (samples[..., None] == classes).sum(axis=2) + 0.5 * (
                samples[..., centre, None] == classes
            )
            best = classes[votes.argmax(axis=-1)]
            water = (samples == 80).sum(axis=-1) >= water_votes
            out[y0 : y0 + rows] = np.where(water, 80, best)
        return out

    # ---- vertical caricature ---------------------------------------------------------

    def relief_cap(self, sx: np.ndarray, sy: np.ndarray) -> np.ndarray:
        """The relief factor's upper bound at source points: `vertical.max`, lowered
        over focus areas that set their own `reliefMax` (Hoover Dam's Black Canyon,
        where the full factor made a slot deeper than the dam is long).

        The cap holds over the focus area and its falloff ring, where the scale is
        still finer than around it, then fades back to `vertical.max` over another
        falloff. Fading over the ring itself would let the factor peak there, where
        the cap has risen but the scale hasn't yet coarsened."""
        hi = float(self.spec.vertical.get("max", 4.0))
        cap = np.full(np.broadcast(sx, sy).shape, hi)
        for f in self.spec.focus:
            if "reliefMax" not in f:
                continue
            fx, fy = self._src([f["lon"]], [f["lat"]])
            falloff = max(float(f.get("falloffKm", f["radiusKm"])) * 1000, 1.0)
            reach = float(f["radiusKm"]) * 1000 + falloff
            d = np.hypot(np.asarray(sx) - fx[0], np.asarray(sy) - fy[0])
            t = np.clip((d - reach) / falloff, 0.0, 1.0)
            w = 1.0 - t * t * (3.0 - 2.0 * t)
            cap = np.minimum(cap, hi + w * (min(float(f["reliefMax"]), hi) - hi))
        return cap

    def _factor(self, scale: np.ndarray, sx: np.ndarray, sy: np.ndarray) -> np.ndarray:
        """R = (base metres per cell / local metres per cell)^γ, clamped to
        [vertical.min, the relief cap there]."""
        v = self.spec.vertical
        gamma = float(v.get("gamma", 1.0))
        lo = float(v.get("min", 0.5))
        r = (self.region.meters_per_cell / np.asarray(scale)) ** gamma
        return np.maximum(np.minimum(r, self.relief_cap(sx, sy)), lo)

    def relief(self, elev: np.ndarray, k: int = 1) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Exaggerate local relief so magnified areas keep the base proportions.

        elev' = ref + R·(elev − ref): ref is the elevation smoothed over
        `referenceSigmaKm` (flat ground stays flat; the regional trend is
        untouched) and R = (base metres per cell / local metres per cell)^γ,
        clamped (see relief_cap). Returns (elev', ref, R) at the same corners.
        """
        v = self.spec.vertical
        if not v:
            ones = np.ones_like(elev)
            return elev, elev, ones
        sigma = float(v.get("referenceSigmaKm", 6.0)) * 1000
        kind = self.region.sources["dem"]["kind"]
        ref_grid = rasters.smoothed_dem(self.region, kind, sigma)
        sx, sy = self.corner_source(k)
        px, py = self.source_to_projected(sx, sy)
        ref = rasters.sample_grid(ref_grid, px, py)
        scale = self.corner_scale(1)
        if k != 1:
            scale = np.repeat(np.repeat(scale, k, 0)[: sx.shape[0]], k, 1)[:, : sx.shape[1]]
        r = self._factor(scale, sx, sy)
        return ref + r * (elev - ref), ref, r

    def drawn_height(self, px: float, py: float, metres: float) -> float:
        """The exaggerated elevation (metres) drawn for a real one at a projected point."""
        v = self.spec.vertical
        if not v:
            return metres
        kind = self.region.sources["dem"]["kind"]
        sigma = float(v.get("referenceSigmaKm", 6.0)) * 1000
        ref = float(
            rasters.sample_grid(
                rasters.smoothed_dem(self.region, kind, sigma), np.array([px]), np.array([py])
            )[0]
        )
        sx, sy = np.array([px - self.x0]), np.array([self.y1 - py])
        cx, cy = self.warp.to_cells(sx, sy)
        r = float(self._factor(self.warp.scale_at_cells(cx, cy), sx, sy)[0])
        return ref + r * (metres - ref)
