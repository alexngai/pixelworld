"""The Python API (`pixelworld_pipeline.build`) and the CLI on top of it, offline."""

import importlib
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
    "style": "s",
    "start": {"lon": -115.1, "lat": 36.1},
    "sources": {"dem": {"kind": "usgs-3dep-1arcsec"}, "landcover": {"kind": "esa-worldcover-2021"}},
}


def test_the_package_exposes_build_beside_the_build_module():
    module = importlib.import_module("pixelworld_pipeline.build")
    assert pixelworld_pipeline.build is api.build is build_module_attr
    assert callable(pixelworld_pipeline.build) and hasattr(module, "refresh_heroes")
    assert "Returns:" in pixelworld_pipeline.build.__doc__


@pytest.fixture
def recorded(monkeypatch):
    """api.build's stages, recorded instead of run."""
    calls = {}

    def fake_build(path, out, compress=True, region=None):
        calls["build"] = (Path(path), Path(out), compress, region)
        return {"packageHash": "h", "roads": {"ok": True}}

    def fake_routes(path, out, spec=None):
        calls["routes"] = (Path(path), Path(out), spec)
        return {"file": "routes.json.gz"}

    monkeypatch.setattr(api, "build_package", fake_build)
    monkeypatch.setattr(api, "refresh_routes", fake_routes)
    return calls


def test_build_takes_a_spec_path(tmp_path, recorded):
    path = tmp_path / "world.yaml"
    path.write_text(yaml.safe_dump(SPEC))
    report = pixelworld_pipeline.build(path, tmp_path / "out", compress=False)
    assert report == {
        "packageHash": "h",
        "roads": {"ok": True},
        "routes": {"file": "routes.json.gz"},
    }
    spec_path, out, compress, region = recorded["build"]
    assert spec_path == path and out == tmp_path / "out" and compress is False
    assert region.id == "api-test" and recorded["routes"][2]["id"] == "api-test"


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


def test_build_writes_to_fixtures_by_default(tmp_path, recorded):
    pixelworld_pipeline.build(SPEC, base_dir=tmp_path)
    assert recorded["build"][1] == api.default_out_dir("api-test")
    assert api.default_out_dir("x").parts[-2:] == ("fixtures", "x")  # this checkout's


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
    assert cli.main(["build", str(path), "--out", str(tmp_path / "out")]) == 2


def test_the_cli_builds_through_the_api(tmp_path, monkeypatch, capsys):
    path = tmp_path / "world.yaml"
    path.write_text(yaml.safe_dump(SPEC))
    seen = {}

    def fake(spec, out_dir=None, *, compress=True, routes=True):
        seen.update(spec=spec, out=out_dir, compress=compress, routes=routes)
        return {"roads": {"ok": False}}

    monkeypatch.setattr(api, "build", fake)
    assert cli.main(["build", str(path), "--out", str(tmp_path / "o"), "--no-routes"]) == 1
    assert seen == {"spec": path, "out": tmp_path / "o", "compress": True, "routes": False}
    assert f"wrote {tmp_path / 'o'}" in capsys.readouterr().out


def test_the_plugins_command_lists_and_checks(tmp_path, capsys):
    path = tmp_path / "world.yaml"
    path.write_text(yaml.safe_dump(SPEC))
    assert cli.main(["plugins", str(path)]) == 0
    out = capsys.readouterr().out
    assert "usgs-3dep-13arcsec" in out and "builtin" in out and "pixelworld.facts" in out
    assert "every plugin it names is installed" in out
