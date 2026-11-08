"""Regenerate the cross-language golden files in testdata/world-format/.

    uv run python -m pixelworld_pipeline.golden

The TypeScript and Python codec tests both decode these files and compare
against the expected values in the JSON sidecar. Only the current format
(v1) is regenerated; chunk-v0-small.* is a frozen fixture that checks old
files still decode.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .world_format import NO_WATER, Chunk, encode_chunk, pack_shape

REPO = Path(__file__).resolve().parents[3]
GOLDEN_DIR = REPO / "testdata" / "world-format"


def golden_chunk() -> Chunk:
    size = 4
    base = np.arange(size * size, dtype=np.int16).reshape(size, size) - 3
    base[0, 0] = -32000
    base[3, 3] = 32000
    k = np.arange(size * size).reshape(size, size)
    # every offset 0..3 appears; corner 3 stays 0 so each shape is normalized
    shape = pack_shape(np.stack([k % 4, (k // 4) % 4, (k // 2) % 4, np.zeros_like(k)]))
    surface = (np.arange(size * size) * 7 % 256).astype(np.uint8).reshape(size, size)
    water = np.full((size, size), NO_WATER, dtype=np.int16)
    water[1, 2] = 5
    water[2, 1] = -4
    road = np.zeros((size, size), dtype=np.uint16)
    road[1, 1] = 0b0000_0001_0001_0100  # E + S, crossing at corner 0
    road[3, 0] = 0xFFFF & 0x0FFF  # every direction and every crossing
    road_class = np.zeros((size, size), dtype=np.uint8)
    road_class[1, 1] = 2
    road_class[3, 0] = 255
    geology = (np.arange(size * size) % 3).astype(np.uint8).reshape(size, size)
    return Chunk(
        x=-2,
        y=7,
        base=base,
        shape=shape,
        surface=surface,
        water=water,
        road=road,
        road_class=road_class,
        geology=geology,
    )


def golden_micro_chunk() -> Chunk:
    """A 2×2 chunk with K=2 micro-terrain: (2·2 + 1)² micro-corner heights."""
    size, k = 2, 2
    side = size * k + 1
    corners = np.arange(side * side, dtype=np.int32).reshape(side, side) * 7 % 23 - 9
    corners[0, 0] = -32000
    corners[4, 4] = 32000
    return Chunk(
        x=3,
        y=-1,
        base=np.array([[10, 11], [12, -5]], dtype=np.int16),
        shape=np.zeros((size, size), dtype=np.uint8),
        surface=np.ones((size, size), dtype=np.uint8),
        micro_corners=corners.astype(np.int16),
    )


def main() -> None:
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
    chunk = golden_chunk()
    (GOLDEN_DIR / "chunk-v1-small.pxwc").write_bytes(encode_chunk(chunk))
    expected = {
        "x": chunk.x,
        "y": chunk.y,
        "size": chunk.size,
        "base": chunk.base.flatten().tolist(),
        "shape": chunk.shape.flatten().tolist(),
        "surface": chunk.surface.flatten().tolist(),
        "water": chunk.water.flatten().tolist(),
        "road": chunk.road.flatten().tolist(),
        "roadClass": chunk.road_class.flatten().tolist(),
        "geology": chunk.geology.flatten().tolist(),
    }
    (GOLDEN_DIR / "chunk-v1-small.json").write_text(json.dumps(expected) + "\n")
    micro = golden_micro_chunk()
    (GOLDEN_DIR / "chunk-v1-micro.pxwc").write_bytes(encode_chunk(micro))
    expected_micro = {
        "x": micro.x,
        "y": micro.y,
        "size": micro.size,
        "k": micro.micro_k,
        "base": micro.base.flatten().tolist(),
        "microCorners": micro.micro_corners.flatten().tolist(),
    }
    (GOLDEN_DIR / "chunk-v1-micro.json").write_text(json.dumps(expected_micro) + "\n")
    print(f"wrote golden files to {GOLDEN_DIR}")


if __name__ == "__main__":
    main()
