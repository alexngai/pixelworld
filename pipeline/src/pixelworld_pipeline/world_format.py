"""World package codec, format v1 (reads v0). Spec: docs/world-format.md.

Mirrors packages/world-format (TypeScript). Both are tested against the shared
golden files in testdata/world-format/.
"""

from __future__ import annotations

import hashlib
import json
import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

CHUNK_MAGIC = b"PXWC"
CHUNK_FORMAT_VERSION = 1
READABLE_CHUNK_VERSIONS = (0, 1)  # v0 stored a 1-bit-per-corner slope mask (SLOP)
WORLD_FORMAT = "pixelworld-world"
WORLD_FORMAT_VERSION = 0
NO_WATER = -32768
MAX_CORNER_OFFSET = 3


def pack_shape(offsets: np.ndarray) -> np.ndarray:
    """(4, ...) corner offsets 0..3 -> packed uint8 shape (corner i in bits 2i..2i+1)."""
    o = np.asarray(offsets).astype(np.uint8)
    return (o[0] | (o[1] << 2) | (o[2] << 4) | (o[3] << 6)).astype(np.uint8)


def unpack_shape(shape: np.ndarray) -> np.ndarray:
    """Packed shape -> (4, ...) corner offsets."""
    s = np.asarray(shape).astype(np.uint8)
    return np.stack([(s >> (2 * i)) & 3 for i in range(4)])


def shape_from_v0_mask(mask: np.ndarray) -> np.ndarray:
    m = np.asarray(mask).astype(np.uint8)
    return pack_shape(np.stack([(m >> i) & 1 for i in range(4)]))


_HEADER = struct.Struct("<4sHHiiHH")  # magic, version, flags, x, y, size, section count
_ENTRY = struct.Struct("<4sII")  # tag, offset, length


class ChunkFormatError(ValueError):
    pass


@dataclass
class Chunk:
    """One chunk of terrain. Arrays are (size, size), indexed [y, x]."""

    x: int
    y: int
    base: np.ndarray  # int16 height steps (lowest corner)
    shape: np.ndarray  # uint8 packed corner offsets 0..3 (see pack_shape)
    surface: np.ndarray  # uint8 surface id
    water: np.ndarray = field(default=None)  # int16 water height, NO_WATER = none

    def __post_init__(self) -> None:
        size = self.base.shape[0]
        if self.water is None:
            self.water = np.full((size, size), NO_WATER, dtype=np.int16)
        for name in ("base", "shape", "surface", "water"):
            arr = getattr(self, name)
            if arr.shape != (size, size):
                raise ChunkFormatError(f"{name} has shape {arr.shape}, expected {(size, size)}")
        self.base = self.base.astype(np.int16, copy=False)
        self.shape = self.shape.astype(np.uint8, copy=False)
        self.surface = self.surface.astype(np.uint8, copy=False)
        self.water = self.water.astype(np.int16, copy=False)
        if self.shape.size and int(unpack_shape(self.shape).min(axis=0).max()) != 0:
            raise ChunkFormatError("shape must have its lowest corner offset at 0")

    @property
    def size(self) -> int:
        return int(self.base.shape[0])


def _align4(n: int) -> int:
    return (n + 3) & ~3


def encode_chunk(chunk: Chunk) -> bytes:
    payloads: list[tuple[bytes, bytes]] = [
        (b"BASE", chunk.base.astype("<i2").tobytes()),
        (b"CRNR", chunk.shape.astype("u1").tobytes()),
        (b"SURF", chunk.surface.astype("u1").tobytes()),
    ]
    if np.any(chunk.water != NO_WATER):
        payloads.append((b"WATR", chunk.water.astype("<i2").tobytes()))

    offset = _HEADER.size + len(payloads) * _ENTRY.size
    placed = []
    for tag, data in payloads:
        offset = _align4(offset)
        placed.append((tag, data, offset))
        offset += len(data)

    out = bytearray(_align4(offset))
    _HEADER.pack_into(
        out, 0, CHUNK_MAGIC, CHUNK_FORMAT_VERSION, 0, chunk.x, chunk.y, chunk.size, len(placed)
    )
    for i, (tag, data, at) in enumerate(placed):
        _ENTRY.pack_into(out, _HEADER.size + i * _ENTRY.size, tag, at, len(data))
        out[at : at + len(data)] = data
    return bytes(out)


def decode_chunk(data: bytes) -> Chunk:
    if len(data) < _HEADER.size:
        raise ChunkFormatError("truncated header")
    magic, version, _flags, x, y, size, count = _HEADER.unpack_from(data, 0)
    if magic != CHUNK_MAGIC:
        raise ChunkFormatError("bad magic")
    if version not in READABLE_CHUNK_VERSIONS:
        raise ChunkFormatError(f"unsupported chunk version {version}")
    n = size * size
    sections: dict[bytes, tuple[int, int]] = {}
    for i in range(count):
        tag, off, length = _ENTRY.unpack_from(data, _HEADER.size + i * _ENTRY.size)
        if off + length > len(data):
            raise ChunkFormatError(f"section {tag!r} out of bounds")
        if tag in sections:
            raise ChunkFormatError(f"duplicate section {tag!r}")
        sections[tag] = (off, length)

    def section(tag: bytes, dtype: str, required: bool) -> np.ndarray | None:
        if tag not in sections:
            if required:
                raise ChunkFormatError(f"missing section {tag!r}")
            return None
        off, length = sections[tag]
        itemsize = np.dtype(dtype).itemsize
        if length != n * itemsize:
            raise ChunkFormatError(f"section {tag!r} has {length} bytes, expected {n * itemsize}")
        return np.frombuffer(data, dtype=dtype, count=n, offset=off).reshape(size, size).copy()

    return Chunk(
        x=x,
        y=y,
        base=section(b"BASE", "<i2", True),
        shape=(
            shape_from_v0_mask(_v0_mask(section(b"SLOP", "u1", True)))
            if version == 0
            else section(b"CRNR", "u1", True)
        ),
        surface=section(b"SURF", "u1", True),
        water=section(b"WATR", "<i2", False),
    )


def _v0_mask(mask: np.ndarray) -> np.ndarray:
    if int(mask.max(initial=0)) > 14:
        raise ChunkFormatError("v0 slope mask out of range")
    return mask


def write_package(
    out_dir: Path,
    *,
    world_id: str,
    name: str,
    base: np.ndarray,
    shape: np.ndarray,
    surface: np.ndarray,
    water: np.ndarray,
    chunk_size: int,
    scale: dict[str, float],
    surfaces: dict[int, str],
    style: str,
    attribution: list[dict[str, str]],
    source: dict[str, Any] | None = None,
    generator: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Split full-grid layers into chunks and write manifest.json + chunk files."""
    cells_y, cells_x = base.shape
    chunk_dir = out_dir / "chunks"
    chunk_dir.mkdir(parents=True, exist_ok=True)
    refs = []
    for cy in range(0, (cells_y + chunk_size - 1) // chunk_size):
        for cx in range(0, (cells_x + chunk_size - 1) // chunk_size):
            ys = slice(cy * chunk_size, (cy + 1) * chunk_size)
            xs = slice(cx * chunk_size, (cx + 1) * chunk_size)

            def pad(a: np.ndarray, fill: int, ys: slice = ys, xs: slice = xs) -> np.ndarray:
                block = a[ys, xs]
                out = np.full((chunk_size, chunk_size), fill, dtype=a.dtype)
                out[: block.shape[0], : block.shape[1]] = block
                return out

            chunk = Chunk(
                x=cx,
                y=cy,
                base=pad(base, 0),
                shape=pad(shape, 0),
                surface=pad(surface, 0),
                water=pad(water, NO_WATER),
            )
            blob = encode_chunk(chunk)
            rel = f"chunks/{cx}_{cy}.pxwc"
            (out_dir / rel).write_bytes(blob)
            refs.append({"x": cx, "y": cy, "path": rel, "sha256": hashlib.sha256(blob).hexdigest()})

    manifest: dict[str, Any] = {
        "format": WORLD_FORMAT,
        "formatVersion": WORLD_FORMAT_VERSION,
        "id": world_id,
        "name": name,
        "chunkSize": chunk_size,
        "cellsX": int(cells_x),
        "cellsY": int(cells_y),
        "chunks": refs,
        "scale": scale,
        "surfaces": {str(k): v for k, v in sorted(surfaces.items())},
        "style": style,
        "attribution": attribution,
    }
    if source is not None:
        manifest["source"] = source
    if generator is not None:
        manifest["generator"] = generator
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest
