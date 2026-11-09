import numpy as np
import pytest

from pixelworld_pipeline.build import S, apply_water, classify, label_components, provinces
from pixelworld_pipeline.region import Region, RegionError
from pixelworld_pipeline.world_format import NO_WATER

SPEC = {
    "id": "t",
    "name": "Test",
    "bounds": [-115.2, 36.0, -115.0, 36.2],
    "metersPerCell": 1000,
    "verticalExaggeration": 2.0,
    "maxSlope": 2,
    "style": "s",
    "start": {"lon": -115.1, "lat": 36.1},
    "sources": {},
    "geology": {
        "default": "basin",
        "provinces": [
            {
                "name": "plateau",
                "polygon": [[-115.3, 36.3], [-115.1, 36.3], [-115.1, 35.9], [-115.3, 35.9]],
            }
        ],
    },
}


def test_region_grid_covers_bounds_and_maps_start_inside():
    r = Region.from_dict(SPEC)
    cx, cy = r.cells
    assert 17 <= cx <= 20 and 21 <= cy <= 24  # ~18 km × 22 km at 1 km per cell
    x, y = r.lonlat_to_cell([-115.1], [36.1])
    assert 0 <= x[0] < cx and 0 <= y[0] < cy
    assert len(r.digest()) == 16 and r.digest() == Region.from_dict(SPEC).digest()


def test_region_spec_validation():
    with pytest.raises(RegionError):
        Region.from_dict({**SPEC, "maxSlope": 4})
    with pytest.raises(RegionError):
        Region.from_dict({**SPEC, "start": {"lon": 0, "lat": 0}})
    with pytest.raises(RegionError):
        Region.from_dict({k: v for k, v in SPEC.items() if k != "bounds"})


def test_provinces_split_the_grid_by_polygon():
    r = Region.from_dict(SPEC)
    geo, names = provinces(r)
    assert names == {0: "basin", 1: "plateau"}
    assert (geo[:, 0] == 1).all()  # western edge is inside the plateau polygon
    assert (geo[:, -1] == 0).all()


def test_label_components_is_8_connected():
    m = np.zeros((5, 5), bool)
    m[0, 0] = m[1, 1] = True  # diagonal neighbours: one component
    m[4, 4] = True
    labels, n = label_components(m)
    assert n == 2 and labels[0, 0] == labels[1, 1] != labels[4, 4]


def test_apply_water_flattens_lakes_and_lowers_rivers():
    q = np.arange(36, dtype=np.int64).reshape(6, 6) % 7
    lake = np.zeros((5, 5), bool)
    lake[1:3, 1:3] = True
    river = np.zeros((5, 5), bool)
    river[4, :] = True
    out, level = apply_water(q, lake, river)
    lake_corners = out[1:4, 1:4]
    assert (lake_corners == lake_corners[0, 0]).all()
    assert (level[lake] == lake_corners[0, 0]).all()
    assert (level[~lake] == NO_WATER).all()
    assert (out[4:, :] <= q[4:, :]).all() and (out[4:, :] < q[4:, :]).any()


def test_reservoirs_raise_only_the_lake_behind_their_dam():
    q = np.zeros((7, 9), dtype=np.int64)
    lake = np.zeros((6, 8), bool)
    lake[1:3, 0:3] = True  # behind the dam
    lake[4:6, 5:8] = True  # another lake
    river = np.zeros((6, 8), bool)
    plain, plain_level = apply_water(q, lake, river)
    # a dam's points one cell into the first lake, wanting it at 3
    held = [(np.array([1.5, 2.5]), np.array([2.2, 2.6]), 3)]
    out, level = apply_water(q, lake, river, held)
    assert (level[1:3, 0:3] == 3).all() and (out[1:4, 0:4] == 3).all()
    assert (level[4:6, 5:8] == plain_level[4:6, 5:8]).all()  # the other lake keeps its level
    assert (out[5:, 5:] == plain[5:, 5:]).all()
    # a reservoir never lowers a lake, and points off the grid or on land are ignored
    low = [(np.array([1.5, -4.0, 6.5]), np.array([1.5, 2.0, 1.5]), -5)]
    assert (apply_water(q, lake, river, low)[1] == plain_level).all()


def test_classify_maps_land_cover_and_marks_cliffs_as_rock():
    lc = np.array([[10, 20, 30], [50, 60, 80]], dtype=np.uint8)
    corner_m = np.full((3, 4), 1000.0)
    base = np.zeros((2, 3), np.int16)
    shape = np.zeros((2, 3), np.uint8)
    water = np.full((2, 3), NO_WATER, np.int16)
    water[1, 2] = 0
    out = classify(lc, corner_m, base, shape, water, step_m=25.0)
    assert out.tolist() == [
        [S["woodland"], S["scrub"], S["grass"]],
        [S["urban"], S["desert"], S["water"]],
    ]
    base[0, 1] = 10  # a 250 m cliff above its neighbours
    out = classify(lc, corner_m, base, shape, water, step_m=25.0)
    assert out[0, 1] == S["rock"]
