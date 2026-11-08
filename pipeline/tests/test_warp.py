"""Elastic map (M2): scale field, separable and mesh warps, maps, pins."""

import numpy as np
import pytest

from pixelworld_pipeline.warp import (
    Focus,
    Mesh,
    Pin,
    ScaleField,
    signed_areas,
    solve,
    solve_v1,
)

W, H = 120_000.0, 90_000.0
SF = ScaleField(
    400.0,
    [
        Focus("west", 30_000, 45_000, 5_000, 100.0, 12_000),
        Focus("east", 90_000, 45_000, 5_000, 200.0, 12_000),  # same latitude as west
    ],
)


def test_scale_field_blends_from_core_to_background():
    s = SF.at(
        np.array([30_000, 30_000 + 5_000, 30_000 + 11_000, 30_000 + 17_000, 60_000]),
        np.full(5, 45_000),
    )
    assert s[0] == pytest.approx(100.0) and s[1] == pytest.approx(100.0)
    assert 100.0 < s[2] < 400.0
    assert s[3] == pytest.approx(400.0) and s[4] == pytest.approx(400.0)


def test_mesh_locate_returns_exact_barycentrics():
    mesh = Mesh.grid(10.0, 6.0, 2.0)
    pts = np.array([[0.0, 0.0], [3.3, 1.2], [10.0, 6.0], [7.9, 5.5]])
    tri, b = mesh.locate(pts[:, 0], pts[:, 1])
    back = (mesh.points[mesh.tris[tri]] * b[..., None]).sum(axis=1)
    assert np.allclose(back, pts)
    assert (b >= -1e-12).all()


def test_v1_is_monotone_and_fold_free():
    mesh = Mesh.grid(W, H, 3_000)
    w = solve_v1(mesh, SF)
    assert (signed_areas(mesh, w.uv) > 0).all()
    assert w.uv[:, 0].min() == 0 and w.uv[:, 1].min() == 0
    # two focus areas on one latitude: a separable map can't give both their scale
    errors = {f["name"]: abs(f["error"]) for f in w.stats["focus"]}
    assert errors["west"] > 0.2


@pytest.fixture(scope="module")
def v2():
    return solve(W, H, SF, spacing_m=3_000)


def test_v2_hits_focus_targets_without_folds(v2):
    assert v2.stats["folds"] == 0
    assert (signed_areas(v2.mesh, v2.uv) > 0).all()
    for f in v2.stats["focus"]:
        assert abs(f["error"]) < 0.05, f
    # the boundary stays a rectangle
    assert v2.uv[:, 0].min() == pytest.approx(0, abs=1e-9)
    assert v2.uv[:, 1].min() == pytest.approx(0, abs=1e-9)


def test_forward_and_inverse_maps_round_trip(v2):
    rng = np.random.default_rng(3)
    x = rng.uniform(0, W, 5_000)
    y = rng.uniform(0, H, 5_000)
    cx, cy = v2.to_cells(x, y)
    bx, by = v2.to_source(cx, cy)
    assert np.abs(bx - x).max() < 1e-3 and np.abs(by - y).max() < 1e-3
    assert (cx >= -1e-9).all() and (cx <= v2.width + 1e-9).all()
    # local scale where a focus is: close to its target
    sx, sy = v2.to_cells(np.array([30_000.0]), np.array([45_000.0]))
    assert v2.scale_at_cells(sx, sy)[0] == pytest.approx(100.0, rel=0.06)


def test_pins_hold_their_target(v2):
    cx, cy = v2.to_cells(np.array([90_000.0]), np.array([45_000.0]))
    pin = Pin("east", 90_000.0, 45_000.0, float(cx[0]) + 8.0, float(cy[0]) - 5.0)
    pinned = solve(W, H, SF, pins=[pin], spacing_m=3_000)
    assert pinned.stats["folds"] == 0
    assert pinned.stats["pins"][0]["cells"] < 0.5


def test_unknown_method_is_rejected():
    with pytest.raises(ValueError):
        solve(W, H, SF, method="v9")
