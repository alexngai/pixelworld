"""The Python API (`pixelworld_pipeline.build`) and the CLI on top of it, offline."""

import importlib
import json
import re
from pathlib import Path

import pytest
import yaml

import pixelworld_pipeline
from pixelworld_pipeline import api, cli, plugins
from pixelworld_pipeline import build as build_module_attr

SPEC = {
    "id": "api-test",
    "name": "API test",
    "bounds": [-115.2, 36.0, -115.0, 36.2],
    "metersPerCell": 1000,
    "style": "desert-southwest",
    "start": {"lon": -115.1, "lat": 36.1},
    "sources": {
        "dem": {"kind": "usgs-3dep-1arcsec"},
        "landcover": {"kind": "esa-worldcover-2021"},
        "overture": {"release": "2026-10-21.0"},
        "roads": {"classes": ["primary"]},
    },
}


def test_the_package_exposes_build_beside_the_build_module():
    module = importlib.import_module("pixelworld_pipeline.build")
    assert pixelworld_pipeline.build is api.build is build_module_attr
    assert callable(pixelworld_pipeline.build) and hasattr(module, "refresh_heroes")
    assert "Returns:" in pixelworld_pipeline.build.__doc__
    assert pixelworld_pipeline.check is api.check


def _write_package(out, packageHash="h"):
    (out / "chunks").mkdir(parents=True, exist_ok=True)
    (out / "chunks" / "0_0.pxwc.gz").write_bytes(b"chunk")
    (out / "manifest.json").write_text(json.dumps({"packageHash": packageHash}))


@pytest.fixture
def recorded(monkeypatch):
    """api.build's stages, recorded instead of run (each writes a stand-in package)."""
    calls = {}

    def fake_build(path, out, compress=True, region=None):
        calls["build"] = (Path(path), Path(out), compress, region)
        _write_package(Path(out), "h-before-routes")
        return {"packageHash": "h-before-routes", "roads": {"ok": True}}

    def fake_routes(path, out, spec=None):
        calls["routes"] = (Path(path), Path(out), spec)
        _write_package(Path(out), "h")  # routes rewrite the manifest, and its hash
        return {"file": "routes.json.gz"}

    monkeypatch.setattr(api, "build_package", fake_build)
    monkeypatch.setattr(api, "refresh_routes", fake_routes)
    return calls


def test_build_takes_a_spec_path(tmp_path, recorded):
    path = tmp_path / "world.yaml"
    path.write_text(yaml.safe_dump(SPEC))
    report = pixelworld_pipeline.build(path, tmp_path / "out", compress=False)
    # the hash of the package as written, after routes
    assert report == {
        "packageHash": "h",
        "roads": {"ok": True},
        "routes": {"file": "routes.json.gz"},
    }
    spec_path, stage, compress, region = recorded["build"]
    assert spec_path == path and compress is False
    assert stage != tmp_path / "out" and stage.parent == tmp_path  # built beside, then moved
    assert region.id == "api-test" and recorded["routes"][2]["id"] == "api-test"
    assert json.loads((tmp_path / "out" / "manifest.json").read_text())["packageHash"] == "h"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["out", "world.yaml"]


def test_build_takes_a_dict_resolved_from_its_base_dir(tmp_path, recorded):
    base = tmp_path / "worlds" / "x"
    (base.parent / "_landmarks").mkdir(parents=True)
    base.mkdir()
    (base / "region.yaml").write_text(yaml.safe_dump(SPEC | {"name": "Base"}))
    (base.parent / "_landmarks" / "tower.yaml").write_text(
        yaml.safe_dump(
            {
                "anchor": {"lon": -115.1, "lat": 36.1},
                "height": 100,
                "depictions": {"generic": {"group": "landmark.tower"}},
            }
        )
    )
    spec = {
        "extends": "region.yaml",
        "id": "api-dict",
        "metersPerCell": 500,
        "objects": {"landmarks": ["tower"]},
    }
    before = yaml.safe_dump(spec)
    report = pixelworld_pipeline.build(spec, tmp_path / "out", base_dir=base, routes=False)
    assert "routes" not in report and "routes" not in recorded
    spec_path, _, compress, region = recorded["build"]
    assert spec_path.parent == base and compress is True
    assert (region.id, region.name, region.meters_per_cell) == ("api-dict", "Base", 500.0)
    assert region.objects["landmarks"][0]["group"] == "landmark.tower"  # from ../_landmarks
    assert yaml.safe_dump(spec) == before  # the caller's dict is left alone


def test_build_writes_to_fixtures_by_default(tmp_path, monkeypatch, recorded):
    monkeypatch.setattr(api, "staged", _no_stage)
    _no_stage.outs.clear()
    pixelworld_pipeline.build(SPEC, base_dir=tmp_path)
    assert _no_stage.outs == [api.default_out_dir("api-test")]
    assert api.default_out_dir("x").parts[-2:] == ("fixtures", "x")  # this checkout's


class _no_stage:
    """api.staged without touching the checkout's fixtures/ (a test must not write there)."""

    outs: list = []

    def __init__(self, out):
        self.outs.append(out)

    def __enter__(self):
        import tempfile

        self.tmp = tempfile.TemporaryDirectory()
        return Path(self.tmp.name)

    def __exit__(self, *exc):
        self.tmp.cleanup()


def test_a_failed_build_leaves_the_previous_package_as_it_was(tmp_path, recorded, monkeypatch):
    path = tmp_path / "world.yaml"
    path.write_text(yaml.safe_dump(SPEC))
    out = tmp_path / "out"
    _write_package(out, "previous")
    (out / "notes.txt").write_text("mine")  # not a package file: never touched
    before = {p: p.read_bytes() for p in out.rglob("*") if p.is_file()}

    def broken_routes(path, out, spec=None):
        (Path(out) / "routes.json.gz").write_bytes(b"half")
        raise RuntimeError("routes crashed")

    monkeypatch.setattr(api, "refresh_routes", broken_routes)
    with pytest.raises(RuntimeError, match="routes crashed"):
        pixelworld_pipeline.build(path, out)
    assert {p: p.read_bytes() for p in out.rglob("*") if p.is_file()} == before
    assert sorted(p.name for p in tmp_path.iterdir()) == ["out", "world.yaml"]  # no scratch left
    # and a first build that fails leaves no package at all
    with pytest.raises(RuntimeError):
        pixelworld_pipeline.build(path, tmp_path / "new")
    assert not (tmp_path / "new" / "manifest.json").exists()


def test_a_rebuild_replaces_the_old_package_files_and_keeps_others(tmp_path, recorded):
    path = tmp_path / "world.yaml"
    path.write_text(yaml.safe_dump(SPEC))
    out = tmp_path / "out"
    _write_package(out, "previous")
    (out / "chunks" / "9_9.pxwc.gz").write_bytes(b"stale chunk")
    (out / "geo.i32.gz").write_bytes(b"stale")
    (out / "notes.txt").write_text("mine")
    pixelworld_pipeline.build(path, out)
    assert sorted(p.name for p in (out / "chunks").iterdir()) == ["0_0.pxwc.gz"]
    assert not (out / "geo.i32.gz").exists()  # this build wrote none
    assert (out / "notes.txt").read_text() == "mine"


def test_a_missing_facts_plugin_fails_before_anything_is_fetched(tmp_path, monkeypatch):
    stage = importlib.import_module("pixelworld_pipeline.build")  # the module, not the API

    def no_fetch(*args, **kwargs):
        raise AssertionError("the build went on to fetch data")

    monkeypatch.setattr(stage, "make_layout", no_fetch)
    monkeypatch.setattr(plugins, "_entry_points", lambda group: ())
    spec = SPEC | {"objects": {"typology": {"facts": "datasf", "rules": []}}}
    with pytest.raises(plugins.PluginNotFoundError, match="pip install pixelworld-city-sf"):
        pixelworld_pipeline.build(spec, tmp_path / "out", base_dir=tmp_path)
    # the CLI says the same, without a traceback
    path = tmp_path / "sf.yaml"
    path.write_text(yaml.safe_dump(spec))
    assert cli.main(["build", str(path), "--out", str(tmp_path / "out")]) == cli.INVALID


REPORT = {
    "packageHash": "abc",
    "cells": [10, 12],
    "chunks": 1,
    "objects": {"tree": 4},
    "roads": {"ok": True, "split_segments": 0},
    "routes": {"routes": 2},
}


def test_the_cli_builds_through_the_api(tmp_path, monkeypatch, capsys):
    path = tmp_path / "world.yaml"
    path.write_text(yaml.safe_dump(SPEC))
    seen = {}

    def fake(spec, out_dir=None, *, compress=True, routes=True):
        seen.update(spec=spec, out=out_dir, compress=compress, routes=routes)
        return REPORT

    monkeypatch.setattr(api, "build", fake)
    assert cli.main(["build", str(path), "--out", str(tmp_path / "o"), "--no-routes"]) == cli.OK
    assert seen == {"spec": path, "out": tmp_path / "o", "compress": True, "routes": False}
    out, err = capsys.readouterr()
    assert f"wrote {tmp_path / 'o'}" in out and "packageHash abc" in out
    assert "10×12 cells, 1 chunks, 4 objects, 2 routes" in out
    assert "building" in err  # progress goes to stderr
    # --json: the report alone on stdout
    assert cli.main(["build", str(path), "--out", str(tmp_path / "o"), "--json"]) == cli.OK
    out, err = capsys.readouterr()
    assert json.loads(out) == REPORT and "packageHash abc" in err


def test_exit_codes_tell_road_problems_from_bad_specs_and_failed_builds(
    tmp_path, monkeypatch, capsys
):
    path = tmp_path / "world.yaml"
    path.write_text(yaml.safe_dump(SPEC))
    out = ["--out", str(tmp_path / "o")]

    monkeypatch.setattr(api, "build", lambda *a, **k: REPORT | {"roads": {"ok": False, "x": 1}})
    assert cli.main(["build", str(path), *out]) == cli.PROBLEMS == 1
    assert "road report found problems" in capsys.readouterr().err

    def crash(*a, **k):
        from pixelworld_pipeline import progress

        progress.stage("routes")
        raise ZeroDivisionError("a bug")

    monkeypatch.setattr(api, "build", crash)
    assert cli.main(["build", str(path), *out]) == cli.FAILED == 3
    err = capsys.readouterr().err
    assert "failed in the routes stage: ZeroDivisionError: a bug" in err
    assert "--no-routes" in err and "left as it was" in err and "Traceback" in err

    def offline(*a, **k):
        import urllib.error

        raise urllib.error.URLError("no route to host")

    monkeypatch.setattr(api, "build", offline)
    assert cli.main(["build", str(path), *out]) == cli.FAILED
    err = capsys.readouterr().err
    assert "a download failed" in err and "Traceback" not in err

    path.write_text(yaml.safe_dump(SPEC | {"maxSlope": 2.7}))
    assert cli.main(["build", str(path), *out]) == cli.INVALID == 2
    assert "maxSlope: must be a whole number, not 2.7" in capsys.readouterr().err
    assert cli.EPILOG.count("\n  ") >= 4 and "PIXELWORLD_CACHE" in cli.EPILOG


def test_the_help_speaks_plainly():
    help_text = cli.parser().format_help()
    for name, sub in cli.parser()._subparsers._group_actions[0].choices.items():
        help_text += sub.format_help()
        assert "D-0" not in sub.format_help(), name
    assert "D-0" not in help_text and "exit codes" in help_text
    for command in ("build", "check", "view", "reference"):
        assert command in help_text


def test_the_plugins_command_lists_and_checks(tmp_path, capsys, monkeypatch):
    path = tmp_path / "world.yaml"
    path.write_text(yaml.safe_dump(SPEC))
    assert cli.main(["plugins", str(path)]) == 0
    out = capsys.readouterr().out
    assert "usgs-3dep-13arcsec" in out and "builtin" in out and "pixelworld.facts" in out
    assert "every plugin it names is installed" in out

    # columns never run together, however long a plugin's distribution name is
    long = plugins.Plugin(
        plugins.FACTS, "mining-town", "pixelworld-facts-mining-town", "pkg.module:Factory"
    )
    monkeypatch.setattr(plugins, "available", lambda group: {"mining-town": long})
    assert cli.main(["plugins"]) == 0
    out = capsys.readouterr().out
    row = next(ln for ln in out.splitlines() if "mining-town" in ln)
    assert re.fullmatch(r"  mining-town +\S+ {2,}pkg\.module:Factory", row), row


def test_check_reports_every_problem_without_building(tmp_path, capsys):
    good = tmp_path / "good.yaml"
    good.write_text(yaml.safe_dump(SPEC))
    bad = tmp_path / "bad.yaml"
    bad.write_text(
        "id: bad\nname: Bad\nbounds: [-115.2, 36.0, -115.0, 36.2]\nmetersPerCell: 100\n"
        "verticalExageration: 2\nstyle: desert-southwest\nstart: {lon: -115.1, lat: 36.1}\n"
        "sources:\n  dem: {kind: usgs-3dep-1arcsec}\n  landcover: {kind: esa-worldcover-2021}\n"
        "  overture: {release: 2026-10-21.0}\n  roads: {classes: [primary, residental]}\n"
    )
    assert cli.main(["check", str(good), str(bad)]) == cli.INVALID
    out, err = capsys.readouterr()
    assert f"{good}: ok (api-test: " in out
    assert f"{bad}:5: verticalExageration: unknown key; did you mean 'verticalExaggeration'?" in err
    assert f"{bad}:12: sources.roads.classes[1]: unknown value 'residental'" in err
    assert f"{bad}: 2 problems" in err
    region, issues = pixelworld_pipeline.check(good)
    assert region.id == "api-test" and issues == []
