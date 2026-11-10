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


def test_water_cells_become_flat_at_their_level():
    k = 4
    q = np.random.default_rng(1).uniform(0, 40, size=(2 * k + 1, 2 * k + 1))
    water = np.array([[3, NO_WATER], [NO_WATER, NO_WATER]], dtype=np.int16)
    out = micro.flatten_water(q, water, k)
    assert (out[: k + 1, : k + 1] == 12).all()  # level 3 steps = 12 micro-steps
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


def test_build_micro_quantizes_a_slope_and_keeps_water_flat():
    k, cy, cx = 4, 2, 2
    step_m = 10.0
    ys, xs = np.mgrid[0 : cy * k + 1, 0 : cx * k + 1]
    corner_m = xs * 2.5 + 200.0  # 1 micro-step (2.5 m) per micro-cell eastward
    base = np.array([[20, 21], [20, 21]], dtype=np.int16)
    shape = np.zeros((2, 2), dtype=np.uint8)
    water = np.array([[NO_WATER, NO_WATER], [NO_WATER, 20]], dtype=np.int16)
    mc = micro.build_micro(corner_m, step_m, k, base, shape, water, np.zeros((2, 2), np.uint16))
    assert mc.shape == (9, 9) and mc.dtype == np.int16
    assert (mc[:5, :4] == xs[:5, :4] + 80).all()  # land: 1 micro-step per micro-cell
    assert (mc[4:, 4:] == 80).all()  # water cell corners: 20 steps = 80 micro-steps
    mb, ms = micro_cells(mc)
    assert (unpack_shape(ms[4:, 4:]) == 0).all() and (mb[4:, 4:] == 80).all()
