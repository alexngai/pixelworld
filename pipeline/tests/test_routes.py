"""Ambient traffic routes (D-060): traced from a built package's road layer,
bridge decks at their height, rail matched onto the streets, deterministic."""

from __future__ import annotations

import json

import numpy as np
import pytest

from pixelworld_pipeline import roads as road_stage
from pixelworld_pipeline import routes as R
from pixelworld_pipeline.world_format import NO_WATER, write_package

W, H = 40, 30


def _package(tmp_path, *, bridge: bool = False, objects=None):
    """A flat 40×30 world (height 2): a street along y = 10 from x = 2 to 37
    crossed by one along x = 20 (y 2..27), and an L-shaped lane. With
    `bridge`, a strip of water x 26..31 cuts the long street, spanned by a
    bridge landmark at deck height 7."""
    base = np.full((H, W), 2, np.int16)
    shape = np.zeros((H, W), np.uint8)
    surface = np.ones((H, W), np.uint8)
    water = np.full((H, W), NO_WATER, np.int16)
    lines = [
        ("main", 2, [(np.array([2.5, 37.5]), np.array([10.5, 10.5]))]),
        ("cross", 1, [(np.array([20.5, 20.5]), np.array([2.5, 27.5]))]),
        ("lane", 1, [(np.array([5.5, 5.5, 12.5]), np.array([15.5, 25.5, 25.5]))]),
    ]
    layer = road_stage.rasterize(lines, (H, W))
    road, rcls = layer.mask, layer.cls
    instances = list(objects or [])
    if bridge:
        water[:, 26:32] = 1
        base[:, 26:32] = 1
        surface[:, 26:32] = 5
        road[:, 26:32] = 0
        rcls[:, 26:32] = 0
        instances.append(
            {
                "g": "landmark.bridge.suspension",
                "x": 29.0,
                "y": 10.5,
                "s": 0,
                "id": "test-bridge",
                "fp": [[24.0, 10.0], [34.0, 10.0], [34.0, 11.0], [24.0, 11.0]],
                "top": 7.0,
                "z0": 0.0,
                "ln": [24.0, 10.5, 34.0, 10.5],
                "lw": 0.5,
            }
        )
    # a geo grid: 1e-3 degrees per cell east and south of (-122, 37.8)
    xs = np.minimum(np.arange(0, W + 8, 8), W)
    ys = np.minimum(np.arange(0, H + 8, 8), H)
    gx, gy = np.meshgrid(xs, ys)
    lons, lats = -122 + gx * 1e-3, 37.8 - gy * 1e-3
    write_package(
        tmp_path,
        world_id="t",
        name="t",
        base=base,
        shape=shape,
        surface=surface,
        water=water,
        road=road,
        road_class=rcls,
        chunk_size=16,
        scale={"metersPerCell": 25, "metersPerStep": 6.8, "elevationDatumMeters": 0},
        surfaces={1: "grass", 5: "water"},
        road_classes={1: "residential", 2: "primary"},
        style="test",
        attribution=[],
        objects=instances or None,
        geo=(lons, lats, 8),
    )
    return tmp_path


def _pts(route):
    return np.array(route["pts"]).reshape(-1, 3)


def test_roads_follow_the_drawn_cells_and_meet_at_junctions(tmp_path):
    doc, report = R.make_routes(_package(tmp_path))
    roads = [r for r in doc["routes"] if r["net"] == "road"]
    # the crossing splits both streets: 4 arms, plus the lane
    assert len(roads) == 5
    assert report["roads"]["roadCells"] > 60
    for r in roads:
        p = _pts(r)
        # vertices at cell centres, every segment along one of the 8 directions
        assert np.allclose(p[:, :2] % 1, 0.5)
        d = np.diff(p[:, :2], axis=0)
        assert np.all((d[:, 0] == 0) | (d[:, 1] == 0) | (np.abs(d[:, 0]) == np.abs(d[:, 1])))
        assert np.allclose(p[:, 2], 2)  # flat ground at height 2
        # simplified: straight runs keep only their ends (the lane turns its corner diagonally)
        assert len(p) <= 4
        assert doc["nodes"][r["a"]][:2] == list(p[0, :2])
        assert doc["nodes"][r["b"]][:2] == list(p[-1, :2])
    centre = [i for i, n in enumerate(doc["nodes"]) if n[:2] == [20.5, 10.5]]
    assert len(centre) == 1
    assert sum((r["a"] == centre[0]) + (r["b"] == centre[0]) for r in roads) == 4
    assert {r["cls"] for r in roads} == {"primary", "residential"}


def test_a_bridge_deck_carries_the_road_over_water_at_its_height(tmp_path):
    doc, report = R.make_routes(_package(tmp_path, bridge=True))
    assert report["decks"] == ["test-bridge"]
    assert report["roads"]["deckLinks"] == 1
    deck = [r for r in doc["routes"] if r.get("bridge") == "test-bridge"]
    assert len(deck) == 1
    p = _pts(deck[0])
    # from the road's last cell before the water to its first after it, all on
    # the deck: those cells are on its band too
    assert p[0, 0] == 25.5 and p[-1, 0] == 32.5
    assert np.allclose(p[:, 1], 10.5) and np.allclose(p[:, 2], 7)
    # the street along the deck's band over land is lifted to it; the cross street isn't
    main_west = [
        r for r in doc["routes"] if r["net"] == "road" and r.get("deck") and "bridge" not in r
    ]
    assert main_west, "the street on the deck's band over land"
    for r in main_west:
        q = _pts(r)
        on_band = (q[:, 0] >= 24) & (q[:, 0] <= 34)
        assert on_band.any() and np.allclose(q[on_band, 2], 7)
        assert np.allclose(q[q[:, 0] < 23.5, 2], 2)
    cross = [r for r in doc["routes"] if r["net"] == "road" and np.all(_pts(r)[:, 0] == 20.5)]
    assert all(np.allclose(_pts(r)[:, 2], 2) for r in cross)


def test_routes_are_deterministic_and_listed_in_the_manifest(tmp_path):
    pkg = _package(tmp_path, bridge=True)
    a, _ = R.make_routes(pkg)
    b, _ = R.make_routes(pkg)
    assert R.encode_routes(a) == R.encode_routes(b)
    before = json.loads((pkg / "manifest.json").read_text())
    ref = R.write_routes(pkg, a)
    m = json.loads((pkg / "manifest.json").read_text())
    assert m["routes"] == ref and ref["path"] == "routes.json.gz" and ref["version"] == 1
    assert m["packageHash"] != before["packageHash"]
    # chunks untouched
    assert m["chunks"] == before["chunks"]
    assert R.decode_routes((pkg / "routes.json.gz").read_bytes()) == a
    with pytest.raises(ValueError):
        R.decode_routes(json.dumps({"version": 99}).encode())


def _seg(id_, cls, coords, name=None, flags=()):
    wkt = "LINESTRING (" + ", ".join(f"{x} {y}" for x, y in coords) + ")"
    return {
        "id": id_,
        "subtype": "rail",
        "class": cls,
        "subclass": None,
        "name": name,
        "routes": [],
        "flags": list(flags),
        "geometry": wkt,
    }


def _cell(x, y):
    """Lon/lat of a cell position in the test package's geo grid."""
    return (-122 + x * 1e-3, 37.8 - y * 1e-3)


def test_unnamed_tram_networks_can_be_cable_cars():
    rows = [
        _seg("a", "tram", [(0, 0), (1, 0)]),
        _seg("b", "tram", [(1, 0), (2, 0)]),
        _seg("c", "tram", [(5, 5), (6, 5)], name="Muni F"),
        _seg("d", "tram", [(6, 5), (7, 5)]),
        _seg("e", "standard_gauge", [(0, 9), (9, 9)]),
        _seg("f", "standard_gauge", [(0, 8), (9, 8)], flags=["is_tunnel"]),
        _seg("g", "subway", [(0, 7), (9, 7)]),
    ]
    kinds = {r["id"]: k for r, k in R.classify_rail(rows, {"unnamedTram": "cablecar"})}
    assert kinds == {
        "a": "cablecar",
        "b": "cablecar",
        "c": "streetcar",
        "d": "streetcar",
        "e": "train",
    }
    plain = {r["id"]: k for r, k in R.classify_rail(rows, {})}
    assert plain["a"] == "streetcar"


def test_street_running_rail_follows_the_drawn_street(tmp_path):
    pkg = _package(tmp_path)
    # a cable car line half a cell off the long street, and a train line across open ground
    rows = [
        _seg("cc", "tram", [_cell(3.0, 10.1), _cell(36.5, 10.9)]),
        _seg("tr", "standard_gauge", [_cell(2.5, 20.5), _cell(37.5, 22.5)]),
    ]
    doc, report = R.make_routes(pkg, rows, {"rail": {"unnamedTram": "cablecar"}, "ferries": False})
    cc = [r for r in doc["routes"] if r.get("kind") == "cablecar"]
    assert cc and report["rail"]["matched"] == 1
    for r in cc:
        # on the street's cells (y = 10), through the junction with the cross street
        assert np.allclose(_pts(r)[:, 1], 10.5)
    xs = np.concatenate([_pts(r)[:, 0] for r in cc])
    assert xs.min() <= 3.5 and xs.max() >= 36.5
    tr = [r for r in doc["routes"] if r.get("kind") == "train"]
    assert tr
    p = np.concatenate([_pts(r) for r in tr])
    assert np.all((p[:, 1] >= 19.5) & (p[:, 1] <= 23.5))


def test_the_geo_grid_inverts_to_cells(tmp_path):
    pkg = _package(tmp_path)
    m = json.loads((pkg / "manifest.json").read_text())
    geo = R.GeoInverse(pkg, m)
    pts = np.array([[3.25, 4.5], [17.9, 22.1], [39.0, 29.5]])
    lon, lat = _cell(pts[:, 0], pts[:, 1])
    x, y = geo.cells(lon, lat)
    assert np.allclose(np.column_stack([x, y]), pts, atol=1e-6)


def test_single_track_keeps_one_of_two_parallel_tracks():
    a = np.array([[0.0, 0.0], [20.0, 0.0]])
    b = a + [0.0, 0.3]
    c = np.array([[0.0, 5.0], [20.0, 5.0]])
    rows = [({"id": i}, "train", xy) for i, xy in (("a", a), ("b", b), ("c", c))]
    kept = [r[0]["id"] for r in R.single_track(rows)]
    assert kept == ["a", "c"]
