"""Regenerate the cross-language golden files in testdata/world-format/.

    uv run python -m pixelworld_pipeline.golden

The TypeScript and Python codec tests both decode these files and compare
against the expected values in the JSON sidecar.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .world_format import NO_WATER, Chunk, encode_chunk

REPO = Path(__file__).resolve().parents[3]
GOLDEN_DIR = REPO / "testdata" / "world-format"


def golden_chunk() -> Chunk:
    size = 4
    base = np.arange(size * size, dtype=np.int16).reshape(size, size) - 3
    base[0, 0] = -32000
    base[3, 3] = 32000
    slope = (np.arange(size * size) % 15).astype(np.uint8).reshape(size, size)
    surface = (np.arange(size * size) * 7 % 256).astype(np.uint8).reshape(size, size)
    water = np.full((size, size), NO_WATER, dtype=np.int16)
    water[1, 2] = 5
    water[2, 1] = -4
    return Chunk(x=-2, y=7, base=base, slope=slope, surface=surface, water=water)


def main() -> None:
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
    chunk = golden_chunk()
    (GOLDEN_DIR / "chunk-v0-small.pxwc").write_bytes(encode_chunk(chunk))
    expected = {
        "x": chunk.x,
        "y": chunk.y,
        "size": chunk.size,
        "base": chunk.base.flatten().tolist(),
        "slope": chunk.slope.flatten().tolist(),
        "surface": chunk.surface.flatten().tolist(),
        "water": chunk.water.flatten().tolist(),
    }
    (GOLDEN_DIR / "chunk-v0-small.json").write_text(json.dumps(expected) + "\n")
    print(f"wrote golden files to {GOLDEN_DIR}")


if __name__ == "__main__":
    main()
