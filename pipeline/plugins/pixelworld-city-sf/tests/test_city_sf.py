"""San Francisco's city pack, offline: lot aggregation, lookups, caching and
its registration with the pipeline."""

import gzip
import json
import os
from pathlib import Path

import numpy as np
import pytest
import shapely
from rasterio.warp import transform as transform_points

import pixelworld_city_sf
from pixelworld_city_sf import datasf
from pixelworld_pipeline import facts, plugins
from pixelworld_pipeline.region import Region
from pixelworld_pipeline.sources import http

REGION = Region.from_dict(
    {
        "id": "sf-test",
        "name": "SF test",
        "bounds": [-122.45, 37.77, -122.43, 37.78],
        "metersPerCell": 10,
        "style": "s",
        "start": {"lon": -122.44, "lat": 37.775},
        "sources": {},
    }
)


def _unit(year, stories, units, use, cls="Dwelling", code=None, hood="Haight Ashbury"):
    r = {
        "block": "1234",
        "lot": "001",
        "year_property_built": str(year),
        "number_of_stories": str(stories),
        "number_of_units": str(units),
        "use_definition": use,
        "property_class_code_definition": cls,
        "construction_type": "D",
        "analysis_neighborhood": hood,
    }
    if code is not None:
        r["property_class_code"] = code
    return r


def test_condominium_units_aggregate_per_lot():
    got = datasf.aggregate(
        [
            _unit(1906, 3, 1, "Multi-Family Residential", "Condominium"),
            _unit(1900, 4, 2, "Multi-Family Residential", "Condominium"),
            _unit(0, 2, 1, "Commercial Retail", "Store"),
        ]
    )
    assert got["year"] == 1900 and got["stories"] == 4.0 and got["units"] == 4.0
    assert got["use"] == "Multi-Family Residential" and got["class"] == "Condominium"
    assert got["hood"] == "Haight Ashbury" and "classDefinition" not in got
    assert datasf.aggregate([])["year"] is None
    # with class codes, `class` is the code and the definition stays beside it
    coded = datasf.aggregate([_unit(1900, 3, 2, "Residential", "Flats & Duplex", code="F")])
    assert coded["class"] == "F" and coded["classDefinition"] == "Flats & Duplex"


def _lot(lon, lat, d=0.0004):
    return shapely.geometry.mapping(shapely.box(lon, lat, lon + d, lat + d))


@pytest.fixture
def offline(monkeypatch):
    roll = [
        {
            **_unit(1895, 3, 1, "Single Family Residential", code=None),
            "block": "0001",
            "lot": "001",
        },
        {**_unit(1925, 2, 2, "Multi-Family Residential"), "block": "0001", "lot": "002"},
        {**_unit(1925, 2, 2, "Multi-Family Residential"), "block": "0001", "lot": "003"},
    ]
    lots = [
        {"blklot": "0001001", "mapblklot": "0001001", "shape": _lot(-122.44, 37.775)},
        # two condominium lots on one map lot
        {"blklot": "0001002", "mapblklot": "0001002", "shape": _lot(-122.438, 37.775)},
        {"blklot": "0001003", "mapblklot": "0001002", "shape": _lot(-122.438, 37.775)},
    ]
    monkeypatch.setattr(datasf, "assessor_roll", lambda year: roll)
    monkeypatch.setattr(datasf, "parcels", lambda: lots)
    monkeypatch.setattr(datasf, "class_codes", lambda year: {"0001001": "D", "0001002": "F2"})
    monkeypatch.setattr(datasf, "latest_roll_year", lambda: "2025")


def _project(lons, lats):
    xs, ys = transform_points("EPSG:4326", REGION.crs, lons, lats)
    return np.array(xs), np.array(ys)


def test_facts_are_found_by_projected_point(offline):
    source = datasf.DataSFFacts(REGION, {})
    assert source.summary() == "DataSF assessor roll 2025"
    xs, ys = _project([-122.4398, -122.4378, -122.42], [37.7752, 37.7752, 37.7752])
    first, condo, outside = source.at(xs, ys)
    assert first["year"] == 1895 and first["class"] == "Dwelling"
    assert condo["units"] == 4.0 and condo["year"] == 1925
    assert outside is None
    coded = datasf.DataSFFacts(REGION, {"rollYear": 2024, "classCodes": True})
    assert coded.parcels.year == "2024"
    assert [f["class"] for f in coded.at(xs[:2], ys[:2])] == ["D", "F2"]
    with pytest.raises(ValueError, match="unknown option"):
        datasf.DataSFFacts(REGION, {"year": 2024})


def test_downloads_are_cached_in_the_shared_cache(tmp_path, monkeypatch):
    if not os.environ.get("PIXELWORLD_CACHE"):
        # where they were before the move: pipeline/.cache/datasf
        assert http.CACHE_ROOT == Path(http.__file__).resolve().parents[4] / "pipeline" / ".cache"
    pages = [[{"block": "1", "lot": str(i)} for i in range(3)]]
    urls = []

    def fake_get(url, timeout=120):
        urls.append(url)
        return json.dumps(pages.pop(0)).encode()

    monkeypatch.setattr(http, "CACHE_ROOT", tmp_path)
    monkeypatch.setattr(datasf, "get", fake_get)
    rows = datasf._soql(datasf.ASSESSOR, {"$select": "block,lot"}, "test-rows")
    assert len(rows) == 3 and len(urls) == 1
    cached = tmp_path / "datasf" / "test-rows.json.gz"
    assert json.loads(gzip.decompress(cached.read_bytes())) == rows
    assert datasf._soql(datasf.ASSESSOR, {}, "test-rows") == rows and len(urls) == 1


def test_the_pack_registers_its_facts_source():
    assert plugins.load(plugins.FACTS, "datasf") is datasf.DataSFFacts
    assert plugins.available(plugins.FACTS)["datasf"].origin == "pixelworld-city-sf"
    assert facts.attribution({"facts": "datasf"}) == [datasf.ATTRIBUTION]
    assert facts.attribution({"facts": {"plugin": "datasf", "classCodes": True}}) == [
        pixelworld_city_sf.ATTRIBUTION
    ]
    assert issubclass(datasf.DataSFFacts, facts.FactsSource)
