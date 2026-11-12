"""Paris's city pack, offline: years from periods, uses, the joins, lookups,
paging and caching, IGN's tiles, and its registration with the pipeline."""

import gzip
import json
import urllib.parse

import numpy as np
import pytest
import rasterio
import shapely
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from rasterio.warp import Resampling
from rasterio.warp import transform as transform_points

from pixelworld_pipeline import facts, plugins
from pixelworld_pipeline.region import Region
from pixelworld_pipeline.sources import apur, http, ign, rasters

REGION = Region.from_dict(
    {
        "id": "paris-test",
        "name": "Paris test",
        "bounds": [2.33, 48.85, 2.34, 48.86],
        "metersPerCell": 10,
        "style": "s",
        "start": {"lon": 2.335, "lat": 48.855},
        "sources": {},
    }
)


def _feature(lon, lat, d=0.0002, **props):
    geom = shapely.geometry.mapping(shapely.box(lon, lat, lon + d, lat + d))
    return {"type": "Feature", "geometry": geom, "properties": props}


def test_a_period_gives_the_year_unless_the_footprint_has_one_inside_it():
    assert apur.year_of({"c_perconst": 3}) == 1880
    assert apur.year_of({"c_perconst": 3, "an_const": 1867}) == 1867
    # a year outside its period is a slip: the period's
    assert apur.year_of({"c_perconst": 3, "an_const": 1960}) == 1880
    assert [apur.year_of({"c_perconst": c}) for c in (1, 2, 5, 6, 12)] == [
        1750,
        1830,
        1930,
        1958,
        2012,
    ]
    assert apur.year_of({"c_perconst": 99, "an_const": 1900}) is None
    assert apur.year_of({}) is None


def test_bd_topo_uses_map_to_use_groups():
    use = lambda u1, u2=None: apur.use_of({"usage_1": u1, "usage_2": u2})  # noqa: E731
    assert use("Résidentiel") == "residential"
    assert use("Résidentiel", "Commercial et services") == "mixed"
    assert use("Commercial et services", "Résidentiel") == "mixed"
    assert use("Commercial et services") == "commercial"
    assert use("Religieux") == "civic" and use("Industriel") == "industrial"
    assert use("Indifférencié") == "" and use(None) == ""


def test_building_facts():
    got = apur.building_facts(
        {"c_perconst": 3, "an_const": 1868, "c_tissu": "TR", "c_forme_toit": 4, "h_med": 21.4},
        {"usage_1": "Résidentiel", "nombre_d_etages": 7, "nombre_de_logements": 18},
        "Gros-Caillou",
    )
    assert got == {
        "year": 1868,
        "stories": 7.0,
        "units": 18.0,
        "use": "residential",
        "class": "TR",
        "hood": "Gros-Caillou",
        "roof": "mansard",
        "height": 21.4,
    }
    bare = apur.building_facts({"c_perconst": 99, "c_forme_toit": 1}, None, "")
    assert bare["year"] is None and bare["stories"] == 0.0 and bare["use"] == ""
    assert bare["roof"] == "flat" and bare["height"] == 0.0


@pytest.fixture
def offline(monkeypatch):
    fps = [
        # a Haussmann block over a BD TOPO building
        _feature(2.332, 48.852, c_perconst=3, c_tissu="TR", c_forme_toit=4, h_med=22.0),
        # an HBM block with no BD TOPO building under it
        _feature(2.334, 48.852, c_perconst=5, an_const=1931, c_tissu="HBM", c_forme_toit=1),
    ]
    buildings = [_feature(2.3315, 48.8515, d=0.001, usage_1="Résidentiel", nombre_d_etages=7)]
    qus = [_feature(2.33, 48.85, d=0.01, L_QU="Saint-Germain-des-Prés", C_AR=6)]
    monkeypatch.setattr(apur, "footprints", lambda bounds, version: fps)
    monkeypatch.setattr(apur, "bdtopo", lambda bounds, version: buildings)
    monkeypatch.setattr(apur, "quartiers", lambda version: qus)
    monkeypatch.setattr(apur, "current_version", lambda: "2026-07-30")


def _project(lons, lats):
    xs, ys = transform_points("EPSG:4326", REGION.crs, lons, lats)
    return np.array(xs), np.array(ys)


def test_facts_are_found_by_point_in_footprint(offline):
    source = apur.ApurFacts(REGION, {})
    assert source.summary() == (
        "APUR footprints and IGN BD TOPO, 2026-07-30: 2 footprints, 1 on a BD TOPO building"
    )
    xs, ys = _project([2.3321, 2.3341, 2.339], [48.8521, 48.8521, 48.8521])
    haussmann, hbm, outside = source.at(xs, ys)
    assert haussmann["year"] == 1880 and haussmann["stories"] == 7.0
    assert haussmann["roof"] == "mansard" and haussmann["height"] == 22.0
    assert haussmann["use"] == "residential" and haussmann["hood"] == "Saint-Germain-des-Prés"
    assert hbm["year"] == 1931 and hbm["class"] == "HBM" and hbm["stories"] == 0.0
    assert outside is None
    assert apur.ApurFacts(REGION, {"version": "2025-01-01"}).footprints.version == "2025-01-01"
    with pytest.raises(ValueError, match="unknown option"):
        apur.ApurFacts(REGION, {"year": 2026})


def test_apur_queries_page_by_objectid_and_are_cached(tmp_path, monkeypatch):
    pages = [
        {"features": [_feature(2.33, 48.85, OBJECTID=i) for i in range(apur.APUR_PAGE)]},
        {"features": [_feature(2.33, 48.85, OBJECTID=apur.APUR_PAGE)]},
    ]
    urls = []

    def fake_get(url, timeout=120):
        urls.append(urllib.parse.parse_qs(urllib.parse.urlsplit(url).query))
        return json.dumps(pages.pop(0)).encode()

    monkeypatch.setattr(http, "CACHE_ROOT", tmp_path)
    monkeypatch.setattr(apur, "get", fake_get)
    bounds = (2.285, 48.85, 2.365, 48.875)
    rows = apur.footprints(bounds, "2026-07-30")
    assert len(rows) == apur.APUR_PAGE + 1 and len(urls) == 2
    assert urls[0]["geometry"] == ["2.285,48.85,2.365,48.875"] and urls[0]["outSR"] == ["4326"]
    assert [u["resultOffset"] for u in urls] == [["0"], [str(apur.APUR_PAGE)]]
    cached = tmp_path / "paris" / "emprise-2.2850_48.8500_2.3650_48.8750-2026-07-30.json.gz"
    assert json.loads(gzip.decompress(cached.read_bytes())) == rows
    assert apur.footprints(bounds, "2026-07-30") == rows and len(urls) == 2


def test_bd_topo_is_read_from_the_wfs_in_latitude_order(tmp_path, monkeypatch):
    urls = []

    def fake_get(url, timeout=120):
        urls.append(urllib.parse.parse_qs(urllib.parse.urlsplit(url).query))
        return json.dumps({"features": [_feature(2.33, 48.85, cleabs="BATIMENT1")]}).encode()

    monkeypatch.setattr(http, "CACHE_ROOT", tmp_path)
    monkeypatch.setattr(apur, "get", fake_get)
    rows = apur.bdtopo((2.285, 48.85, 2.365, 48.875), "v")
    assert len(rows) == 1 and urls[0]["TYPENAMES"] == ["BDTOPO_V3:batiment"]
    assert urls[0]["BBOX"] == ["48.85,2.285,48.875,2.365,urn:ogc:def:crs:EPSG::4326"]
    assert (tmp_path / "paris" / "bdtopo-2.2850_48.8500_2.3650_48.8750-v.json.gz").exists()


def _geotiff(x0: float, y0: float, res: float, value: float) -> bytes:
    """A 2,000-pixel tile as the WMS-R serves it (its CRS with an unnamed datum)."""
    with MemoryFile() as mem:
        with mem.open(
            driver="GTiff",
            width=ign.TILE,
            height=ign.TILE,
            count=1,
            dtype="float32",
            crs="+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000",
            transform=from_origin(x0, y0 + ign.TILE * res, res, res),
            nodata=-99999.0,
        ) as ds:
            ds.write(np.full((1, ign.TILE, ign.TILE), value, dtype=np.float32))
        return mem.read()


def test_ign_tiles_are_fetched_at_the_overview_on_a_fixed_grid(tmp_path, monkeypatch):
    urls = []

    def fake_get(url, timeout=120):
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        urls.append(q)
        x0, y0, _, _ = (float(v) for v in q["BBOX"][0].split(","))
        return _geotiff(x0, y0, 4.0, 35.0)

    monkeypatch.setattr(http, "CACHE_ROOT", tmp_path)
    monkeypatch.setattr(ign, "get", fake_get)
    region = REGION
    cx, cy = region.cells
    dst = np.full((cy + 1, cx + 1), np.nan, dtype=np.float32)
    missing = ign.RGE_ALTI.read_into(
        dst,
        region.corner_transform(),
        region.crs,
        region.lonlat_envelope(0.002),
        4,
        Resampling.average,
        np.nan,
    )
    assert missing == [] and urls
    assert all(q["LAYERS"] == ["ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES"] for q in urls)
    assert all(q["CRS"] == ["EPSG:2154"] and q["WIDTH"] == ["2000"] for q in urls)
    # 8 km tiles at 4 m: the box (about 750 m) is in one or two of them
    assert 1 <= len(urls) <= 4
    assert np.nanmin(dst) == pytest.approx(35.0) and not np.isnan(dst[1:-1, 1:-1]).any()
    tiles = sorted((tmp_path / "ign").glob("*.tif"))
    assert len(tiles) == len(urls) and tiles[0].name.startswith(
        "ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES-4m-"
    )
    with rasterio.open(tiles[0]) as f:
        assert f.crs.to_epsg() == 2154
    # a second read is from the cache
    box = region.lonlat_envelope(0.002)
    ign.RGE_ALTI.read_into(
        dst, region.corner_transform(), region.crs, box, 4, Resampling.average, np.nan
    )
    assert len(urls) == len(tiles)


def test_ign_refuses_what_isnt_a_geotiff(tmp_path, monkeypatch):
    monkeypatch.setattr(http, "CACHE_ROOT", tmp_path)
    monkeypatch.setattr(ign, "get", lambda url, timeout=120: b"<ServiceExceptionReport/>")
    with pytest.raises(RuntimeError, match="not a GeoTIFF"):
        ign.LIDAR_HD_MNT.fetch((2.33, 48.85, 2.34, 48.86), 0.5)


def test_the_sources_are_built_in():
    assert plugins.load_source("facts", "apur") is apur.ApurFacts
    assert plugins.available()["apur"].origin == "builtin"
    assert plugins.attribution({"facts": {"kind": "apur"}}, "facts") == apur.ATTRIBUTION
    assert any("ODbL" in a["license"] for a in apur.ATTRIBUTION)
    assert any("Licence Ouverte" in a["license"] for a in apur.ATTRIBUTION)
    for name, src in (("ign-rgealti", ign.RGE_ALTI), ("ign-lidar-hd-mnt", ign.LIDAR_HD_MNT)):
        assert rasters.source(name, "terrain") is src
        assert "Licence Ouverte" in src.attribution["license"]
    assert issubclass(apur.ApurFacts, facts.FactsSource)
