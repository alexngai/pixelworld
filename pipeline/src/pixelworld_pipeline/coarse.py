"""Coarse heights (D-123): an optional layer giving, for every block of 8 × 8
cells, the lowest drawn ground and the highest drawn top (ground or water), for
clients that hold part of a world at a time: a game server can step a player
over ground it hasn't loaded yet when the player is clear of everything there.
Written into a built package without rebuilding it (`pixelworld coarse-heights
<package>`).

`coarse.i16.gz`: gzip of little-endian int16 pairs (lowest, highest) in 1/16
step, one pair per block, rows of blocks from the north-west; a block no chunk
covers holds -32768 twice. Heights are the drawn ground's: the micro-terrain's
corners where there is micro-terrain, else the cells' corners.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import math
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import numpy as np

from .world_format import NO_WATER, Chunk, decode_chunk, package_hash, unpack_shape

COARSE_FILE = "coarse.i16.gz"
COARSE_BLOCK = 8
COARSE_VERSION = 1
NO_DATA = -32768


def coarse_heights(
    chunks: Iterable[Chunk], chunk_size: int, cells_x: int, cells_y: int, block: int = COARSE_BLOCK
) -> np.ndarray:
    """(rows, cols, 2) int16: each block's lowest and highest, in 1/16 step."""
    rows, cols = math.ceil(cells_y / block), math.ceil(cells_x / block)
    lo = np.full((rows, cols), np.inf)
    hi = np.full((rows, cols), -np.inf)
    for c in chunks:
        k = c.micro_k
        offs = unpack_shape(c.shape)
        cell_lo = c.base + offs.min(axis=0)
        cell_hi = c.base + offs.max(axis=0)
        water = c.water if c.water is not None else None
        for by in range(chunk_size // block):
            for bx in range(chunk_size // block):
                # the block's cells inside the world
                x0, y0 = c.x * chunk_size + bx * block, c.y * chunk_size + by * block
                w, h = min(block, cells_x - x0), min(block, cells_y - y0)
                if w <= 0 or h <= 0:
                    continue
                lx, ly = bx * block, by * block
                if k:
                    m = c.micro_corners[ly * k : (ly + h) * k + 1, lx * k : (lx + w) * k + 1] / k
                    b_lo, b_hi = float(m.min()), float(m.max())
                else:
                    b_lo = float(cell_lo[ly : ly + h, lx : lx + w].min())
                    b_hi = float(cell_hi[ly : ly + h, lx : lx + w].max())
                if water is not None:
                    wt = water[ly : ly + h, lx : lx + w]
                    if np.any(wt != NO_WATER):
                        b_hi = max(b_hi, float(wt[wt != NO_WATER].max()))
                r, q = y0 // block, x0 // block
                lo[r, q] = min(lo[r, q], b_lo)
                hi[r, q] = max(hi[r, q], b_hi)
    out = np.full((rows, cols, 2), NO_DATA, dtype="<i2")
    have = np.isfinite(lo)
    out[..., 0][have] = np.floor(lo[have] * 16)
    out[..., 1][have] = np.ceil(hi[have] * 16)
    return out


def write_coarse(out_dir: Path) -> dict[str, Any]:
    """Write a built package's coarse heights and point its manifest at them
    (packageHash updated). Returns the manifest entry."""
    manifest_path = out_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    chunks = (decode_chunk((out_dir / ref["path"]).read_bytes()) for ref in manifest["chunks"])
    grid = coarse_heights(chunks, manifest["chunkSize"], manifest["cellsX"], manifest["cellsY"])
    blob = gzip.compress(grid.tobytes(), compresslevel=9, mtime=0)
    (out_dir / COARSE_FILE).write_bytes(blob)
    entry = {
        "version": COARSE_VERSION,
        "path": COARSE_FILE,
        "sha256": hashlib.sha256(blob).hexdigest(),
        "block": COARSE_BLOCK,
    }
    manifest["coarse"] = entry
    manifest["packageHash"] = package_hash(manifest)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    report_path = out_dir / "build-report.json"
    if report_path.exists():
        report = json.loads(report_path.read_text())
        report["packageHash"] = manifest["packageHash"]
        report_path.write_text(json.dumps(report, indent=2) + "\n")
    return entry
