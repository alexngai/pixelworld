"""Japan's city pack, offline: PLATEAU's mesh codes, a tiny CityGML file read
into facts (footprints, attributes, placeholders, roof shapes), the catalog
and the extract cache; GSI's tile decoding and fallbacks; the entry points
and attribution."""

import gzip
import io
import json
import math
import urllib.error
import warnings

import numpy as np
import pytest
from rasterio.errors import NotGeoreferencedWarning
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from rasterio.warp import Resampling
from rasterio.warp import transform as transform_points

from pixelworld_city_jp import gsi, plateau
from pixelworld_pipeline import facts, plugins
from pixelworld_pipeline.region import Region
from pixelworld_pipeline.sources import http, rasters

LAT0, LON0 = 35.0040, 135.7560  # in mesh 52354600 (Shijō-Karasuma)
KX = 111_320.0 * math.cos(math.radians(LAT0))
KY = 110_574.0
REGION = Region.from_dict(
    {
        "id": "kyoto-test",
        "name": "Kyoto test",
        "bounds": [135.755, 35.003, 135.758, 35.006],
        "metersPerCell": 4,
        "style": "s",
        "start": {"lon": 135.756, "lat": 35.004},
        "sources": {},
    }
)


# ---- a tiny CityGML file, in local metres east (x) and north (y) of LAT0, LON0 --------------


def ll(x, y, z=0.0):
    """Local metres to PLATEAU's lat, lon, height."""
    return (LAT0 + y / KY, LON0 + x / KX, z)


def ring(pts):
    pts = [ll(*p) for p in pts]
    return np.array(pts + pts[:1])


def poslist(pts) -> str:
    return " ".join(f"{a:.10f} {b:.10f} {c:.3f}" for a, b, c in ring(pts))


def polygon(pts, holes=()) -> str:
    inner = "".join(
        f"<gml:interior><gml:LinearRing><gml:posList>{poslist(h)}</gml:posList>"
        "</gml:LinearRing></gml:interior>"
        for h in holes
    )
    return (
        "<gml:Polygon><gml:exterior><gml:LinearRing>"
        f"<gml:posList>{poslist(pts)}</gml:posList></gml:LinearRing></gml:exterior>{inner}"
        "</gml:Polygon>"
    )


def box(x0, y0, x1, y1, z=0.0):
    return [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)]


# roofs on a 10 × 6 m house, eaves at 6 m, ridge (along x) at 8 m
GABLED = [
    [(0, 0, 6), (10, 0, 6), (10, 3, 8), (0, 3, 8)],
    [(10, 6, 6), (0, 6, 6), (0, 3, 8), (10, 3, 8)],
]
HIPPED = [
    [(0, 0, 6), (10, 0, 6), (7, 3, 8), (3, 3, 8)],
    [(10, 6, 6), (0, 6, 6), (3, 3, 8), (7, 3, 8)],
    [(10, 0, 6), (10, 6, 6), (7, 3, 8)],
    [(0, 6, 6), (0, 0, 6), (3, 3, 8)],
]
SKILLION = [[(0, 0, 8), (10, 0, 8), (10, 6, 6), (0, 6, 6)]]
# an L: wing A (x 0–10, gable at x = 0) meets wing B (x 4–10, gable at y = 14);
# a hip at the outer corner (10, 0), a valley at the inner one (4, 6)
L_GABLED = [
    [(0, 0, 6), (10, 0, 6), (7, 3, 8), (0, 3, 8)],
    [(0, 6, 6), (0, 3, 8), (7, 3, 8), (4, 6, 6)],
    [(10, 0, 6), (10, 14, 6), (7, 14, 8), (7, 3, 8)],
    [(4, 14, 6), (4, 6, 6), (7, 3, 8), (7, 14, 8)],
]
# hip-and-gable (入母屋): a hipped skirt to 6.5 m, the gable above it
IRIMOYA = [
    [(0, 0, 6), (10, 0, 6), (9.25, 0.75, 6.5), (9.25, 3, 8), (0.75, 3, 8), (0.75, 0.75, 6.5)],
    [(10, 6, 6), (0, 6, 6), (0.75, 5.25, 6.5), (0.75, 3, 8), (9.25, 3, 8), (9.25, 5.25, 6.5)],
    [(10, 0, 6), (10, 6, 6), (9.25, 5.25, 6.5), (9.25, 0.75, 6.5)],
    [(0, 6, 6), (0, 0, 6), (0.75, 0.75, 6.5), (0.75, 5.25, 6.5)],
]
FLAT = [box(0, 0, 10, 6, 6)]


def building(gid, attrs: dict, roofs=(), lod0=None, lod1=None, uro=None) -> str:
    body = "".join(f"<bldg:{k}>{v}</bldg:{k}>" for k, v in attrs.items())
    if lod0 is not None:
        body += (
            "<bldg:lod0RoofEdge><gml:MultiSurface><gml:surfaceMember>"
            f"{polygon(*lod0)}</gml:surfaceMember></gml:MultiSurface></bldg:lod0RoofEdge>"
        )
    if lod1 is not None:
        x0, y0, x1, y1, h = lod1
        base = box(x0, y0, x1, y1)
        faces = [box(x0, y0, x1, y1, 0.0), box(x0, y0, x1, y1, h)] + [
            [(a[0], a[1], 0), (b[0], b[1], 0), (b[0], b[1], h), (a[0], a[1], h)]
            for a, b in zip(base, base[1:] + base[:1], strict=True)
        ]
        members = "".join(f"<gml:surfaceMember>{polygon(f)}</gml:surfaceMember>" for f in faces)
        body += (
            "<bldg:lod1Solid><gml:Solid><gml:exterior><gml:CompositeSurface>"
            f"{members}</gml:CompositeSurface></gml:exterior></gml:Solid></bldg:lod1Solid>"
        )
    for r in roofs:
        body += (
            "<bldg:boundedBy><bldg:RoofSurface><bldg:lod2MultiSurface><gml:MultiSurface>"
            f"<gml:surfaceMember>{polygon(r)}</gml:surfaceMember>"
            "</gml:MultiSurface></bldg:lod2MultiSurface></bldg:RoofSurface></bldg:boundedBy>"
        )
    if uro:
        detail = "".join(f"<uro:{k}>{v}</uro:{k}>" for k, v in uro.items())
        body += (
            "<uro:buildingDetailAttribute><uro:BuildingDetailAttribute>"
            f"{detail}</uro:BuildingDetailAttribute></uro:buildingDetailAttribute>"
        )
    member = f'<bldg:Building gml:id="{gid}">{body}</bldg:Building>'
    return f"<core:cityObjectMember>{member}</core:cityObjectMember>"


def citygml(*buildings) -> bytes:
    return (
        "<?xml version='1.0' encoding='utf-8'?>"
        '<core:CityModel xmlns:core="http://www.opengis.net/citygml/2.0" '
        'xmlns:bldg="http://www.opengis.net/citygml/building/2.0" '
        'xmlns:gml="http://www.opengis.net/gml" '
        'xmlns:app="http://www.opengis.net/citygml/appearance/2.0" '
        'xmlns:uro="https://www.geospatial.jp/iur/uro/3.2">'
        "<gml:boundedBy/>" + "".join(buildings) + "<app:appearanceMember/></core:CityModel>"
    ).encode()


SAMPLE = citygml(
    # a machiya: footprint with a courtyard, every attribute, a gabled roof
    building(
        "bldg_a",
        {
            "usage": "413",
            "yearOfConstruction": "1925",
            "measuredHeight": "7.9",
            "storeysAboveGround": "2",
        },
        roofs=GABLED,
        lod0=(box(0, 0, 10, 6), [box(4, 2, 6, 4)]),
        uro={"buildingStructureType": "601"},
    ),
    # placeholders everywhere; no LoD0: the footprint is the bottom of the LoD1 solid
    building(
        "bldg_b",
        {
            "usage": "461",
            "yearOfConstruction": "0001",
            "measuredHeight": "-9999",
            "storeysAboveGround": "9999",
        },
        roofs=[[(x + 20, y, z) for x, y, z in f] for f in HIPPED],
        lod1=(20, 0, 30, 6, 8.0),
        uro={"buildingStructureType": "611", "fireproofStructureType": "1001"},
    ),
    # a flat-roofed block of flats, storeys 0 (unknown), no LoD2
    building(
        "bldg_c",
        {"usage": "412", "measuredHeight": "21.5", "storeysAboveGround": "0"},
        lod0=(box(0, 20, 12, 30), []),
        uro={"buildingStructureType": "603", "detailedUsage": "412102"},
    ),
)


def test_mesh_codes_cover_a_box_with_the_standard_grid():
    # one point: Shijō-Karasuma (Kyoto) and the Shibuya crossing (Tokyo)
    assert plateau.mesh_codes((135.7563, 35.0042, 135.7564, 35.0043)) == ["52354600"]
    assert plateau.mesh_codes((139.7005, 35.6595, 139.7006, 35.6596)) == ["53393596"]
    # the Kyoto check box: 4 rows of 30" by 3 columns of 45"
    codes = plateau.mesh_codes((135.755, 34.990, 135.785, 35.012))
    assert len(codes) == 12 and {"52354600", "52353692", "52354602"} <= set(codes)
    w, s, e, n = plateau.mesh_bounds("52354600")
    assert (w, s) == pytest.approx((135.75, 35.0)) and (e - w, n - s) == pytest.approx(
        (1 / 80, 1 / 120)
    )
    # a mesh's own box is that mesh alone (no neighbour by rounding)
    assert plateau.mesh_codes((w + 1e-9, s + 1e-9, e - 1e-9, n - 1e-9)) == ["52354600"]


def test_roof_shapes_from_lod2_roof_surfaces():
    shape = lambda faces: plateau.roof_shape([ring(f) for f in faces])  # noqa: E731
    assert shape(GABLED) == "gabled"
    assert shape(HIPPED) == "hipped"
    assert shape(SKILLION) == "skillion"
    assert shape(FLAT) == "flat"
    assert shape([]) == ""
    assert shape(L_GABLED) == "gabled"
    assert shape(IRIMOYA) == "hipped"
    # the L's edges: one hip, one valley (each 3√2 m in plan), four verges of 3 m
    faces = [ring(f) for f in L_GABLED]
    xyz = [plateau._local_xyz(r, LAT0, LON0) for r in faces]
    asp = [math.atan2(*plateau._normal(x)[[1, 0]]) for x in xyz]
    facets = [(x, 1.0, 30.0, a) for x, a in zip(xyz, asp, strict=True)]
    side = np.array([3, 1, 0, 2])  # south, north, east, west
    hips, valleys, verges = plateau.roof_edges(facets, side)
    assert (hips, valleys, verges) == pytest.approx((3 * 2**0.5, 3 * 2**0.5, 12), abs=0.05)
    # the hip-and-gable's gable stands on the skirt: its verges aren't a gable's
    xyz = [plateau._local_xyz(ring(f), LAT0, LON0) for f in IRIMOYA]
    facets = [(x, 1.0, 30.0, math.atan2(*plateau._normal(x)[[1, 0]])) for x in xyz]
    hips, valleys, verges = plateau.roof_edges(facets, np.array([3, 1, 0, 2]))
    assert hips == pytest.approx(4 * 0.75 * 2**0.5, abs=0.05) and valleys == verges == 0
    # a gable split into coplanar pieces is still a gable (shared verges between pieces)
    split = [
        [(0, 0, 6), (5, 0, 6), (5, 3, 8), (0, 3, 8)],
        [(5, 0, 6), (10, 0, 6), (10, 3, 8), (5, 3, 8)],
        GABLED[1],
    ]
    assert shape(split) == "gabled"
    # a machiya: the gable and a pent roof (hisashi) over the street
    hisashi = [(0, -1.5, 4.5), (10, -1.5, 4.5), (10, 0, 5), (0, 0, 5)]
    assert shape([*GABLED, hisashi]) == "gabled"
    # turned 30°: the axes come from the facets, not north
    c, s = math.cos(math.radians(30)), math.sin(math.radians(30))
    turn = lambda f: [(x * c - y * s, x * s + y * c, z) for x, y, z in f]  # noqa: E731
    assert shape([turn(f) for f in GABLED]) == "gabled"
    assert shape([turn(f) for f in HIPPED]) == "hipped"
    # mostly flat, with a small sloped bit: flat
    assert shape([box(0, 0, 20, 20, 30), *GABLED]) == "flat"


def test_a_citygml_file_reads_into_footprints_and_attributes():
    recs = {r["id"]: r for r in plateau.parse(io.BytesIO(SAMPLE))}
    assert set(recs) == {"bldg_a", "bldg_b", "bldg_c"}
    a, b, c = recs["bldg_a"], recs["bldg_b"], recs["bldg_c"]
    # the LoD0 footprint in lon/lat, with its courtyard
    ga = plateau._shape(a)
    assert ga.geom_type == "Polygon" and len(ga.interiors) == 1
    assert ga.area == pytest.approx((60 - 4) / (KX * KY), rel=1e-2)
    assert ga.bounds[0] == pytest.approx(LON0) and ga.bounds[1] == pytest.approx(LAT0)
    # no LoD0: the LoD1 solid's base
    gb = plateau._shape(b)
    assert gb.area == pytest.approx(60 / (KX * KY), rel=1e-2)
    assert gb.bounds[0] == pytest.approx(LON0 + 20 / KX)
    assert (a["roof"], b["roof"], c["roof"]) == ("gabled", "hipped", "")
    assert (a["structure"], b["fireproof"], c["detailed"]) == ("601", "1001", "412102")

    fa, fb, fc = (plateau.building_facts(r) for r in (a, b, c))
    assert fa == {
        "year": 1925,
        "stories": 2.0,
        "use": "mixed",
        "class": "413",
        "material": "wood",
        "roof": "gabled",
        "height": 7.9,
    }
    # placeholders: year 0001, storeys 9999 and 0, height -9999, use and structure unknown
    assert fb["year"] is None and fb["stories"] == 0.0 and fb["height"] == 0.0
    assert fb["use"] == "" and fb["class"] == "461" and fb["material"] == ""
    assert fc["stories"] == 0.0 and fc["use"] == "residential"
    assert fc["material"] == "reinforced concrete" and fc["height"] == 21.5


def test_a_self_crossing_footprint_keeps_its_area_and_a_building_its_own_attributes():
    # a bow-tie with a spike: make_valid nests a multipolygon beside a line
    ring_ = np.array(
        [(y, x, 0.0) for x, y in [(0, 0), (2, 2), (2, 0), (0, 2), (-1, 3), (0, 2), (0, 0)]]
    )
    g = plateau._footprint([(ring_, [])])
    assert g is not None and g.geom_type == "MultiPolygon" and g.area == pytest.approx(2.0)
    # a part's attributes come after its own in document order, but the building's win
    part = building("bldg_p", {"usage": "402"}, uro={"buildingStructureType": "604"})
    part = part.replace("core:cityObjectMember", "bldg:consistsOfBuildingPart")
    part = part.replace("bldg:Building ", "bldg:BuildingPart ").replace(
        "</bldg:Building>", "</bldg:BuildingPart>"
    )
    whole = building("bldg_w", {"usage": "411"}, lod0=(box(0, 0, 10, 6), []))
    whole = whole.replace(
        "</bldg:Building>",
        part + "<uro:buildingDetailAttribute>"
        "<uro:BuildingDetailAttribute><uro:buildingStructureType>601</uro:buildingStructureType>"
        "</uro:BuildingDetailAttribute></uro:buildingDetailAttribute></bldg:Building>",
    )
    (rec,) = plateau.parse(io.BytesIO(citygml(whole)))
    assert (rec["id"], rec["usage"], rec["structure"]) == ("bldg_w", "411", "601")


def test_codes_map_to_use_groups_and_materials():
    use = lambda code: plateau.building_facts({"usage": code})["use"]  # noqa: E731
    assert [use(c) for c in ("401", "403", "411", "412", "414", "422", "441", "461")] == [
        "commercial",
        "commercial",
        "residential",
        "residential",
        "mixed",
        "civic",
        "industrial",
        "",
    ]
    mat = lambda code: plateau.building_facts({"structure": code})["material"]  # noqa: E731
    assert [mat(c) for c in ("601", "602", "604", "605", "606", "611")] == [
        "wood",
        "steel reinforced concrete",
        "steel",
        "light steel",
        "masonry",
        "",
    ]


def _catalog(*cities):
    return json.dumps({"cities": list(cities), "featureTypes": []}).encode()


def _city(code, name, mesh, size, features, year=2025):
    url = f"https://example.test/{code}/udx/bldg/{mesh}_bldg_6697_op.gml"
    return {
        "cityCode": code,
        "cityName": name,
        "year": year,
        "spec": "5.0",
        "url": f"https://example.test/{code}.zip",
        "files": {
            "bldg": [
                {
                    "code": mesh,
                    "url": url,
                    "fileSize": size,
                    "features": features,
                    **{f"lod{i}": features for i in range(2)},
                    "lod2": features // 3,
                }
            ]
        },
    }


def test_catalog_reads_a_ward_border_mesh_once(monkeypatch):
    doc = _catalog(
        _city("13103", "港区", "53393596", 102_444_284, 1946),
        _city("13113", "渋谷区", "53393596", 101_932_486, 1946),
        _city("13104", "新宿区", "53393596", 5_000_000, 120),
        _city("13110", "目黒区", "53393586", 9_000_000, 300),  # another mesh's file
        _city("13109", "品川区", "53393596", 7_000_000, 120),  # Shinjuku's counts by chance
    )
    monkeypatch.setattr(plateau, "get", lambda url, timeout=120: doc)
    entries = plateau.catalog("53393596")
    # Minato's copy of the border mesh stands for Shibuya's; Shinjuku's and
    # Shinagawa's own files (the same counts, sizes 40% apart) are both kept
    assert [(e["city"], e["features"]) for e in entries] == [
        ("13103", 1946),
        ("13104", 120),
        ("13109", 120),
    ]
    assert entries[0]["year"] == 2025 and entries[0]["spec"] == "5.0"


def test_a_mesh_two_cities_publish_in_different_years_pins_either(tmp_path, monkeypatch):
    monkeypatch.setattr(http, "CACHE_ROOT", tmp_path)
    doc = _catalog(
        _city("26100", "京都市", "52354600", 1000, 3),
        _city("26208", "向日市", "52354600", 500, 2, year=2024),
    )
    calls = []
    monkeypatch.setattr(plateau, "get", lambda url, timeout=120: calls.append(url) or doc)
    entries = plateau.FootprintFacts._entries("52354600", 2025)
    assert [e["city"] for e in entries] == ["26100", "26208"] and len(calls) == 1
    assert (tmp_path / "plateau" / "catalog-52354600-2024_2025.json").exists()
    for year in (2024, 2025):  # both read the kept answer
        assert [e["city"] for e in plateau.FootprintFacts._entries("52354600", year)] == [
            "26100",
            "26208",
        ]
    assert len(calls) == 1
    with pytest.raises(RuntimeError, match="isn't cached from the 2023 release"):
        plateau.FootprintFacts._entries("52354600", 2023)


def test_facts_from_the_catalog_and_the_extract_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(http, "CACHE_ROOT", tmp_path)
    mesh = "52354600"
    gz = gzip.compress(SAMPLE)
    got = []

    def fake_get(url, headers=None, timeout=120):
        got.append(url)
        if url.startswith(plateau.CATALOG):
            m = url[len(plateau.CATALOG) :]
            if m != mesh:
                return _catalog()
            # the same file listed twice (as Tokyo's wards do), and another city's own
            return _catalog(
                _city("26100", "京都市", mesh, 1000, 3),
                _city("26100", "京都市", mesh, 1020, 3),
            )
        assert headers == {"Accept-Encoding": "gzip"}
        return gz

    monkeypatch.setattr(plateau, "get", fake_get)
    src = plateau.PlateauFacts(REGION, {})
    gml = [u for u in got if u.endswith(".gml")]
    assert len(gml) == 1  # the duplicate listing is read once
    cached = sorted(p.name for p in (tmp_path / "plateau").iterdir())
    assert "26100-2025-spec5_0-52354600-x3.json.gz" in cached
    assert "catalog-52354600-2025.json" in cached
    assert not any(n.endswith(".gml.gz") for n in cached)  # the GML isn't kept
    assert "PLATEAU 京都市 2025 (spec 5.0): 3 buildings in 1 mesh" in src.summary()

    # the machiya's centre, projected: its facts; the courtyard and the street: none
    lon, lat = LON0 + 2 / KX, LAT0 + 3 / KY
    xs, ys = transform_points(
        "EPSG:4326", REGION.crs, [lon, LON0 + 5 / KX, LON0 - 5 / KX], [lat, LAT0 + 3 / KY, lat]
    )
    hits = src.at(np.array(xs), np.array(ys))
    assert hits[0]["class"] == "413" and hits[0]["roof"] == "gabled"
    assert hits[1] is None and hits[2] is None

    # again: the extract is read from the cache (the catalog is still asked)
    got.clear()
    plateau.PlateauFacts(REGION, {})
    assert got and not any(u.endswith(".gml") for u in got)
    # pinned to the release it cached: no network at all (meshes without models included)
    got.clear()
    plateau.PlateauFacts(REGION, {"year": 2025})
    assert got == []
    # pinned to a release it never cached, which the catalog no longer serves: an error
    with pytest.raises(RuntimeError, match="isn't cached from the 2024 release"):
        plateau.PlateauFacts(REGION, {"year": 2024})
    # keepGml keeps the gzipped file
    for p in (tmp_path / "plateau").glob("*.json.gz"):
        p.unlink()
    plateau.PlateauFacts(REGION, {"keepGml": True})
    assert (tmp_path / "plateau" / "26100-2025-52354600_bldg.gml.gz").read_bytes() == gz
    with pytest.raises(ValueError, match="unknown option"):
        plateau.PlateauFacts(REGION, {"rollYear": 2025})


# ---- GSI ------------------------------------------------------------------------------------


def _png(x: np.ndarray) -> bytes:
    """A GSI elevation tile with the 24-bit values x."""
    rgb = np.stack([(x >> 16) & 255, (x >> 8) & 255, x & 255]).astype(np.uint8)
    with warnings.catch_warnings(), MemoryFile() as mem:
        warnings.simplefilter("ignore", NotGeoreferencedWarning)
        with mem.open(
            driver="PNG", width=x.shape[1], height=x.shape[0], count=3, dtype="uint8"
        ) as f:
            f.write(rgb)
        return mem.read()


def _const(h: float) -> bytes:
    return _png(np.full((256, 256), round(h * 100), dtype=np.int64))


def test_tiles_decode_heights_no_data_and_below_sea_level():
    x = np.zeros((256, 256), dtype=np.int64)
    x[0, :4] = [0, 1234, 1 << 23, (1 << 24) - 107]
    x[1, 0] = 377_699  # Mount Fuji's summit, 3776.99 m
    h = gsi.decode(_png(x))
    assert h.dtype == np.float32 and h.shape == (256, 256)
    assert h[0, 0] == 0 and h[0, 1] == pytest.approx(12.34)
    assert np.isnan(h[0, 2]) and h[0, 3] == pytest.approx(-1.07)
    assert h[1, 0] == pytest.approx(3776.99)


def test_tile_coordinates_and_zooms():
    # Kyoto at zoom 17 (checked against the live tiles)
    assert gsi.tile_xy(135.77, 35.0, 17) == (114968, 51917)
    assert gsi.tile_xy(135.77, 35.0, 15) == (114968 >> 2, 51917 >> 2)
    # 1 m: zoom 17; 4 m: 15; 8 m: 14; far coarser: lower
    assert [gsi.zoom_for(r, 35.0) for r in (1, 4, 8, 1000)] == [17, 15, 14, 8]


def test_dem1a_where_it_exists_dem5a_then_dem10b_elsewhere(tmp_path, monkeypatch):
    monkeypatch.setattr(http, "CACHE_ROOT", tmp_path)
    region = REGION
    w, s, e, n = region.lonlat_envelope(0.0)
    # DEM1A has only the tiles west of the region's middle; DEM5A's tile has no
    # data south of the region's middle (water, say)
    lon_mid, lat_mid = (w + e) / 2, (s + n) / 2
    mid_x17 = gsi.tile_xy(lon_mid, 35.0, 17)[0]
    fy = (1 - math.asinh(math.tan(math.radians(lat_mid))) / math.pi) / 2 * (1 << 15)
    holed = np.full((256, 256), 5000, dtype=np.int64)
    holed[int((fy % 1) * 256) :] = 1 << 23
    urls = []

    def fake_get(url, timeout=120):
        urls.append(url)
        dem, z, x, y = url.removesuffix(".png").split("/")[-4:]
        if dem == "dem1a_png" and int(x) < mid_x17:
            return _const(30.0)
        if dem == "dem5a_png":
            return _png(holed)
        if dem == "dem_png":
            return _const(70.0)
        raise urllib.error.HTTPError(url, 404, "Not Found", None, None)

    monkeypatch.setattr(gsi, "get", fake_get)
    cx, cy = region.cells
    dst = np.full((cy + 1, cx + 1), np.nan, dtype=np.float32)
    args = (region.corner_transform(), region.crs, region.lonlat_envelope(0.002), 1)
    missing = gsi.GSI_DEM.read_into(dst, *args, Resampling.average, np.nan)
    assert missing == [] and not np.isnan(dst).any()
    assert set(np.unique(dst).tolist()) <= {30.0, 50.0, 70.0}
    # every DEM is used: 1 m in the west, 5 m in the north-east, 10 m in the south-east
    assert {30.0, 50.0, 70.0} <= set(np.unique(dst).tolist())
    assert dst[0, 0] == 30.0  # north-west corner
    first = len(urls)
    zs = {u.split("/")[-4] + "/" + u.split("/")[-3] for u in urls}
    assert zs == {"dem1a_png/17", "dem5a_png/15", "dem_png/14"}
    # the 404s are cached as empty files; a second read fetches nothing
    assert any(p.stat().st_size == 0 for p in (tmp_path / "gsi" / "dem1a_png").rglob("*.png"))
    gsi.GSI_DEM.read_into(dst, *args, Resampling.average, np.nan)
    assert len(urls) == first
    # at 4 m the tiles are read at zoom 15
    urls.clear()
    gsi.GSI_DEM.read_into(
        dst, region.corner_transform(), region.crs, args[2], 4, Resampling.average, np.nan
    )
    assert {u.split("/")[-3] for u in urls} <= {"15", "14"}


def test_where_no_dem_has_a_tile_it_says_so(tmp_path, monkeypatch):
    monkeypatch.setattr(http, "CACHE_ROOT", tmp_path)

    def gone(url, timeout=120):
        raise urllib.error.HTTPError(url, 404, "Not Found", None, None)

    monkeypatch.setattr(gsi, "get", gone)
    dst = np.full((4, 4), np.nan, dtype=np.float32)
    missing = gsi.GSI_DEM.read_into(
        dst,
        from_origin(140.0, 30.0, 1e-4, 1e-4),
        "EPSG:4326",
        (140.0, 29.999, 140.001, 30.0),
        1,
        Resampling.average,
        np.nan,
    )
    assert missing and missing[0].startswith("dem_png/14/") and np.isnan(dst).all()
    # other errors aren't swallowed
    monkeypatch.setattr(
        gsi,
        "get",
        lambda url, timeout=120: (_ for _ in ()).throw(
            urllib.error.HTTPError(url, 503, "Unavailable", None, None)
        ),
    )
    with pytest.raises(urllib.error.HTTPError):
        gsi.tile("dem1a_png", 17, 1, 2)


def test_the_pack_registers_its_plugins_with_attribution():
    assert plugins.load(plugins.FACTS, "plateau") is plateau.PlateauFacts
    assert plugins.available(plugins.FACTS)["plateau"].origin == "pixelworld-city-jp"
    assert issubclass(plateau.PlateauFacts, facts.FactsSource)
    assert facts.attribution({"facts": "plateau"}) == plateau.ATTRIBUTION
    (a,) = plateau.ATTRIBUTION
    assert "出典：国土交通省 PLATEAUウェブサイト" in a["name"] and "加工して作成" in a["name"]
    assert "PDL 1.0" in a["license"] and "CC BY 4.0" in a["license"]
    assert rasters.source("gsi-dem", "terrain") is gsi.GSI_DEM
    assert plugins.available(plugins.SOURCES)["gsi-dem"].origin == "pixelworld-city-jp"
    g = gsi.GSI_DEM.attribution
    assert "出典：国土地理院ウェブサイト" in g["name"] and "を加工して作成" in g["name"]
    assert "PDL 1.0" in g["license"]
