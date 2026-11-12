"""New York's city pack, offline: the joins, the year fallbacks, lookups,
caching and its registration with the pipeline."""

import gzip
import json

import numpy as np
import pytest
import shapely
from rasterio.warp import transform as transform_points

from pixelworld_pipeline import facts, plugins
from pixelworld_pipeline.region import Region
from pixelworld_pipeline.sources import http, pluto

REGION = Region.from_dict(
    {
        "id": "nyc-test",
        "name": "NYC test",
        "bounds": [-74.0, 40.69, -73.99, 40.70],
        "metersPerCell": 10,
        "style": "s",
        "start": {"lon": -73.995, "lat": 40.695},
        "sources": {},
    }
)


def _box(lon, lat, d=0.0002):
    return shapely.geometry.mapping(shapely.box(lon, lat, lon + d, lat + d))


def test_year_falls_back_from_lpc_to_the_footprint_to_pluto():
    lot = {
        "bldgclass": "B1",
        "landuse": "1",
        "yearbuilt": "1910",
        "numfloors": "3.0",
        "unitsres": "2",
    }
    lpc = {"date_low": "1861", "mat_prim": "Brownstone"}
    assert pluto.building_facts({"construction_year": "1899"}, lot, lpc, "Brooklyn Heights") == {
        "year": 1861,
        "stories": 3.0,
        "units": 2.0,
        "use": "residential",
        "class": "B1",
        "hood": "Brooklyn Heights",
        "material": "Brownstone",
    }
    assert pluto.building_facts({"construction_year": "1899"}, lot, None, "")["year"] == 1899
    # 1900 is the footprints' placeholder: PLUTO's year then
    assert pluto.building_facts({"construction_year": "1900"}, lot, None, "")["year"] == 1910
    assert pluto.building_facts({}, {**lot, "yearbuilt": "0"}, None, "")["year"] is None
    # an undetermined material is none
    got = pluto.building_facts({}, None, {"mat_prim": "Not determined"}, "")
    assert got["material"] == "" and got["use"] == "" and got["class"] == ""


def test_land_use_maps_to_use_groups():
    use = lambda code: pluto.building_facts({}, {"landuse": code}, None, "")["use"]  # noqa: E731
    assert [use(c) for c in ("01", "2", "3", "4", "05", "6", "7", "8", "9", "11", None)] == [
        "residential",
        "residential",
        "residential",
        "mixed",
        "commercial",
        "industrial",
        "civic",
        "civic",
        "",
        "",
        "",
    ]


@pytest.fixture
def offline(monkeypatch):
    fps = [
        # a brownstone with an LPC record, on a PLUTO lot by its base BBL
        {
            "bin": "3001518",
            "base_bbl": "3002080506",
            "construction_year": "1900",
            "the_geom": _box(-73.996, 40.695),
        },
        # a tower on a lot found by its MapPLUTO BBL
        {
            "bin": "1000001",
            "base_bbl": "1",
            "mappluto_bbl": "1000010001",
            "construction_year": "1931",
            "the_geom": _box(-73.994, 40.695),
        },
        # no lot, no record
        {
            "bin": "9",
            "base_bbl": "2",
            "construction_year": "1900",
            "the_geom": _box(-73.992, 40.695),
        },
    ]
    lots = [
        {
            "bbl": "3002080506.00000000",
            "bldgclass": "B1",
            "landuse": "1",
            "yearbuilt": "1899",
            "numfloors": "4.0",
            "unitsres": "2",
        },
        {
            "bbl": "1000010001.00000000",
            "bldgclass": "O4",
            "landuse": "5",
            "yearbuilt": "1930",
            "numfloors": "67.0",
            "unitsres": "0",
        },
    ]
    lpc = [
        {"bin": "3001518", "date_low": "1861", "mat_prim": "Brownstone", "style_prim": "Italianate"}
    ]
    ntas = [
        {
            "ntaname": "Brooklyn Heights",
            "the_geom": shapely.geometry.mapping(shapely.box(-74.0, 40.69, -73.99, 40.70)),
        }
    ]
    monkeypatch.setattr(pluto, "footprints", lambda bounds, version: fps)
    monkeypatch.setattr(pluto, "lots", lambda bounds, version: lots)
    monkeypatch.setattr(pluto, "landmarks", lambda bounds, version: lpc)
    monkeypatch.setattr(pluto, "neighbourhoods", lambda version: ntas)
    monkeypatch.setattr(pluto, "current_version", lambda: "26v2")


def _project(lons, lats):
    xs, ys = transform_points("EPSG:4326", REGION.crs, lons, lats)
    return np.array(xs), np.array(ys)


def test_facts_are_found_by_point_in_footprint(offline):
    source = pluto.PlutoFacts(REGION, {})
    assert (
        source.summary()
        == "NYC Open Data, PLUTO 26v2: 3 footprints, 2 on a PLUTO lot, 1 with an LPC record"
    )
    xs, ys = _project([-73.9959, -73.9939, -73.9919, -73.98], [40.6951, 40.6951, 40.6951, 40.6951])
    brownstone, tower, bare, outside = source.at(xs, ys)
    assert brownstone["year"] == 1861 and brownstone["material"] == "Brownstone"
    assert brownstone["class"] == "B1" and brownstone["hood"] == "Brooklyn Heights"
    assert tower["year"] == 1931 and tower["class"] == "O4" and tower["stories"] == 67.0
    assert tower["use"] == "commercial"
    assert bare["year"] is None and bare["class"] == "" and bare["hood"] == "Brooklyn Heights"
    assert outside is None
    assert pluto.PlutoFacts(REGION, {"version": "25v4"}).footprints.version == "25v4"
    with pytest.raises(ValueError, match="unknown option"):
        pluto.PlutoFacts(REGION, {"year": 2024})


def test_downloads_are_cached_by_name_with_a_box_query(tmp_path, monkeypatch):
    pages = [[{"bin": str(i)} for i in range(3)]]
    urls = []

    def fake_get(url, timeout=120):
        urls.append(url)
        return json.dumps(pages.pop(0)).encode()

    monkeypatch.setattr(http, "CACHE_ROOT", tmp_path)
    monkeypatch.setattr(pluto, "get", fake_get)
    bounds = (-74.02, 40.69, -73.97, 40.729)
    rows = pluto.footprints(bounds, "26v2")
    assert len(rows) == 3 and len(urls) == 1
    assert "within_box%28the_geom%2C+40.729%2C+-74.02%2C+40.69%2C+-73.97%29" in urls[0]
    cached = tmp_path / "nyc" / "footprints--74.0200_40.6900_-73.9700_40.7290-26v2.json.gz"
    assert json.loads(gzip.decompress(cached.read_bytes())) == rows
    assert pluto.footprints(bounds, "26v2") == rows and len(urls) == 1


def test_the_facts_source_is_built_in():
    assert plugins.load_source("facts", "pluto") is pluto.PlutoFacts
    assert plugins.available()["pluto"].origin == "builtin"
    assert plugins.attribution({"facts": {"kind": "pluto"}}, "facts") == pluto.ATTRIBUTION
    assert (
        plugins.attribution({"facts": {"kind": "pluto", "version": "26v2"}}, "facts")
        == pluto.ATTRIBUTION
    )
    assert all("§23-502(d)" in a["license"] for a in pluto.ATTRIBUTION)
    assert issubclass(pluto.PlutoFacts, facts.FactsSource)
