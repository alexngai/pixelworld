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


def test_class_rules_match_codes_exactly_or_by_prefix():
    insts = _row(1.0, 5)
    facts = [
        {"year": 1895, "stories": 4, "use": "residential", "class": "A4"},
        {"year": 1910, "stories": 5, "use": "residential", "class": "C7"},
        {"year": 1925, "stories": 6, "use": "residential", "class": "C"},
        {"year": 1930, "stories": 3, "use": "residential", "class": "A40"},
        {
            "year": 1930,
            "stories": 3,
            "use": "residential",
            "class": 4,
        },  # a number, as YAML reads it
    ]
    spec = {
        "rules": [
            {"group": "building.rowhouse.brownstone", "classes": ["A4", "B1"]},
            {"group": "building.tenement", "classes": ["C*"]},
            {"group": "building.house", "classes": [4]},
        ]
    }
    f = typology.features(insts, STREET, None, 25.0, facts)
    assert [g["class"] for g in f] == ["A4", "C7", "C", "A40", "4"]
    counts = typology.classify(insts, spec, f)
    assert [i["g"] for i in insts] == [
        "building.rowhouse.brownstone",
        "building.tenement",
        "building.tenement",  # "C*" also matches "C" itself
        "building.residential",  # A40 is neither A4 nor a C
        "building.house",
    ]
    assert counts == {
        "building.rowhouse.brownstone": 1,
        "building.tenement": 2,
        "building.house": 1,
    }
    assert typology.class_matches(["*"], "Z") and not typology.class_matches(["*"], "")
    # without facts there is no class to match
    bare = _row(1.0, 1)
    assert not typology.classify(bare, spec, typology.features(bare, STREET, None, 25.0))


def test_roof_rules_use_the_facts_roof_else_overtures():
    insts = _row(1.0, 4)
    insts[0]["_roof"] = "mansard"  # Overture's, any shape (rs only holds the drawable ones)
    insts[1]["rs"] = "gabled"
    insts[2]["_roof"] = "flat"  # the facts say otherwise: they win
    facts = [None, None, {"year": 1870, "roof": "mansard"}, None]
    f = typology.features(insts, STREET, None, 25.0, facts)
    assert [g.get("roof") for g in f] == ["mansard", "gabled", "mansard", None]
    spec = {
        "rules": [
            {"group": "building.apartment.haussmann", "roofs": ["mansard"]},
            {"group": "building.house", "roofs": ["gabled", "hipped"]},
        ]
    }
    typology.classify(insts, spec, f)
    assert [i["g"] for i in insts] == [
        "building.apartment.haussmann",
        "building.house",
        "building.apartment.haussmann",
        "building.residential",  # no roof shape known: no roof rule matches
    ]


def test_material_rules_match_the_facts_material_in_any_case():
    insts = _row(1.0, 3)
    facts = [
        {"year": 1855, "stories": 4, "use": "residential", "material": "Brownstone"},
        {"year": 1870, "stories": 5, "use": "commercial", "material": "Cast Iron"},
        {"year": 1880, "stories": 4, "use": "residential"},
    ]
    spec = {
        "rules": [
            {"group": "building.brownstone", "materials": ["brownstone"]},
            {"group": "building.loft.castiron", "materials": ["Cast Iron"]},
        ]
    }
    f = typology.features(insts, STREET, None, 25.0, facts)
    assert [g["material"] for g in f] == ["Brownstone", "Cast Iron", ""]
    typology.classify(insts, spec, f)
    assert [i["g"] for i in insts] == [
        "building.brownstone",
        "building.loft.castiron",
        "building.residential",  # no material: no material rule matches
    ]


def test_parts_share_their_buildings_class_and_roof():
    insts = _row(1.0, 2)
    for inst in insts:
        inst["_grp"] = "tower"
        inst["g"] = "building.tower"
        inst["_roof"] = "flat"
    facts = [{"year": 1931, "class": "O4"}, None]
    f = typology.features(insts, STREET, None, 25.0, facts)
    assert all(g["parts"] and g["class"] == "O4" and g["roof"] == "flat" for g in f)
    typology.classify(
        insts,
        {
            "rules": [
                {"group": "building.tower.deco", "from": ["building.tower"], "classes": ["O*"]}
            ]
        },
        f,
    )
    assert {i["g"] for i in insts} == {"building.tower.deco"}


def test_use_group_takes_normalized_uses_as_they_are():
    for word in typology.USE_GROUPS:
        assert typology.use_group(word) == word
        assert typology.use_group(word.capitalize()) == word
    assert typology.use_group("Government") == "civic"
    assert typology.use_group("") == "" and typology.use_group(None) == ""


def test_bounds_rules_keep_to_a_neighbourhoods_box_and_max_depth_to_small_lots():
    insts = _row(1.0, 3)
    f = typology.features(insts, STREET, None, 25.0)
    # centroids in lon/lat, as type_buildings adds them where a rule has bounds
    for g, ll in zip(f, [(139.70, 35.66), (139.69, 35.69), (139.75, 35.70)], strict=True):
        g["lonlat"] = ll
    spec = {
        "rules": [
            {"group": "building.zakkyo", "bounds": [139.695, 35.655, 139.705, 35.665]},
            {
                "group": "building.tower.glass",
                "bounds": [[139.0, 35.0, 139.1, 35.1], [139.686, 35.685, 139.698, 35.695]],
            },
            {"group": "building.kodate", "maxDepth": 19.0},
        ]
    }
    typology.classify(insts, spec, f)
    # the third is outside both boxes, and 20 m deep
    assert [i["g"] for i in insts] == [
        "building.zakkyo",
        "building.tower.glass",
        "building.residential",
    ]
    assert not typology.matches(
        {"group": "x", "bounds": [0, 0, 1, 1]}, "building.residential", {"floors": 1}
    )


def test_a_sliver_footprint_still_has_its_storeys_for_rules_that_dont_ask():
    """A footprint too thin for a rectangle keeps its floors, so a rule by kind can retype it."""
    sliver = {
        "g": "building.residential",
        "x": 1.0,
        "y": 1.0,
        "s": 1,
        "fp": [[1.0, 1.0], [1.5, 1.0], [1.0, 1.0]],
        "hm": 9.6,
        "_cls": "school",
    }
    f = typology.features([sliver], STREET, None, 25.0)
    assert f[0]["floors"] == 3
    counts = typology.classify(
        [sliver], {"rules": [{"group": "building.civic", "kinds": ["school"]}]}, f
    )
    assert counts == {"building.civic": 1} and sliver["fl"] == 3
