import numpy as np

from pixelworld_pipeline.gridify import (
    bilateral,
    cell_corner_heights,
    cliff_mask,
    gridify_heights,
    smooth,
)


def test_gentle_terrain_becomes_matching_slopes():
    # a smooth ramp rising 0.5 step per cell eastward
    xs = np.arange(5, dtype=float) * 0.5
    corners = np.tile(xs, (5, 1))
    base, slope = gridify_heights(corners)
    c = cell_corner_heights(base, slope)
    q = np.floor(corners + 0.5)
    # every cell's corners equal the rounded corner grid, so neighbours match exactly
    np.testing.assert_array_equal(c[0], q[:-1, :-1])
    np.testing.assert_array_equal(c[1], q[:-1, 1:])
    np.testing.assert_array_equal(c[2], q[1:, 1:])
    np.testing.assert_array_equal(c[3], q[1:, :-1])
    assert slope.max() <= 14


def test_steep_terrain_becomes_flat_terraces():
    xs = np.arange(4, dtype=float) * 3.0  # 3 steps per cell
    corners = np.tile(xs, (4, 1))
    base, slope = gridify_heights(corners)
    assert (slope == 0).all()
    # flat at the mean rounded half-up: means 1.5, 4.5, 7.5 → 2, 5, 8
    np.testing.assert_array_equal(base[0], [2, 5, 8])
    assert cliff_mask(base, slope).any()


def test_all_raised_normalizes():
    corners = np.full((2, 2), 3.0)
    base, slope = gridify_heights(corners)
    assert base[0, 0] == 3 and slope[0, 0] == 0


def test_steep_slope_mode_keeps_downhill_direction():
    xs = np.arange(4, dtype=float) * 3.0  # rising east, 3 steps per cell
    corners = np.tile(xs, (4, 1))
    base, slope = gridify_heights(corners, steep="slope")
    # east corners (c1, c2) raised: mask 0b0110
    assert (slope == 0b0110).all()
    c = cell_corner_heights(base, slope).mean(axis=0)
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
