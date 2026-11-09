"""The pipeline's Python API: builds driven from code, beside the CLI."""

from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any

from .build import build as build_package
from .landmarks import expand
from .region import Region, load_spec, resolve_spec
from .routes import refresh_routes

REPO = Path(__file__).resolve().parents[3]


def default_out_dir(world_id: str) -> Path:
    """Where a world is built by default: `fixtures/<id>` of the repository
    checkout the pipeline runs from, else `./<id>`."""
    if (REPO / "pipeline" / "pyproject.toml").is_file() and (REPO / "fixtures").is_dir():
        return REPO / "fixtures" / world_id
    return Path.cwd() / world_id


def load_region(
    spec: str | os.PathLike | dict[str, Any], base_dir: str | os.PathLike | None = None
) -> tuple[Region, dict[str, Any], Path]:
    """(the Region, the resolved spec, the spec's path) for a spec given as a
    path or as a dict. A dict has no file of its own: the path returned is
    where it is taken to stand (in `base_dir`, default the current directory),
    so the files it refers to are found beside it."""
    if isinstance(spec, dict):
        base = Path(base_dir) if base_dir is not None else Path.cwd()
        raw = resolve_spec(copy.deepcopy(spec), base)
        path = base / f"{raw.get('id', 'region')}.yaml"
    else:
        path = Path(spec)
        raw = load_spec(path)
    return Region.from_dict(expand(raw, path)), raw, path


def build(
    spec: str | os.PathLike | dict[str, Any],
    out_dir: str | os.PathLike | None = None,
    *,
    base_dir: str | os.PathLike | None = None,
    compress: bool = True,
    routes: bool = True,
) -> dict[str, Any]:
    """Build a world package from a region spec, as `pixelworld build` does.

    Args:
        spec: the path of a region spec (`worlds/<id>/region.yaml`), or the
            spec itself as a dict, as its YAML would load. A dict's references
            to other files (`extends: region.yaml`, `warp: warp.yaml`), the
            landmark registry (the nearest `_landmarks/` directory) and the
            importance snapshot (`importance.json`) are looked up from
            `base_dir`. The dict isn't modified.
        out_dir: the package directory. Default: `fixtures/<id>` of the
            repository checkout the pipeline runs from, else `./<id>`.
        base_dir: the directory a dict spec stands in (default: the current
            directory); ignored for a path.
        compress: gzip the chunks (the CLI's `--no-compress` turns it off).
        routes: also write the ambient traffic routes (D-060), as the CLI does
            unless given `--no-routes`.

    Returns:
        The build report, also written to `<out_dir>/build-report.json`: the
        package hash, cells, chunks, height range, object counts per group, the
        road report (`report["roads"]["ok"]` is False when the network has
        problems; the CLI then exits with 1) and, with `routes`, the routes'
        manifest entry.

    Raises:
        RegionError: the spec is invalid.
        PluginError: the spec names a plugin (a facts source, a terrain or land
            cover source) that isn't installed; the message lists those that are.

    Example:
        >>> import pixelworld_pipeline
        >>> report = pixelworld_pipeline.build("worlds/sf/walk.yaml", "/tmp/sf-walk")
        >>> report["packageHash"]  # doctest: +SKIP

    Builds are deterministic: the same spec and cached inputs give the same
    package, byte for byte. Downloads are cached in the pipeline's cache
    directory (`pipeline/.cache`, or `$PIXELWORLD_CACHE`).
    """
    region, raw, path = load_region(spec, base_dir)
    out = Path(out_dir) if out_dir is not None else default_out_dir(region.id)
    report = build_package(path, out, compress=compress, region=region)
    if routes:
        report["routes"] = refresh_routes(path, out, spec=raw)
    return report
