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
    args = parser.parse_args(argv)

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
