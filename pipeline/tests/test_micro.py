"""Micro-terrain (M1.6): codec sections, water and road constraints, quantization."""

import json
from pathlib import Path

import numpy as np
import pytest

from pixelworld_pipeline import micro
from pixelworld_pipeline.roads import DIR_INDEX
from pixelworld_pipeline.world_format import (
    NO_WATER,
    Chunk,
    ChunkFormatError,
    decode_chunk,
    delta_rows,
    encode_chunk,
    height_range,
    micro_cells,
    undelta_rows,
    unpack_shape,
)

GOLDEN = Path(__file__).resolve().parents[2] / "testdata" / "world-format"


def test_micro_corners_round_trip_and_match_the_golden():
    data = (GOLDEN / "chunk-v1-micro.pxwc").read_bytes()
    chunk = decode_chunk(data)
    expected = json.loads((GOLDEN / "chunk-v1-micro.json").read_text())
    assert chunk.micro_k == expected["k"] == 2
    assert chunk.micro_corners.flatten().tolist() == expected["microCorners"]
    assert encode_chunk(chunk) == data


def test_chunks_without_micro_terrain_are_unchanged():
    data = (GOLDEN / "chunk-v1-small.pxwc").read_bytes()
    chunk = decode_chunk(data)
    assert chunk.micro_k == 0 and chunk.micro_corners is None
    assert encode_chunk(chunk) == data


def test_row_deltas_wrap_around_safely():
    a = np.array([[-32000, 32000, -32768, 32767, 0]], dtype=np.int16)
    assert (undelta_rows(delta_rows(a)) == a).all()


def test_micro_corners_are_validated():
    z = np.zeros((2, 2), dtype=np.int16)
    u = z.astype(np.uint8)
    with pytest.raises(ChunkFormatError):
        Chunk(x=0, y=0, base=z, shape=u, surface=u, micro_corners=np.zeros((4, 4)))
    with pytest.raises(ChunkFormatError):
        Chunk(x=0, y=0, base=z, shape=u, surface=u, micro_corners=np.zeros((5, 4)))


def test_micro_cells_slope_or_terrace():
    corners = np.array([[0, 1, 9], [1, 3, 9]], dtype=np.int16)
    base, shape = micro_cells(corners)
    offs = unpack_shape(shape)
    assert base[0, 0] == 0 and offs[:, 0, 0].tolist() == [0, 1, 3, 1]  # a slope tile
    assert base[0, 1] == 6 and offs[:, 0, 1].tolist() == [0, 0, 0, 0]  # steep: flat at mean 5.5 → 6


def test_height_range_covers_micro_terrain():
    base = np.array([[10]], dtype=np.int16)
    shape = np.zeros((1, 1), dtype=np.uint8)
    corners = np.array([[38, 41, 44], [44, 47, 50], [40, 41, 42]], dtype=np.int16)
    assert height_range(base, shape, (corners, 4)) == [9, 13]  # floor(38/4), ceil(50/4)


def test_water_cells_become_flat_a_micro_step_under_their_level():
    k = 4
    q = np.random.default_rng(1).uniform(0, 40, size=(2 * k + 1, 2 * k + 1))
    water = np.array([[3, NO_WATER], [NO_WATER, NO_WATER]], dtype=np.int16)
    out = micro.flatten_water(q, water, k)
    assert (out[: k + 1, : k + 1] == 11).all()  # level 3 steps = 12 micro-steps, the bed at 11
    assert (out[k + 1 :, k + 1 :] == q[k + 1 :, k + 1 :]).all()


def test_road_beds_follow_the_profile_near_the_centre_line():
    k = 4
    q = np.full((3 * k + 1, 3 * k + 1), 100.0)
    # a road from the centre of cell (0, 1) to the centre of cell (2, 1), rising 1 → 3 steps
    out = micro.cut_road_beds(q, [(0.5, 1.5, 1.0, 2.5, 1.5, 3.0)], k)
    row = 6  # y = 1.5 cells
    assert out[row, 2] == pytest.approx(4.0)  # x = 0.5: 1 step = 4 micro-steps
    assert out[row, 6] == pytest.approx(8.0)  # x = 1.5: halfway
    assert out[row, 10] == pytest.approx(12.0)
    assert out[row - 1, 6] == pytest.approx(8.0)  # 0.25 cells off the line: inside the bed
    assert out[row - 2, 6] == 100.0  # 0.5 cells off: untouched
    assert out[row, 0] == 100.0  # beyond the segment's end by more than the radius


def test_road_segments_come_once_per_connection():
    mask = np.zeros((2, 3), dtype=np.uint16)
    east, west = 1 << DIR_INDEX[(1, 0)], 1 << DIR_INDEX[(-1, 0)]
    mask[0, 0] = east
    mask[0, 1] = east | west
    mask[0, 2] = west
    segs = micro.road_segments(mask, np.zeros((2, 3)))
    assert [(s[0], s[3]) for s in segs] == [(0.5, 1.5), (1.5, 2.5)]


def test_build_micro_quantizes_a_slope_and_sinks_water_under_its_level():
    k, cy, cx = 4, 2, 2
    step_m = 10.0
    ys, xs = np.mgrid[0 : cy * k + 1, 0 : cx * k + 1]
    corner_m = xs * 2.5 + 200.0  # 1 micro-step (2.5 m) per micro-cell eastward
    base = np.array([[20, 21], [20, 21]], dtype=np.int16)
    shape = np.zeros((2, 2), dtype=np.uint8)
    water = np.array([[NO_WATER, NO_WATER], [NO_WATER, 20]], dtype=np.int16)
    mc = micro.build_micro(corner_m, step_m, k, base, shape, water, np.zeros((2, 2), np.uint16))
    assert mc.shape == (9, 9) and mc.dtype == np.int16
    # land: 1 micro-step per micro-cell, and above the plane of the water beside
    # it (20 steps = 80 micro-steps)
    assert (mc[:5, :4] == np.maximum(xs[:5, :4] + 80, 81)).all()
    # the water cell (at the world's corner, rounded): its bed under the level
    assert (mc[7:, 7:] < 80).all()
    mb, _ms = micro_cells(mc)
    assert (mb[5:, 5:] < 80).all() and (mb[:2, :2] > 80).all()  # rounded: its edges stay dry


def test_shorelines_follow_the_map_not_the_cells():
    import shapely

    k, n = 4, 6
    # the map's water: everything south-east of the diagonal x + y = 6.3 cells
    sea = shapely.Polygon([(7.3, -1), (7.3, 7.3), (-1, 7.3)])
    centres = np.add.outer(np.arange(n), np.arange(n)) + 1.0
    water = np.where(centres > 6.3, 0, NO_WATER).astype(np.int16)  # level 0
    road = np.zeros((n, n), np.uint16)
    road[0, 5] = 1  # a road cell beside the water: no plane over it
    plane = micro.plane_levels(water, road)
    assert plane[0, 5] == NO_WATER and plane[0, 4] == 0 and plane[0, 0] == NO_WATER

    shore = micro.shore_field((n, n), k, water != NO_WATER, [sea])
    ys, xs = np.mgrid[0 : n * k + 1, 0 : n * k + 1] / k
    true = (6.3 - xs - ys) / np.sqrt(2) * k  # micro-cells, positive on land
    near = np.abs(true) < 4
    assert np.median(np.abs(shore - true)[near]) < 0.2

    q = micro.shape_shore(np.full(shore.shape, 12.0), shore, water, road, k)
    covered = np.isfinite(
        micro.corner_min(micro.expand(np.where(plane != NO_WATER, 0.0, np.inf), k), np.inf)
    )
    away = covered & (np.abs(true) > 0.5) & (xs < 5)  # off the road cell's corners
    # under the plane exactly where the map has water: a diagonal, not the cells' staircase
    assert ((q < 0) == (true < 0))[away].all()
    assert (q[away & (true < -3)] == -micro.SHORE_DEPTH).all()
    # a natural bank rises from just above the waterline at SHORE_BANK per micro-cell
    ground = micro.SHORE_BANK_TOP - 1.0  # under the bank's top: the bank meets it
    banked = micro.shape_shore(
        np.full(shore.shape, ground), shore, water, road, k, np.ones((n, n), bool)
    )
    flat = micro.shape_shore(np.full(shore.shape, ground), shore, water, road, k)
    rise = 1 + micro.SHORE_BANK * np.maximum(shore - micro.SHORE_LIP, 0)
    assert (banked[away & (true > 0)] <= np.minimum(ground, rise[away & (true > 0)])).all()
    assert (banked[away & (true < 0)] == flat[away & (true < 0)]).all()
    # and draws as slope tiles: no micro-cell on it spans more than 3 micro-steps
    # (but beside the road cell, which meets the water in a wall)
    b = np.floor(banked + 0.5)
    cs = np.stack([b[:-1, :-1], b[:-1, 1:], b[1:, 1:], b[1:, :-1]])
    assert (cs.max(axis=0) - cs.min(axis=0) <= 3)[:, : 5 * k - 1].all()


def test_ground_far_under_a_neighbours_water_is_not_its_shore():
    # a reservoir behind a dam: the canyon below it is 40 micro-steps lower
    k = 2
    water = np.full((3, 4), NO_WATER, dtype=np.int16)
    water[:, :2] = 20  # the reservoir, level 20 steps = 40 micro-steps
    road = np.zeros((3, 4), np.uint16)
    q = np.full((3 * k + 1, 4 * k + 1), 50.0)
    q[:, 2 * k + 1 :] = 0.0  # the canyon, beyond the dam's crest at x = 2
    shore = micro.shore_field((3, 4), k, water != NO_WATER)
    out = micro.shape_shore(q, shore, water, road, k)
    assert (out[:, 2 * k + 1 :] == 0).all()  # left as it is, not raised to the reservoir
    assert (out[1:-1, 1 : 2 * k - 1] < 40).all()  # the reservoir's own bed under its level
