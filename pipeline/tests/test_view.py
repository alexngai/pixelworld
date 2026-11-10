"""`pixelworld view`: a package outside fixtures/ served to the viewer (D-076)."""

import json
import threading
import urllib.request

import pytest

from pixelworld_pipeline import cli, view


@pytest.fixture
def package(tmp_path):
    out = tmp_path / "jerome"
    (out / "chunks").mkdir(parents=True)
    (out / "chunks" / "0_0.pxwc.gz").write_bytes(b"chunk")
    manifest = {"id": "jerome", "name": "Jerome", "style": "desert-southwest"}
    (out / "manifest.json").write_text(json.dumps(manifest))
    return out


def test_the_package_is_served_with_cors_for_the_viewer(package):
    server = view.make_server(package, 0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        base = f"http://127.0.0.1:{server.server_address[1]}/"
        with urllib.request.urlopen(base + "manifest.json") as r:
            assert json.load(r)["id"] == "jerome"
            assert r.headers["Access-Control-Allow-Origin"] == "*"
            assert r.headers["Cache-Control"] == "no-store"  # a rebuild shows on reload
        with urllib.request.urlopen(base + "chunks/0_0.pxwc.gz") as r:
            assert r.read() == b"chunk"
    finally:
        server.shutdown()
        server.server_close()


def test_the_viewer_url_carries_the_package_url():
    url = view.viewer_url("http://localhost:5173", "http://127.0.0.1:8766/")
    assert url == "http://localhost:5173/?world=http://127.0.0.1:8766/"


def test_only_packages_are_served(package, tmp_path, capsys):
    view.check_package(package)
    with pytest.raises(view.PackageError, match="has no manifest.json"):
        view.check_package(tmp_path)
    spec = tmp_path / "region.yaml"
    spec.write_text("id: x\n")
    with pytest.raises(view.PackageError, match="build it first"):
        view.check_package(spec)
    assert cli.main(["view", str(tmp_path)]) == cli.INVALID
    assert "not a world package" in capsys.readouterr().err


def test_a_style_this_viewer_lacks_is_a_warning(package):
    assert view.style_warning({"style": "desert-southwest"}) is None
    warning = view.style_warning({"style": "desert"})
    assert warning and "no style pack desert" in warning
