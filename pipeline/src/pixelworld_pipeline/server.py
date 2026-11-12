"""Local pipeline server for the editor (`uv run pixelworld serve <region.yaml>`).

The editor (apps/editor) paints focus areas and drags pins; every change is
POSTed here, solved, and answered with a warped preview within seconds. The
full world build runs in the background on request. Binds to 127.0.0.1.

  GET  /api/region         spec, source-frame geometry, importance places
  GET  /api/source.png     the region in source space: hillshade, land cover, roads
  POST /api/solve          {warp} → stats, preview URL, forward-map lattice
  GET  /api/preview/<id>   a solved preview (world cells, 1 px per cell)
  POST /api/save           {warp} → writes the spec's warp file (worlds/<id>/warp.yaml)
  POST /api/build          start a full build (pixelworld_pipeline.build: the package
                           and its traffic routes) into --out, default fixtures/<id>
  GET  /api/build          build status and log tail

The source map and the solver's mesh scale with the region, so a town of a
few kilometres reads as well as the Southwest's 400 km.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import math
import struct
import threading
import time
import traceback
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import numpy as np
import shapely
import yaml
from rasterio.warp import transform as transform_points

from . import importance as importance_stage
from . import plugins
from .layout import WarpedLayout, WarpSpec
from .region import Region
from .sources import rasters

PREVIEW_MESH_KM = 4.0  # the editor solves on a mesh at most this coarse (the Southwest's)
LATTICE_KM = 10.0  # forward-map lattice spacing, at most
SOURCE_PX = 1024  # the source map's longer side, about (pixels)


def nice(m: float, up: bool = True) -> float:
    """m rounded to 1, 2, 2.5, 4 or 5 × 10^k: up (the smallest at or above m) or
    down (the largest at or below it)."""
    k = 10.0 ** math.floor(math.log10(m))
    steps = [f * k for f in (1, 2, 2.5, 4, 5, 10)]
    if up:
        return next(v for v in steps if v >= m * (1 - 1e-9))
    return max(v for v in steps if v <= m * (1 + 1e-9))


def scales(width_m: float, height_m: float, meters_per_cell: float) -> dict[str, float]:
    """The editor's scales for a region: the source map's metres per pixel
    (about SOURCE_PX across: 400 m for the Southwest, 4 m for a 3 km town), the
    preview solve's mesh and the lattice spacing (km)."""
    longest = max(width_m, height_m)
    mesh_km = min(PREVIEW_MESH_KM, max(longest / 100, 2 * meters_per_cell) / 1000)
    return {
        "source_px_m": nice(longest / SOURCE_PX),
        "mesh_km": nice(mesh_km, up=False),
        "lattice_km": min(LATTICE_KM, nice(longest / 40 / 1000, up=False)),
    }


def png(rgb: np.ndarray) -> bytes:
    """Minimal RGB PNG encoder (no Pillow in the pipeline)."""
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].astype(np.uint8).tobytes() for y in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )


LANDCOVER_TINT = {
    10: (70, 110, 60),  # tree
    20: (150, 140, 100),  # shrub
    30: (160, 160, 110),  # grass
    40: (130, 150, 80),  # crop
    50: (140, 140, 150),  # built
    60: (205, 185, 150),  # bare
    70: (235, 240, 245),  # snow
    80: (60, 110, 140),  # water
    90: (90, 130, 120),  # wetland
}


class Editor:
    """State behind the server: the region, its source image and solved previews."""

    def __init__(self, region_path: Path, out_dir: Path):
        self.region_path = Path(region_path)
        self.out_dir = Path(out_dir)
        self.region = Region.load(self.region_path)
        x0, y0, x1, y1 = self.region._projected_envelope()
        self.x0, self.y1 = x0, y1
        self.width_m, self.height_m = x1 - x0, y1 - y0
        sc = scales(self.width_m, self.height_m, self.region.meters_per_cell)
        self.source_px_m, self.preview_mesh_km = sc["source_px_m"], sc["mesh_km"]
        self.lattice_km = sc["lattice_km"]
        snap = importance_stage.load_snapshot(self.region_path)
        self.places = snap["places"] if snap else []
        self._source: tuple[np.ndarray, bytes] | None = None
        self.previews: dict[str, bytes] = {}
        self.build_state: dict[str, Any] = {"state": "idle", "log": ""}
        self._lock = threading.Lock()

    # ---- geometry -------------------------------------------------------------------

    def to_source(self, lons, lats) -> tuple[np.ndarray, np.ndarray]:
        xs, ys = transform_points("EPSG:4326", self.region.crs, list(lons), list(lats))
        return np.asarray(xs) - self.x0, self.y1 - np.asarray(ys)

    def region_info(self) -> dict[str, Any]:
        sx, sy = (
            self.to_source([p["lon"] for p in self.places], [p["lat"] for p in self.places])
            if self.places
            else ([], [])
        )
        w, h = self.source_size()
        return {
            "id": self.region.id,
            "name": self.region.name,
            "baseMetersPerCell": self.region.meters_per_cell,
            "sourceMeters": [self.width_m, self.height_m],
            "source": {
                "url": "/api/source.png",
                "width": w,
                "height": h,
                "metersPerPixel": self.source_px_m,
            },
            "warp": self.normalize(self.region.warp or self.default_warp()),
            # where the viewer finds the build: `?world=` for a package under
            # fixtures/, else none (`pixelworld view <out>` serves it)
            "out": str(self.out_dir),
            "viewer": self.viewer_world(),
            "places": [
                {"label": p["label"], "sitelinks": p["sitelinks"], "x": float(x), "y": float(y)}
                for p, x, y in zip(self.places, sx, sy, strict=True)
            ],
            "proj": {"crs": self.region.crs.to_proj4(), "x0": self.x0, "y1": self.y1},
        }

    def default_warp(self) -> dict[str, Any]:
        """A spec without a warp starts from none: the background at its own
        scale, on a mesh fine enough for a small region."""
        warp: dict[str, Any] = {"background": self.region.meters_per_cell, "focus": [], "pins": []}
        if self.preview_mesh_km < 2.0:
            warp["meshKm"] = self.preview_mesh_km
        return warp

    def viewer_world(self) -> str | None:
        """The viewer's `?world=` for the build output, if the dev server serves it
        (a package under the repository's fixtures/)."""
        from .api import REPO

        try:
            rel = self.out_dir.resolve().relative_to((REPO / "fixtures").resolve())
        except ValueError:
            return None
        return f"/{rel.as_posix()}/"

    def source_size(self) -> tuple[int, int]:
        r = self.source_px_m
        return math.ceil(self.width_m / r), math.ceil(self.height_m / r)

    def lonlat_of(self, sx: float, sy: float) -> tuple[float, float]:
        lons, lats = transform_points(self.region.crs, "EPSG:4326", [sx + self.x0], [self.y1 - sy])
        return float(lons[0]), float(lats[0])

    # ---- source image -------------------------------------------------------------------

    def source_image(self) -> tuple[np.ndarray, bytes]:
        if self._source is None:
            self._source = self._render_source()
        return self._source

    def _render_source(self) -> tuple[np.ndarray, bytes]:
        w, h = self.source_size()
        r = self.source_px_m
        gx, gy = np.meshgrid((np.arange(w) + 0.5) * r, (np.arange(h) + 0.5) * r)
        px, py = gx + self.x0, self.y1 - gy
        dem_kind = self.region.sources["dem"]
        lc_kind = self.region.sources["landcover"]
        elev = rasters.sample_points(self.region, dem_kind, px, py, np.full(px.size, r)).reshape(
            h, w
        )
        lc = rasters.sample_points(self.region, lc_kind, px, py, np.full(px.size, r)).reshape(h, w)
        # hillshade from the north-west
        dzdx = np.gradient(elev, axis=1) / r
        dzdy = np.gradient(elev, axis=0) / r
        shade = np.clip(
            0.75 + 1.6 * (-dzdx * 0.7 - dzdy * 0.7) / np.sqrt(1 + dzdx**2 + dzdy**2), 0.35, 1.25
        )
        t = np.clip((elev - elev.min()) / max(np.ptp(elev), 1.0), 0, 1)
        base = np.stack([200 - 40 * t, 175 - 30 * t, 140 - 10 * t], -1)
        tint = np.zeros((h, w, 3))
        has = np.zeros((h, w), bool)
        for code, col in LANDCOVER_TINT.items():
            m = lc == code
            tint[m] = col
            has |= m
        rgb = np.where(has[..., None], 0.5 * base + 0.5 * tint, base) * shade[..., None]
        # roads on top
        rows = plugins.source(self.region, "features").roads(
            self.region.lonlat_envelope(), self.region.sources["roads"]["classes"]
        )
        for row in rows:
            geom = shapely.segmentize(shapely.from_wkt(row["geometry"]), 0.002)
            for part in list(geom.geoms) if hasattr(geom, "geoms") else [geom]:
                c = np.asarray(part.coords)
                sx, sy = self.to_source(c[:, 0], c[:, 1])
                i = np.clip((sx / r).astype(int), 0, w - 1)
                j = np.clip((sy / r).astype(int), 0, h - 1)
                rgb[j, i] = (70, 64, 80)
        rgb = np.clip(rgb, 0, 255).astype(np.uint8)
        return rgb, png(rgb)

    # ---- editor ↔ spec ---------------------------------------------------------------

    def normalize(self, warp: dict[str, Any]) -> dict[str, Any]:
        """Editor entries may carry source-frame positions (sx, sy); fill lon/lat from
        them, and sx/sy from lon/lat, so both sides always agree."""
        out = dict(warp)
        for key in ("focus", "pins"):
            items = []
            for item in warp.get(key, []):
                it = dict(item)
                if "sx" in it and "sy" in it:
                    lon, lat = self.lonlat_of(float(it["sx"]), float(it["sy"]))
                    it["lon"], it["lat"] = round(lon, 5), round(lat, 5)
                sx, sy = self.to_source([it["lon"]], [it["lat"]])
                it["sx"], it["sy"] = round(float(sx[0]), 1), round(float(sy[0]), 1)
                items.append(it)
            out[key] = items
        return out

    @staticmethod
    def strip(warp: dict[str, Any]) -> dict[str, Any]:
        """The spec as stored: without the editor's source-frame positions."""
        out = dict(warp)
        for key in ("focus", "pins"):
            out[key] = [
                {k: v for k, v in it.items() if k not in ("sx", "sy")} for it in warp.get(key, [])
            ]
        return out

    # ---- solving --------------------------------------------------------------------------

    def layout_for(self, warp: dict[str, Any], mesh_km: float | None = None) -> WarpedLayout:
        """The warped layout of an edited warp, solved on the preview mesh."""
        spec = WarpSpec.from_dict(warp | {"meshKm": mesh_km or self.preview_mesh_km})
        return WarpedLayout(self.region, spec, places=self.places if spec.importance else None)

    def solve(self, warp: dict[str, Any]) -> dict[str, Any]:
        t0 = time.perf_counter()
        warp = self.normalize(warp)
        layout = self.layout_for(self.strip(warp))
        t1 = time.perf_counter()
        wp = layout.warp
        rgb, _ = self.source_image()
        cw, ch = math.ceil(wp.width), math.ceil(wp.height)
        gx, gy = np.meshgrid(np.arange(cw) + 0.5, np.arange(ch) + 0.5)
        sx, sy = wp.to_source(gx, gy)
        i = np.clip((sx / self.source_px_m).astype(int), 0, rgb.shape[1] - 1)
        j = np.clip((sy / self.source_px_m).astype(int), 0, rgb.shape[0] - 1)
        preview = rgb[j, i]
        # forward-map lattice for the editor: source points every lattice_km → cells
        step = self.lattice_km * 1000
        lx = np.arange(0, self.width_m + step, step).clip(max=self.width_m)
        ly = np.arange(0, self.height_m + step, step).clip(max=self.height_m)
        mx, my = np.meshgrid(lx, ly)
        ux, uy = wp.to_cells(mx, my)
        pid = hashlib.sha1(json.dumps(warp, sort_keys=True).encode()).hexdigest()[:12]
        with self._lock:
            self.previews[pid] = png(preview)
            while len(self.previews) > 8:
                self.previews.pop(next(iter(self.previews)))
        return {
            "warp": warp,
            "stats": wp.stats,
            "cells": [cw, ch],
            "preview": f"/api/preview/{pid}",
            "lattice": {
                "xs": lx.tolist(),
                "ys": ly.tolist(),
                "cx": np.round(ux, 3).tolist(),
                "cy": np.round(uy, 3).tolist(),
            },
            "timing": {
                "solve": round(t1 - t0, 3),
                "total": round(time.perf_counter() - t0, 3),
            },
        }

    # ---- saving and building --------------------------------------------------------------

    def warp_file(self) -> Path:
        """The warp file this spec owns (`warp: <file>` in the spec file itself).

        A scale level that inherits its warp and overrides a few keys (D-046)
        owns no warp file: edit the base level, or give the level its own file.
        """
        raw = yaml.safe_load(self.region_path.read_text()) or {}
        if not isinstance(raw.get("warp"), str):
            raise ValueError(
                f"{self.region_path.name} doesn't own a warp file (its warp is inherited or "
                "inline); edit the base level, or give this level `warp: <file>.yaml`"
            )
        return self.region_path.parent / raw["warp"]

    def save(self, warp: dict[str, Any]) -> Path:
        path = self.warp_file()
        warp = self.strip(self.normalize(warp))
        clean = {
            k: warp[k]
            for k in ("background", "method", "meshKm", "vertical", "importance", "focus", "pins")
            if k in warp
        }
        header = (
            "# Elastic map (M2), written by apps/editor. See docs/architecture.md §6.\n"
            "# Focus areas: target metres per cell inside radiusKm, blending back over falloffKm.\n"
            "# Pins: keep (lon, lat) at world cell (x, y).\n"
        )
        path.write_text(
            header + yaml.safe_dump(clean, sort_keys=False, default_flow_style=None, width=120)
        )
        return path

    def start_build(self) -> dict[str, Any]:
        with self._lock:
            if self.build_state["state"] == "running":
                return self.build_state
            self.build_state = {"state": "running", "log": "", "started": time.time()}
        threading.Thread(target=self._build, daemon=True).start()
        return self.build_state

    def _build(self) -> None:
        # the whole build, as `pixelworld build` runs it: the package and its routes
        from .api import build

        log = io.StringIO()
        try:
            with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                report = build(self.region_path, self.out_dir)
            state = {"state": "done", "report": report}
        except Exception:  # noqa: BLE001 (report any failure to the editor)
            state = {"state": "failed", "error": traceback.format_exc()}
        with self._lock:
            self.build_state = state | {
                "log": log.getvalue()[-4000:],
                "seconds": round(time.time() - self.build_state.get("started", time.time()), 1),
                "world": self.viewer_world(),
                "out": str(self.out_dir),
            }


def make_handler(editor: Editor):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args) -> None:  # quiet
            pass

        def _send(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj: Any, code: int = 200) -> None:
            self._send(code, json.dumps(obj).encode(), "application/json")

        def _body(self) -> dict[str, Any]:
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}")

        def do_GET(self) -> None:  # noqa: N802
            try:
                if self.path == "/api/region":
                    return self._json(editor.region_info())
                if self.path == "/api/source.png":
                    return self._send(200, editor.source_image()[1], "image/png")
                if self.path.startswith("/api/preview/"):
                    data = editor.previews.get(self.path.rsplit("/", 1)[-1])
                    return (
                        self._send(200, data, "image/png")
                        if data
                        else self._json({"error": "unknown preview"}, 404)
                    )
                if self.path == "/api/build":
                    return self._json(editor.build_state)
                self._json({"error": "not found"}, 404)
            except Exception as e:  # noqa: BLE001
                self._json({"error": str(e)}, 500)

        def do_POST(self) -> None:  # noqa: N802
            try:
                if self.path == "/api/solve":
                    return self._json(editor.solve(self._body()["warp"]))
                if self.path == "/api/save":
                    return self._json({"saved": str(editor.save(self._body()["warp"]))})
                if self.path == "/api/build":
                    return self._json(editor.start_build())
                self._json({"error": "not found"}, 404)
            except Exception as e:  # noqa: BLE001
                self._json({"error": str(e)}, 500)

    return Handler


def serve(region_path: Path, out_dir: Path, port: int = 8765) -> None:
    editor = Editor(region_path, out_dir)
    print(f"preparing the source image for {editor.region.id}…", flush=True)
    editor.source_image()
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(editor))
    print(
        f"pixelworld pipeline server on http://127.0.0.1:{port} (region {editor.region.id}); "
        "the editor: pnpm --filter @pixelworlds/editor dev, then http://localhost:5180",
        flush=True,
    )
    server.serve_forever()
