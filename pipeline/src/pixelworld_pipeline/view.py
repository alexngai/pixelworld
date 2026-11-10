"""`pixelworld view <package>`: serve a built package to the viewer.

The viewer (`pnpm dev` in the repository, http://localhost:5173) serves the
packages in `fixtures/`; any other package is opened by URL with
`?world=<url>`. This serves one package directory over HTTP with CORS
headers, so the viewer can fetch it from another port, and prints the URL to
open. Binds to 127.0.0.1.
"""

from __future__ import annotations

import functools
import json
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote

DEFAULT_PORT = 8766
DEFAULT_VIEWER = "http://localhost:5173/"


class PackageError(ValueError):
    pass


class CORSHandler(SimpleHTTPRequestHandler):
    """Static files with `Access-Control-Allow-Origin: *`, never cached (a
    rebuild shows on the next reload)."""

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args) -> None:  # quiet
        pass


def check_package(path: Path) -> dict:
    """The package's manifest; PackageError if `path` isn't a package."""
    path = Path(path)
    if path.suffix in (".yaml", ".yml") and path.is_file():
        raise PackageError(
            f"{path} is a region spec, not a package: build it first "
            f"(pixelworld build {path} --out <dir>), then view <dir>"
        )
    manifest = path / "manifest.json"
    if not manifest.is_file():
        raise PackageError(f"{path} is not a world package (it has no manifest.json)")
    try:
        return json.loads(manifest.read_text())
    except json.JSONDecodeError as e:
        raise PackageError(f"{manifest} is not valid JSON ({e})") from None


def viewer_url(viewer: str, package_url: str, query: str = "") -> str:
    base = viewer if viewer.endswith("/") else viewer + "/"
    return f"{base}?world={quote(package_url, safe=':/')}{'&' + query if query else ''}"


def reachable(url: str, timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout):
            return True
    except (urllib.error.URLError, OSError, ValueError):
        return False


def make_server(root: Path, port: int) -> ThreadingHTTPServer:
    handler = functools.partial(CORSHandler, directory=str(root))
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


def style_warning(manifest: dict) -> str | None:
    """Why this repository's viewer can't draw the package, if its style pack
    isn't one of worlds/_styles."""
    from .schema import repo_styles_dir, style_packs

    root = repo_styles_dir()
    style = manifest.get("style")
    if root is None or not style or style in style_packs(root):
        return None
    return (
        f"its style pack '{style}' isn't in {root}, so the viewer will say "
        f"'no style pack {style}' (there: {', '.join(style_packs(root))})"
    )
