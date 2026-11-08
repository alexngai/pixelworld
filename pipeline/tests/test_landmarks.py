"""Landmark registry (D-051): references expand to placed landmarks; landmarks
replace the buildings they stand for; line landmarks place their parts."""

import numpy as np
import pytest
import yaml

from pixelworld_pipeline import landmarks, objects
from pixelworld_pipeline.region import Region

SPEC = {
    "id": "lm",
    "name": "Landmarks",
    "bounds": [-115.2, 36.0, -115.19, 36.01],
    "metersPerCell": 20,
    "style": "s",
    "start": {"lon": -115.195, "lat": 36.005},
    "sources": {},
}


@pytest.fixture
def registry(tmp_path):
    root = tmp_path / "worlds"
    (root / "_landmarks").mkdir(parents=True)
    (root / "_landmarks" / "tower.yaml").write_text(
        yaml.safe_dump(
            {
                "name": "A Tower",
                "anchor": {"lon": -115.195, "lat": 36.005},
                "height": 120,
                "clear": 20,
                "replaces": ["A Tower"],
                "depictions": {
                    "generic": {"group": "landmark.tower.observation"},
                    "stylized": {"group": "landmark.tower.observation.stylized"},
                },
            }
        )
    )
    (root / "_landmarks" / "dam.yaml").write_text(
        yaml.safe_dump(
            {
                "line": [[-115.198, 36.003], [-115.192, 36.003]],
                "crest": 300,
                "thickness": 20,
                "bulge": 0.1,
                "parts": [
                    {"group": "landmark.dam.intake", "along": 0.25, "offset": 60, "aboveCrest": 5}
                ],
                "depictions": {"generic": {"group": "landmark.dam"}},
            }
        )
    )
    (root / "r").mkdir()
    return root


def _region(root, objs):
    path = root / "r" / "region.yaml"
    path.write_text(yaml.safe_dump(SPEC | {"objects": objs}))
    return Region.load(path)


def test_references_expand_with_the_chosen_depiction_and_overrides(registry):
    r = _region(registry, {"landmarks": ["tower", {"id": "dam", "clear": 99}]})
    tower, dam = r.objects["landmarks"]
    assert tower["group"] == "landmark.tower.observation" and tower["hm"] == 120
    assert tower["replaces"] == ["A Tower"] and tower["lon"] == -115.195
    assert dam["line"] == [[-115.198, 36.003], [-115.192, 36.003]] and dam["clear"] == 99
    assert dam["crestMeters"] == 300 and dam["thicknessM"] == 20 and dam["bulge"] == 0.1
    styl = _region(registry, {"landmarks": ["tower", "dam"], "landmarkDepiction": "stylized"})
    assert styl.objects["landmarks"][0]["group"] == "landmark.tower.observation.stylized"
    assert styl.objects["landmarks"][1]["group"] == "landmark.dam"  # no stylized: generic
    inline = {"group": "landmark.sign", "lon": -115.19, "lat": 36.0}
    assert _region(registry, {"landmarks": [inline]}).objects["landmarks"] == [inline]


def test_registry_entries_are_validated(registry):
    (registry / "_landmarks" / "bad.yaml").write_text(
        yaml.safe_dump({"anchor": {"lon": 0, "lat": 0}})
    )
    with pytest.raises(landmarks.LandmarkError, match="generic"):
        _region(registry, {"landmarks": ["bad"]})
    with pytest.raises(landmarks.LandmarkError, match="no landmark"):
        _region(registry, {"landmarks": ["missing"]})


def test_landmarks_replace_buildings_by_name_or_id():
    rows = [
        {"id": "a", "names": {"primary": "A Tower"}},
        {"id": "b", "names": {"primary": "Other"}},
        {"id": "c", "names": None},
    ]
    skip = {"a tower", "c"}
    assert [objects.replaced_by_landmark(r, skip) for r in rows] == [True, False, True]
    assert not objects.replaced_by_landmark(rows[0], set())


def test_line_landmarks_place_parts_upstream_with_their_crest(registry):
    r = _region(registry, {"landmarks": ["dam"]})
    blocked = np.zeros(r.cells[::-1], dtype=bool)
    out, counts = objects.place(r, blocked, [], heights=lambda x, y, m: m / 10.0)
    assert counts == {"landmark.dam": 1, "landmark.dam.intake": 1}
    dam = next(i for i in out if i["g"] == "landmark.dam")
    tower = next(i for i in out if i["g"] == "landmark.dam.intake")
    assert dam["top"] == 30.0 and tower["top"] == 30.5  # crest + 5 m
    # the line runs west → east, so upstream (where the dam bows) is to the north: smaller y
    assert tower["y"] < dam["y"] - 2.0
    fp = np.asarray(dam["fp"])
    assert fp[:, 1].min() < dam["y"] - 0.5  # bows the same way


def test_lidar_massing_finds_podium_and_towers():
    import shapely
    from rasterio.transform import Affine

    from pixelworld_pipeline.sources.lidar import HeightGrid

    # a 120 × 80 m complex: a 20 m podium with a 40 × 40 m, 110 m tower
    res = 4.0
    heights = np.zeros((40, 50))
    heights[5:25, 5:35] = 20.0
    heights[10:20, 10:20] = 110.0
    grid = HeightGrid(heights, np.ones_like(heights, bool), Affine(res, 0, 0, 0, -res, 160), res)
    footprint = shapely.box(20, 60, 140, 140)  # columns 5..35, rows 5..25
    podium, towers = objects.lidar_massing(footprint, grid, None, {})
    assert podium == 20.0 and len(towers) == 1
    poly, h = towers[0]
    assert h == 110.0 and 1200 < poly.area < 2000
    # a trusted Overture height wins; a far-too-low one doesn't
    assert objects.lidar_massing(footprint, grid, 100.0, {}) is None
    assert objects.lidar_massing(footprint, grid, 13.8, {}) is not None
    # outside the survey: keep Overture
    nowhere = HeightGrid(heights, np.zeros_like(heights, bool), grid.transform, res)
    assert objects.lidar_massing(footprint, nowhere, None, {}) is None


def test_canopy_rule_keeps_points_where_trees_stand():
    region = Region.from_dict(SPEC)
    blocked = np.zeros(region.cells[::-1], dtype=bool)
    p = objects.Placement(region, blocked)

    class FakeCanopy:
        # trees (8 m) only in the west half of the region
        def sample(self, xs, ys, crs):
            return np.where(np.asarray(xs) < p.west + 450.0, 8.0, 0.0)

    rule = {"group": "tree", "canopy": 3, "spacing": 15}
    out = objects.scatter(p, rule, lambda xs, ys: np.zeros(len(xs), bool), "t", FakeCanopy())
    assert out and all(i["x"] * p.m < 450.0 + 15 for i in out)
    none = objects.scatter(p, rule, lambda xs, ys: np.zeros(len(xs), bool), "t", None)
    assert none == []


def test_hero_bakes_and_paints_are_packaged_and_refreshed(registry, tmp_path):
    import json

    from pixelworld_pipeline.build import refresh_heroes
    from pixelworld_pipeline.world_format import package_hash

    lm_root = registry / "_landmarks"
    text = (lm_root / "tower.yaml").read_text()
    (lm_root / "tower.yaml").write_text(text + "hero: true\n")
    hero = lm_root / "tower" / "hero" / "lm"
    paint = lm_root / "tower" / "paint" / "lm"
    hero.mkdir(parents=True)
    paint.mkdir(parents=True)
    meta = {"left": -12, "top": 40, "width": 3, "height": 9, "depthBase": 81.5}
    for r in (0, 1):
        (hero / f"r{r}.png").write_bytes(b"bake%d" % r)
        (hero / f"r{r}.json").write_text(json.dumps(meta))
    (paint / "r0.png").write_bytes(b"paint0")  # r1 has no paint yet: not packaged

    region = _region(registry, {"landmarks": ["tower"]})
    assert region.objects["landmarks"][0]["hero"] is True
    spec_path = registry / "r" / "region.yaml"
    out = tmp_path / "pkg"
    out.mkdir()
    (out / "manifest.json").write_text(json.dumps({"id": "lm", "packageHash": "old"}))
    (out / "build-report.json").write_text(json.dumps({"packageHash": "old"}))

    heroes = refresh_heroes(spec_path, out)
    assert heroes == [
        {
            "id": "tower",
            "rotation": 0,
            "left": -12,
            "top": 40,
            "width": 3,
            "height": 9,
            "depthBase": 81.5,
            "bake": "heroes/tower/bake-r0.png",
            "paint": "heroes/tower/paint-r0.png",
            "sha256": heroes[0]["sha256"],
        }
    ]
    assert (out / "heroes" / "tower" / "paint-r0.png").read_bytes() == b"paint0"
    manifest = json.loads((out / "manifest.json").read_text())
    assert manifest["heroes"] == heroes
    assert manifest["packageHash"] == package_hash(manifest) != "old"
    report = json.loads((out / "build-report.json").read_text())
    assert report["packageHash"] == manifest["packageHash"]

    # an artist's new paint changes the package hash; removing the files unpackages the hero
    (paint / "r0.png").write_bytes(b"paint0, touched up")
    assert refresh_heroes(spec_path, out)[0]["sha256"] != heroes[0]["sha256"]
    for f in [*hero.iterdir(), *paint.iterdir()]:
        f.unlink()
    assert refresh_heroes(spec_path, out) == []
    assert "heroes" not in json.loads((out / "manifest.json").read_text())
    assert not (out / "heroes").exists()


def test_bridges_turn_to_the_grid_with_their_road_and_keep_their_foot(registry):
    import math

    lm_root = registry / "_landmarks"
    # a bridge about 10° off north, like the Golden Gate
    (lm_root / "span.yaml").write_text(
        yaml.safe_dump(
            {
                "line": [[-115.1955, 36.0015], [-115.1945, 36.0085]],
                "crest": 60,
                "base": 0,
                "thickness": 20,
                "bulge": 0,
                "snap": True,
                "depictions": {"generic": {"group": "landmark.bridge.suspension"}},
            }
        )
    )
    for snap in (None, {"roads": {"angle": 16}}):
        path = registry / "r" / "region.yaml"
        extra = {"snap": snap} if snap else {}
        path.write_text(yaml.safe_dump(SPEC | {"objects": {"landmarks": ["span"]}} | extra))
        r = Region.load(path)
        blocked = np.zeros(r.cells[::-1], dtype=bool)
        out, _ = objects.place(r, blocked, [], heights=lambda x, y, m: m / 10.0)
        bridge = out[0]
        fp = np.asarray(bridge["fp"])
        # the band's long direction
        d = fp[len(fp) // 2 - 1] - fp[0]
        angle = math.degrees(math.atan2(d[0], -d[1]))  # 0 = north
        if snap is None:
            assert 5 < abs(angle) < 15
        else:
            assert abs(angle) < 0.5
            assert bridge["z0"] == 0.0 and bridge["top"] == 6.0


def test_snapped_bridges_lie_on_the_road_they_carry(registry):
    (registry / "_landmarks" / "span.yaml").write_text(
        yaml.safe_dump(
            {
                "line": [[-115.1955, 36.0015], [-115.1945, 36.0085]],
                "crest": 60,
                "thickness": 20,
                "bulge": 0,
                "snap": True,
                "depictions": {"generic": {"group": "landmark.bridge.suspension"}},
            }
        )
    )
    path = registry / "r" / "region.yaml"
    path.write_text(
        yaml.safe_dump(
            SPEC | {"objects": {"landmarks": ["span"]}, "snap": {"roads": {"angle": 16}}}
        )
    )
    r = Region.load(path)
    blocked = np.zeros(r.cells[::-1], dtype=bool)
    alone, _ = objects.place(r, blocked, [])
    x0 = float(np.asarray(alone[0]["fp"])[:, 0].mean())
    road = [("r", 1, [(np.array([x0 + 1.5, x0 + 1.5]), np.array([0.0, 100.0]))])]
    on_road, _ = objects.place(r, blocked, [], streets=road)
    assert abs(float(np.asarray(on_road[0]["fp"])[:, 0].mean()) - (x0 + 1.5)) < 0.05
    # a road snapping left slanted: the bridge follows it, piece by piece
    ys = np.array([0.0, 100.0])
    slanted = [("r", 1, [(x0 + 0.1 * (ys - 50.0), ys)])]
    on_slant, _ = objects.place(r, blocked, [], streets=slanted)
    for piece in on_slant:
        c = np.asarray(piece["fp"]).mean(axis=0)
        assert abs(c[0] - (x0 + 0.1 * (c[1] - 50.0))) < 0.05


def test_water_under_a_bridge_deck_stays_water():
    from pixelworld_pipeline.build import bridge_decks_over_water

    wet = np.zeros((10, 10), dtype=bool)
    wet[:, 4:] = True  # the shore at x = 4
    instances = [
        {"g": "landmark.bridge.suspension", "fp": [[2.0, 3.0], [8.0, 3.0], [8.0, 4.0], [2.0, 4.0]]},
        {"g": "building.house", "fp": [[0.0, 0.0], [9.0, 0.0], [9.0, 9.0], [0.0, 9.0]]},
    ]
    under = bridge_decks_over_water(instances, wet, (10, 10))
    assert np.argwhere(under).tolist() == [[3, 4], [3, 5], [3, 6], [3, 7]]
    # the road it carries, stepping beside the deck over the water, goes too; roads on land stay
    road = np.zeros((10, 10), dtype=bool)
    road[5, 2:9] = True
    road[8, 6] = True  # a road over water, but too far from the deck
    under = bridge_decks_over_water(instances, wet, (10, 10), road)
    assert under[5, 4:8].all() and not under[5, 2:4].any() and not under[8, 6]
    # land cover taking the deck itself for land: a one-cell gap in the water still counts
    gap = wet.copy()
    gap[:, 6] = False
    under = bridge_decks_over_water(instances, gap, (10, 10))
    assert under[3, 6] and under[3, 4:8].all()


def test_micro_terrain_under_a_bridge_deck_is_flat_water():
    # a causeway across the water on row 4, a step above it; the cells under
    # the deck (x 2..7) turn back into water after micro-terrain is built
    from pixelworld_pipeline import micro
    from pixelworld_pipeline.build import S, water_under_decks
    from pixelworld_pipeline.gridify import cell_corner_heights
    from pixelworld_pipeline.roads import CONNECT_MASK, rasterize
    from pixelworld_pipeline.world_format import NO_WATER

    h, w, k = 8, 10, 4
    road = rasterize([("r", 1, [(np.array([0.5, 9.5]), np.array([4.5, 4.5]))])], (h, w))
    on_road = (road.mask & CONNECT_MASK) != 0
    base = np.where(on_road, 1, 0).astype(np.int16)
    shape = np.zeros((h, w), dtype=np.uint8)
    water = np.where(on_road, NO_WATER, 0).astype(np.int16)
    surface = np.where(on_road, S["urban"], S["water"]).astype(np.uint8)
    hw = np.where(on_road, 13, 0).astype(np.uint8)  # 0.4 cells either side
    seabed = np.full((h * k + 1, w * k + 1), -8.0)  # metres, at 2 m per step
    mc = micro.build_micro(seabed, 2.0, k, base, shape, water, road.mask, hw / 32.0)
    low = cell_corner_heights(base, shape).min(axis=0)
    under = np.zeros((h, w), dtype=bool)
    under[4, 2:8] = True
    inside = (slice(4 * k + 1, 5 * k), slice(2 * k + 1, 8 * k))  # micro-corners within them
    assert (mc[inside] == k).all()  # the road bed, which showed through as streaks

    base, shape, water, surface, (mc2, k2) = water_under_decks(
        under, base, shape, water, surface, low, road, hw, (mc, k)
    )
    assert k2 == k and mc2.dtype == np.int16
    assert (water[under] == 0).all() and (surface[under] == S["water"]).all()
    assert not road.mask[under].any() and not hw[under].any()
    # flat at the water level, like every other water cell
    assert (mc2[4 * k : 5 * k + 1, 2 * k : 8 * k + 1] == 0).all()
    assert (mc2[: 4 * k + 1] == 0).all() and (mc2[5 * k :] == 0).all()
    # the road on either shore keeps its bed (the edges it shares with water are water's)
    for x0, x1 in ((0, 2), (8, 10)):
        bed = (slice(4 * k + 1, 5 * k), slice(x0 * k + 1, x1 * k - 1))
        assert (mc2[bed] == mc[bed]).all() and (mc2[bed] == k).all()
