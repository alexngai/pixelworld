"""World package codec, format v1 (reads v0). Spec: docs/world-format.md.

Mirrors packages/world-format (TypeScript). Both are tested against the shared
golden files in testdata/world-format/.
"""

from __future__ import annotations

import gzip
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

# (attribute, tag, dtype, fill) for every per-cell layer. The first three are
# required; the rest are optional and only written when they hold data.
LAYERS = (
    ("base", b"BASE", "<i2", 0),
    ("shape", b"CRNR", "u1", 0),
    ("surface", b"SURF", "u1", 0),
    ("water", b"WATR", "<i2", NO_WATER),
    ("road", b"ROAD", "<u2", 0),
    ("road_class", b"RCLS", "u1", 0),
    ("geology", b"GEOL", "u1", 0),
)
_REQUIRED = {"base", "shape", "surface"}


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
    road: np.ndarray = field(default=None)  # uint16 road connectivity + corner crossings
    road_class: np.ndarray = field(default=None)  # uint8 road class id, 0 = none
    geology: np.ndarray = field(default=None)  # uint8 geology province id

    def __post_init__(self) -> None:
        size = self.base.shape[0]
        for name, _tag, dtype, fill in LAYERS:
            arr = getattr(self, name)
            if arr is None:
                arr = np.full((size, size), fill, dtype=np.dtype(dtype).newbyteorder("="))
            if arr.shape != (size, size):
                raise ChunkFormatError(f"{name} has shape {arr.shape}, expected {(size, size)}")
            setattr(self, name, arr.astype(np.dtype(dtype).newbyteorder("="), copy=False))
        if self.shape.size and int(unpack_shape(self.shape).min(axis=0).max()) != 0:
            raise ChunkFormatError("shape must have its lowest corner offset at 0")

    @property
    def size(self) -> int:
        return int(self.base.shape[0])


def _align4(n: int) -> int:
    return (n + 3) & ~3


def encode_chunk(chunk: Chunk) -> bytes:
    payloads: list[tuple[bytes, bytes]] = []
    for name, tag, dtype, fill in LAYERS:
        arr = getattr(chunk, name)
        if name not in _REQUIRED and not np.any(arr != fill):
            continue
        payloads.append((tag, arr.astype(dtype).tobytes()))

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
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
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

    layers: dict[str, np.ndarray | None] = {}
    for name, tag, dtype, _fill in LAYERS:
        if name == "shape" and version == 0:
            layers[name] = shape_from_v0_mask(_v0_mask(section(b"SLOP", "u1", True)))
        else:
            layers[name] = section(tag, dtype, name in _REQUIRED)
    return Chunk(x=x, y=y, **layers)


def _v0_mask(mask: np.ndarray) -> np.ndarray:
    if int(mask.max(initial=0)) > 14:
        raise ChunkFormatError("v0 slope mask out of range")
    return mask


def height_range(base: np.ndarray, shape: np.ndarray) -> list[int]:
    """[lowest, highest] corner height of a block of cells."""
    if base.size == 0:
        return [0, 0]
    top = base.astype(np.int32) + unpack_shape(shape).max(axis=0)
    return [int(base.min()), int(top.max())]


def package_hash(manifest: dict[str, Any]) -> str:
    """SHA-256 of the manifest (minus this field) as canonical JSON.

    The manifest already lists every chunk's SHA-256, so this covers the
    whole package: identical inputs and code give an identical hash.
    """
    body = {k: v for k, v in manifest.items() if k != "packageHash"}
    return hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()


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
    road: np.ndarray | None = None,
    road_class: np.ndarray | None = None,
    geology: np.ndarray | None = None,
    road_classes: dict[int, str] | None = None,
    provinces: dict[int, str] | None = None,
    start: tuple[int, int] | None = None,
    source: dict[str, Any] | None = None,
    generator: dict[str, Any] | None = None,
    compress: bool = False,
    clean: bool = False,
) -> dict[str, Any]:
    """Split full-grid layers into chunks and write manifest.json + chunk files.

    With compress=True chunks are written as deterministic gzip (`.pxwc.gz`,
    mtime 0) and the manifest records the hash of the compressed bytes. With
    clean=True, chunk files left over from earlier builds are removed.
    """
    cells_y, cells_x = base.shape
    full = {
        "base": base,
        "shape": shape,
        "surface": surface,
        "water": water,
        "road": road,
        "road_class": road_class,
        "geology": geology,
    }
    chunk_dir = out_dir / "chunks"
    chunk_dir.mkdir(parents=True, exist_ok=True)
    refs = []
    for cy in range(0, (cells_y + chunk_size - 1) // chunk_size):
        for cx in range(0, (cells_x + chunk_size - 1) // chunk_size):
            ys = slice(cy * chunk_size, (cy + 1) * chunk_size)
            xs = slice(cx * chunk_size, (cx + 1) * chunk_size)
            layers = {}
            for lname, _tag, dtype, fill in LAYERS:
                a = full[lname]
                if a is None:
                    continue
                block = a[ys, xs]
                out = np.full(
                    (chunk_size, chunk_size), fill, dtype=np.dtype(dtype).newbyteorder("=")
                )
                out[: block.shape[0], : block.shape[1]] = block
                layers[lname] = out
            chunk = Chunk(x=cx, y=cy, **layers)
            blob = encode_chunk(chunk)
            rel = f"chunks/{cx}_{cy}.pxwc"
            if compress:
                blob = gzip.compress(blob, compresslevel=9, mtime=0)
                rel += ".gz"
            (out_dir / rel).write_bytes(blob)
            refs.append(
                {
                    "x": cx,
                    "y": cy,
                    "path": rel,
                    "sha256": hashlib.sha256(blob).hexdigest(),
                    "heightRange": height_range(base[ys, xs], shape[ys, xs]),
                }
            )

    if clean:
        # Remove chunk files this build didn't write. Files are overwritten in
        # place rather than deleting the directory, so a running dev server
        # keeps serving them.
        written = {(out_dir / r["path"]).name for r in refs}
        for stale in chunk_dir.iterdir():
            if stale.name not in written:
                stale.unlink()

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
        "heightRange": height_range(base, shape),
        "surfaces": {str(k): v for k, v in sorted(surfaces.items())},
        "style": style,
        "attribution": attribution,
    }
    if road_classes is not None:
        manifest["roadClasses"] = {str(k): v for k, v in sorted(road_classes.items())}
    if provinces is not None:
        manifest["geology"] = {str(k): v for k, v in sorted(provinces.items())}
    if start is not None:
        manifest["start"] = {"x": int(start[0]), "y": int(start[1])}
    if source is not None:
        manifest["source"] = source
    if generator is not None:
        manifest["generator"] = generator
    manifest["packageHash"] = package_hash(manifest)
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest
