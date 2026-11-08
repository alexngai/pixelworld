"""Command-line entry point: `uv run pixelworld build <region.yaml>`."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from .region import Region

REPO = Path(__file__).resolve().parents[3]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pixelworld", description="Pixelworld geo pipeline")
    sub = parser.add_subparsers(dest="command", required=True)
    b = sub.add_parser("build", help="build a world package from a region spec")
    b.add_argument("region", type=Path, help="path to worlds/<id>/region.yaml")
    b.add_argument("--out", type=Path, help="output directory (default: fixtures/<id>)")
    b.add_argument("--no-compress", action="store_true", help="write plain .pxwc chunks")
    srv = sub.add_parser("serve", help="local pipeline server for the editor (apps/editor)")
    srv.add_argument("region", type=Path)
    srv.add_argument("--port", type=int, default=8765)
    srv.add_argument("--out", type=Path, help="build output (default: fixtures/<id>)")
    imp = sub.add_parser("importance", help="refresh the region's Wikidata importance snapshot")
    imp.add_argument("region", type=Path)
    imp.add_argument("--min-sitelinks", type=int, default=20)
    args = parser.parse_args(argv)

    if args.command == "serve":
        from .server import serve

        region = Region.load(args.region)
        serve(args.region, args.out or REPO / "fixtures" / region.id, args.port)
        return 0

    if args.command == "importance":
        from .importance import snapshot_path, write_snapshot

        snap = write_snapshot(args.region, args.min_sitelinks)
        print(f"{len(snap['places'])} places → {snapshot_path(args.region)}")
        return 0

    if args.command == "build":
        from .build import build

        region = Region.load(args.region)
        out = args.out or REPO / "fixtures" / region.id
        t0 = time.time()
        report = build(args.region, out, compress=not args.no_compress)
        print(json.dumps(report, indent=2))
        print(f"wrote {out} in {time.time() - t0:.0f}s")
        return 0 if report["roads"]["ok"] else 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
