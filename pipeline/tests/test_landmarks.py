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
