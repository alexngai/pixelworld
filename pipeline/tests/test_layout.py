"""Warped layouts, importance and rigid object stamps (M2), without network access."""

import numpy as np
import pytest
import shapely

from pixelworld_pipeline import importance, objects
from pixelworld_pipeline.layout import UniformLayout, WarpedLayout, WarpSpec
from pixelworld_pipeline.region import Region
from pixelworld_pipeline.sources import rasters

SPEC = {
    "id": "warp-test",
    "name": "Warp test",
    "bounds": [-115.4, 36.0, -114.9, 36.3],  # ~45 × 33 km
    "metersPerCell": 400,
    "style": "s",
    "start": {"lon": -115.17, "lat": 36.11},
    "sources": {"dem": {"kind": "usgs-3dep-1arcsec"}, "landcover": {"kind": "esa-worldcover-2021"}},
}
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
    "vertical": {"gamma": 1.0, "referenceSigmaKm": 3, "min": 0.5, "max": 4.0},
}


@pytest.fixture(scope="module")
def layout():
    region = Region.from_dict(SPEC | {"warp": WARP})
    return WarpedLayout(region, WarpSpec.from_dict(WARP))


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    # elevation: a plane rising 10 m per km eastward plus a 50 m bump; land cover: 50 (built)
    def fake_sample(region, kind, x, y, spacing):
        x = np.asarray(x, dtype=float).ravel()
        y = np.asarray(y, dtype=float).ravel()
        if kind.startswith("usgs"):
            return 600 + (x - x.min()) * 0.01 + 50 * np.sin(y / 3000.0)
        return np.full(x.shape, 50, dtype=np.uint8)

    monkeypatch.setattr(rasters, "sample_points", fake_sample)
    monkeypatch.setattr(rasters, "_SMOOTHED", {})


def test_focus_hits_its_target_and_the_layout_maps_both_ways(layout):
    stats = layout.warp.stats
    assert stats["folds"] == 0
    assert abs(stats["focus"][0]["error"]) < 0.05
    x, y = layout.lonlat_to_cell([-115.17], [36.11])
    assert 0 < x[0] < layout.cells[0] and 0 < y[0] < layout.cells[1]
    lons, lats = layout.cell_centers_lonlat()
    cx, cy = int(x[0]), int(y[0])
    bx, by = layout.lonlat_to_cell([lons[cy, cx]], [lats[cy, cx]])
    assert bx[0] == pytest.approx(cx + 0.5, abs=1e-3) and by[0] == pytest.approx(cy + 0.5, abs=1e-3)
    mpc = layout.meters_per_cell()
    assert mpc[cy, cx] == pytest.approx(125, rel=0.06)
    # the background stays far coarser than the core (in a region this small the
    # magnified core pushes its surroundings finer than the 500 m target)
    assert mpc.max() > 2.5 * mpc[cy, cx]


def test_corner_fields_and_micro_corners_line_up(layout):
    cx, cy = layout.cells
    elev = layout.corner_elevation({"kind": "usgs-3dep-1arcsec"})
    assert elev.shape == (cy + 1, cx + 1)
    k = 4
    sx1, sy1 = layout.corner_source(1)
    sxk, syk = layout.corner_source(k)
    assert sxk.shape == (k * cy + 1, k * cx + 1)
    # every 4th micro-corner is a cell corner
    assert np.allclose(sxk[::k, ::k], sx1) and np.allclose(syk[::k, ::k], sy1)


def test_relief_exaggeration_follows_magnification(layout):
    elev = layout.corner_elevation({"kind": "usgs-3dep-1arcsec"})
    out, ref, r = layout.relief(elev)
    x, y = layout.lonlat_to_cell([-115.17], [36.11])
    j, i = int(round(y[0])), int(round(x[0]))
    assert r[j, i] == pytest.approx(400 / 125, rel=0.08)  # ≈ 3.2 in the focus core
    assert r.min() >= 0.5 and r.max() <= 4.0
    assert np.allclose(out, ref + r * (elev - ref))
    # a drawn crest keeps its order relative to the terrain
    px, py = layout.source_to_projected(*layout.corner_source(1))
    lo = layout.drawn_height(float(px[j, i]), float(py[j, i]), 500.0)
    hi = layout.drawn_height(float(px[j, i]), float(py[j, i]), 600.0)
    assert hi - lo == pytest.approx(100 * r[j, i], rel=0.1)


def test_uniform_layout_matches_the_region_grid():
    region = Region.from_dict(SPEC)
    u = UniformLayout(region)
    assert u.cells == region.cells
    assert not u.warped
    assert (u.meters_per_cell() == 400).all()


def test_importance_magnifies_famous_places_only():
    places = [
        {"id": "Q1", "label": "Famous", "lon": 0.0, "lat": 0.0, "sitelinks": 160},
        {"id": "Q2", "label": "Some County", "lon": 0.5, "lat": 0.0, "sitelinks": 500},
    ]

    def to_source(lons, lats):
        return np.array(lons) * 100_000 + 50_000, np.array(lats) * 100_000 + 50_000

    spec = {"minSitelinks": 20, "sigmaKm": 4, "maxMagnification": 2.0, "reference": 80}
    grid, origin, cell = importance.scale_grid(places, to_source, 120_000, 100_000, 400.0, spec)
    assert origin == (0.0, 0.0)
    at = grid[int(50_000 / cell), int(50_000 / cell)]
    assert at == pytest.approx(200.0)  # full magnification at the famous place
    assert grid[0, 0] == pytest.approx(400.0)  # far away: background
    # counties are left out even with many sitelinks
    assert grid[int(50_000 / cell), int(100_000 / cell)] == pytest.approx(400.0, rel=0.02)


def test_rigid_footprints_keep_shape_under_the_warp(layout):
    region = layout.region
    p = objects.Placement(region, np.zeros((layout.cells[1], layout.cells[0]), bool), layout)
    lon, lat = -115.17, 36.11
    from rasterio.warp import transform

    xs, ys = transform("EPSG:4326", region.crs, [lon], [lat])
    square = shapely.box(xs[0] - 60, ys[0] - 60, xs[0] + 60, ys[0] + 60)
    fp = np.array(objects._footprint(p, square, 0.1))
    sides = np.hypot(*np.diff(np.vstack([fp, fp[:1]]), axis=0).T)
    assert sides.max() / sides.min() == pytest.approx(1.0, abs=0.02)  # still a square
    assert sides.mean() == pytest.approx(120 / p.scale_at(xs[0], ys[0]), rel=0.02)
    dam = np.array(objects.dam_footprint(p, [[lon - 0.002, lat], [lon + 0.002, lat]], 50.0))
    assert len(dam) == 18 and shapely.Polygon(dam).is_valid
