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
