"""Editor pipeline server (M2): spec round trips, solves, previews, saving."""

import json
import threading
import urllib.request
from http.server import ThreadingHTTPServer

import numpy as np
import pytest
import yaml

from pixelworld_pipeline import server
from pixelworld_pipeline.sources import overture, rasters

REGION = """
id: srv
name: Server test
bounds: [-115.4, 36.0, -114.9, 36.3]
metersPerCell: 400
style: desert-southwest
start: { lon: -115.17, lat: 36.11 }
sources:
  dem: { kind: usgs-3dep-1arcsec }
  landcover: { kind: esa-worldcover-2021 }
  overture: { release: 2026-10-21.0 }
  roads: { classes: [primary] }
warp: warp.yaml
"""
WARP = {
    "background": 500,
    "meshKm": 3,
    "focus": [
        {
            "name": "core",
            "lon": -115.17,
            "lat": 36.11,
            "radiusKm": 4,
            "falloffKm": 8,
            "metersPerCell": 125,
        }
    ],
    "pins": [],
}


@pytest.fixture
def editor(tmp_path, monkeypatch):
    def fake_sample(region, kind, x, y, spacing):
        x = np.asarray(x, dtype=float).ravel()
        if kind.startswith("usgs"):
            return 600 + (x - x.min()) * 0.01
        return np.full(x.shape, 60, dtype=np.uint8)

    monkeypatch.setattr(rasters, "sample_points", fake_sample)
    monkeypatch.setattr(overture, "roads", lambda release, bbox, classes: [])
    (tmp_path / "region.yaml").write_text(REGION)
    (tmp_path / "warp.yaml").write_text(yaml.safe_dump(WARP))
    return server.Editor(tmp_path / "region.yaml", tmp_path / "out")


def test_png_encoder_writes_a_valid_header():
    data = server.png(np.zeros((3, 5, 3), dtype=np.uint8))
    assert (
        data.startswith(b"\x89PNG\r\n\x1a\n")
        and b"IHDR" in data
        and data.endswith(b"IEND\xaeB`\x82")
    )


def test_region_info_carries_source_positions(editor):
    info = editor.region_info()
    f = info["warp"]["focus"][0]
    assert {"sx", "sy", "lon", "lat"} <= f.keys()
    assert 0 < f["sx"] < info["sourceMeters"][0] and 0 < f["sy"] < info["sourceMeters"][1]
    w, h = editor.source_size()
    assert info["source"] == {
        "url": "/api/source.png",
        "width": w,
        "height": h,
        "metersPerPixel": 400.0,
    }


def test_solve_returns_stats_preview_and_a_lattice(editor):
    warp = editor.region_info()["warp"]
    res = editor.solve(warp)
    assert res["stats"]["folds"] == 0
    assert abs(res["stats"]["focus"][0]["error"]) < 0.05
    cw, ch = res["cells"]
    assert editor.previews[res["preview"].rsplit("/", 1)[-1]].startswith(b"\x89PNG")
    lat = res["lattice"]
    assert len(lat["cx"]) == len(lat["ys"]) and len(lat["cx"][0]) == len(lat["xs"])
    assert 0 <= min(map(min, lat["cx"])) and max(map(max, lat["cx"])) <= cw + 1e-6


def test_editor_positions_become_lon_lat_and_saving_drops_them(editor, tmp_path):
    warp = editor.region_info()["warp"]
    moved = dict(warp, focus=[dict(warp["focus"][0], sx=warp["focus"][0]["sx"] + 5000)])
    out = editor.normalize(moved)
    assert out["focus"][0]["lon"] > warp["focus"][0]["lon"]  # 5 km east
    path = editor.save(moved)
    saved = yaml.safe_load(path.read_text())
    assert "sx" not in saved["focus"][0] and saved["focus"][0]["lon"] == out["focus"][0]["lon"]
    assert saved["background"] == 500


def test_http_endpoints(editor):
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(editor))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    try:
        info = json.load(urllib.request.urlopen(base + "/api/region"))
        assert info["id"] == "srv"
        req = urllib.request.Request(
            base + "/api/solve",
            data=json.dumps({"warp": info["warp"]}).encode(),
            headers={"Content-Type": "application/json"},
        )
        res = json.load(urllib.request.urlopen(req))
        assert res["stats"]["folds"] == 0
        img = urllib.request.urlopen(base + res["preview"]).read()
        assert img.startswith(b"\x89PNG")
        assert urllib.request.urlopen(base + "/api/source.png").read().startswith(b"\x89PNG")
        status = json.load(urllib.request.urlopen(base + "/api/build"))
        assert status["state"] == "idle"
    finally:
        httpd.shutdown()
