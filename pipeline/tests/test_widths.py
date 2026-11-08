"""Real road and path widths (D-050): classes, per-cell half-widths, paved bands,
the path network and its chunk layers."""

import numpy as np
import pytest

from pixelworld_pipeline import micro
from pixelworld_pipeline import roads as R
from pixelworld_pipeline.build import (
    PATH_ORDER,
    ROAD_ORDER,
    class_ids,
    half_width_cells,
    paved_band,
)
from pixelworld_pipeline.sources import overture
from pixelworld_pipeline.world_format import Chunk, decode_chunk, encode_chunk


def test_class_ids_follow_priority_and_keep_the_classic_numbers():
    classic = class_ids(["motorway", "trunk", "primary", "secondary"], ROAD_ORDER)
    assert classic == {1: "secondary", 2: "primary", 3: "trunk", 4: "motorway"}
    walk = class_ids(["primary", "residential", "service", "secondary"], ROAD_ORDER)
    assert walk == {1: "service", 2: "residential", 3: "secondary", 4: "primary"}
    assert class_ids(["sidewalk", "footway", "crosswalk"], PATH_ORDER) == {
        1: "footway",
        2: "sidewalk",
        3: "crosswalk",
    }
    with pytest.raises(ValueError):
        class_ids(["highway"], ROAD_ORDER)


def test_footway_subclasses_are_their_own_path_classes():
    assert overture.path_class({"class": "footway", "subclass": "sidewalk"}) == "sidewalk"
    assert overture.path_class({"class": "footway", "subclass": "crosswalk"}) == "crosswalk"
    assert overture.path_class({"class": "footway", "subclass": None}) == "footway"
    assert overture.path_class({"class": "steps"}) == "steps"


def test_half_widths_come_from_metres_at_the_local_scale_with_a_floor():
    width = np.array([[14.0, 14.0, 0.0, 3.0]], dtype=np.float32)
    mpc = np.array([[20.0, 100.0, 20.0, 500.0]])
    hw = half_width_cells(width, mpc, {"scale": 1.0, "minCells": 0.1})
    # 14 m at 20 m cells: 0.35 cells half-width = 11.2/32; at 100 m: 0.07 → 2/32
    assert hw.tolist() == [[11, 2, 0, 2]]  # the 3 m path at 500 m hits the floor (0.05)
    wide = half_width_cells(width, mpc, {"scale": 3.0, "minCells": 0.0})
    assert wide[0, 1] == round(3 * 7 / 100 * 32)


def test_rasterize_records_the_widest_way_and_the_higher_priority_class():
    lines = [
        ("a", 1, [(np.array([0.5, 6.5]), np.array([2.5, 2.5]))]),
        ("b", 3, [(np.array([3.5, 3.5]), np.array([0.5, 5.5]))]),
    ]
    layer = R.rasterize(lines, (6, 7), deviation=1.0, widths={"a": 8.0, "b": 14.0})
    assert layer.width[2, 3] == 14.0 and layer.cls[2, 3] == 3  # the crossing
    assert layer.width[2, 0] == 8.0 and layer.cls[2, 0] == 1
    # with priorities given, a lower class number can win
    rank = {1: 10, 3: 5}.get
    layer = R.rasterize(lines, (6, 7), deviation=1.0, rank_of=rank)
    assert layer.cls[2, 3] == 1 and layer.width is None


def test_a_wide_road_paves_the_cells_beside_it():
    on = np.zeros((9, 9), bool)
    on[4, :] = True
    hw = np.where(on, 1.4, 0.0)
    paved = paved_band(on, hw)
    assert paved[3:6, :].all() and not paved[2, :].any() and not paved[6, :].any()
    assert not paved_band(np.zeros((3, 3), bool), np.zeros((3, 3))).any()


def test_road_beds_follow_the_road_width():
    mask = np.zeros((3, 5), np.uint16)
    for x in range(5):  # an east-west road along row 1
        if x < 4:
            mask[1, x] |= 1 << R.DIR_INDEX[(1, 0)]
        if x > 0:
            mask[1, x] |= 1 << R.DIR_INDEX[(-1, 0)]
    centre = np.zeros((3, 5))
    narrow = micro.road_segments(mask, centre)
    wide = micro.road_segments(mask, centre, np.full((3, 5), 1.2))
    assert narrow[0][6] == micro.ROAD_BED_RADIUS and wide[0][6] == 1.2
    q = np.full((13, 21), 40.0)
    cut = micro.cut_road_beds(q, wide, 4)
    # the bed reaches 1.2 cells (4.8 micro-corners) to either side of row 1.5
    assert (cut[6 - 4 : 6 + 5, 8] == 0).all() and cut[0, 8] == 40.0


def test_width_and_path_layers_round_trip_in_a_chunk():
    n = 8
    z = np.zeros((n, n), np.int16)
    rw = np.zeros((n, n), np.uint8)
    rw[2, 3] = 40
    path = np.zeros((n, n), np.uint16)
    path[5, 5] = 0b100
    pcls = np.zeros((n, n), np.uint8)
    pcls[5, 5] = 2
    chunk = Chunk(
        x=0,
        y=0,
        base=z,
        shape=z.astype(np.uint8),
        surface=z.astype(np.uint8),
        road_width=rw,
        path=path,
        path_class=pcls,
        path_width=rw,
    )
    data = encode_chunk(chunk)
    for tag in (b"RWID", b"PATH", b"PCLS", b"PWID"):
        assert tag in data
    back = decode_chunk(data)
    assert back.road_width[2, 3] == 40 and back.path[5, 5] == 0b100 and back.path_class[5, 5] == 2
    plain = encode_chunk(
        Chunk(x=0, y=0, base=z, shape=z.astype(np.uint8), surface=z.astype(np.uint8))
    )
    assert b"RWID" not in plain and b"PATH" not in plain  # optional layers stay out when empty


def test_junctions_beyond_the_world_edge_are_not_checked():
    segs = [
        {
            "id": "a",
            "connectors": [{"connector_id": "out", "at": 0.0}, {"connector_id": "in", "at": 1.0}],
        },
        {"id": "b", "connectors": [{"connector_id": "out", "at": 1.0}]},
        {"id": "c", "connectors": [{"connector_id": "in", "at": 0.0}]},
    ]
    assert R.junction_index(segs) == {"out": ["a", "b"], "in": ["a", "c"]}
    inside = {("a", 0.0): False, ("b", 1.0): False}
    kept = R.junction_index(segs, lambda s, at: inside.get((s, at), True))
    assert kept == {"in": ["a", "c"]}
    assert R.point_at(np.array([0.0, 2.0, 2.0]), np.array([0.0, 0.0, 2.0]), 0.75) == (2.0, 1.0)
