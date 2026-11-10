"""The pipeline's Python API: builds driven from code, beside the CLI."""

from __future__ import annotations

import json
import os
import shutil
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from . import progress
from .build import build as build_package
from .region import Region, SpecError, load_region
from .routes import refresh_routes
from .schema import Issue

REPO = Path(__file__).resolve().parents[3]
# What a build writes into a package directory; other files there are left alone.
PACKAGE_FILES = (
    "manifest.json",
    "build-report.json",
    "objects.json.gz",
    "geo.i32.gz",
    "routes.json.gz",
)
PACKAGE_DIRS = ("chunks", "heroes")

__all__ = ["build", "check", "default_out_dir", "load_region"]


def default_out_dir(world_id: str) -> Path:
    """Where a world is built by default: `fixtures/<id>` of the repository
    checkout the pipeline runs from, else `./<id>`."""
    if (REPO / "pipeline" / "pyproject.toml").is_file() and (REPO / "fixtures").is_dir():
        return REPO / "fixtures" / world_id
    return Path.cwd() / world_id


def check(
    spec: str | os.PathLike | dict[str, Any], base_dir: str | os.PathLike | None = None
) -> tuple[Region | None, list[Issue]]:
    """Check a region spec without building it, as `pixelworld check` does:
    (the Region, or None if the spec has errors; every issue found, errors
    first, each with its key path and, for a file, the file and line). Also
    checks that the plugins the spec names are installed."""
    from . import plugins

    warnings: list[str] = []
    try:
        region, _, path = load_region(spec, base_dir, warn=warnings.append)
    except SpecError as e:
        return None, e.issues
    issues = [Issue((), w, "warning") for w in warnings]
    try:
        plugins.check(region)
    except plugins.PluginError as e:
        return None, [Issue((), str(e)), *issues]
    return region, issues


@contextmanager
def staged(out_dir: Path) -> Iterator[Path]:
    """A fresh directory beside `out_dir` to build into. When the block ends
    normally its files replace the package in `out_dir` (file by file, the
    manifest last, so a running dev server keeps serving a whole package);
    when it fails, `out_dir` is left exactly as it was."""
    out_dir = Path(out_dir)
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    stage = out_dir.parent / f".{out_dir.name}.building"
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir()
    try:
        yield stage
        _replace_package(stage, out_dir)
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def _replace_package(new: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    files = sorted(p.relative_to(new) for p in new.rglob("*") if p.is_file())
    # the old package's files this build didn't write
    old = [out / f for f in PACKAGE_FILES]
    for d in PACKAGE_DIRS:
        if (out / d).is_dir():
            old += [p for p in (out / d).rglob("*") if p.is_file()]
    keep = {out / f for f in files}
    manifest = Path("manifest.json")
    for rel in [f for f in files if f != manifest] + [manifest]:
        if (new / rel).exists():
            (out / rel).parent.mkdir(parents=True, exist_ok=True)
            os.replace(new / rel, out / rel)
    for p in old:
        if p not in keep and p.is_file():
            p.unlink()
    for d in PACKAGE_DIRS:
        for sub in sorted((out / d).rglob("*"), reverse=True) if (out / d).is_dir() else []:
            if sub.is_dir() and not any(sub.iterdir()):
                sub.rmdir()


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
        routes: also write the ambient traffic routes, as the CLI does unless
            given `--no-routes`.

    Returns:
        The build report, also written to `<out_dir>/build-report.json`: the
        package hash (the final one, as in the manifest written), cells,
        chunks, height range, object counts per group, the road report
        (`report["roads"]["ok"]` is False when the network has problems; the
        CLI then exits with 1) and, with `routes`, the routes' report and
        manifest entry.

    Raises:
        RegionError: the spec is invalid (a SpecError lists every problem,
            with its key path, file and line).
        PluginError: the spec names a plugin (a facts source, a terrain or land
            cover source) that isn't installed; the message lists those that are.

    A build writes into a scratch directory beside `out_dir` and moves the
    package into place only when every stage has succeeded: a failed build
    leaves `out_dir` as it was. Progress goes to stderr, a line per stage.

    Example:
        >>> import pixelworld_pipeline
        >>> report = pixelworld_pipeline.build("worlds/sf/walk.yaml", "/tmp/sf-walk")
        >>> report["packageHash"]  # doctest: +SKIP

    Builds are deterministic: the same spec and cached inputs give the same
    package, byte for byte. Downloads are cached in the pipeline's cache
    directory (`pipeline/.cache`, or `$PIXELWORLD_CACHE`).
    """
    with progress.run():
        progress.stage("spec", str(spec) if not isinstance(spec, dict) else "(a dict)")
        region, raw, path = load_region(spec, base_dir, warn=progress.log)
        out = Path(out_dir) if out_dir is not None else default_out_dir(region.id)
        with staged(out) as stage:
            report = build_package(path, stage, compress=compress, region=region)
            if routes:
                progress.stage("routes", "ambient traffic")
                report["routes"] = refresh_routes(path, stage, spec=raw)
            progress.stage("write", str(out))
            # routes rewrite the manifest: report the hash of the package as written
            manifest = json.loads((stage / "manifest.json").read_text())
            report["packageHash"] = manifest["packageHash"]
        return report
