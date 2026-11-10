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


def _crooked_block():
    """Two streets 12 cells apart joined by a straight cross street and by a
    crooked one whose hairpins swing two cells either side of its line
    (Lombard Street's block between Hyde and Leavenworth)."""
    zig_x = np.linspace(10.3, 22.3, 13)
    zig_y = 20.3 + np.array([0, 2, -2, 2, -2, 2, -2, 2, -2, 2, -2, 2, 0], dtype=np.float64)
    return [
        ("west-n", 1, [(np.array([10.3, 10.3]), np.array([8.3, 20.3]))]),
        ("west-s", 1, [(np.array([10.3, 10.3]), np.array([20.3, 32.3]))]),
        ("east-n", 1, [(np.array([22.3, 22.3]), np.array([8.3, 20.3]))]),
        ("east-s", 1, [(np.array([22.3, 22.3]), np.array([20.3, 32.3]))]),
        ("cross", 1, [(np.array([10.3, 22.3]), np.array([8.3, 8.3]))]),
        ("crooked", 1, [(zig_x, zig_y)]),
    ]


def test_kept_ways_keep_their_hairpins_while_the_grid_straightens():
    lines = _crooked_block()
    shape = (40, 40)
    plain = R.straighten(lines, angle=16, simplify=0.75)
    kept = R.straighten(lines, angle=16, simplify=0.75, keep={"crooked"})
    (pxs, _pys) = {seg: parts for seg, _, parts in plain.lines}["crooked"][0]
    (kxs, kys) = {seg: parts for seg, _, parts in kept.lines}["crooked"][0]
    # straightened, the steep hairpin legs are pulled upright and bunch together
    assert not np.allclose(pxs, np.linspace(10.3, 22.3, 13), atol=0.5)
    # kept, every vertex stays where it was (the ends are junctions with
    # streets that already run along the grid)
    assert len(kxs) == 13
    assert np.allclose(kxs, np.linspace(10.3, 22.3, 13), atol=1e-6)
    assert np.allclose(kys[1:-1], 20.3 + np.array([2, -2] * 5 + [2]), atol=1e-6)
    # the streets around it are still made octilinear, the hairpins aren't
    assert kept.constrained == 5 < plain.constrained
    # drawn, the hairpins swing across five rows and stay one connected street
    layer = R.rasterize(kept.lines, shape, deviation=1.0)
    rows = {y for x, y in layer.segment_cells["crooked"]}
    assert len(rows) >= 5
    report = R.validate(layer, np.zeros((4, *shape), dtype=np.int16), {})
    assert report.split_segments == 0 and report.components == 1


def test_street_tracks_run_on_their_road_and_trains_keep_their_own_way():
    shape = (12, 20)
    on_road = np.zeros(shape, dtype=bool)
    on_road[5, :] = True  # an east-west street along row 5
    street = R.RAIL_KINDS["street"]
    cable = R.RAIL_KINDS["cable"]
    train = R.RAIL_KINDS["train"]
    lines = [
        # the street's two tracks, a little either side of its line
        ("t1", street, [(np.array([1.0, 18.0]), np.array([5.3, 5.3]))]),
        ("t2", cable, [(np.array([1.0, 10.0]), np.array([6.2, 6.2]))]),
        # a train two rows south, nowhere near the street
        ("rail", train, [(np.array([1.0, 18.0]), np.array([8.5, 8.5]))]),
    ]
    rail = R.rail_layer(lines, shape, deviation=1.0, on_road=on_road)
    kinds = rail >> R.RAIL_KIND_SHIFT
    # both tracks merged onto the street's cells; cable wins where they share one
    assert (kinds[5, 1:19] > 0).all() and not kinds[6].any()
    assert (kinds[5, 1:11] == cable).all() and (kinds[5, 11:19] == street).all()
    # one connected line along the street: east-west connections, no others
    e, w = 1 << R.DIR_INDEX[(1, 0)], 1 << R.DIR_INDEX[(-1, 0)]
    assert all(int(v) & R.CONNECT_MASK == e | w for v in rail[5, 2:18])
    # the train keeps its own row
    assert (kinds[8, 1:19] == train).all()


def test_rungs_between_parallel_tracks_go_but_crossings_stay():
    rail = np.zeros((6, 6), dtype=np.uint16)
    n, e, s, w = (1 << R.DIR_INDEX[d] for d in ((0, -1), (1, 0), (0, 1), (-1, 0)))
    # two north-south tracks in columns 1 and 2, with a rung between them in row 2
    rail[0:5, 1] = n | s
    rail[0:5, 2] = n | s
    rail[2, 1] |= e
    rail[2, 2] |= w
    # an east-west track crossing a north-south one at (4, 3)
    rail[3, 3:6] |= e | w
    rail[2:5, 4] |= n | s
    out = R.drop_rungs(rail)
    assert not out[2, 1] & e and not out[2, 2] & w
    assert out[3, 3] & e and out[3, 4] & w and out[3, 4] & e  # the crossing keeps its line
    assert (out[0:5, 1] & (n | s)).all()


def test_rail_rules_pick_segments_and_tunnels_are_left_out():
    from pixelworld_pipeline.build import rail_lines
    from pixelworld_pipeline.layout import UniformLayout
    from pixelworld_pipeline.sources import overture

    def line(coords):
        return f"LINESTRING ({', '.join(f'{x} {y}' for x, y in coords)})"

    lon0, lat0 = -115.199, 36.002
    rows = [
        # named, its middle third in a tunnel
        {
            "id": "a",
            "class": "tram",
            "names": {"primary": "Muni F"},
            "rail_flags": [{"values": ["is_tunnel"], "between": [1 / 3, 2 / 3]}],
            "geometry": line([(lon0, lat0), (lon0 + 0.006, lat0)]),
        },
        # unnamed, inside the box
        {
            "id": "b",
            "class": "tram",
            "names": None,
            "geometry": line([(lon0, lat0 + 0.002), (lon0 + 0.003, lat0 + 0.002)]),
        },
        # a train
        {
            "id": "c",
            "class": "standard_gauge",
            "names": None,
            "geometry": line([(lon0, lat0 + 0.004), (lon0 + 0.006, lat0 + 0.004)]),
        },
        # light rail matches no rule
        {
            "id": "d",
            "class": "light_rail",
            "names": None,
            "geometry": line([(lon0, lat0 + 0.006), (lon0 + 0.006, lat0 + 0.006)]),
        },
    ]
    box = [lon0 - 0.001, lat0 + 0.001, lon0 + 0.004, lat0 + 0.003]
    rules = [
        {"draw": "cable", "rail": ["tram"], "unnamed": True, "bounds": box},
        {"draw": "street", "rail": ["tram"]},
        {"draw": "train", "rail": ["standard_gauge"]},
    ]
    assert overture.rail_matches(rules[0], rows[1]) and not overture.rail_matches(rules[0], rows[0])
    assert len(overture.rail_open_parts(rows[0])) == 2  # either side of the tunnel
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
    got = {
        seg: (kind, parts) for seg, kind, parts in rail_lines(UniformLayout(region), rows, rules)
    }
    assert {seg: k for seg, (k, _) in got.items()} == {
        "a": R.RAIL_KINDS["street"],
        "b": R.RAIL_KINDS["cable"],
        "c": R.RAIL_KINDS["train"],
    }
    # the tunnel's third is missing: two parts with a gap between them
    (axs, _), (bxs, _) = got["a"][1]
    assert bxs[0] - axs[-1] > 5  # about 180 m at 20 m cells
    # a straight track comes out as one run, whatever the vertices it was bent with
    assert len(got["c"][1][0][0]) == 2
    # with the roads' shift, it moves with its street
    moved = rail_lines(UniformLayout(region), rows, rules, lambda x, y: (x * 0 + 0.5, y * 0))
    assert np.allclose(moved[2][2][0][0], got["c"][1][0][0] + 0.5)


def test_kept_ways_are_those_inside_a_keep_box():
    from pixelworld_pipeline.build import kept_ways

    def row(i, coords):
        return {"id": i, "geometry": f"LINESTRING ({', '.join(f'{x} {y}' for x, y in coords)})"}

    rows = [
        row("crooked", [(-122.4196, 37.8020), (-122.4190, 37.8022), (-122.4180, 37.8021)]),
        row("cross", [(-122.4196, 37.8010), (-122.4196, 37.8030)]),  # leaves the box
        row("elsewhere", [(-122.40, 37.79), (-122.39, 37.79)]),
    ]
    box = {"bounds": [-122.4197, 37.8019, -122.4179, 37.8023], "width": 5}
    assert kept_ways(rows, [box]) == {"crooked": box}
    assert kept_ways(rows, []) == {}


def _lombard():
    """A crooked block like Lombard Street's: hairpins swinging 0.7 cells
    either side of its line between two cross streets 13 cells apart, a lane
    joining it from the north at a mid-block vertex, and steps beside it."""
    s = np.linspace(0.0, 13.0, 53)
    zig = 0.7 * np.sin(s / 13.0 * 8 * math.pi)  # eight hairpins
    xs, ys = 10.5 + s, 20.0 + zig
    mid = 26  # the lane's junction
    return [
        ("west", 5, [(np.array([10.5, 10.5]), np.array([8.5, 32.5]))]),
        ("east", 4, [(np.array([23.5, 23.5]), np.array([8.5, 32.5]))]),
        ("crooked-a", 4, [(xs[: mid + 1], ys[: mid + 1])]),
        ("crooked-b", 4, [(xs[mid:], ys[mid:])]),
        ("lane", 4, [(np.array([xs[mid], xs[mid]]), np.array([10.5, ys[mid]]))]),
        ("steps", 3, [(np.array([11.0, 23.0]), np.array([21.1, 21.1]))]),
    ]


def test_a_crooked_street_swings_wider_within_its_block_and_stays_joined():
    lines = _lombard()
    kept = {"crooked-a", "crooked-b", "steps"}
    sw = R.swing(lines, kept, {"crooked-a", "crooked-b"}, factor=2.0, within=1.3)
    assert sw is not None
    got = {seg: parts for seg, _, parts in sw.lines}
    before = {seg: parts for seg, _, parts in lines}
    # the axis runs between the street's two ends, which stay where they were
    assert np.allclose(sw.a, [10.5, 20.0]) and np.allclose(sw.b, [23.5, 20.0])
    xs, ys = got["crooked-a"][0]
    assert (xs[0], ys[0]) == pytest.approx((10.5, 20.0))
    # the bends swing wider, up to 1.3 cells either side but never past it
    off = np.concatenate([got["crooked-a"][0][1], got["crooked-b"][0][1]]) - 20.0
    assert off.max() == pytest.approx(1.3) and off.min() == pytest.approx(-1.3)
    old = np.concatenate([before["crooked-a"][0][1], before["crooked-b"][0][1]]) - 20.0
    assert np.all(np.abs(off) >= np.abs(old) - 1e-9)
    # along the street nothing moves
    assert np.allclose(got["crooked-a"][0][0], before["crooked-a"][0][0])
    # the steps beside it move out to the block's edge, no further
    assert np.allclose(got["steps"][0][1], 21.3)
    # the lane's end moves with the junction it shares, the rest of it stays
    lane_x, lane_y = got["lane"][0]
    joint = (got["crooked-b"][0][0][0], got["crooked-b"][0][1][0])
    assert (lane_x[-1], lane_y[-1]) == pytest.approx(joint)
    assert lane_y[0] == pytest.approx(10.5)
    # the cross streets keep their line
    assert np.allclose(got["west"][0][0], 10.5) and np.allclose(got["east"][0][0], 23.5)
    # drawn, the hairpins span four rows instead of two, as one street
    shape = (40, 40)

    def drawn(ls):
        st = R.straighten(ls, angle=16, simplify=0.75, keep=kept)
        layer = R.rasterize(st.lines[:5], shape, deviation=1.0)
        cells = layer.segment_cells["crooked-a"] + layer.segment_cells["crooked-b"]
        return layer, {y for _, y in cells}

    layer, rows = drawn(sw.lines)
    assert rows == {18, 19, 20, 21} and drawn(lines)[1] == {19, 20}
    junctions = {
        "j": ["crooked-a", "crooked-b", "lane"],
        "h": ["west", "crooked-a"],
        "l": ["east", "crooked-b"],
    }
    report = R.validate(layer, np.zeros((4, *shape), dtype=np.int16), junctions)
    assert report.split_segments == 0 and report.disconnected_junctions == 0
    assert report.components == 1 and report.discontinuous_edges == 0
    # the gardens between the bends: the cells the swung street sweeps
    band = R.street_band(sw.a, sw.b, 1.3 + 0.5, shape)
    assert {y for y in range(40) if band[y, 15]} == rows
    assert not band[20, 9] and not band[20, 24]  # nor past its ends


def test_kept_streets_swing_and_take_their_class_and_gardens_from_the_rule():
    from pixelworld_pipeline.build import ROAD_ORDER, class_ids, swing_kept
    from pixelworld_pipeline.layout import UniformLayout

    region = Region.from_dict(
        {
            "id": "s",
            "name": "S",
            "bounds": [-122.43, 37.79, -122.41, 37.81],
            "metersPerCell": 10,
            "style": "s",
            "start": {"lon": -122.42, "lat": 37.80},
            "sources": {},
        }
    )
    layout = UniformLayout(region)
    lines = _lombard()
    roads = {s for s, _, _ in lines[:5]}
    rule = {"bounds": [0, 0, 0, 0], "widen": 2, "within": 13, "surface": "grass", "class": "brick"}
    keep = dict.fromkeys(("crooked-a", "crooked-b", "steps"), rule)
    swung, paths, gardens = swing_kept(layout, lines[:5], lines[5:], keep, [rule], roads)
    assert len(swung) == 5 and len(paths) == 1
    assert np.abs(swung[2][2][0][1] - 20.0).max() == pytest.approx(1.3)  # 13 m at 10 m cells
    ((_a, _b, half, surface),) = gardens
    assert half == pytest.approx(1.3) and surface == "grass"
    # without `widen`, kept ways stay as they are
    plain = {"bounds": [0, 0, 0, 0], "width": 5}
    same = swing_kept(layout, lines[:5], lines[5:], dict.fromkeys(keep, plain), [plain], roads)
    assert same == (lines[:5], lines[5:], [])
    # the street's own class is the lowest: the streets it meets keep their junctions
    assert class_ids(["residential", "tertiary", "brick"], ROAD_ORDER) == {
        1: "brick",
        2: "residential",
        3: "tertiary",
    }
    assert class_ids(["residential", "tertiary"], ROAD_ORDER) == {1: "residential", 2: "tertiary"}


def test_sixteen_directions_snap_two_to_one_edges_exactly():
    # an edge 27 degrees off the x axis: 18 degrees from 45, so 8 directions leave it,
    # while 16 snap it onto 2:1 (26.57 degrees)
    lines = [
        ("a", 1, [(np.array([2.0, 12.0]), np.array([2.0, 2.0 + 10 * np.tan(np.radians(27))]))])
    ]
    assert R.straighten(lines, angle=12).constrained == 0
    st = R.straighten(lines, angle=12, directions=16)
    assert st.constrained == 1
    ((xs, ys),) = st.lines[0][2]
    assert np.degrees(np.arctan2(ys[1] - ys[0], xs[1] - xs[0])) == pytest.approx(26.565, abs=1e-3)
    with pytest.raises(ValueError, match="8 or 16"):
        R.straighten(lines, directions=12)


def test_centre_line_pieces_follow_the_line_cell_by_cell():
    got = list(R.cell_pieces(0.5, 0.5, 2.5, 1.5))
    assert [(cx, cy) for cx, cy, _ in got] == [(0, 0), (1, 0), (1, 1), (2, 1)]
    # each piece ends where the next begins, in world coordinates
    ends = [(cx + p[2], cy + p[3]) for cx, cy, p in got]
    starts = [(cx + p[0], cy + p[1]) for cx, cy, p in got]
    assert all(np.allclose(e, s) for e, s in zip(ends, starts[1:], strict=False))
    assert R.pack_piece(0.0, 0.0, 1.0, 0.5) == 0 | 0 << 8 | 255 << 16 | 128 << 24
    assert R.pack_piece(0.3, 0.3, 0.3, 0.3) == 0  # too short to hold: an empty slot


def test_rasterize_with_pieces_keeps_the_widest_four_and_marks_clipped_cells():
    line = ("a", 2, [(np.array([0.5, 4.5]), np.array([0.5, 2.5]))])
    layer = R.rasterize([line], (4, 6), deviation=1.0, widths={"a": 8.0}, pieces=True)
    assert layer.pieces is not None and layer.pieces.shape == (4, 6, R.PIECES)
    cells = {(x, y) for x, y, _ in R.cell_pieces(0.5, 0.5, 4.5, 2.5)}
    assert {(x, y) for y, x in zip(*np.nonzero(layer.pieces[..., 0]), strict=True)} == cells
    # every cell the line crosses has its class and width, connections or not
    assert all(layer.cls[y, x] == 2 and layer.width[y, x] == 8.0 for x, y in cells)
    # one way more than fits through one cell: the narrowest is left out
    n = R.PIECES + 1
    ways = [
        (f"w{k}", 1, [(np.array([0.05 + 0.12 * k, 0.05 + 0.12 * k]), np.array([0.0, 1.0]))])
        for k in range(n)
    ]
    crowded = R.rasterize(ways, (2, 2), widths={f"w{k}": 2.0 + k for k in range(n)}, pieces=True)
    assert crowded.pieces_dropped == 1
    kept = [int(p) & 0xFF for p in crowded.pieces[0, 0]]  # x0 of each piece
    assert kept == [round((0.05 + 0.12 * k) * 255) for k in range(n - 1, 0, -1)]


def test_a_ways_wiggle_in_a_cell_merges_into_one_piece_but_a_bend_does_not():
    # a vertex 0.02 cell off the straight line: one piece; 0.2 off: two
    flat = R.merge_pieces([(0.0, 0.5, 0.5, 0.52), (0.5, 0.52, 1.0, 0.5)])
    assert flat == [(0.0, 0.5, 1.0, 0.5)]
    bent = R.merge_pieces([(0.0, 0.5, 0.5, 0.7), (0.5, 0.7, 1.0, 0.5)])
    assert len(bent) == 2
    # pieces that don't join stay apart
    assert len(R.merge_pieces([(0.0, 0.2, 1.0, 0.2), (0.0, 0.8, 1.0, 0.8)])) == 2
