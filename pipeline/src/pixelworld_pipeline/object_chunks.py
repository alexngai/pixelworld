"""Placed objects by chunk (D-123): an optional layer for clients that hold only
part of a world at a time, such as a game server on a big level. It is written
into a built package beside its whole objects file, without rebuilding it
(`pixelworld object-chunks <package>`), and a client that knows it loads each
chunk's objects with its terrain and lets them go together.

- `objects/<x>_<y>.json.gz`: the objects file format (version 2), holding every
  instance without a landmark id whose bounds touch the chunk: its footprint's,
  edges included, or its anchor's cell. One straddling a chunk edge is in both,
  so a point's chunk alone answers what stands there.
- `objects/landmarks.json.gz`: every instance with a landmark id (D-051), which
  a client keeps whole: there are few, and one drawn from its anchor stands
  where its model reaches, past its own chunk.
"""

from __future__ import annotations

import hashlib
import json
import math
import shutil
from collections import defaultdict
from pathlib import Path
from typing import Any

from .world_format import decode_objects, encode_objects, package_hash

OBJECT_CHUNKS_VERSION = 1
OBJECT_CHUNKS_DIR = "objects"
OBJECT_CHUNK_PATH = "objects/{x}_{y}.json.gz"
LANDMARKS_FILE = "objects/landmarks.json.gz"


def split_objects(
    instances: list[dict[str, Any]], chunk_size: int, cells_x: int, cells_y: int
) -> tuple[list[dict[str, Any]], dict[tuple[int, int], list[dict[str, Any]]]]:
    """The landmarks, and every other instance by each chunk its bounds touch."""
    landmarks = [i for i in instances if i.get("id")]
    chunks: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    last_x = (cells_x - 1) // chunk_size
    last_y = (cells_y - 1) // chunk_size
    for inst in instances:
        if inst.get("id"):
            continue
        if inst.get("fp"):
            xs = [p[0] for p in inst["fp"]]
            ys = [p[1] for p in inst["fp"]]
            x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        else:
            x0, y0 = math.floor(inst["x"]), math.floor(inst["y"])
            x1, y1 = x0 + 1, y0 + 1
        cx0 = max(0, math.floor(x0 / chunk_size))
        cy0 = max(0, math.floor(y0 / chunk_size))
        cx1 = min(last_x, math.floor(x1 / chunk_size))
        cy1 = min(last_y, math.floor(y1 / chunk_size))
        for cy in range(cy0, cy1 + 1):
            for cx in range(cx0, cx1 + 1):
                chunks[(cx, cy)].append(inst)
    return landmarks, chunks


def write_object_chunks(out_dir: Path) -> dict[str, Any]:
    """Write a built package's objects by chunk and point its manifest at them
    (packageHash updated). Returns the manifest entry's summary."""
    manifest_path = out_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if not manifest.get("objects"):
        raise ValueError(f"{out_dir}: the package has no objects")
    instances = decode_objects((out_dir / manifest["objects"]["path"]).read_bytes())
    landmarks, chunks = split_objects(
        instances, manifest["chunkSize"], manifest["cellsX"], manifest["cellsY"]
    )
    folder = out_dir / OBJECT_CHUNKS_DIR
    if folder.exists():
        shutil.rmtree(folder)
    folder.mkdir()

    def write(path: str, items: list[dict[str, Any]]) -> dict[str, Any]:
        blob = encode_objects(items)
        (out_dir / path).write_bytes(blob)
        return {"sha256": hashlib.sha256(blob).hexdigest(), "count": len(items)}

    entries = [
        {"x": x, "y": y, **write(OBJECT_CHUNK_PATH.format(x=x, y=y), chunks[(x, y)])}
        for (x, y) in sorted(chunks, key=lambda c: (c[1], c[0]))
    ]
    manifest["objectChunks"] = {
        "version": OBJECT_CHUNKS_VERSION,
        "path": OBJECT_CHUNK_PATH,
        "landmarks": {"path": LANDMARKS_FILE, **write(LANDMARKS_FILE, landmarks)},
        "chunks": entries,
    }
    manifest["packageHash"] = package_hash(manifest)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    summary = {
        "chunks": len(entries),
        "landmarks": len(landmarks),
        "instances": sum(e["count"] for e in entries),
    }
    report_path = out_dir / "build-report.json"
    if report_path.exists():
        report = json.loads(report_path.read_text())
        report["packageHash"] = manifest["packageHash"]
        report["objectChunks"] = summary
        report_path.write_text(json.dumps(report, indent=2) + "\n")
    return summary
