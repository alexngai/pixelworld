"""Local pipeline server for the editor (`uv run pixelworld serve <region.yaml>`).

The editor (apps/editor) paints focus areas and drags pins; every change is
POSTed here, solved, and answered with a warped preview within seconds. The
full world build runs in the background on request. Binds to 127.0.0.1.

  GET  /api/region         spec, source-frame geometry, importance places
  GET  /api/source.png     the region in source space: hillshade, land cover, roads
  POST /api/solve          {warp} → stats, preview URL, forward-map lattice
  GET  /api/preview/<id>   a solved preview (world cells, 1 px per cell)
  POST /api/save           {warp} → writes worlds/<id>/warp.yaml
  POST /api/build          start a full build into fixtures/<id>
  GET  /api/build          build status and log tail
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
from .layout import WarpedLayout, WarpSpec
from .region import Region
from .sources import overture, rasters

PREVIEW_MESH_KM = 4.0  # the editor solves on a coarser mesh than the build
LATTICE_KM = 10.0
SOURCE_PX_M = 400.0


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
                "metersPerPixel": SOURCE_PX_M,
            },
            "warp": self.normalize(
                self.region.warp
                or {"background": self.region.meters_per_cell, "focus": [], "pins": []}
            ),
            "places": [
                {"label": p["label"], "sitelinks": p["sitelinks"], "x": float(x), "y": float(y)}
                for p, x, y in zip(self.places, sx, sy, strict=True)
            ],
            "proj": {"crs": self.region.crs.to_proj4(), "x0": self.x0, "y1": self.y1},
        }

    def source_size(self) -> tuple[int, int]:
        return math.ceil(self.width_m / SOURCE_PX_M), math.ceil(self.height_m / SOURCE_PX_M)

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
        r = SOURCE_PX_M
        gx, gy = np.meshgrid((np.arange(w) + 0.5) * r, (np.arange(h) + 0.5) * r)
        px, py = gx + self.x0, self.y1 - gy
        dem_kind = self.region.sources["dem"]["kind"]
        lc_kind = self.region.sources["landcover"]["kind"]
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
        release = self.region.sources["overture"]["release"]
        rows = overture.roads(
            release, self.region.lonlat_envelope(), self.region.sources["roads"]["classes"]
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

    def layout_for(
        self, warp: dict[str, Any], mesh_km: float | None = PREVIEW_MESH_KM
    ) -> WarpedLayout:
        spec = WarpSpec.from_dict(warp | ({"meshKm": mesh_km} if mesh_km else {}))
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
        i = np.clip((sx / SOURCE_PX_M).astype(int), 0, rgb.shape[1] - 1)
        j = np.clip((sy / SOURCE_PX_M).astype(int), 0, rgb.shape[0] - 1)
        preview = rgb[j, i]
        # forward-map lattice for the editor: source points every LATTICE_KM → cells
        step = LATTICE_KM * 1000
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

    def save(self, warp: dict[str, Any]) -> Path:
        path = self.region_path.parent / "warp.yaml"
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
        from .build import build

        log = io.StringIO()
        try:
            with contextlib.redirect_stdout(log):
                report = build(self.region_path, self.out_dir)
            state = {"state": "done", "report": report}
        except Exception:  # noqa: BLE001 (report any failure to the editor)
            state = {"state": "failed", "error": traceback.format_exc()}
        with self._lock:
            self.build_state = state | {
                "log": log.getvalue()[-4000:],
                "seconds": round(time.time() - self.build_state.get("started", time.time()), 1),
                "world": f"/{self.out_dir.name}/",
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
    print(f"preparing the source image for {editor.region.id}…")
    editor.source_image()
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(editor))
    print(f"pixelworld pipeline server on http://127.0.0.1:{port} (region {editor.region.id})")
    server.serve_forever()
