"""The global-data path's first pieces (D-107): Copernicus GLO-30 terrain with
a ground filter, and facts from the spec's neighbourhood boxes."""

import numpy as np
import pytest
from rasterio.warp import transform as transform_points

from pixelworld_pipeline import facts, plugins
from pixelworld_pipeline.areas import AreaFacts
from pixelworld_pipeline.facts import FactsSpecError
from pixelworld_pipeline.region import Region
from pixelworld_pipeline.sources import rasters
from pixelworld_pipeline.typology import FLOOR_METERS

SPEC = {
    "id": "global-path-test",
    "name": "Global path test",
    "bounds": [114.16, 22.30, 114.18, 22.32],
    "metersPerCell": 10,
    "style": "s",
    "start": {"lon": 114.17, "lat": 22.31},
    "sources": {
        "dem": {"kind": "copernicus-glo30-ground"},
        "landcover": {"kind": "esa-worldcover-2021"},
    },
}


def test_glo30_tile_names_cover_each_degree_in_every_hemisphere():
    urls = rasters.copernicus_glo30_tiles((113.5, 22.2, 114.3, 22.6))
    assert [u.rsplit("/", 1)[1] for u in urls] == [
        "Copernicus_DSM_COG_10_N22_00_E113_00_DEM.tif",
        "Copernicus_DSM_COG_10_N22_00_E114_00_DEM.tif",
    ]
    (u,) = rasters.copernicus_glo30_tiles((-43.3, -22.99, -43.1, -22.9))  # Rio
    assert u.endswith("Copernicus_DSM_COG_10_S23_00_W044_00_DEM.tif")


def test_glo30_sources_are_built_in_terrain():
    for kind in ("copernicus-glo30", "copernicus-glo30-ground"):
        src = rasters.source(kind, "terrain")
        assert src.native_m == 30.0
        assert "Copernicus WorldDEM-30" in src.attribution["name"]
        assert "do not incur any liability" in src.attribution["name"]


def test_ground_filter_takes_off_blocks_narrower_than_the_window_and_keeps_water():
    a = np.full((40, 40), 10.0)
    a[:, :8] = 0.0  # the harbour
    a[18:21, 18:21] = 60.0  # a 90 m block of towers
    a[30:33, 10:12] += 25.0  # a block on the shore
    g = rasters.ground_filter(a, 7)
    assert abs(g[19, 19] - 10.0) < 1e-6
    assert abs(g[31, 11] - 10.0) < 1e-6
    assert (g[:, :8] == 0.0).all()  # water untouched
    assert np.allclose(g[2:-2, 10:-2], 10.0)  # flat ground stays flat, the shore not pulled down
    # a slope wider than the window survives (lowered by at most the window's rise)
    ramp = np.tile(np.arange(40, dtype=float), (40, 1)) + 5.0
    assert np.abs(rasters.ground_filter(ramp, 7) - ramp)[5:-5, 5:-5].max() <= 3.0
    assert rasters.ground_filter(a, 1) is a


def _region():
    return Region.from_dict(SPEC)


def test_area_facts_name_the_hood_and_give_a_height():
    region = _region()
    src = AreaFacts(
        region,
        {
            "areas": [
                {
                    "hood": "Mong Kok",
                    "bounds": [114.165, 22.315, 114.175, 22.325],
                    "floors": 7,
                    "use": "mixed",
                },
                {
                    "hood": "Tsim Sha Tsui",
                    "bounds": [[114.167, 22.293, 114.178, 22.303], [114.16, 22.30, 114.17, 22.31]],
                },
            ]
        },
    )
    lon = [114.170, 114.172, 114.163, 114.190]
    lat = [22.320, 22.296, 22.305, 22.320]
    xs, ys = transform_points("EPSG:4326", region.crs, lon, lat)
    got = src.at(np.array(xs), np.array(ys))
    assert got[0] == {"hood": "Mong Kok", "height": 7 * FLOOR_METERS, "use": "mixed"}
    assert got[1] == {"hood": "Tsim Sha Tsui"} and got[2] == {"hood": "Tsim Sha Tsui"}
    assert got[3] is None
    got[0]["hood"] = "changed"
    assert src.at(np.array(xs[:1]), np.array(ys[:1]))[0]["hood"] == "Mong Kok"


def test_area_facts_are_a_built_in_facts_source():
    region = _region()
    src = facts.open_facts(
        region, {"facts": {"plugin": "areas", "areas": [{"hood": "x", "bounds": [0, 0, 1, 1]}]}}
    )
    assert isinstance(src, AreaFacts)
    assert plugins.load(plugins.FACTS, "areas") is AreaFacts
    with pytest.raises(FactsSpecError):
        AreaFacts(region, {})
    with pytest.raises(FactsSpecError):
        AreaFacts(region, {"areas": [{"hood": "x", "bounds": [1, 0, 0, 1]}]})
