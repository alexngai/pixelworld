import numpy as np

from pixelworld_pipeline.gridify import cell_corner_heights, gridify_heights
from pixelworld_pipeline.roads import (
    CROSSING_SHIFT,
    DIR_INDEX,
    apply_to_corners,
    junction_index,
    rasterize,
    road_heights,
    trace_cells,
    validate,
)


def line(*pts):
    xs, ys = zip(*pts, strict=True)
    return [(np.array(xs, float), np.array(ys, float))]


def test_trace_is_thin_and_8_connected():
    path = trace_cells(np.array([0.5, 6.5]), np.array([0.5, 3.5]))
    assert path[0] == (0, 0) and path[-1] == (6, 3)
    for a, b in zip(path, path[1:], strict=False):
        assert max(abs(a[0] - b[0]), abs(a[1] - b[1])) == 1
    # a pure diagonal becomes diagonal moves, not a staircase
    diag = trace_cells(np.array([0.5, 4.5]), np.array([0.5, 4.5]))
    assert diag == [(i, i) for i in range(5)]


def test_rasterize_sets_symmetric_connections_and_crossings():
    layer = rasterize([("a", 2, line((0.5, 0.5), (2.5, 2.5)))], (4, 4))
    se, nw = DIR_INDEX[(1, 1)], DIR_INDEX[(-1, -1)]
    assert layer.mask[0, 0] & (1 << se)
    assert layer.mask[1, 1] & (1 << nw) and layer.mask[1, 1] & (1 << se)
    # the diagonal passes through the corner shared with (1,0) and (0,1)
    assert layer.mask[0, 1] & (1 << (CROSSING_SHIFT + 3))  # cell x=1,y=0: its corner c3
    assert layer.mask[1, 0] & (1 << (CROSSING_SHIFT + 1))  # cell x=0,y=1: its corner c1
    assert layer.cls[1, 1] == 2


def test_road_heights_are_grade_limited_along_the_road():
    # a straight east-west road over a steep ramp: 3 steps per cell
    corners = np.tile(np.arange(11) * 3.0, (4, 1))
    layer = rasterize([("r", 1, line((0.5, 1.5), (9.5, 1.5)))], (3, 10))
    h = road_heights(layer.mask, corners)
    row = h[1]
    assert (row > -32768).all()
    assert np.abs(np.diff(row)).max() <= 1


def test_cut_and_fill_makes_connected_road_cells_continuous():
    rng = np.random.default_rng(7)
    corners = np.cumsum(rng.normal(scale=1.5, size=(17, 17)), axis=0)
    corners = np.floor(corners + 0.5)
    layer = rasterize(
        [
            ("a", 3, line((0.5, 8.5), (15.5, 8.5))),
            ("b", 1, line((8.5, 0.5), (8.5, 15.5))),
            ("c", 2, line((1.5, 1.5), (14.5, 14.5))),
        ],
        (16, 16),
    )
    h = road_heights(layer.mask, corners)
    q = apply_to_corners(corners, layer.mask, h)
    base, shape = gridify_heights(q, max_offset=2)
    cc = cell_corner_heights(base, shape)
    report = validate(layer, cc, {"j": ["a", "b", "c"]})
    assert report.discontinuous_edges == 0
    assert report.split_segments == 0
    assert report.disconnected_junctions == 0
    assert report.components == 1
    assert report.ok()


def test_junction_index_keeps_shared_connectors_only():
    segs = [
        {"id": "a", "connectors": [{"connector_id": "x"}, {"connector_id": "y"}]},
        {"id": "b", "connectors": [{"connector_id": "y"}]},
        {"id": "c", "connectors": None},
    ]
    assert junction_index(segs) == {"y": ["a", "b"]}
