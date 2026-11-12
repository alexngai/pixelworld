"""The plugin registry: entry points, in-process registration, built-ins,
missing-plugin errors, and the raster and facts seams it serves."""

from dataclasses import dataclass, field

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from pixelworld_pipeline import facts, objects, plugins
from pixelworld_pipeline.region import Region
from pixelworld_pipeline.sources import rasters

SPEC = {
    "id": "plugin-test",
    "name": "Plugin test",
    "bounds": [-115.2, 36.0, -115.0, 36.2],
    "metersPerCell": 1000,
    "style": "s",
    "start": {"lon": -115.1, "lat": 36.1},
    "sources": {"dem": {"kind": "usgs-3dep-1arcsec"}, "landcover": {"kind": "esa-worldcover-2021"}},
}


@dataclass
class FakeDist:
    name: str


@dataclass
class FakeEntryPoint:
    """What the registry reads of an importlib.metadata.EntryPoint."""

    name: str
    value: str
    obj: object = None
    dist: FakeDist = field(default_factory=lambda: FakeDist("pixelworld-city-test"))

    def load(self):
        if self.obj is None:
            raise ImportError(f"No module named {self.value.split(':')[0]!r}")
        return self.obj


def installed(monkeypatch, group: str, *eps: FakeEntryPoint) -> None:
    real = plugins._entry_points

    def fake(g: str):
        return tuple(eps) if g == group else real(g)

    monkeypatch.setattr(plugins, "_entry_points", fake)


class Terrain(rasters.RasterSource):
    role = "terrain"
    native_m = 5.0
    attribution = {"name": "Test terrain", "license": "CC0", "url": "https://example.org"}

    def __init__(self, metres: float = 42.0):
        self.metres = metres

    def read_into(self, dst, transform, crs, bounds, overview, resampling, nodata):
        dst[:] = self.metres
        return []


# ---- the registry ---------------------------------------------------------------------------


def test_built_in_sources_resolve_and_are_listed():
    found = plugins.available(plugins.SOURCES)
    for kind in ("usgs-3dep-1arcsec", "usgs-3dep-13arcsec", "esa-worldcover-2021"):
        assert found[kind].origin == "builtin"
    dem = plugins.load(plugins.SOURCES, "usgs-3dep-13arcsec")
    assert dem is rasters.USGS_3DEP_13ARCSEC and dem.role == "terrain" and dem.native_m == 10.0
    assert rasters.source("esa-worldcover-2021", "landcover").role == "landcover"
    assert set(plugins.GROUPS) == {"pixelworld.facts", "pixelworld.sources", "pixelworld.stages"}


def test_entry_points_resolve_and_registration_wins(monkeypatch):
    first, second = object(), object()
    installed(monkeypatch, plugins.FACTS, FakeEntryPoint("pluto", "city_nyc.pluto:Pluto", first))
    assert plugins.load(plugins.FACTS, "pluto") is first
    assert plugins.available(plugins.FACTS)["pluto"].origin == "pixelworld-city-test"
    with plugins.registered(plugins.FACTS, "pluto", second):
        assert plugins.load(plugins.FACTS, "pluto") is second
        assert plugins.available(plugins.FACTS)["pluto"].origin == "registered"
    assert plugins.load(plugins.FACTS, "pluto") is first  # restored
    # an entry point can stand in for a built-in, and register() for both
    other = Terrain()
    installed(monkeypatch, plugins.SOURCES, FakeEntryPoint("usgs-3dep-1arcsec", "x:y", other))
    assert rasters.source("usgs-3dep-1arcsec", "terrain") is other


def test_register_and_unregister():
    obj = object()
    plugins.register(plugins.STAGES, "noop", obj)
    try:
        assert plugins.load(plugins.STAGES, "noop") is obj
        with pytest.raises(plugins.PluginError, match="already registered"):
            plugins.register(plugins.STAGES, "noop", object())
        plugins.register(plugins.STAGES, "noop", obj, replace=True)
    finally:
        plugins.unregister(plugins.STAGES, "noop")
    assert "noop" not in plugins.names(plugins.STAGES)
    with pytest.raises(ValueError, match="unknown plugin group"):
        plugins.register("pixelworld.nope", "x", obj)


def test_a_missing_plugin_lists_what_is_installed(monkeypatch):
    installed(monkeypatch, plugins.FACTS, FakeEntryPoint("bag", "city_nl.bag:BAG", object()))
    with pytest.raises(plugins.PluginNotFoundError) as e:
        plugins.load(plugins.FACTS, "cadastre", where="objects.typology.facts")
    msg = str(e.value)
    assert "no facts source named 'cadastre' (named by objects.typology.facts)" in msg
    assert "Installed facts sources: areas, bag." in msg
    assert "entry point group 'pixelworld.facts'" in msg and "docs/plugins.md" in msg
    assert e.value.available == ["areas", "bag"]
    # names published from this repository say which package to install
    installed(monkeypatch, plugins.FACTS)
    with pytest.raises(plugins.PluginNotFoundError) as e:
        plugins.load(plugins.FACTS, "datasf")
    assert "Installed facts sources: areas." in str(e.value)
    assert "pip install pixelworld-city-sf" in str(e.value)


def test_a_missing_terrain_source_lists_terrain_sources_only():
    with pytest.raises(plugins.PluginNotFoundError) as e:
        rasters.source("ahn-dtm-05", "terrain", where="sources.dem.kind")
    # the built-ins, and Paris's and Japan's city packs' (installed in this repository)
    assert e.value.available == [
        "copernicus-glo30",
        "copernicus-glo30-ground",
        "gsi-dem",
        "ign-lidar-hd-mnt",
        "ign-rgealti",
        "usgs-3dep-13arcsec",
        "usgs-3dep-1arcsec",
    ]
    assert "no terrain source named 'ahn-dtm-05' (named by sources.dem.kind)" in str(e.value)
    with pytest.raises(plugins.PluginError, match="is a landcover source, not a terrain source"):
        rasters.source("esa-worldcover-2021", "terrain")


def test_broken_and_ambiguous_plugins_say_where_they_come_from(monkeypatch):
    installed(monkeypatch, plugins.FACTS, FakeEntryPoint("bag", "city_nl.bag:BAG"))
    with pytest.raises(plugins.PluginError, match=r"'bag' \(from pixelworld-city-test\) failed"):
        plugins.load(plugins.FACTS, "bag")
    installed(
        monkeypatch,
        plugins.FACTS,
        FakeEntryPoint("bag", "a:BAG", object(), FakeDist("pixelworld-city-a")),
        FakeEntryPoint("bag", "b:BAG", object(), FakeDist("pixelworld-city-b")),
    )
    with pytest.raises(plugins.PluginError, match="provided by both pixelworld-city-a"):
        plugins.load(plugins.FACTS, "bag")


def test_check_finds_a_missing_plugin_before_a_build(monkeypatch):
    installed(monkeypatch, plugins.FACTS)
    spec = SPEC | {"objects": {"typology": {"facts": "datasf", "rules": []}}}
    assert plugins.spec_plugins(spec) == [
        (plugins.SOURCES, "usgs-3dep-1arcsec", "sources.dem.kind"),
        (plugins.SOURCES, "esa-worldcover-2021", "sources.landcover.kind"),
        (plugins.FACTS, "datasf", "objects.typology.facts"),
    ]
    with pytest.raises(plugins.PluginNotFoundError, match="pixelworld-city-sf"):
        plugins.check(Region.from_dict(spec))
    with plugins.registered(plugins.FACTS, "datasf", object()):
        plugins.check(Region.from_dict(spec))
    with pytest.raises(plugins.PluginNotFoundError, match="no terrain source named 'ahn'"):
        plugins.check(Region.from_dict(SPEC | {"micro": {"k": 4, "dem": {"kind": "ahn"}}}))


# ---- terrain sources ------------------------------------------------------------------------


def test_a_registered_terrain_source_feeds_uniform_and_warped_reads(monkeypatch, tmp_path):
    monkeypatch.setattr(rasters, "CACHE_ROOT", tmp_path)
    region = Region.from_dict(SPEC | {"sources": {**SPEC["sources"], "dem": {"kind": "flat"}}})
    with plugins.registered(plugins.SOURCES, "flat", Terrain(42.0)):
        dem = rasters.dem_corners(region)
        cx, cy = region.cells
        assert dem.shape == (cy + 1, cx + 1) and np.all(dem == 42.0)
        # warped layouts sample a pyramid of levels from the source's own resolution
        assert rasters.overview_factor("flat", 20.0) == (4, 4)
        x0, y0, x1, y1 = region._projected_envelope()
        xs, ys = np.linspace(x0, x1, 5), np.linspace(y0, y1, 5)
        got = rasters.sample_points(region, "flat", xs, ys, np.full(5, 40.0))
        assert np.allclose(got, 42.0)


def test_a_terrain_source_of_local_geotiff_tiles(monkeypatch, tmp_path):
    # the seam a national DEM (AHN, LiDAR HD) would use: list the tiles for a box
    tile = tmp_path / "dtm.tif"
    with rasterio.open(
        tile,
        "w",
        driver="GTiff",
        width=40,
        height=40,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_origin(-115.3, 36.3, 0.01, 0.01),
        nodata=-9999.0,
    ) as f:
        f.write(np.full((1, 40, 40), 123.0, dtype=np.float32))

    class LocalTiles(rasters.RasterSource):
        role = "terrain"
        native_m = 1000.0

        def tiles(self, bounds):
            w, s, e, n = bounds
            assert w < -115.2 and e > -115.0 and s < 36.0 and n > 36.2
            return [str(tile), str(tmp_path / "missing.tif")]

    monkeypatch.setattr(rasters, "CACHE_ROOT", tmp_path / "cache")
    spec = SPEC | {"sources": {**SPEC["sources"], "dem": {"kind": "local", "overview": 1}}}
    with plugins.registered(plugins.SOURCES, "local", LocalTiles):  # a class: instantiated
        dem = rasters.dem_corners(Region.from_dict(spec))
    assert np.allclose(dem, 123.0)


# ---- facts sources --------------------------------------------------------------------------


def test_facts_refs_name_a_plugin_with_options():
    assert facts.facts_ref({}) is None
    assert facts.facts_ref({"facts": None, "rules": []}) is None
    assert facts.facts_ref({"facts": "datasf", "rules": []}) == ("datasf", {})
    # the older form: options beside the name
    assert facts.facts_ref({"facts": "datasf", "rollYear": 2024}) == ("datasf", {"rollYear": 2024})
    assert facts.facts_ref({"facts": {"plugin": "datasf", "classCodes": True}}) == (
        "datasf",
        {"classCodes": True},
    )
    with pytest.raises(facts.FactsSpecError, match="needs a plugin name"):
        facts.facts_ref({"facts": {"rollYear": 2024}})
    with pytest.raises(facts.FactsSpecError):
        facts.facts_ref({"facts": ["datasf"]})


class Records(facts.FactsSource):
    """West of x = 0 a 1890s brownstone row (class A4, flat roofs); east, tenements (C7)."""

    attribution = {"name": "Test records", "license": "CC0", "url": "https://example.org"}
    built: list = []

    def __init__(self, region, options=None):
        super().__init__(region, options)
        Records.built.append(self.options)

    def at(self, xs, ys):
        return [
            {"year": 1890, "stories": 4, "use": "residential", "class": "A4" if x < 0 else "C7"}
            for x in xs
        ]

    def summary(self):
        return "test records 2026"


def test_a_registered_facts_source_types_buildings(capsys):
    region = Region.from_dict(SPEC)
    found = []
    for k, cx in enumerate((-2.0, 2.0)):
        fp = [[cx, 1.0], [cx + 0.3, 1.0], [cx + 0.3, 1.8], [cx, 1.8]]
        found.append(
            {
                "g": "building.residential",
                "x": cx + 0.15,
                "y": 1.4,
                "fp": fp,
                "hm": 12.0,
                "_grp": f"b{k}",
                "_c": (cx * 1000.0, 0.0),
                "_roof": "flat",
            }
        )
    spec = {
        "facts": {"plugin": "records", "vintage": 2026},
        "rules": [
            {"group": "building.rowhouse.brownstone", "classes": ["A4"], "roofs": ["flat"]},
            {"group": "building.tenement", "classes": ["C*"], "year": [1880, 1930]},
        ],
    }
    Records.built.clear()
    with plugins.registered(plugins.FACTS, "records", Records):
        objects.type_buildings(region, found, spec, None, None)
        assert facts.attribution(spec) == [Records.attribution]
    assert Records.built == [{"vintage": 2026}]
    assert [b["g"] for b in found] == ["building.rowhouse.brownstone", "building.tenement"]
    assert all(b["yr"] == 1890 and b["fl"] == 4 for b in found)
    assert "typology facts: test records 2026, 2/2 buildings with facts" in capsys.readouterr().err


class Heights(facts.FactsSource):
    def at(self, xs, ys):
        return [{"height": 60.0 if x > 0 else 24.0} for x in xs]


def test_facts_heights_fill_only_buildings_without_one(capsys):
    """D-084: a facts `height` replaces only a default height (`_hdef`), and a
    building it lifts to the tower height becomes a tower."""
    region = Region.from_dict(SPEC)
    found = []
    for k, (cx, hdef) in enumerate(((-2.0, True), (-1.0, False), (2.0, True))):
        fp = [[cx, 1.0], [cx + 0.3, 1.0], [cx + 0.3, 1.8], [cx, 1.8]]
        b = {"g": "building.residential", "x": cx, "y": 1.4, "fp": fp, "hm": 6.0}
        b.update({"_grp": f"b{k}", "_c": (cx * 1000.0, 0.0)})
        if hdef:
            b["_hdef"] = True
        found.append(b)
    with plugins.registered(plugins.FACTS, "heights", Heights):
        objects.type_buildings(region, found, {"facts": "heights", "rules": []}, None, None, 45.0)
    assert [b["hm"] for b in found] == [24.0, 6.0, 60.0]
    assert [b["g"] for b in found] == ["building.residential"] * 2 + ["building.tower"]
    assert not any("_hdef" in b for b in found)
    assert "2 heights from facts" in capsys.readouterr().err


class Roofs:
    """A facts source whose buildings all have gabled roofs."""

    def __init__(self, region, options=None):
        pass

    def at(self, xs, ys):
        return [{"roof": "gabled"} for _ in xs]


def test_roof_hints_take_the_facts_roof_where_overture_has_none():
    """D-100: with `roofHints`, a building without Overture's roof shape takes the
    facts' as its generator's hint (`rs`); one with Overture's keeps it; off by default."""
    region = Region.from_dict(SPEC)
    for hints, want in ((True, ["gabled", "flat"]), (False, [None, "flat"])):
        found = []
        for k, rs in enumerate((None, "flat")):
            fp = [[k, 1.0], [k + 0.3, 1.0], [k + 0.3, 1.8], [k, 1.8]]
            b = {"g": "building.residential", "x": k, "y": 1.4, "fp": fp, "hm": 6.0}
            b.update({"_grp": f"b{k}", "_c": (k * 1000.0, 0.0)})
            if rs:
                b["rs"] = rs
            found.append(b)
        spec = {"facts": "roofs", "rules": [], "roofHints": hints}
        with plugins.registered(plugins.FACTS, "roofs", Roofs):
            objects.type_buildings(region, found, spec, None, None, 45.0)
        assert [b.get("rs") for b in found] == want


def test_names_rules_match_a_building_and_its_parts_by_overture_name():
    """D-088: `names:` matches Overture's primary name, which a building's parts share."""
    from pixelworld_pipeline import typology

    louvre = {"g": "building.residential", "_grp": "a", "_name": "Palais du Louvre"}
    part = {"g": "building.residential", "_grp": "a", "_name": "Palais du Louvre"}
    other = {"g": "building.residential", "_grp": "b", "_name": "Hôtel du Louvre"}
    rule = {
        "group": "building.palace",
        "names": ["Palais du Louvre"],
        "from": ["building.residential"],
    }
    for inst, want in ((louvre, True), (part, True), (other, False)):
        f = {"name": inst["_name"], "parts": True, "height": 20.0}
        assert typology.matches(rule, inst["g"], f) is want


def test_kinds_rules_match_a_building_and_its_parts_by_overture_class():
    """D-091: `kinds:` matches Overture's building class (OSM's `building=*`)."""
    from pixelworld_pipeline import typology

    rule = {"group": "building.temple", "kinds": ["temple"]}
    for kind, want in (("temple", True), ("shrine", False), ("", False)):
        f = {"kind": kind, "height": 12.0}
        assert typology.matches(rule, "building.commercial", f) is want
    fp = [[0.0, 0.0], [2.0, 0.0], [2.0, 1.0], [0.0, 1.0]]
    hall = {"g": "building.commercial", "x": 1.0, "y": 0.5, "fp": fp, "hm": 12.0}
    hall.update({"_grp": "a", "_name": "本堂", "_cls": "temple"})
    assert typology.features([hall], None, None, 10.0, None)[0]["kind"] == "temple"


def test_grounds_rules_match_buildings_standing_in_a_land_use_area(monkeypatch):
    """D-100: `grounds:` matches the Overture land-use class under a building's
    centroid (a temple's grounds); the areas are fetched only when a rule names one."""
    import numpy as np
    import shapely

    from pixelworld_pipeline.sources import overture

    asked = []
    area = "POLYGON ((-115.11 36.09, -115.09 36.09, -115.09 36.11, -115.11 36.11, -115.11 36.09))"

    def land_use(release, bbox, classes):
        asked.append(list(classes))
        return [{"id": "g", "class": "religious", "geometry": area}]

    monkeypatch.setattr(overture, "land_use", land_use)
    spec = {**SPEC, "sources": {**SPEC["sources"], "overture": {"release": "r"}}}
    region = Region.from_dict(spec)
    place = objects.Placement(region, np.zeros((1, 1), dtype=bool))
    found = []
    for k, lon in enumerate((-115.1, -115.05)):
        c = place.project(shapely.Point(lon, 36.1))
        fp = [[k, 1.0], [k + 0.3, 1.0], [k + 0.3, 1.8], [k, 1.8]]
        b = {"g": "building.commercial", "x": k, "y": 1.4, "fp": fp, "hm": 9.0}
        b.update({"_grp": f"b{k}", "_c": (c.x, c.y)})
        found.append(b)
    rules = [{"group": "building.temple", "grounds": ["religious"]}]
    objects.type_buildings(region, found, {"rules": rules}, None, None, 45.0)
    assert [b["g"] for b in found] == ["building.temple", "building.commercial"]
    assert asked == [["religious"]]
    objects.type_buildings(region, found, {"rules": []}, None, None, 45.0)
    assert asked == [["religious"]]  # no rule names grounds: nothing fetched


def test_max_fill_finds_a_ring_or_a_c_shaped_footprint():
    """D-104: `fill` is the footprint's share of its smallest enclosing rectangle."""
    from pixelworld_pipeline import typology

    block = [[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0]]
    c_shape = [[0, 0], [4, 0], [4, 0.4], [0.4, 0.4], [0.4, 3.6], [4, 3.6], [4, 4], [0, 4]]
    found = []
    for k, fp in enumerate((block, c_shape)):
        b = {"g": "building.commercial", "x": 2.0, "y": 2.0, "fp": fp, "hm": 6.0}
        b.update({"_grp": f"b{k}"})
        found.append(b)
    feats = typology.features(found, None, None, 10.0, None)
    assert feats[0]["fill"] > 0.99 and feats[1]["fill"] < 0.35
    rule = {"group": "building.corridor", "maxFill": 0.5}
    assert [typology.matches(rule, b["g"], f) for b, f in zip(found, feats, strict=True)] == [
        False,
        True,
    ]


def test_courtyards_are_kept_as_holes_and_move_with_the_footprint():
    """D-088: with `courtyards`, a footprint's holes go out as `fh` rings,
    turned with it when snapped, scaled with it when depicted, and stored
    relative to the anchor as `fp` is."""
    from pixelworld_pipeline import world_format

    outer = [[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0]]
    court = [[1.0, 1.0], [3.0, 1.0], [3.0, 3.0], [1.0, 3.0]]
    inst = {"g": "building.palace", "x": 2.0, "y": 2.0, "s": 1, "fp": outer, "fh": [court]}
    # scaled twice about the anchor, as depict_buildings scales the outline
    out = objects._moved_rings(inst["fh"], lambda r: (r - (2.0, 2.0)) * 2 + (2.0, 2.0))
    assert out == [[[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0]]]
    # stored as hundredths from the anchor, and read back
    blob = world_format.encode_objects([inst])
    back = world_format.decode_objects(blob)
    assert back[0]["fh"] == [court] and back[0]["fp"] == outer
    # snapping turns them with the outline
    turned = objects.snap_buildings(
        [{**inst, "_grp": "a", "fp": [[0, 0], [4, 0.2], [3.8, 4.2], [-0.2, 4]]}], {"angle": 12}
    )
    assert turned[0]["fh"] != [court] and len(turned[0]["fh"][0]) == 4
