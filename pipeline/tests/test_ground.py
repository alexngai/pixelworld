"""Ground surfaces from land use (M3.5): park lawns, yards and smoothed lawns."""

import numpy as np
import pytest
import shapely

from pixelworld_pipeline import ground, micro
from pixelworld_pipeline.build import SURFACES, S
from pixelworld_pipeline.region import Region
from pixelworld_pipeline.world_format import NO_WATER

NAMES = SURFACES | ground.SURFACES
SPEC = {
    "id": "t",
    "name": "Test",
    "bounds": [-122.45, 37.76, -122.44, 37.77],  # about 880 m × 1110 m
    "metersPerCell": 20,
    "style": "s",
    "start": {"lon": -122.445, "lat": 37.765},
    "sources": {"overture": {"release": "r"}},
}


def test_ground_surfaces_follow_the_classic_ones_and_leave_older_specs_alone():
    assert set(ground.SURFACES).isdisjoint(SURFACES)
    assert max(NAMES) < 16  # the style's MAX_SURFACES
    plain = Region.from_dict(SPEC)
    assert plain.ground is None
    assert Region.from_dict(SPEC | {"ground": {"lawn": {"landUse": ["park"]}}}).ground
    with pytest.raises(ValueError, match="unknown surfaces"):
        ground.surface_ids(NAMES, ["lawns"])


def test_cell_slope_measures_real_rise_over_run():
    # corners rising 3 m per 20 m cell eastward: 15%
    corner_m = np.tile(np.arange(6) * 3.0, (5, 1))
    slope = ground.cell_slope(corner_m, 20.0)
    assert slope.shape == (4, 5) and np.allclose(slope, 0.15)
    assert np.allclose(ground.cell_slope(corner_m, 20.0, window_m=60.0)[1:-1, 1:-1], 0.15)


def test_a_park_is_lawn_or_wild_as_a_whole_by_its_median_slope():
    slope = np.full((4, 6), 0.1)
    slope[0, 0] = 0.5  # a steep corner of the gentle park
    slope[:, 3:] = 0.3  # the steep park
    gentle_park = shapely.box(0, 0, 3, 4)
    steep_park = shapely.box(3, 0, 6, 4)
    ys, xs = np.mgrid[0:4, 0:6] + 0.5
    members = ground.points_in([gentle_park, steep_park], xs, ys)
    out = ground.gentle_land(members, 2, slope, 0.2)
    assert out[:, :3].all() and not out[:, 3:].any()
    assert not ground.gentle_land(ground.points_in([], xs, ys), 0, slope, 0.2).any()


def test_lawn_replaces_open_ground_and_open_woods_but_not_wild_land():
    surface = np.array(
        [[S["grass"], S["urban"], S["woodland"], S["woodland"], S["water"], S["grass"]]]
    )
    gentle = np.array([[True, True, True, True, True, False]])
    wild = np.zeros_like(gentle)
    rule = {"over": ["grass", "urban"]}
    out = ground.lawn_cells(surface, NAMES, gentle, wild, rule)
    assert out.tolist() == [[True, True, False, False, False, False]]
    wild[0, 1] = True  # mapped as natural scrub
    cover = np.array([[0, 0, 0.2, 0.9, 0, 0]])
    rule["wooded"] = {"over": ["woodland"], "maxCover": 0.5}
    out = ground.lawn_cells(surface, NAMES, gentle, wild, rule, cover)
    assert out.tolist() == [[True, False, True, False, False, False]]


def test_lawn_rule_reads_land_use_where_cells_are_drawn(monkeypatch):
    region = Region.from_dict(SPEC)
    cx, cy = region.cells
    w, s, e, n = region.bounds
    park = shapely.box(w, s, w + (e - w) / 2, n)  # the west half
    scrub = shapely.box(w, s, w + (e - w) / 4, s + (n - s) / 4)
    rows = {"land_use": [{"geometry": park.wkt}], "land": [{"geometry": scrub.wkt}]}
    monkeypatch.setattr(ground.overture, "land_use", lambda rel, box, cls: rows["land_use"])
    monkeypatch.setattr(ground.overture, "land", lambda rel, box, cls: rows["land"])
    surface = np.full((cy, cx), S["grass"], dtype=np.uint8)
    corner_m = np.zeros((cy + 1, cx + 1))
    rule = {"landUse": ["park"], "over": ["grass"], "keep": ["scrub"]}
    out = ground.lawn(region, surface, NAMES, corner_m, rule)
    assert out[cy // 2, 1 : cx // 2 - 1].all() and not out[:, cx // 2 + 1 :].any()
    assert not out[cy - 5, 4] and out[cy // 2, 4]  # the scrub in the south-west stays wild
    # a road shift of two cells east moves the park with its streets
    shifted = ground.lawn(
        region, surface, NAMES, corner_m, rule, shift=lambda x, y: (np.full_like(x, 2.0), 0 * y)
    )
    cols = np.nonzero(out.any(axis=0))[0]
    moved = np.nonzero(shifted.any(axis=0))[0]
    assert (moved.min(), moved.max()) == (cols.min() + 2, cols.max() + 2)
    # too steep a park (a 30% climb) stays wild
    steep = np.tile(np.arange(cx + 1) * 6.0, (cy + 1, 1))
    assert not ground.lawn(region, surface, NAMES, steep, rule | {"maxSlope": 0.2}).any()


def test_canopy_cover_samples_across_each_cell():
    region = Region.from_dict(SPEC)

    class HalfCanopy:  # trees on the west half of every cell
        def sample(self, xs, ys, crs):
            return np.where(np.mod(np.asarray(xs) - region.grid[0], 20.0) < 10.0, 8.0, 0.0)

    xs = region.grid[0] + np.array([[10.0, 30.0]])
    ys = np.array([[0.0, 0.0]])
    cover = ground.canopy_cover(region, HalfCanopy(), xs, ys, np.array([[True, False]]))
    assert cover.tolist() == [[0.5, 0.0]]


def _house(x0, y0, x1, y1, g="building.rowhouse.stucco"):
    return {
        "g": g,
        "x": (x0 + x1) / 2,
        "y": (y0 + y1) / 2,
        "s": 1,
        "fp": shapely.box(x0, y0, x1, y1).exterior.coords[:-1],
    }


def test_yards_lie_beside_houses_off_roads_and_away_from_other_buildings():
    surface = np.full((10, 12), S["urban"], dtype=np.uint8)
    surface[:, 11] = S["woodland"]
    blocked = np.zeros((10, 12), dtype=bool)
    blocked[:, 5] = True  # a road
    houses = [_house(1, 1, 2, 4), _house(1, 5, 2, 8)]
    shops = [_house(8, 1, 10, 9, g="building.commercial")]
    rule = {"near": ["building.rowhouse", "building.house"], "over": ["urban"], "reachMeters": 20}
    out = ground.yard_cells(surface, NAMES, houses + shops, blocked, 10.0, rule)
    assert out[2, 3] and out[6, 0]  # beside the houses
    assert not out[:, 5].any()  # never on the road
    assert not out[5, 9]  # by the shops
    assert not out[:, 11].any()  # only over the surfaces named
    assert not ground.yard_cells(surface, NAMES, shops, blocked, 10.0, rule).any()
    # a share of the yards stays paved, the same way every time
    some = ground.yard_cells(surface, NAMES, houses, blocked, 10.0, rule | {"paved": 0.5}, seed=3)
    again = ground.yard_cells(surface, NAMES, houses, blocked, 10.0, rule | {"paved": 0.5}, seed=3)
    all_ = ground.yard_cells(surface, NAMES, houses, blocked, 10.0, rule)
    assert (some == again).all() and (some <= all_).all() and 0 < some.sum() < all_.sum()


def test_footprint_cover_is_the_share_of_each_cell_under_footprints():
    cover = ground.footprint_cover([_house(0, 0, 1.5, 1)], lambda g: True, (2, 2))
    assert cover.tolist() == [[1.0, 0.5], [0.0, 0.0]]
    assert not ground.footprint_cover([_house(0, 0, 1, 1)], lambda g: False, (2, 2)).any()


def test_smoothing_flattens_noise_on_its_cells_only():
    k = 4
    rng = np.random.default_rng(7)
    q = 40.0 + rng.uniform(-4, 4, size=(3 * k + 1, 6 * k + 1))
    sigma = np.zeros((3, 6))
    sigma[:, :3] = 2.0  # the west half is lawn
    out = micro.smooth_cells(q, sigma, k)
    west, east = out[:, : 3 * k], out[:, 3 * k + 1 :]
    assert west.std() < 0.5 * q[:, : 3 * k].std()
    assert (east == q[:, 3 * k + 1 :]).all()  # untouched beyond the lawn's edge
    assert abs(west.mean() - q[:, : 3 * k].mean()) < 0.5
    # through build_micro: smoothed, then roads and water as before
    base = np.full((3, 6), 10, dtype=np.int16)
    shape = np.zeros((3, 6), dtype=np.uint8)
    water = np.full((3, 6), NO_WATER, dtype=np.int16)
    water[2, 0] = 10
    mc = micro.build_micro(q, 4.0, k, base, shape, water, np.zeros((3, 6), np.uint16), smooth=sigma)
    assert mc[3 * k - 1, 1] < 40  # the water cell's bed lies under its level
    plain = micro.build_micro(q, 4.0, k, base, shape, water, np.zeros((3, 6), np.uint16))
    assert (mc[:, 3 * k + 1 :] == plain[:, 3 * k + 1 :]).all()
    assert (
        np.abs(np.diff(mc[: 2 * k, : 3 * k], axis=1)).mean()
        < np.abs(np.diff(plain[: 2 * k, : 3 * k], axis=1)).mean()
    )


def test_lawn_spreads_into_the_open_grass_around_it_only():
    surface = np.full((1, 8), S["grass"], dtype=np.uint8)
    surface[0, 5] = S["urban"]
    lawn = np.zeros((1, 8), dtype=bool)
    lawn[0, 3] = True
    wild = np.zeros((1, 8), dtype=bool)
    wild[0, 1] = True
    out = ground.spread_lawn(lawn, surface, NAMES, wild, {"over": ["grass"], "meters": 30}, 10.0)
    # two cells west up to the wild scrub, one east up to the street, not past it
    assert out.tolist() == [[False, False, True, True, True, False, False, False]]
    assert (ground.spread_lawn(lawn, surface, NAMES, wild, {"meters": 4}, 10.0) == lawn).all()
