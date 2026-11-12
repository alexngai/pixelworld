"""A new region from nothing, offline (D-076): a single-level spec with a
railway in its bounds builds whole, its geo grid and routes included, and the
hash it reports is the package's."""

import json

import numpy as np
import pytest
import yaml

import pixelworld_pipeline
from pixelworld_pipeline import cli, routes
from pixelworld_pipeline.sources import overture, rasters, transit
from pixelworld_pipeline.world_format import package_hash

# a small town with no `levels:` (the Jerome spec before D-076 crashed in routes)
SPEC = {
    "id": "town",
    "name": "Test Town",
    "bounds": [-112.130, 34.738, -112.110, 34.752],
    "metersPerCell": 40,
    "style": "desert-southwest",
    "start": {"lon": -112.12, "lat": 34.745},
    "sources": {
        "dem": {"kind": "usgs-3dep-13arcsec", "overview": 1},
        "landcover": {"kind": "esa-worldcover-2021", "overview": 1},
        "features": {"kind": "overture", "release": "2026-10-21.0"},
        "roads": {"classes": ["primary", "residential"]},
    },
}


def road(seg_id, cls, coords, connectors):
    wkt = "LINESTRING (" + ", ".join(f"{x} {y}" for x, y in coords) + ")"
    return {
        "id": seg_id,
        "subtype": "road",
        "class": cls,
        "subclass": None,
        "connectors": [{"connector_id": c, "at": at} for c, at in connectors],
        "geometry": wkt,
    }


ROADS = [
    road("r1", "primary", [(-112.129, 34.745), (-112.120, 34.745)], [("a", 0.0), ("x", 1.0)]),
    road("r2", "primary", [(-112.120, 34.745), (-112.111, 34.745)], [("x", 0.0), ("b", 1.0)]),
    road("r3", "residential", [(-112.120, 34.739), (-112.120, 34.745)], [("c", 0.0), ("x", 1.0)]),
]
# a railway across the town: routes place it through the package's geo grid
RAIL = {
    "id": "rail1",
    "subtype": "rail",
    "class": "standard_gauge",
    "subclass": None,
    "name": "Verde Valley line",
    "routes": [],
    "flags": [],
    "geometry": "LINESTRING (-112.129 34.740, -112.111 34.751)",
}


@pytest.fixture
def offline(monkeypatch, tmp_path):
    """Every download replaced: a gentle slope of desert, three roads, a railway."""

    def dem_corners(region, k=1, spec=None):
        cx, cy = region.cells
        yy, xx = np.mgrid[0 : k * cy + 1, 0 : k * cx + 1]
        return (1500.0 + 2.0 * xx / k + 1.0 * yy / k).astype(np.float32)

    def landcover_cells(region):
        cx, cy = region.cells
        return np.full((cy, cx), 60, dtype=np.uint8)  # bare

    monkeypatch.setattr(rasters, "dem_corners", dem_corners)
    monkeypatch.setattr(rasters, "landcover_cells", landcover_cells)
    monkeypatch.setattr(overture, "roads", lambda *a, **k: [dict(r) for r in ROADS])
    monkeypatch.setattr(overture, "rivers", lambda *a, **k: [])
    monkeypatch.setattr(transit, "segments", lambda release, bbox: [dict(RAIL)])
    path = tmp_path / "town" / "region.yaml"
    path.parent.mkdir()
    path.write_text(yaml.safe_dump(SPEC))
    return path


def test_a_new_single_level_region_builds_with_its_geo_grid_and_routes(offline, tmp_path):
    out = tmp_path / "out"
    report = pixelworld_pipeline.build(offline, out)
    manifest = json.loads((out / "manifest.json").read_text())
    # every package has a geo grid now, levels or not
    assert manifest["geo"]["step"] == 16 and (out / "geo.i32.gz").is_file()
    assert "levels" not in manifest
    # the railway became a route, placed through that grid
    assert report["routes"]["rail"]["train"] >= 1
    doc = routes.decode_routes((out / routes.ROUTES_FILE).read_bytes())
    assert {r.get("kind") for r in doc["routes"]} >= {"train"}
    assert manifest["routes"]["count"] == len(doc["routes"])
    # the hash reported is the package's, after routes rewrote its manifest
    on_disk = json.loads((out / "build-report.json").read_text())
    assert report["packageHash"] == manifest["packageHash"] == on_disk["packageHash"]
    assert package_hash(manifest) == manifest["packageHash"]


def test_the_cli_builds_a_new_region_and_prints_the_final_hash(offline, tmp_path, capsys):
    out = tmp_path / "cli-out"
    assert cli.main(["build", str(offline), "--out", str(out)]) == cli.OK
    stdout, stderr = capsys.readouterr()
    manifest = json.loads((out / "manifest.json").read_text())
    assert f"packageHash {manifest['packageHash']}" in stdout
    for stage in ("layout", "terrain", "ways", "grid", "package", "routes"):
        assert f"] {stage}" in stderr  # a progress line per stage, on stderr
    assert "{" not in stdout  # no JSON dump unless --json


def test_routes_for_an_old_package_without_a_geo_grid_skip_rail_rather_than_crash(
    offline, tmp_path
):
    out = tmp_path / "old"
    pixelworld_pipeline.build(offline, out, routes=False)
    manifest = json.loads((out / "manifest.json").read_text())
    del manifest["geo"]  # as packages without `levels:` were built before D-076
    (out / "manifest.json").write_text(json.dumps(manifest))
    report = routes.refresh_routes(offline, out)
    assert report["transit"].startswith("skipped") and "rail" not in report
    assert report["routes"] == report["roads"]["chains"] > 0  # road routes still made
