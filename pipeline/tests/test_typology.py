"""Building typologies (D-055): geometry features, facts and rules."""

import numpy as np

from pixelworld_pipeline import typology


def _row(x0: float, n: int, width: float = 0.3, depth: float = 0.8, y0: float = 1.0):
    """n attached houses along +x, fronts on a street along y = y0 - 0.5 (cells)."""
    out = []
    for k in range(n):
        x = x0 + k * width
        out.append(
            {
                "g": "building.residential",
                "x": x + width / 2,
                "y": y0 + depth / 2,
                "fp": [[x, y0], [x + width, y0], [x + width, y0 + depth], [x, y0 + depth]],
                "hm": 9.0,
                "_grp": f"b{k}",
            }
        )
    return out


STREET = [("s", 1, [(np.array([0.0, 10.0]), np.array([0.5, 0.5]))])]
CROSS = [("c", 1, [(np.array([0.5, 0.5]), np.array([0.0, 5.0]))])]


def test_row_houses_share_walls_and_face_their_street():
    insts = _row(1.0, 4)
    f = typology.features(insts, STREET, None, 25.0)
    # 0.3 cell × 25 m = 7.5 m wide, 20 m deep
    assert abs(f[1]["width"] - 7.5) < 1e-6 and abs(f[1]["depth"] - 20.0) < 1e-6
    # middle houses share both long sides; end houses one
    assert f[1]["party"] > 0.5 and 0.2 < f[0]["party"] < 0.5
    # the street lies at smaller y: the front faces -y (octant 6)
    assert {g["front"] for g in f} == {6}
    assert not f[1]["corner"]


def test_corner_lots_and_water():
    insts = _row(1.0, 2)
    water = np.zeros((10, 10), dtype=bool)
    f = typology.features(insts, STREET + CROSS, water, 25.0)
    assert f[0]["corner"] and not f[1]["corner"]
    insts = _row(0.5, 2, width=0.6)  # cells 0 and 1 of row 1
    water[1, 0] = True
    f = typology.features(insts, STREET, water, 25.0)
    assert f[0]["onWater"] and not f[1]["onWater"]


def test_rules_use_facts_and_first_match_wins():
    insts = _row(1.0, 3)
    facts = [
        {"year": 1895, "stories": 3, "use": "Single Family Residential", "hood": "Haight Ashbury"},
        {"year": 1938, "stories": 2, "use": "Single Family Residential", "hood": "Sunset/Parkside"},
        None,
    ]
    spec = {
        "rules": [
            {
                "group": "building.rowhouse.victorian",
                "year": [1840, 1906],
                "uses": ["residential"],
                "maxWidth": 12,
            },
            {
                "group": "building.rowhouse.stucco",
                "year": [1920, 1960],
                "hoods": ["Sunset/Parkside"],
            },
            {"group": "building.house", "maxWidth": 12},
        ]
    }
    f = typology.features(insts, STREET, None, 25.0, facts)
    counts = typology.classify(insts, spec, f)
    assert [i["g"] for i in insts] == [
        "building.rowhouse.victorian",
        "building.rowhouse.stucco",
        "building.house",  # no facts: only geometry rules can match
    ]
    assert counts == {
        "building.rowhouse.victorian": 1,
        "building.rowhouse.stucco": 1,
        "building.house": 1,
    }
    assert insts[0]["yr"] == 1895 and insts[0]["fl"] == 3 and insts[0]["fr"] == 6
    assert "yr" not in insts[2] and insts[2]["fl"] == 3  # 9 m tall → 3 floors


def test_rules_only_replace_generic_groups_unless_told():
    insts = _row(1.0, 1)
    insts[0]["g"] = "building.tower"
    f = typology.features(
        insts, STREET, None, 25.0, [{"year": 1928, "stories": 30, "use": "Commercial Office"}]
    )
    typology.classify(
        insts, {"rules": [{"group": "building.commercial.historic", "year": [1880, 1950]}]}, f
    )
    assert insts[0]["g"] == "building.tower"
    typology.classify(
        insts, {"rules": [{"group": "building.tower.deco", "from": ["building.tower"]}]}, f
    )
    assert insts[0]["g"] == "building.tower.deco"
    assert typology.use_group("Commercial Office") == "commercial"
    assert typology.use_group("Miscellaneous/Mixed-Use") == "mixed"


def test_parts_take_their_buildings_year_and_only_explicit_rules():
    # a podium and two tower parts of one building; only the podium's centroid is on a lot
    insts = _row(1.0, 3)
    for k, inst in enumerate(insts):
        inst["_grp"] = "russ"
        inst["g"] = "building.commercial" if k == 0 else "building.tower"
        inst["hm"] = 15.0 if k == 0 else 80.0 + 40 * k
    facts = [{"year": 1927, "stories": 31, "use": "Commercial Office", "hood": "FiDi"}, None, None]
    f = typology.features(insts, STREET, None, 25.0, facts)
    assert all(g["parts"] and g["year"] == 1927 for g in f)
    assert [g["floors"] for g in f] == [5, 38, 50]
    assert "width" not in f[1] and "front" not in f[1]
    spec = {
        "rules": [
            {"group": "building.commercial.historic", "year": [1880, 1950]},
            {"group": "building.tower.deco", "from": ["building.tower"], "year": [1906, 1950]},
        ]
    }
    counts = typology.classify(insts, spec, f)
    # the podium matches no generic rule; both towers are deco, with their own storeys
    assert [i["g"] for i in insts] == [
        "building.commercial",
        "building.tower.deco",
        "building.tower.deco",
    ]
    assert counts == {"building.tower.deco": 2}
    assert insts[1]["yr"] == 1927 and insts[2]["fl"] == 50 and "fr" not in insts[1]
