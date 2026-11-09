"""Command-line entry point: `uv run pixelworld build <region.yaml>`.

The same builds are available from Python: `pixelworld_pipeline.build(spec)`.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from .plugins import PluginError
from .region import Region, RegionError


def default_out(region_path: Path, out: Path | None) -> Path:
    from .api import default_out_dir

    return out or default_out_dir(Region.load(region_path).id)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pixelworld", description="Pixelworld geo pipeline")
    sub = parser.add_subparsers(dest="command", required=True)
    b = sub.add_parser("build", help="build a world package from a region spec")
    b.add_argument("region", type=Path, help="path to worlds/<id>/region.yaml")
    b.add_argument("--out", type=Path, help="output directory (default: fixtures/<id>)")
    b.add_argument("--no-compress", action="store_true", help="write plain .pxwc chunks")
    b.add_argument("--no-routes", action="store_true", help="skip ambient traffic routes (D-060)")
    srv = sub.add_parser("serve", help="local pipeline server for the editor (apps/editor)")
    srv.add_argument("region", type=Path)
    srv.add_argument("--port", type=int, default=8765)
    srv.add_argument("--out", type=Path, help="build output (default: fixtures/<id>)")
    imp = sub.add_parser("importance", help="refresh the region's Wikidata importance snapshot")
    imp.add_argument("region", type=Path)
    imp.add_argument("--min-sitelinks", type=int, default=20)
    her = sub.add_parser(
        "heroes", help="re-package hero bakes and paint-overs into a built package (D-053)"
    )
    her.add_argument("region", type=Path)
    her.add_argument("--out", type=Path, help="package directory (default: fixtures/<id>)")
    rts = sub.add_parser(
        "routes", help="add ambient traffic routes to a built package (D-060), no rebuild"
    )
    rts.add_argument("region", type=Path)
    rts.add_argument("--out", type=Path, help="package directory (default: fixtures/<id>)")
    plg = sub.add_parser(
        "plugins", help="list the installed plugins (facts sources, source adapters)"
    )
    plg.add_argument("region", type=Path, nargs="?", help="also check the plugins a spec names")
    args = parser.parse_args(argv)
    try:
        return run(args)
    except (PluginError, RegionError) as e:
        print(f"pixelworld: {e}", file=sys.stderr)
        return 2


def run(args: argparse.Namespace) -> int:
    if args.command == "plugins":
        from . import plugins

        for group in plugins.GROUPS:
            print(f"{group} ({plugins.GROUPS[group]}s):")
            found = plugins.available(group)
            for name, plugin in found.items():
                print(f"  {name:24} {plugin.origin:20} {plugin.ref}")
            if not found:
                print("  (none)")
        if args.region:
            region = Region.load(args.region)
            plugins.check(region)
            names = [name for _, name, _ in plugins.spec_plugins(region)]
            print(f"{args.region}: every plugin it names is installed ({', '.join(names)})")
        return 0

    if args.command == "routes":
        from .routes import refresh_routes

        out = default_out(args.region, args.out)
        t0 = time.time()
        report = refresh_routes(args.region, out)
        print(json.dumps(report, indent=2))
        print(f"routes for {out} in {time.time() - t0:.0f}s")
        return 0

    if args.command == "heroes":
        from .build import refresh_heroes

        out = default_out(args.region, args.out)
        heroes = refresh_heroes(args.region, out)
        print(f"{len(heroes)} hero bakes in {out}")
        return 0

    if args.command == "serve":
        from .server import serve

        serve(args.region, default_out(args.region, args.out), args.port)
        return 0

    if args.command == "importance":
        from .importance import snapshot_path, write_snapshot

        snap = write_snapshot(args.region, args.min_sitelinks)
        print(f"{len(snap['places'])} places → {snapshot_path(args.region)}")
        return 0

    if args.command == "build":
        from .api import build

        out = default_out(args.region, args.out)
        t0 = time.time()
        report = build(args.region, out, compress=not args.no_compress, routes=not args.no_routes)
        print(json.dumps(report, indent=2))
        print(f"wrote {out} in {time.time() - t0:.0f}s")
        return 0 if report["roads"]["ok"] else 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
