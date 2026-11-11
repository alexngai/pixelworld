"""Object placement, fine-terrain rules and spec inheritance (M1.5 experiment)."""

import gzip
import hashlib
import json

import numpy as np
import pytest
import shapely

from pixelworld_pipeline import objects
from pixelworld_pipeline.build import S, buffered_lines, classify, drop_sloped, drop_small
from pixelworld_pipeline.region import Region, RegionError, load_spec
from pixelworld_pipeline.world_format import NO_WATER, write_package

SPEC = {
    "id": "t",
    "name": "Test",
    "bounds": [-115.2, 36.0, -115.19, 36.01],  # about 900 m × 1100 m
    "metersPerCell": 20,
    "style": "s",
    "start": {"lon": -115.195, "lat": 36.005},
    "sources": {},
}


def test_spec_extends_merges_mappings_and_null_removes(tmp_path):
    (tmp_path / "base.yaml").write_text(
        "id: base\nname: B\nmetersPerCell: 20\nsources: {dem: {kind: a, overview: 1}}\n"
        "terrain: {cliffSlope: 0.6}\nrender: {scale: 0.125, tileSize: 512}\n"
    )
    (tmp_path / "child.yaml").write_text(
        "extends: base.yaml\nid: child\nsources: {dem: {overview: 8}}\nterrain: null\n"
        "render: {scale: 1}\n"
    )
    spec = load_spec(tmp_path / "child.yaml")
    assert spec["id"] == "child" and spec["name"] == "B"
    assert spec["sources"]["dem"] == {"kind": "a", "overview": 8}
    assert spec["terrain"] is None
    assert spec["render"] == {"scale": 1, "tileSize": 512}


def test_optional_sections_leave_older_digests_alone():
    plain = Region.from_dict(SPEC)
    assert plain.render is None and plain.objects is None and plain.terrain is None
    with_render = Region.from_dict(SPEC | {"render": {"scale": 0.25}})
    assert with_render.digest() != plain.digest()
    with pytest.raises(RegionError):
        Region.from_dict(SPEC | {"render": {"scale": 2}})


def test_drop_small_and_sloped_water():
    mask = np.zeros((6, 8), dtype=bool)
    mask[0:2, 0:2] = True  # 4 cells, flat
    mask[3:6, 3:8] = True  # 15 cells, steep
    assert drop_small(mask, 5).sum() == 15
    corners = np.zeros((7, 9))
    corners[3:7, 3:9] = np.arange(6)[None, :] * 10.0  # 50 m of relief across the big body
    kept = drop_sloped(mask, corners, max_relief=12)
    assert kept[0:2, 0:2].all() and not kept[3:6, 3:8].any()


def test_buffered_lines_widen_rivers():
    line = [("r", 1, [(np.array([0.0, 10.0]), np.array([5.0, 5.0]))])]
    wide = buffered_lines(line, 1.6, (10, 10))
    # cell centres within 1.6 of y = 5: rows 3..6 (centres 3.5 … 6.5)
    assert wide[3:7].all() and not wide[:3].any() and not wide[7:].any()


def test_cliff_slope_turns_steep_cells_to_rock_whatever_the_cover():
    lc = np.full((1, 3), 10, dtype=np.uint8)  # tree cover everywhere
    base = np.array([[20, 10, 0]], dtype=np.int16)  # 10-step drops between cells
    shape = np.zeros_like(base, dtype=np.uint8)
    water = np.full_like(base, NO_WATER)
    corner_m = np.zeros((2, 4))
    default = classify(lc, corner_m, base, shape, water, step_m=3.0)
    assert (default == S["woodland"]).all()  # tree cover never becomes rock by default
    fine = classify(lc, corner_m, base, shape, water, 3.0, cliff_slope=0.6, meters_per_cell=20)
    assert fine[0, 0] == S["rock"] and fine[0, 1] == S["rock"]


@pytest.mark.parametrize(
    ("cls", "height", "group"),
    [
        ("hotel", 120, "building.tower.hotel"),
        (None, 80, "building.tower"),
        ("parking", 15, "building.parking"),
        ("house", 6, "building.residential"),
        ("retail", 8, "building.commercial"),
    ],
)
def test_building_groups(cls, height, group):
    assert objects.building_group(cls, height, tower_m=45) == group


def _placement(monkeypatch, landcover_code=10):
    region = Region.from_dict(SPEC)
    cx, cy = region.cells
    lc = np.full((cy * 2, cx * 2), landcover_code, dtype=np.uint8)
    monkeypatch.setattr(objects.rasters, "landcover_fine", lambda r, meters=10.0: (lc, 10.0))
    blocked = np.zeros((cy, cx), dtype=bool)
    blocked[:, : cx // 2] = True  # west half is road/water/cliff
    return objects.Placement(region, blocked)


def test_scatter_is_deterministic_and_respects_cover_and_blocking(monkeypatch):
    p = _placement(monkeypatch)
    rule = {"group": "tree.x", "landcover": ["tree"], "spacing": 30, "density": 0.5}
    none = lambda xs, ys: np.zeros(len(xs), dtype=bool)  # noqa: E731
    a = objects.scatter(p, rule, none, "0")
    b = objects.scatter(p, rule, none, "0")
    assert a == b and len(a) > 50
    assert all(i["x"] >= p.cx // 2 for i in a)  # nothing on blocked cells
    assert all(0 <= i["r"] < 4 for i in a)
    assert objects.scatter(p, rule | {"landcover": ["built"]}, none, "0") == []


def test_place_buildings_footprints_parts_and_clear_zones(monkeypatch):
    p = _placement(monkeypatch)
    lon0, lat0 = -115.193, 36.004

    def square(lon, lat, d=0.0003):
        return shapely.box(lon, lat, lon + d, lat + d).wkt

    rows = [
        {
            "id": "a",
            "class": "hotel",
            "height": 120,
            "has_parts": False,
            "geometry": square(lon0, lat0),
        },
        {
            "id": "b",
            "class": None,
            "height": 100,
            "has_parts": True,
            "geometry": square(lon0, lat0 + 0.001),
        },
        {
            "id": "c",
            "class": None,
            "height": 9,
            "has_parts": False,
            "geometry": square(lon0, lat0 + 0.002),
        },
    ]
    parts = [
        {
            "id": "b1",
            "building_id": "b",
            "height": 60,
            "min_height": 0,
            "geometry": square(lon0, lat0 + 0.001, 0.0001),
        }
    ]
    no_clear = lambda x, y: False  # noqa: E731
    out, polys = objects.place_buildings(p, {"minArea": 30}, rows, parts, no_clear)
    groups = [o["g"] for o in out]
    assert groups == [
        "building.tower.hotel",
        "building.commercial",
        "building.tower",
        "building.commercial",
    ]
    assert out[1]["hm"] == 15  # a 100 m parent of parts is cut down to a podium
    assert len(polys) == 4 and all(len(o["fp"]) >= 4 for o in out)
    cleared, _ = objects.place_buildings(p, {}, rows[:1], [], lambda x, y: True)
    assert cleared == []

    # a setback tier standing on b's part (from 60 m to 90 m), and a skybridge
    # off b's footprint: both dropped, or with `tiers` the tier drawn from the ground
    tier = {"id": "b2", "building_id": "b", "height": 90, "min_height": 60}
    tier["geometry"] = square(lon0 + 0.00002, lat0 + 0.00102, 0.00006)
    bridge = {"id": "b3", "building_id": "b", "height": 20, "min_height": 10}
    bridge["geometry"] = square(lon0 + 0.0004, lat0 + 0.001, 0.0001)
    stacked = parts + [tier, bridge]
    dropped, _ = objects.place_buildings(p, {"minArea": 1}, rows[1:2], stacked, no_clear)
    assert [o["hm"] for o in dropped] == [15, 60]
    kept, _ = objects.place_buildings(
        p, {"minArea": 1, "tiers": True}, rows[1:2], stacked, no_clear
    )
    assert [o["hm"] for o in kept] == [15, 60, 90]


def _rect(w: float, d: float, x: float = 0.0, y: float = 0.0):
    return shapely.box(x, y, x + w, y + d)


def test_implausible_footprints_are_tall_specks_with_nothing_to_say_what_they_are():
    speck = {"id": "t", "class": None, "height": 22.1, "has_parts": False}
    # Alamo Square's "apartment block": 45 m², 5.7 m wide, 22 m tall
    assert objects.footprint_width(_rect(5.7, 7.9)) == pytest.approx(5.7)
    assert objects.implausible_footprint(speck, _rect(5.7, 7.9), {})
    for keep in (
        {"class": "apartments"},  # a class says it's a building
        {"subtype": "civic"},
        {"names": {"primary": "Conservatory of Flowers"}},
        {"has_parts": True},  # mapped in parts: someone modelled it
        {"height": 4.0},  # a restroom or a kiosk
        {"height": 12.0},  # under 2.5 times its width
        {"height": None},  # no stated height: drawn at a plausible default
    ):
        assert not objects.implausible_footprint(speck | keep, _rect(5.7, 7.9), {}), keep
    assert not objects.implausible_footprint(speck, _rect(12, 20), {})  # 240 m²: not a speck
    assert objects.implausible_footprint(speck | {"height": None, "num_floors": 7}, _rect(5, 7), {})
    # the spec can loosen or tighten the rule
    assert objects.implausible_footprint(
        speck | {"height": 12.0}, _rect(5.7, 7.9), {"minAspect": 2}
    )
    assert not objects.implausible_footprint(speck, _rect(5.7, 7.9), {"maxArea": 40})


def test_place_buildings_drops_tall_specks_in_parks_only(monkeypatch):
    p = _placement(monkeypatch)
    lon0, lat0 = -115.193, 36.004

    def box(lon, lat, dlon, dlat):
        return shapely.box(lon, lat, lon + dlon, lat + dlat)

    def speck(rid, lon, lat, **kw):
        # about 6 × 7 m, 22 m tall
        row = {"id": rid, "class": None, "height": 22.0, "has_parts": False}
        return row | {"geometry": box(lon, lat, 0.00007, 0.00006).wkt} | kw

    rows = [
        speck("tree", lon0 + 0.0005, lat0 + 0.0005),  # in the park
        speck("tower", lon0 + 0.003, lat0 + 0.0005),  # the same, outside the park
        speck("kiosk", lon0 + 0.0010, lat0 + 0.0010, height=3.5),
        speck("named", lon0 + 0.0015, lat0 + 0.0015, names={"primary": "Bell tower"}),
        speck("museum", lon0 + 0.0002, lat0 + 0.0002, height=20.0, **{"class": "museum"}),
    ]
    park = p.project(box(lon0, lat0, 0.002, 0.002))
    spec = {"minArea": 15}
    stats: dict = {}
    out, _ = objects.place_buildings(
        p, spec, rows, [], lambda x, y: False, stats=stats, parks=[park]
    )
    kept = {o["s"] for o in out}
    assert kept == {objects._stable_int(r) for r in ("tower", "kiosk", "named", "museum")}
    assert stats == {"implausible": 1}
    # without parks, or with the rule off, every footprint stays
    out, _ = objects.place_buildings(p, spec, rows, [], lambda x, y: False)
    assert len(out) == 5
    off = spec | {"implausible": None}
    out, _ = objects.place_buildings(p, off, rows, [], lambda x, y: False, parks=[park])
    assert len(out) == 5


def test_park_polygons_come_from_the_lawn_classes_or_the_rule_or_a_default(monkeypatch):
    calls = []

    def land_use(release, box, classes):
        calls.append((box, tuple(classes)))
        lon, lat = box[0] + 0.001, box[1] + 0.001
        return [
            {
                "id": f"p{len(calls)}",
                "geometry": shapely.box(lon, lat, lon + 0.001, lat + 0.001).wkt,
            }
        ]

    monkeypatch.setattr(objects.overture, "land_use", land_use)
    region = Region.from_dict(SPEC | {"sources": {"overture": {"release": "r"}}})
    boxes = [[-115.2, 36.0, -115.195, 36.005], [-115.195, 36.005, -115.19, 36.01]]
    parks = objects.park_polygons(region, {}, boxes)
    assert len(parks) == 2 and all(pk.area > 1000 for pk in parks)  # projected metres
    assert calls[0] == (tuple(boxes[0]), tuple(objects.PARK_LAND_USE))
    lawn = Region.from_dict(
        SPEC
        | {
            "sources": {"overture": {"release": "r"}},
            "ground": {"lawn": {"landUse": ["park", "golf_course"]}},
        }
    )
    objects.park_polygons(lawn, {}, boxes[:1])
    assert calls[-1][1] == ("park", "golf_course")
    objects.park_polygons(lawn, {"implausible": {"landUse": ["cemetery"]}}, boxes[:1])
    assert calls[-1][1] == ("cemetery",)
    assert objects.park_polygons(lawn, {"implausible": None}, boxes) is None


def test_objects_file_is_written_compressed_and_hashed(tmp_path):
    z = np.zeros((4, 4), dtype=np.int16)
    m = write_package(
        tmp_path,
        world_id="t",
        name="T",
        base=z,
        shape=z.astype(np.uint8),
        surface=z.astype(np.uint8),
        water=np.full_like(z, NO_WATER),
        chunk_size=4,
        scale={"metersPerCell": 20, "metersPerStep": 3, "elevationDatumMeters": 0},
        surfaces={0: "none"},
        style="s",
        attribution=[],
        render={"scale": 0.125},
        objects=[
            {"g": "tree", "x": 1.5, "y": 2.5, "s": 7},
            {
                "g": "building",
                "x": 2.25,
                "y": 1.5,
                "s": 8,
                "fp": [[1.5, 1.0], [3.0, 1.0], [3.0, 2.0]],
            },
        ],
    )
    assert m["render"] == {"scale": 0.125}
    assert m["objects"]["count"] == 2 and m["objects"]["path"] == "objects.json.gz"
    blob = (tmp_path / "objects.json.gz").read_bytes()
    assert m["objects"]["sha256"] == hashlib.sha256(blob).hexdigest()
    data = json.loads(gzip.decompress(blob))
    # version 2: footprints in hundredths of a cell from the anchor
    assert data == {
        "version": 2,
        "instances": [
            {"g": "tree", "x": 1.5, "y": 2.5, "s": 7},
            {"g": "building", "x": 2.25, "y": 1.5, "s": 8, "fp": [[-75, -50], [75, -50], [75, 50]]},
        ],
    }
    again = write_package(
        tmp_path,
        world_id="t",
        name="T",
        base=z,
        shape=z.astype(np.uint8),
        surface=z.astype(np.uint8),
        water=np.full_like(z, NO_WATER),
        chunk_size=4,
        scale={"metersPerCell": 20, "metersPerStep": 3, "elevationDatumMeters": 0},
        surfaces={0: "none"},
        style="s",
        attribution=[],
        clean=True,
    )
    assert "objects" not in again and not (tmp_path / "objects.json.gz").exists()


def _none(xs, ys):
    return np.zeros(len(xs), dtype=bool)


def test_sidewalk_trees_stand_on_the_verge_where_the_canopy_map_has_trees():
    region = Region.from_dict(
        SPEC | {"widths": {"scale": 1.5, "minCells": 0.1}, "snap": {"roads": {"deviation": 1.0}}}
    )
    cx, cy = region.cells
    p = objects.Placement(region, np.zeros((cy, cx), dtype=bool))
    # a street running north–south 0.2 cells west of its drawn axis (x = 10.5),
    # crossed by another at y = 30.5
    ns = (np.array([10.3, 10.3]), np.array([2.0, 40.0]))
    ew = (np.array([2.0, 30.0]), np.array([30.5, 30.5]))
    streets = [("a", 3, [ns]), ("b", 3, [ew])]
    rows = [{"id": "a", "class": "residential"}, {"id": "b", "class": "residential"}]
    roads = objects.DrawnRoads(region, (cy, cx), streets, rows)
    sampled = []

    class FakeCanopy:
        # trees north of y = 20 cells only
        def sample(self, xs, ys, crs):
            sampled.append(np.column_stack([xs, ys]))
            return np.where(np.asarray(ys) > p.north - 20 * p.m, 6.0, 0.0)

    house = shapely.box(11.0, 5.0, 14.0, 6.0)  # its front on the east verge

    def in_house(x, y):
        return shapely.contains_xy(house, x, y)

    rule = {"group": "tree.street", "roads": ["residential"], "canopy": 3, "spacing": 10}
    out = objects.sidewalk_trees(p, rule, roads, _none, in_house, FakeCanopy())
    assert out == objects.sidewalk_trees(p, rule, roads, _none, in_house, FakeCanopy())
    xs = np.array([i["x"] for i in out])
    ys = np.array([i["y"] for i in out])
    on_ns = np.abs(xs - 10.5) < 1
    # rows on both sides of the drawn axis, off the asphalt, two per cell per side
    assert (xs[on_ns] < 10.5).sum() > 20 and (xs[on_ns] > 10.5).sum() > 20
    assert (roads.clearance(xs, ys) > 0).all()
    assert (ys[on_ns] < 20).all()  # only where the map has trees
    assert not in_house(xs, ys).any()
    near_junction = (np.abs(xs - 10.5) < 1.5) & (np.abs(ys - 30.5) < 1.5)
    assert not near_junction.any()
    # the canopy is read beside the real line (x = 10.3), not the drawn axis
    at = np.concatenate(sampled)
    sx, sy = (at[:, 0] - p.west) / p.m, (p.north - at[:, 1]) / p.m
    west = sx[(sx < 10.3) & (sy < 25)]
    verge = 10.5 - xs[xs < 10.5].max()
    assert abs(np.median(west) - (10.3 - verge)) < 0.05
    # no map, no trees; a landmark's clear zone keeps them away
    assert objects.sidewalk_trees(p, rule, roads, _none, in_house, None) == []

    def everywhere(x, y):
        return np.ones(len(x), dtype=bool)

    assert objects.sidewalk_trees(p, rule, roads, everywhere, in_house, FakeCanopy()) == []


def test_props_strung_across_a_street_hang_over_it_turned_across_it():
    region = Region.from_dict(SPEC)
    cx, cy = region.cells
    # every cell is road: props beside a road keep off it, props across it don't
    p = objects.Placement(region, np.ones((cy, cx), dtype=bool))
    rows = [
        {
            "id": "a",
            "class": "residential",
            "geometry": "LINESTRING (-115.195 36.001, -115.195 36.009)",
        },
        {
            "id": "b",
            "class": "residential",
            "geometry": "LINESTRING (-115.199 36.005, -115.191 36.005)",
        },
        {
            "id": "c",
            "class": "primary",
            "geometry": "LINESTRING (-115.198 36.002, -115.192 36.002)",
        },
    ]
    rule = {"group": "prop.lanterns", "roads": ["residential"], "across": True, "spacing": 40}
    out = objects.street_trees(p, rule, rows, _none, "t")
    assert out == objects.street_trees(p, rule, rows, _none, "t")
    assert objects.street_trees(p, rule | {"across": False}, rows, _none, "t") == []
    # one per step on each street's line (not a pair either side of it), turned across it
    (ax,), (ay,) = p.to_cells(
        *objects.transform_points("EPSG:4326", region.crs, [-115.195], [36.005])
    )
    ns = [i for i in out if abs(i["x"] - ax) < 0.5]
    ew = [i for i in out if abs(i["y"] - ay) < 0.5 and abs(i["x"] - ax) >= 0.5]
    assert len(ns) + len(ew) == len(out)
    assert len(ns) >= 15 and len(ew) >= 15  # about 890 m and 720 m at 40 m steps
    assert {i["r"] for i in ns} == {0} and {i["r"] for i in ew} == {1}
    assert all(i["g"] == "prop.lanterns" for i in out)
    # `bounds` keeps one stretch: here the north-south street near the crossing
    box = {"bounds": [-115.1951, 36.0035, -115.1949, 36.0065]}
    near = objects.street_trees(p, rule | box, rows, _none, "t")
    assert 5 <= len(near) <= 10
    assert all(abs(i["x"] - ax) < 0.5 and abs(i["y"] - ay) < 9 for i in near)
    # buildings and landmarks' clear zones keep them off
    assert objects.street_trees(p, rule, rows, lambda x, y: np.ones(len(x), dtype=bool), "t") == []


def test_streets_run_on_through_junctions_where_they_go_straight():
    # a street in three blocks, crossed by two others, bending 60° after the third where
    # nothing else meets it
    lines = [
        shapely.LineString([(0, 0), (100, 0)]),
        shapely.LineString([(100, 0), (200, 0)]),
        shapely.LineString([(200, 0), (300, 0)]),
        shapely.LineString([(100, -50), (100, 0)]),
        shapely.LineString([(100, 0), (100, 50)]),
        shapely.LineString([(200, 0), (200, 50)]),
        shapely.LineString([(300, 0), (350, 87)]),
    ]
    strokes = sorted(objects._strokes(lines), key=lambda c: -shapely.LineString(c).length)
    lengths = [round(shapely.LineString(c).length) for c in strokes]
    # the long street through both crossings and round its bend; the cross street
    # through the first crossing; the last stub alone
    assert lengths == [400, 100, 50]
    assert {tuple(strokes[0][0]), tuple(strokes[0][-1])} == {(0.0, 0.0), (350.0, 87.0)}


def test_poles_stand_on_one_side_with_a_wire_from_each_to_the_next():
    region = Region.from_dict(SPEC)
    cx, cy = region.cells
    p = objects.Placement(region, np.ones((cy, cx), dtype=bool))
    rows = [
        {
            "id": "a",
            "class": "residential",
            "geometry": "LINESTRING (-115.195 36.001, -115.195 36.005)",
        },
        {
            "id": "b",
            "class": "residential",
            "geometry": "LINESTRING (-115.195 36.005, -115.195 36.009)",
        },
    ]
    rule = {
        "group": "prop.pole",
        "roads": ["residential"],
        "spacing": 30,
        "offset": 3,
        "wires": "prop.wire",
    }
    out = objects.wired_props(p, rule, rows, _none, "t")
    assert out == objects.wired_props(p, rule, rows, _none, "t")
    poles = [i for i in out if i["g"] == "prop.pole"]
    wires = [i for i in out if i["g"] == "prop.wire"]
    # one street of about 890 m (its two segments joined): a pole every 30 m, a wire
    # between each two
    assert len(poles) >= 28 and len(wires) == len(poles) - 1
    (sx,), _ = p.to_cells(*objects.transform_points("EPSG:4326", region.crs, [-115.195], [36.005]))
    m = region.meters_per_cell
    assert all(abs(abs(i["x"] - sx) * m - 3) < 0.2 for i in poles)  # 3 m off the line
    assert len({round(i["x"], 2) for i in poles}) == 1  # all on one side
    assert {i["r"] for i in poles} == {0}  # turned across a north-south street
    # each wire runs from one pole to the next
    ends = {(round(i["x"], 3), round(i["y"], 3)) for i in poles}
    for w in wires:
        a, b = (
            (round(w["ln"][0], 3), round(w["ln"][1], 3)),
            (round(w["ln"][2], 3), round(w["ln"][3], 3)),
        )
        assert a in ends and b in ends and len(w["fp"]) == 4
    # buildings keep poles off, and the wires to them go too
    assert objects.wired_props(p, rule, rows, lambda x, y: np.ones(len(x), dtype=bool), "t") == []


def test_canopy_trees_take_the_groups_of_their_cells_land_cover(monkeypatch):
    region = Region.from_dict(SPEC)
    cx, cy = region.cells
    lc = np.full((cy, cx), 50, dtype=np.uint8)  # built up
    lc[:, : cx // 2] = 10  # tree cover in the west half
    monkeypatch.setattr(objects.rasters, "landcover_cells", lambda r: lc)
    p = objects.Placement(region, np.zeros((cy, cx), dtype=bool))

    class FakeCanopy:
        def sample(self, xs, ys, crs):
            return np.full(len(xs), 9.0)

    rule = {
        "group": "tree",
        "canopy": 3,
        "spacing": 20,
        "byLandcover": {"tree": ["tree.cypress", "tree.eucalyptus"]},
    }
    out = objects.scatter(p, rule, _none, "t", FakeCanopy())
    west = {i["g"] for i in out if i["x"] < cx // 2}
    east = {i["g"] for i in out if i["x"] >= cx // 2}
    assert west == {"tree.cypress", "tree.eucalyptus"} and east == {"tree"}
    with pytest.raises(ValueError, match="unknown land cover class"):
        objects.scatter(p, rule | {"byLandcover": {"trees": ["x"]}}, _none, "t", FakeCanopy())


def test_lowrise_blocks_cover_free_built_up_cells():
    built = np.zeros((6, 8), bool)
    built[1:5, 1:7] = True
    blocked = np.zeros_like(built)
    blocked[2, :] = True  # a road across
    fp = [[5.2, 3.2], [5.8, 3.2], [5.8, 4.4], [5.2, 4.4]]
    tower = {"g": "building.tower", "x": 5.5, "y": 3.5, "s": 1, "fp": fp}
    sign = {"g": "landmark.sign", "x": 1.5, "y": 4.5, "s": 2}
    taken = objects.taken_cells([tower, sign], built.shape)
    # the footprint's cells, and the cells round an object without one
    assert taken[3, 5] and taken[4, 5] and not taken[3, 4]
    assert taken[3:6, 0:3].all() and not taken[1, 1]
    mpc = np.full(built.shape, 400.0)
    out = objects.lowrise({"heightMeters": 9}, built, blocked, taken, mpc)
    cells = {(int(i["x"]), int(i["y"])) for i in out}
    free = built & ~blocked & ~taken
    assert cells == {(int(x), int(y)) for y, x in zip(*np.nonzero(free), strict=True)}
    assert len(out) == int(free.sum())
    i = next(i for i in out if (int(i["x"]), int(i["y"])) == (3, 1))
    assert i["g"] == "city.blocks" and i["hm"] == 9 and i["m"] == 400.0
    assert i["fp"] == [[3, 1], [4, 1], [4, 2], [3, 2]] and (i["x"], i["y"]) == (3.5, 1.5)
    # seeds depend on the cell alone, so rebuilding gives the same blocks
    again = objects.lowrise({}, built, blocked, taken)
    assert [a["s"] for a in again] == [a["s"] for a in out] and "m" not in again[0]
    assert again[0]["g"] == "city.blocks" and again[0]["hm"] == 8.0
