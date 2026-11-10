"""Command-line entry point: `uv run pixelworld build <region.yaml>`.

The same builds are available from Python: `pixelworld_pipeline.build(spec)`.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from importlib import metadata
from pathlib import Path

from . import progress
from .plugins import PluginError
from .region import Region, RegionError

# Exit codes (also in `pixelworld --help` and docs/worlds.md)
OK = 0  # done
PROBLEMS = 1  # the package was written, but its road report found problems
INVALID = 2  # the spec (or the command line) is invalid; nothing was built
FAILED = 3  # the build failed (a download, or a bug); the output was left as it was
INTERRUPTED = 130

EPILOG = """\
exit codes:
  0  done
  1  the package was written, but its road report found problems
     (see build-report.json: split segments, disconnected junctions, steep edges)
  2  the spec or the command line is invalid; nothing was built
  3  the build failed (a download, or a bug); the output directory was left as it was

environment:
  PIXELWORLD_CACHE  where downloads are cached (default: pipeline/.cache in a
                    checkout, else ~/.cache/pixelworld); share it between checkouts

Making a world of your own place: docs/worlds.md
(https://github.com/alexngai/pixelworld/blob/main/docs/worlds.md)
"""


def version() -> str:
    try:
        return metadata.version("pixelworld-pipeline")
    except metadata.PackageNotFoundError:
        return "unknown"


def default_out(region_path: Path, out: Path | None) -> Path:
    """The output directory, once the spec is checked (a bad spec fails here)."""
    from .api import default_out_dir

    region = Region.load(region_path)
    return out or default_out_dir(region.id)


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="pixelworld",
        description="Build pixel-art world packages from real elevation, land cover, "
        "roads and buildings.",
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--version", action="version", version=f"%(prog)s {version()}")
    sub = p.add_subparsers(dest="command", required=True, metavar="command")
    spec_help = "a region spec, e.g. ../worlds/sf/region.yaml"
    out_help = "the package directory (default: fixtures/<id> in this checkout, else ./<id>)"

    def add(name: str, help: str, description: str | None = None) -> argparse.ArgumentParser:
        return sub.add_parser(
            name,
            help=help,
            description=description or help[0].upper() + help[1:] + ".",
            epilog=EPILOG,
            formatter_class=argparse.RawDescriptionHelpFormatter,
        )

    b = add(
        "build",
        "build a world package from a region spec",
        "Build a world package from a region spec. Progress goes to stderr, a line per "
        "stage; the report is written to <out>/build-report.json (and to stdout with "
        "--json). A failed build leaves the output directory as it was.",
    )
    b.add_argument("region", type=Path, help=spec_help)
    b.add_argument("--out", type=Path, help=out_help)
    b.add_argument("--json", action="store_true", help="print the build report to stdout as JSON")
    b.add_argument(
        "--no-compress", action="store_true", help="write plain .pxwc chunks instead of gzipped"
    )
    b.add_argument(
        "--no-routes",
        action="store_true",
        help="skip the ambient traffic routes (they can be added later: pixelworld routes)",
    )

    c = add(
        "check",
        "check region specs without building them",
        "Check region specs without building or downloading anything: unknown keys, "
        "types and ranges, the style pack, landmarks and plugins. Prints each problem "
        "with its file, line and key.",
    )
    c.add_argument("region", type=Path, nargs="+", help="one or more region specs")

    ref = add(
        "reference",
        "print the region spec reference: every key, its type, default and meaning",
        "Print the region spec reference in Markdown: every key, its type, default and "
        "meaning (docs/worlds.md holds the same text).",
    )
    ref.add_argument(
        "--write",
        type=Path,
        metavar="DOC",
        help="replace the reference section of this Markdown file instead of printing",
    )

    v = add(
        "view",
        "serve a built package and print the viewer URL to open",
        "Serve a built package to the viewer (pnpm dev in the repository, "
        "http://localhost:5173) and print the URL to open. Packages in fixtures/ "
        "need no server: open http://localhost:5173/?world=/<id>/.",
    )
    v.add_argument("package", type=Path, help="a package directory (it holds manifest.json)")
    v.add_argument("--port", type=int, default=8766, help="the port to serve it on (default: 8766)")
    v.add_argument(
        "--viewer",
        default="http://localhost:5173/",
        help="the viewer's URL (default: http://localhost:5173/, the dev server)",
    )
    v.add_argument("--open", action="store_true", help="also open the URL in a browser")

    rts = add(
        "routes",
        "add ambient traffic routes to a built package, without rebuilding it",
    )
    rts.add_argument("region", type=Path, help=spec_help)
    rts.add_argument("--out", type=Path, help=out_help)

    her = add(
        "heroes",
        "re-package the offline bakes and paint-overs of hero landmarks into a built package",
    )
    her.add_argument("region", type=Path, help=spec_help)
    her.add_argument("--out", type=Path, help=out_help)

    srv = add(
        "serve",
        "run the local server for the warp editor (apps/editor)",
        "Run the local pipeline server the warp editor talks to (pnpm --filter "
        "@pixelworlds/editor dev, http://localhost:5180). Its Build button builds into "
        "--out.",
    )
    srv.add_argument("region", type=Path, help=spec_help)
    srv.add_argument("--port", type=int, default=8765, help="the port (default: 8765)")
    srv.add_argument("--out", type=Path, help=out_help)

    imp = add(
        "importance",
        "refresh the region's snapshot of famous places from Wikidata (importance.json)",
    )
    imp.add_argument("region", type=Path, help=spec_help)
    imp.add_argument(
        "--min-sitelinks",
        type=int,
        default=20,
        help="leave out places with fewer Wikipedia language links (default: 20)",
    )

    plg = add(
        "plugins",
        "list the installed plugins (facts sources, terrain and land-cover sources)",
    )
    plg.add_argument(
        "region", type=Path, nargs="?", help="also check the plugins this region spec names"
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        return run(args)
    except (PluginError, RegionError) as e:
        print(f"pixelworld: {e}", file=sys.stderr)
        return INVALID
    except KeyboardInterrupt:
        print("pixelworld: interrupted", file=sys.stderr)
        return INTERRUPTED


def run(args: argparse.Namespace) -> int:
    if args.command == "build":
        return run_build(args)

    if args.command == "check":
        return run_check(args.region)

    if args.command == "reference":
        from . import schema

        if args.write:
            args.write.write_text(schema.splice(args.write.read_text(), schema.reference()))
            print(f"wrote the spec reference into {args.write}", file=sys.stderr)
        else:
            print(schema.reference(), end="")
        return OK

    if args.command == "view":
        return run_view(args)

    if args.command == "plugins":
        from . import plugins

        for group in plugins.GROUPS:
            print(f"{group} ({plugins.GROUPS[group]}s):")
            found = plugins.available(group)
            name_w = max([len(n) for n in found] + [4]) + 2
            origin_w = max([len(p.origin) for p in found.values()] + [6]) + 2
            for name, plugin in found.items():
                print(f"  {name:{name_w}}{plugin.origin:{origin_w}}{plugin.ref}")
            if not found:
                print("  (none)")
        if args.region:
            region = Region.load(args.region)
            plugins.check(region)
            names = [name for _, name, _ in plugins.spec_plugins(region)]
            print(f"{args.region}: every plugin it names is installed ({', '.join(names)})")
        return OK

    if args.command == "routes":
        from .routes import refresh_routes

        out = default_out(args.region, args.out)
        with progress.run() as stages:
            progress.stage("routes", str(out))
            report = refresh_routes(args.region, out)
        print(json.dumps(report, indent=2))
        print(f"routes for {out} in {stages.elapsed:.0f}s", file=sys.stderr)
        return OK

    if args.command == "heroes":
        from .build import refresh_heroes

        out = default_out(args.region, args.out)
        heroes = refresh_heroes(args.region, out)
        print(f"{len(heroes)} hero bakes in {out}")
        return OK

    if args.command == "serve":
        from .server import serve

        serve(args.region, default_out(args.region, args.out), args.port)
        return OK

    if args.command == "importance":
        from .importance import snapshot_path, write_snapshot

        snap = write_snapshot(args.region, args.min_sitelinks)
        print(f"{len(snap['places'])} places → {snapshot_path(args.region)}")
        return OK
    return INVALID


def run_build(args: argparse.Namespace) -> int:
    from . import api

    out = default_out(args.region, args.out)
    print(f"pixelworld: building {args.region} into {out}", file=sys.stderr)
    stages = None
    try:
        with progress.run() as stages:
            report = api.build(
                args.region, out, compress=not args.no_compress, routes=not args.no_routes
            )
    except (PluginError, RegionError):
        raise
    except KeyboardInterrupt:
        print(f"pixelworld: interrupted; {out} was left as it was", file=sys.stderr)
        return INTERRUPTED
    except Exception as e:  # noqa: BLE001 (a failed build: say where, keep the output)
        failed(e, stages, out, args)
        return FAILED
    if args.json:
        print(json.dumps(report, indent=2))
    ok = report["roads"]["ok"]
    cells = "×".join(str(c) for c in report["cells"])
    objects = sum((report.get("objects") or {}).values())
    routes = (report.get("routes") or {}).get("routes")
    parts = [f"{cells} cells", f"{report['chunks']} chunks"]
    if objects:
        parts.append(f"{objects:,} objects")
    if routes is not None:
        parts.append(f"{routes:,} routes")
    print(
        f"wrote {out} in {stages.elapsed:.0f} s ({', '.join(parts)})\n"
        f"  packageHash {report['packageHash']}\n"
        f"  stages: {stages.summary()}\n"
        f"  report: {out / 'build-report.json'}",
        file=sys.stdout if not args.json else sys.stderr,
    )
    if not ok:
        roads = {k: v for k, v in report["roads"].items() if k != "ok" and v}
        print(
            f"pixelworld: the road report found problems ({roads}); the package was "
            "written, but roads may not join up (exit code 1)",
            file=sys.stderr,
        )
        return PROBLEMS
    return OK


def failed(e: BaseException, stages, out: Path, args: argparse.Namespace) -> None:
    """Explain a failed build: a download in plain words, anything else with
    its traceback (it's a bug)."""
    import urllib.error

    from rasterio.errors import RasterioIOError

    where = f" in the {stages.current} stage" if stages is not None and stages.current else ""
    network = isinstance(e, (urllib.error.URLError, TimeoutError, ConnectionError, RasterioIOError))
    if not network:
        traceback.print_exc()
    print(
        f"pixelworld: the build failed{where}: {type(e).__name__}: {e}",
        file=sys.stderr,
    )
    if network:
        print(
            "  a download failed: check the network (or the proxy) and run it again; "
            "what was downloaded is cached",
            file=sys.stderr,
        )
    elif stages is not None and stages.current == "routes" and not args.no_routes:
        print("  --no-routes builds the world without traffic routes", file=sys.stderr)
    else:
        print("  this is a bug: please report it with the traceback above", file=sys.stderr)
    print(f"  {out} was left as it was", file=sys.stderr)


def run_check(paths: list[Path]) -> int:
    from .api import check

    status = OK
    for path in paths:
        region, issues = check(path)
        for issue in issues:
            print(str(issue) if issue.file else f"{path}: {issue}", file=sys.stderr)
        if region is None:
            status = INVALID
            errors = sum(i.level == "error" for i in issues)
            print(f"{path}: {errors} problem{'s' * (errors != 1)}", file=sys.stderr)
            continue
        if region.warp:
            size = f"warped, {region.warp['background']:g} m per cell in open country"
        else:
            cx, cy = region.cells
            size = f"{cx}×{cy} cells at {region.meters_per_cell:g} m"
        print(f"{path}: ok ({region.id}: {size}, style {region.style})")
    return status


def run_view(args: argparse.Namespace) -> int:
    import webbrowser

    from . import view

    try:
        manifest = view.check_package(args.package)
    except view.PackageError as e:
        print(f"pixelworld: {e}", file=sys.stderr)
        return INVALID
    warning = view.style_warning(manifest)
    if warning:
        print(f"pixelworld: warning: {warning}", file=sys.stderr)
    try:
        server = view.make_server(args.package, args.port)
    except OSError as e:
        print(
            f"pixelworld: can't serve on port {args.port} ({e.strerror}); try --port",
            file=sys.stderr,
        )
        return INVALID
    package_url = f"http://127.0.0.1:{server.server_address[1]}/"
    url = view.viewer_url(args.viewer, package_url)
    print(f"serving {args.package} ({manifest.get('name', manifest.get('id'))}) at {package_url}")
    print(f"open {url}", flush=True)
    if not view.reachable(args.viewer):
        print(
            f"pixelworld: the viewer isn't running at {args.viewer}: start it in the "
            "repository with `pnpm dev` (or pass --viewer <url>)",
            file=sys.stderr,
        )
    if args.open:
        webbrowser.open(url)
    print("Ctrl+C stops it.", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return OK


if __name__ == "__main__":
    raise SystemExit(main())
