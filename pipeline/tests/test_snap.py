"""Isometric snapping (D-049): straightened road networks, octilinear runs,
buildings turned to the grid and moved with their roads."""

import math

import numpy as np
import pytest

from pixelworld_pipeline import objects
from pixelworld_pipeline import roads as R
from pixelworld_pipeline.region import Region


def _kinks(layer: R.RoadLayer) -> int:
    """45° bends in roads passing through a cell: the jogs that read as jitter
    (a grid's corners turn 90° and don't count)."""
    m = layer.mask & R.CONNECT_MASK
    k = 0
    for v in m[m > 0].tolist():
        bits = [i for i in range(8) if v >> i & 1]
        if len(bits) == 2 and min((bits[1] - bits[0]) % 8, 8 - (bits[1] - bits[0]) % 8) == 3:
            k += 1
    return k


@pytest.mark.parametrize("dx,dy", [(20, 0), (0, -9), (7, 7), (20, 3), (9, 4), (12, 5), (-15, 6)])
def test_octilinear_path_takes_king_steps_in_few_runs_close_to_the_line(dx, dy):
    a, b = (3, 4), (3 + dx, 4 + dy)
    path = R.octilinear_path(a, b, deviation=1.0)
    assert path[0] == a and path[-1] == b
    steps = [(q[0] - p[0], q[1] - p[1]) for p, q in zip(path, path[1:], strict=False)]
    assert all(max(abs(sx), abs(sy)) == 1 for sx, sy in steps)
    runs = 1 + sum(1 for s, t in zip(steps, steps[1:], strict=False) if s != t)
    n_axis = abs(abs(dx) - abs(dy))
    n_diag = min(abs(dx), abs(dy))
    if n_axis == 0 or n_diag == 0:
        assert runs == 1
    length = math.hypot(dx, dy)
    for x, y in path:  # within the deviation (plus rounding) of the line
        d = abs((x - a[0]) * dy - (y - a[1]) * dx) / length
        assert d <= 1.0 + 0.75
    # far fewer runs than a cell-by-cell staircase
    assert runs <= max(1, 2 * math.ceil(n_axis * n_diag / length) + 1)


def _grid_lines(rotation_deg: float, n: int = 4, spacing: float = 12.0, origin=(10.0, 10.0)):
    """An n×n street grid rotated by a few degrees, as road lines in cells,
    split at every crossing (so streets share junction vertices)."""
    t = math.radians(rotation_deg)
    rot = np.array([[math.cos(t), -math.sin(t)], [math.sin(t), math.cos(t)]])

    def at(i, j):
        return rot @ np.array([i * spacing, j * spacing]) + np.array(origin) + 0.3

    lines = []
    for j in range(n):
        for i in range(n - 1):
            a, b = at(i, j), at(i + 1, j)
            lines.append((f"h{j}-{i}", 1, [(np.array([a[0], b[0]]), np.array([a[1], b[1]]))]))
    for i in range(n):
        for j in range(n - 1):
            a, b = at(i, j), at(i, j + 1)
            lines.append((f"v{i}-{j}", 1, [(np.array([a[0], b[0]]), np.array([a[1], b[1]]))]))
    return lines


def test_a_slightly_rotated_street_grid_comes_out_straight_and_connected():
    lines = _grid_lines(3.0)
    shape = (60, 60)
    before = R.rasterize(lines, shape)
    st = R.straighten(lines, angle=12)
    after = R.rasterize(st.lines, shape, deviation=1.0)
    assert _kinks(before) > 4
    assert _kinks(after) == 0  # every street is one straight run
    assert st.constrained == st.edges == 24
    moved = np.hypot(*(st.moved - st.origin).T)
    assert moved.max() < 2.0
    # still one connected network, every segment in one piece
    report = R.validate(after, np.zeros((4, *shape), dtype=np.int16), {})
    assert report.components == 1 and report.split_segments == 0


def test_roads_far_from_any_grid_direction_are_left_alone():
    lines = _grid_lines(22.5, n=2)  # exactly between an axis and a diagonal
    st = R.straighten(lines, angle=12)
    assert st.constrained == 0
    assert np.allclose(st.moved, st.origin)


def test_the_shift_field_follows_nearby_nodes_and_fades_away():
    st = R.Straightened(
        lines=[],
        origin=np.array([[10.0, 10.0], [11.0, 10.0]]),
        moved=np.array([[11.0, 10.0], [12.0, 10.0]]),
        constrained=1,
        edges=1,
    )
    fn = st.shift(3.0)
    dx, dy = fn(np.array([10.5, 40.0]), np.array([10.0, 40.0]))
    assert dx[0] == pytest.approx(1.0, abs=0.06) and dy[0] == pytest.approx(0.0)
    assert dx[1] == 0.0  # far from every road


def _box(x, y, w, h, angle_deg):
    t = math.radians(angle_deg)
    rot = np.array([[math.cos(t), -math.sin(t)], [math.sin(t), math.cos(t)]])
    corners = np.array([[-w, -h], [w, -h], [w, h], [-w, h]]) / 2 @ rot.T + (x, y)
    return [[float(a), float(b)] for a, b in corners]


def test_buildings_turn_to_the_nearest_grid_direction_with_their_parts():
    found = [
        {"g": "building.tower", "x": 5.0, "y": 5.0, "s": 1, "fp": _box(5, 5, 2, 1, 7), "_grp": "a"},
        {
            "g": "building.tower",
            "x": 5.5,
            "y": 5.0,
            "s": 2,
            "fp": _box(5.5, 5, 0.4, 0.4, 7),
            "_grp": "a",
        },
        {
            "g": "building.tower",
            "x": 9.0,
            "y": 5.0,
            "s": 3,
            "fp": _box(9, 5, 2, 1, 40),
            "_grp": "b",
        },
        {
            "g": "building.tower",
            "x": 13.0,
            "y": 5.0,
            "s": 4,
            "fp": _box(13, 5, 2, 1, 22),
            "_grp": "c",
        },
    ]
    out = objects.snap_buildings([dict(i) for i in found], {"angle": 12})

    def direction(fp):
        e = np.subtract(fp[1], fp[0])
        return math.degrees(math.atan2(e[1], e[0]))

    assert direction(out[0]["fp"]) == pytest.approx(0, abs=0.5)  # 7° → axis
    assert direction(out[1]["fp"]) == pytest.approx(0, abs=0.5)  # its part turned with it
    assert out[1]["x"] == pytest.approx(5.0 + 0.5 * math.cos(math.radians(-7)), abs=0.01)
    assert direction(out[2]["fp"]) == pytest.approx(45, abs=0.5)  # 40° → diagonal
    assert out[3]["fp"] == found[3]["fp"]  # 22°: no grid direction is close


def test_objects_move_with_their_roads_but_keep_their_shape_and_dams_stay():
    region = Region.from_dict(
        {
            "id": "s",
            "name": "S",
            "bounds": [-115.2, 36.0, -115.19, 36.01],
            "metersPerCell": 20,
            "style": "s",
            "start": {"lon": -115.195, "lat": 36.005},
            "sources": {},
        }
    )
    blocked = np.zeros(region.cells[::-1], dtype=bool)
    plain = objects.Placement(region, blocked)
    moved = objects.Placement(
        region, blocked, shift=lambda x, y: (np.full(np.shape(x), 1.5), np.zeros(np.shape(y)))
    )
    x, y = plain.west + 200.0, plain.north - 200.0
    a = plain.to_cells(np.array([x]), np.array([y]))
    b = moved.to_cells(np.array([x]), np.array([y]))
    assert b[0][0] == pytest.approx(a[0][0] + 1.5) and b[1][0] == pytest.approx(a[1][0])
    assert moved.to_cells(np.array([x]), np.array([y]), shift=False)[0][0] == pytest.approx(a[0][0])
    assert np.allclose(moved.similarity(x, y), plain.similarity(x, y))


def test_roads_along_the_world_edge_stay_inside_it():
    # a road down the west edge of the world, slightly tilted, plus a side road
    lines = [
        ("edge-a", 1, [(np.array([0.0, 0.0]), np.array([20.0, 12.0]))]),
        ("edge-b", 1, [(np.array([0.0, 0.4]), np.array([12.0, 2.0]))]),
        ("side", 1, [(np.array([0.0, 9.0]), np.array([12.0, 12.6]))]),
    ]
    st = R.straighten(lines, angle=12, shape=(30, 30))
    assert (st.moved >= 0).all()
    layer = R.rasterize(st.lines, (30, 30), deviation=1.0)
    junctions = {"j1": ["edge-a", "edge-b"], "j2": ["edge-b", "side"]}
    report = R.validate(layer, np.zeros((4, 30, 30), dtype=np.int16), junctions)
    assert report.disconnected_junctions == 0 and report.split_segments == 0
