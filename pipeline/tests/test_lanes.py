"""Lanes and medians (M3.5): one-way ways, lane counts, divided roads, the
LANE layer; and the other road fixes of that round: street tracks that join
into one line, sidewalks on their road's bed, buildings off the asphalt."""

import numpy as np
import shapely

from pixelworld_pipeline import lanes as L
from pixelworld_pipeline import micro
from pixelworld_pipeline import roads as R
from pixelworld_pipeline.build import way_widths
from pixelworld_pipeline.objects import clear_of_roads, road_strips
from pixelworld_pipeline.world_format import Chunk, decode_chunk, encode_chunk


def _deny(heading, **when):
    return {"access_type": "denied", "when": {"heading": heading, **when}}


def test_one_way_ways_are_those_denied_one_heading_for_everyone():
    assert L.travel_sign({"access_restrictions": [_deny("backward")]}) == 1
    assert L.travel_sign({"access_restrictions": [_deny("forward")]}) == -1
    # a bus lane, or a restriction for some vehicles only, isn't one-way
    assert L.travel_sign({"access_restrictions": [_deny("backward", mode=["bus"])]}) == 0
    allowed = {"access_type": "allowed", "when": {"heading": "backward"}}
    assert L.travel_sign({"access_restrictions": [allowed]}) == 0
    assert L.travel_sign({"access_restrictions": None}) == 0


def test_lane_counts_follow_the_width_and_are_even_on_two_way_roads():
    assert L.lane_count(14.0, True, 3.5) == 4
    assert L.lane_count(5.0, True, 3.5) == 1
    assert L.lane_count(14.0, False, 3.5) == 4
    assert L.lane_count(10.0, False, 3.5) == 2  # one lane each way
    assert L.lane_count(4.0, False, 3.5) == 2
    assert L.lane_count(200.0, True, 3.5) == L.MAX_LANES


def _line(seg_id, x0, y0, x1, y1):
    return (seg_id, 1, [(np.array([x0, x1], float), np.array([y0, y1], float))])


def _row(seg_id, name, heading="backward", cls="primary"):
    return {
        "id": seg_id,
        "class": cls,
        "names": {"primary": name} if name else None,
        "access_restrictions": [_deny(heading)] if heading else [],
        "geometry": "LINESTRING (0 0, 1 0)",
    }


def test_divided_roads_are_one_way_pairs_of_one_name_running_opposite_ways():
    lines = [
        _line("east", 0, 5.0, 10, 5.0),
        _line("west", 10, 6.5, 0, 6.5),  # its partner, 1.5 cells away, drawn the other way
        _line("same", 0, 8.0, 10, 8.0),  # one-way the same way: a parallel street
        _line("far", 10, 20.0, 0, 20.0),  # the other way, but too far
        _line("other", 10, 3.5, 0, 3.5),  # the other way, but another name
    ]
    rows = {
        "east": _row("east", "Main Street"),
        "west": _row("west", "Main Street"),
        "same": _row("same", "Main Street"),
        "far": _row("far", "Main Street"),
        "other": _row("other", "Side Street"),
    }
    sign = {k: L.travel_sign(r) for k, r in rows.items()}
    got = L.divided(lines, rows, sign, reach=4.0)
    assert got == {"east", "west", "same"}  # "same" pairs with "west" across "east"
    # a carriageway mapped against its geometry still runs the other way
    rows["west"] = _row("west", "Main Street", heading="forward")
    lines[1] = _line("west", 0, 6.5, 10, 6.5)
    sign = {k: L.travel_sign(r) for k, r in rows.items()}
    assert L.divided(lines[:2], rows, sign, reach=4.0) == {"east", "west"}


def test_lane_bytes_carry_counts_flags_and_rule_counts():
    rows = [_row("a", "Main Street"), _row("b", "Main Street"), _row("c", "Side", heading=None)]
    lines = [_line("a", 0, 5, 10, 5), _line("b", 10, 6, 0, 6), _line("c", 0, 9, 10, 9)]
    widths = {"a": 14.0, "b": 14.0, "c": 10.0}
    got = L.lane_bytes(lines, rows, widths, {"meters": 3.5}, 10.0, counts={"b": 3})
    assert got["a"] == 4 | L.ONEWAY | L.DIVIDED
    assert got["b"] == 3 | L.ONEWAY | L.DIVIDED
    assert got["c"] == 2
    flags = L.lane_bytes(lines, rows, widths, {"lines": False}, 10.0)
    assert flags["a"] == L.ONEWAY | L.DIVIDED and flags["c"] == 0


def test_way_rules_set_widths_and_lanes_by_name_and_box():
    rows = [
        {
            **_row("m", "Market Street", cls="tertiary"),
            "geometry": "LINESTRING (-122.40 37.79, -122.39 37.79)",
        },
        {
            **_row("u", "Market Street", cls="primary"),
            "geometry": "LINESTRING (-122.44 37.76, -122.43 37.76)",
        },
        {**_row("w", "Wide Way", cls="tertiary"), "width_rules": [{"value": 18.0}]},
    ]
    rules = [
        {
            "names": ["market street"],
            "bounds": [-122.42, 37.78, -122.38, 37.80],
            "meters": 20,
            "lanes": 4,
        }
    ]
    widths, counts = way_widths(rows, {"tertiary": 10.0, "primary": 14.0}, rules)
    assert widths == {"m": 20.0, "u": 14.0, "w": 18.0}  # mapped widths count too
    assert counts == {"m": 4}
    # a rule for the street mapped as one way leaves its carriageways alone
    two_way = [{**rules[0], "oneway": False}]
    widths, counts = way_widths(rows, {"tertiary": 10.0, "primary": 14.0}, two_way)
    assert widths["m"] == 10.0 and counts == {}  # "m" is one-way
    rows[0]["access_restrictions"] = []
    assert way_widths(rows, {"tertiary": 10.0, "primary": 14.0}, two_way)[0]["m"] == 20.0


def test_rasterize_keeps_the_widest_ways_lanes_and_the_layer_round_trips():
    lines = [
        ("a", 1, [(np.array([0.5, 6.5]), np.array([2.5, 2.5]))]),
        ("b", 3, [(np.array([3.5, 3.5]), np.array([0.5, 5.5]))]),
    ]
    lanes = {"a": 2, "b": 4 | L.ONEWAY}
    layer = R.rasterize(lines, (6, 7), deviation=1.0, widths={"a": 8.0, "b": 14.0}, lanes=lanes)
    assert layer.lanes[2, 0] == 2
    assert layer.lanes[2, 3] == 4 | L.ONEWAY  # the crossing takes the wider way's
    assert R.rasterize(lines, (6, 7), widths={"a": 8.0}).lanes is None
    z = np.zeros((8, 8), np.int16)
    plain = encode_chunk(
        Chunk(x=0, y=0, base=z, shape=z.astype(np.uint8), surface=z.astype(np.uint8))
    )
    assert b"LANE" not in plain
    lane = np.zeros((8, 8), np.uint8)
    lane[2, 3] = 4 | L.ONEWAY | L.DIVIDED
    blob = encode_chunk(
        Chunk(x=0, y=0, base=z, shape=z.astype(np.uint8), surface=z.astype(np.uint8), lane=lane)
    )
    assert b"LANE" in blob and decode_chunk(blob).lane[2, 3] == lane[2, 3]


def test_a_streets_second_track_joins_the_first_instead_of_stepping_across():
    # a two-row road; the two tracks of one line run in its two rows and swap
    # rows halfway, as two mapped tracks do once rasterized
    on_road = np.zeros((6, 12), bool)
    on_road[2:4, :] = True
    up = ("up", R.RAIL_KINDS["street"], [(np.array([0.5, 11.5]), np.array([2.5, 2.5]))])
    down_xs = np.array([11.5, 6.5, 5.5, 0.5])
    down_ys = np.array([3.5, 3.5, 2.5, 2.5])
    down = ("down", R.RAIL_KINDS["street"], [(down_xs, down_ys)])
    rail = R.rail_layer([up, down], (6, 12), deviation=1.0, on_road=on_road)
    on = (rail & R.CONNECT_MASK) != 0
    assert on[2].all() and not on[3].any()  # one line, no pieces across the street
    # tracks of another kind keep their own cells
    cable = ("c", R.RAIL_KINDS["cable"], [(np.array([0.5, 11.5]), np.array([3.5, 3.5]))])
    rail = R.rail_layer([up, cable], (6, 12), deviation=1.0, on_road=on_road)
    assert ((rail[3] >> R.RAIL_KIND_SHIFT) == R.RAIL_KINDS["cable"]).all()


def test_sidewalks_follow_the_road_bed_across_a_step_in_the_ground():
    k = 2
    # ground: a terrace step running along the road, under where the sidewalk is
    y = np.arange(4 * k + 1)[:, None] * np.ones((1, 6 * k + 1))
    q = np.where(y >= 5, 4.0, 0.0)
    road = np.zeros((4, 6), np.uint16)
    road[1, :] = 0b0100_0100
    road[1, 0] = 0b0000_0100
    road[1, -1] = 0b0100_0000
    path = np.zeros((4, 6), np.uint16)
    path[2, :] = road[1, :]
    segs = micro.road_segments(road, np.zeros((4, 6)), np.full((4, 6), 0.3))
    q2 = micro.cut_road_beds(q, segs, k)
    # a 1.5 m sidewalk (0.15 cells) and the micro-cells its band lies on, as build_micro asks
    psegs = [(*s[:6], 0.15 + 1 / k) for s in micro.road_segments(path, np.zeros((4, 6)))]
    out = micro.follow_beds(q, segs, psegs, k)
    # the sidewalk's line (micro-row 5) lies at the road's level, not on the step
    assert (q2[5:7, 2:-2] == 4).all()
    assert (out[4:6, 2:-2] == 0).all()
    assert (out[3] == q2[3]).all()  # the road's own bed is as cut
    # ground beyond the path keeps its own height
    assert (out[8] == q[8]).all()
    # where the ground under the sidewalk has no terrace, it keeps its own height
    gentle = micro.follow_beds(np.full(q.shape, 2.0), segs, psegs, k)
    assert (gentle[4:7] == 2.0).all() and (gentle[3, 2:-2] == 0).all()
    # build_micro lays the whole band and the micro-cells under it on the bed:
    # the step moves a micro-cell out, off the pavement
    base = np.zeros((4, 6), np.int16)
    shape = np.zeros((4, 6), np.uint8)
    water = np.full((4, 6), -32768, np.int16)
    built = micro.build_micro(
        q, 1.0, k, base, shape, water, road, np.full((4, 6), 0.3), None, path, np.full((4, 6), 0.15)
    )
    assert (built[4:7, 2:-2] == 0).all() and (built[7:, 2:-2] == 4 * k).all()  # micro-steps


def test_buildings_move_off_the_asphalt_or_lose_the_part_over_it():
    mask = np.zeros((6, 8), np.uint16)
    mask[2, :] = 0b0100_0100  # an east-west road along row 2, half a cell wide each side
    strips = road_strips(mask, np.full((6, 8), 0.5))

    def box(x0, y0, x1, y1, grp, g="building.house"):
        return {
            "g": g,
            "x": (x0 + x1) / 2,
            "y": (y0 + y1) / 2,
            "fp": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
            "_grp": grp,
        }

    near = box(2.0, 2.8, 3.0, 4.0, "near")  # its front 0.2 cells over the road's edge
    deep = box(5.0, 2.2, 6.0, 4.0, "deep")  # 0.8 cells over: further than a nudge goes
    clear = box(0.2, 4.0, 1.0, 5.0, "clear")
    out, stats = clear_of_roads([near, deep, clear], strips, nudge=0.4)
    assert stats == {"nudged": 1, "trimmed": 1}
    moved = shapely.Polygon(out[0]["fp"])
    assert moved.bounds[1] >= 3.0 - 1e-6 and moved.area == shapely.Polygon(near["fp"]).area
    assert out[0]["y"] > near["y"]
    trimmed = shapely.Polygon(out[1]["fp"])
    assert abs(trimmed.bounds[1] - 3.0) < 0.05 and trimmed.bounds[3] == 4.0
    assert out[2] == clear


def _seg(seg_id, *conns, subclass=None):
    return {
        "id": seg_id,
        "class": "service",
        "subclass": subclass,
        "connectors": [{"connector_id": c} for c in conns],
    }


def test_islands_join_the_network_through_as_few_parking_aisles_as_they_need():
    rows = [_seg("main1", "a", "b"), _seg("main2", "b", "c")]
    rows += [_seg("island", "x", "y"), _seg("lone", "p", "q")]
    aisles = [
        _seg("aisle1", "c", "m", subclass="parking_aisle"),
        _seg("aisle2", "m", "x", subclass="parking_aisle"),  # two aisles from c to the island
        _seg("aisle3", "c", "x", subclass="parking_aisle"),  # or one
        _seg("aisle4", "y", "z", subclass="parking_aisle"),  # a dead end
    ]
    got = R.joining_segments(rows, aisles)
    assert [r["id"] for r in got] == ["aisle3"]  # "lone" has no way in and stays alone
    assert R.joining_segments(rows[:2], aisles) == []  # one network: nothing to join
