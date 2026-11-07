import numpy as np
import pytest

from pixelworld_pipeline.gridify import (
    bilateral,
    cell_corner_heights,
    cliff_mask,
    gridify_heights,
    meters_per_step,
    smooth,
    vertical_exaggeration,
)
from pixelworld_pipeline.world_format import unpack_shape


def test_gentle_terrain_becomes_matching_slopes():
    # a smooth ramp rising 0.5 step per cell eastward
    xs = np.arange(5, dtype=float) * 0.5
    corners = np.tile(xs, (5, 1))
    base, shape = gridify_heights(corners)
    c = cell_corner_heights(base, shape)
    q = np.floor(corners + 0.5)
    # every cell's corners equal the rounded corner grid, so neighbours match exactly
    np.testing.assert_array_equal(c[0], q[:-1, :-1])
    np.testing.assert_array_equal(c[1], q[:-1, 1:])
    np.testing.assert_array_equal(c[2], q[1:, 1:])
    np.testing.assert_array_equal(c[3], q[1:, :-1])
    assert unpack_shape(shape).max() <= 1


def test_steep_terrain_becomes_flat_terraces():
    xs = np.arange(4, dtype=float) * 3.0  # 3 steps per cell
    corners = np.tile(xs, (4, 1))
    base, shape = gridify_heights(corners)
    assert (shape == 0).all()
    # flat at the mean rounded half-up: means 1.5, 4.5, 7.5 → 2, 5, 8
    np.testing.assert_array_equal(base[0], [2, 5, 8])
    assert cliff_mask(base, shape).any()


def test_all_raised_normalizes():
    corners = np.full((2, 2), 3.0)
    base, shape = gridify_heights(corners)
    assert base[0, 0] == 3 and shape[0, 0] == 0


def test_steep_slope_mode_keeps_downhill_direction():
    xs = np.arange(4, dtype=float) * 3.0  # rising east, 3 steps per cell
    corners = np.tile(xs, (4, 1))
    base, shape = gridify_heights(corners, steep="slope")
    # east corners (c1, c2) raised one step
    assert (unpack_shape(shape)[:, 0, 0] == [0, 1, 1, 0]).all()
    assert (shape == shape[0, 0]).all()
    c = cell_corner_heights(base, shape).mean(axis=0)
    mean = corners[:-1, :-1] / 2 + corners[:-1, 1:] / 2
    assert np.abs(c - mean).max() <= 1.0


def test_smooth_preserves_constants_and_reduces_noise():
    flat = np.full((6, 7), 4.0)
    np.testing.assert_allclose(smooth(flat, 1.0), flat)
    rng = np.random.default_rng(0)
    noisy = rng.normal(size=(32, 32))
    assert smooth(noisy, 1.0).std() < noisy.std() / 2


def test_bilateral_keeps_cliffs_and_flattens_benches():
    rng = np.random.default_rng(1)
    a = np.zeros((20, 20))
    a[:, 10:] = 10.0  # a 10-step cliff
    noisy = a + rng.normal(scale=0.3, size=a.shape)
    out = bilateral(noisy, 1.2, 0.8)
    assert out[:, :9].std() < noisy[:, :9].std() / 2  # bench flattened
    assert np.abs(out[:, 11:] - 10).max() < 0.8  # cliff top not pulled down
    assert np.abs(out[:, :9]).max() < 0.8


def test_exaggeration_multiplies_height_differences():
    real = np.array([[700.0, 740.0], [900.0, 2100.0]])
    for e in (1.0, 1.633, 2.5, 4.0):
        steps = real / meters_per_step(160, e)
        base_diff = (real - real[0, 0]) / meters_per_step(160, 1.0)
        np.testing.assert_allclose(steps - steps[0, 0], base_diff * e)
    assert abs(meters_per_step(160, 1.633) - 40.0) < 0.01
    assert abs(vertical_exaggeration(160, meters_per_step(160, 2.7)) - 2.7) < 1e-12
    with pytest.raises(ValueError):
        meters_per_step(160, 0)


def test_multi_step_slopes_stay_continuous():
    xs = np.arange(6, dtype=float) * 2.4  # 2.4 steps per cell, rising east
    corners = np.tile(xs, (5, 1))
    for k, expect_cliffs in ((1, True), (2, True), (3, False)):
        base, shape = gridify_heights(corners, max_offset=k)
        assert cliff_mask(base, shape, min_drop=1).any() == expect_cliffs, k
    base, shape = gridify_heights(corners, max_offset=3)
    c = cell_corner_heights(base, shape)
    q = np.floor(corners + 0.5)
    np.testing.assert_array_equal(c[0], q[:-1, :-1])  # shared corners: no seams
    np.testing.assert_array_equal(c[2], q[1:, 1:])
    assert unpack_shape(shape).max() == 3


def test_max_offset_one_matches_single_step_model():
    rng = np.random.default_rng(3)
    corners = np.cumsum(rng.normal(scale=0.8, size=(9, 9)), axis=1)
    base, shape = gridify_heights(corners, max_offset=1)
    offs = unpack_shape(shape)
    assert offs.max() <= 1 and (offs.min(axis=0) == 0).all()
    with pytest.raises(ValueError):
        gridify_heights(corners, max_offset=4)
