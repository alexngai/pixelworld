"""Scale levels (D-046, D-047): level specs, focus scale, depiction, geo grid."""

import numpy as np
import pytest
import yaml

from pixelworld_pipeline import objects, server
from pixelworld_pipeline.layout import UniformLayout, WarpedLayout, WarpSpec, geo_positions
from pixelworld_pipeline.region import Region, RegionError
from pixelworld_pipeline.world_format import NO_WATER, decode_geo, write_package

SPEC = {
    "id": "lv",
    "name": "Levels",
    "bounds": [-115.4, 36.0, -114.9, 36.3],
    "metersPerCell": 400,
    "style": "desert-southwest",
    "start": {"lon": -115.17, "lat": 36.11},
    "sources": {
        "dem": {"kind": "usgs-3dep-1arcsec"},
        "landcover": {"kind": "esa-worldcover-2021"},
        "overture": {"release": "2026-10-21.0"},
        "roads": {"classes": ["primary"]},
    },
}
WARP = {
    "background": 500,
    "meshKm": 3,
    "focus": [
        {
            "name": "core",
            "lon": -115.17,
            "lat": 36.11,
            "radiusKm": 4,
            "falloffKm": 8,
            "metersPerCell": 125,
        }
    ],
}
LEVELS = [{"name": "fly", "world": "lv-fly"}, {"name": "drive", "world": "lv"}]


def test_levels_are_validated():
    r = Region.from_dict(SPEC | {"level": "drive", "levels": LEVELS})
    assert r.level == "drive" and [lv["world"] for lv in r.levels] == ["lv-fly", "lv"]
    with pytest.raises(RegionError):
        Region.from_dict(SPEC | {"level": "walk", "levels": LEVELS})
    with pytest.raises(RegionError):
        Region.from_dict(SPEC | {"levels": [{"name": "fly"}]})
    with pytest.raises(RegionError):
        Region.from_dict(SPEC | {"levels": LEVELS + [{"name": "fly", "world": "x"}]})


def test_focus_scale_coarsens_every_focus_area_and_keeps_old_digests():
    plain = WarpSpec.from_dict(WARP)
    assert WarpSpec.from_dict(WARP | {"focusScale": 1}).digest() == plain.digest()
    region = Region.from_dict(SPEC)
    coarse = WarpedLayout(region, WarpSpec.from_dict(WARP | {"background": 1000, "focusScale": 3}))
    f = coarse.warp.stats["focus"][0]
    assert f["target"] == pytest.approx(375) and abs(f["error"]) < 0.05
    assert coarse.cells[0] < WarpedLayout(region, plain).cells[0]


@pytest.mark.parametrize("warped", [False, True])
def test_geo_grid_matches_cell_positions(warped):
    region = Region.from_dict(SPEC)
    layout = WarpedLayout(region, WarpSpec.from_dict(WARP)) if warped else UniformLayout(region)
    lons, lats = layout.geo_grid(4)
    xs, ys = geo_positions(layout.cells, 4)
    assert lons.shape == (len(ys), len(xs)) and xs[-1] == layout.cells[0]
    # a grid point maps back to its own cell corner
    j, i = len(ys) // 2, len(xs) // 3
    cx, cy = layout.lonlat_to_cell([lons[j, i]], [lats[j, i]])
    assert cx[0] == pytest.approx(xs[i], abs=0.01) and cy[0] == pytest.approx(ys[j], abs=0.01)


def test_package_carries_level_siblings_and_the_geo_grid(tmp_path):
    z = np.zeros((4, 6), dtype=np.int16)
    lons = np.linspace(-115, -114, 4)[None, :].repeat(3, 0)
    lats = np.linspace(36.2, 36.0, 3)[:, None].repeat(4, 1)
    m = write_package(
        tmp_path,
        world_id="lv",
        name="L",
        base=z,
        shape=z.astype(np.uint8),
        surface=z.astype(np.uint8),
        water=np.full_like(z, NO_WATER),
        chunk_size=4,
        scale={"metersPerCell": 400, "metersPerStep": 60, "elevationDatumMeters": 0},
        surfaces={0: "none"},
        style="s",
        attribution=[],
        geo=(lons, lats, 2),
        level="drive",
        levels=LEVELS,
        depiction={"heightStretch": 1.5},
    )
    assert m["level"] == "drive" and m["levels"] == LEVELS
    assert m["depiction"] == {"heightStretch": 1.5}
    assert m["geo"]["step"] == 2 and m["geo"]["size"] == [4, 3]
    dl, dt = decode_geo((tmp_path / m["geo"]["path"]).read_bytes(), 4, 3)
    assert np.allclose(dl, lons, atol=1e-6) and np.allclose(dt, lats, atol=1e-6)


def test_manifest_depiction_carries_what_the_client_draws_by():
    from pixelworld_pipeline.build import manifest_depiction

    # only object scales (drawn in the pipeline): nothing for the client
    assert manifest_depiction({"buildings": {"scale": 2}, "landmarks": {"scale": 3}}) is None
    assert manifest_depiction({"heightStretch": 2, "scatter": 0.6}) == {
        "heightStretch": 2.0,
        "scatter": 0.6,
    }
    # a flying level caps the traffic's enlargement (D-060)
    assert manifest_depiction({"heightStretch": 2, "vehicleScale": 4}) == {
        "heightStretch": 2.0,
        "vehicleScale": 4.0,
    }


def _building(gid, x, y, half, hm, m=None):
    inst = {
        "g": "building.tower",
        "x": x,
        "y": y,
        "s": 1,
        "fp": [
            [x - half, y - half],
            [x + half, y - half],
            [x + half, y + half],
            [x - half, y + half],
        ],
        "hm": hm,
        "_grp": gid,
    }
    if m is not None:
        inst["m"] = m
    return inst


def _place(spec=None):
    region = Region.from_dict(SPEC | {"objects": spec or {}})
    return objects.Placement(region, np.zeros(region.cells[::-1], dtype=bool))


def test_depiction_scale_keeps_the_tallest_where_oversized_buildings_collide():
    p = _place()
    found = [
        _building("low", 10.0, 10.0, 0.2, 30),
        _building("tall", 10.6, 10.0, 0.2, 200),  # overlaps "low" once both double
        {**_building("tall", 10.7, 10.1, 0.05, 260), "g": "building.tower.part"},
        _building("far", 20.0, 10.0, 0.2, 50),
    ]
    same = objects.depict_buildings(p, [dict(i) for i in found], {})
    assert [{k: v for k, v in i.items() if k != "_grp"} for i in found] == same
    out = objects.depict_buildings(p, [dict(i) for i in found], {"scale": 2})
    assert {(i["g"], i["x"]) for i in out} == {
        ("building.tower", 10.6),
        ("building.tower.part", 10.8),  # moved with its building: 10.6 + 2 × 0.1
        ("building.tower", 20.0),
    }
    tall = next(i for i in out if i["x"] == 10.6)
    assert tall["fp"][0] == [10.2, 9.6] and tall["m"] == 200.0  # 400 m cells drawn 2×
    assert all("_grp" not in i for i in out)
    only_tall = objects.depict_buildings(p, [dict(i) for i in found], {"minHeightMeters": 100})
    assert {i["x"] for i in only_tall} == {10.6, 10.7}


def test_landmark_scale_draws_it_bigger_but_dams_keep_their_size():
    spec = {
        "depiction": {"landmarks": {"scale": 4}},
        "landmarks": [
            {"group": "landmark.tower.observation", "lon": -115.155, "lat": 36.147, "hm": 350},
            {"group": "landmark.sign", "lon": -115.17, "lat": 36.08, "scale": 2},
        ],
    }
    region = Region.from_dict(SPEC | {"objects": spec})
    out, _ = objects.place(region, np.zeros(region.cells[::-1], dtype=bool), [])
    assert [i["m"] for i in out] == [100.0, 200.0]


def test_editor_saves_only_a_warp_file_the_spec_owns(tmp_path):
    base = SPEC | {"warp": "warp.yaml"}
    (tmp_path / "region.yaml").write_text(yaml.safe_dump(base))
    (tmp_path / "warp.yaml").write_text(yaml.safe_dump(WARP))
    (tmp_path / "fly.yaml").write_text(
        "extends: region.yaml\nid: lv-fly\nwarp: { background: 1500, focusScale: 4 }\n"
    )
    assert server.Editor(tmp_path / "region.yaml", tmp_path).warp_file() == tmp_path / "warp.yaml"
    fly = server.Editor(tmp_path / "fly.yaml", tmp_path)
    assert fly.region.warp["focusScale"] == 4 and fly.region.warp["focus"][0]["name"] == "core"
    with pytest.raises(ValueError, match="doesn't own a warp file"):
        fly.warp_file()
