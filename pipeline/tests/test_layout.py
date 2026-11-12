"""Warped layouts, importance and rigid object stamps (M2), without network access."""

import numpy as np
import pytest
import shapely
from scipy import ndimage

from pixelworld_pipeline import importance, objects, plugins
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
        if plugins.split_ref(kind)[0].startswith("usgs"):
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


def test_a_focus_area_can_cap_its_relief(layout):
    # the same map, with the core's relief capped: R = 2 instead of 3.2 there
    capped = dict(WARP["focus"][0], reliefMax=2.0)
    spec = WarpSpec.from_dict(WARP | {"focus": [capped]})
    lc = WarpedLayout(layout.region, spec, warp=layout.warp)
    elev = layout.corner_elevation({"kind": "usgs-3dep-1arcsec"})
    _, _, r0 = layout.relief(elev)
    out, ref, r = lc.relief(elev)
    x, y = layout.lonlat_to_cell([-115.17], [36.11])
    j, i = int(round(y[0])), int(round(x[0]))
    assert r0[j, i] > 3.0 and r[j, i] == pytest.approx(2.0)
    assert np.allclose(out, ref + r * (elev - ref))
    # never above the uncapped factor, and never peaking in the falloff ring: the
    # cap holds through the ring (12 km from the centre), then fades out by 20 km
    sx, sy = lc.corner_source(1)
    fx, fy = lc._src([-115.17], [36.11])
    d = np.hypot(sx - fx[0], sy - fy[0])
    assert (r <= r0 + 1e-12).all() and r[d <= 12_000].max() <= 2.0 + 1e-9
    assert np.allclose(r[d > 20_000], r0[d > 20_000])
    # drawn heights (dam crests) use the same factor
    px, py = lc.source_to_projected(sx, sy)
    lo = lc.drawn_height(float(px[j, i]), float(py[j, i]), 500.0)
    hi = lc.drawn_height(float(px[j, i]), float(py[j, i]), 600.0)
    assert hi - lo == pytest.approx(100 * r[j, i], rel=0.05)
    # a spec without reliefMax keeps its factors
    assert np.array_equal(
        WarpedLayout(layout.region, layout.spec, warp=layout.warp).relief(elev)[2], r0
    )


def test_levels_coarser_than_a_sources_deepest_overview_are_averaged_from_it(monkeypatch, tmp_path):
    # the 1 arc-second DEM carries overviews down to 8×: a 16× level (480 m) is
    # read from the 8× one, under a cache key of its own (older caches hold that
    # level empty, every read of the missing overview having failed)
    assert rasters.overview_factor("usgs-3dep-1arcsec", 240.0) == (8, 8)
    assert rasters.overview_factor("usgs-3dep-1arcsec", 480.0) == (16, 8)
    assert rasters.overview_factor("esa-worldcover-2021", 160.0) == (16, 16)
    reads = []

    def fake_warp(urls, dst, transform, region, overview, resampling, nodata):
        reads.append(overview)
        dst[:] = 500.0
        return []

    monkeypatch.setattr(rasters, "_warp_tiles", fake_warp)
    monkeypatch.setattr(rasters, "CACHE_ROOT", tmp_path)
    region = Region.from_dict(SPEC)
    block = rasters._block(region, "usgs-3dep-1arcsec", 480.0, 0, 0, "level")
    assert reads == [8] and (block == 500.0).all()
    rasters._block(region, "usgs-3dep-1arcsec", 240.0, 0, 0, "level")
    assert reads == [8, 8]
    tags = [p.read_text() for p in (tmp_path / "levels").glob("*.tag")]
    assert len(tags) == 2 and sum("|480.0|0|0|level|from8|" in t for t in tags) == 1


def test_a_strait_narrower_than_a_cell_stays_connected(layout, monkeypatch):
    # a north-south water channel 250 m wide where cells span up to ~640 m east-west
    # (stretched in the transition ring): narrower than a cell, but wider than a
    # third of one, the spacing of the 3×3 samples
    x_lo, _ = layout.source_to_projected(np.array([38_000.0]), np.array([0.0]))
    band = (float(x_lo[0]), float(x_lo[0]) + 250.0)

    def fake_sample(region, kind, x, y, spacing):
        x = np.asarray(x, dtype=float).ravel()
        return np.where((x >= band[0]) & (x < band[1]), 80, 60).astype(np.uint8)

    monkeypatch.setattr(rasters, "sample_points", fake_sample)
    centre = layout.cell_landcover(sub=1, water_votes=1) == 80
    covered = layout.cell_landcover() == 80
    assert not centre.any(axis=1).all()  # centre samples miss the channel in some rows
    assert covered.any(axis=1).all()  # every row keeps water
    labels, n = ndimage.label(covered, structure=np.ones((3, 3)))
    assert n == 1
    assert covered.sum(axis=1).max() <= 2  # and the channel stays narrow


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
