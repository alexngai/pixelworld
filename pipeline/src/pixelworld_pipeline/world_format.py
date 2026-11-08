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
    # vertical caricature (M2): drawn height h ↔ real height ref + (h − ref)·invR
    ("vref", b"VREF", "<i2", 0),  # reference height, 1/16 steps
    ("vfac", b"VFAC", "<i2", 4096),  # 1/R, 1/4096 units (4096 = no exaggeration)
)
_REQUIRED = {"base", "shape", "surface"}

# Micro-terrain (M1.6, D-037), optional: MHGT holds the height of every
# micro-corner, (K·size + 1)² int16 in micro-steps (1/K step), rows delta-coded
# (each value minus its left neighbour; the first of a row is absolute). The
# last row and column repeat the next chunk's first, so a chunk is complete on
# its own. K is implied by the section length. Micro-cells are derived from
# the corners by `micro_cells`; packages/grid applies the same rule.
MICRO_TAG = b"MHGT"
MICRO_MAX_OFFSET = 3


def delta_rows(a: np.ndarray) -> np.ndarray:
    d = a.astype(np.int32)
    d[:, 1:] = d[:, 1:] - a[:, :-1].astype(np.int32)
    return d.astype(np.int16)


def undelta_rows(d: np.ndarray) -> np.ndarray:
    return np.cumsum(d.astype(np.int32), axis=1).astype(np.int16)


def micro_cells(
    corners: np.ndarray, max_offset: int = MICRO_MAX_OFFSET
) -> tuple[np.ndarray, np.ndarray]:
    """Micro-cell (base, packed shape) from integer micro-corner heights.

    A micro-cell whose corners span at most max_offset micro-steps is a slope
    tile on those corners; a steeper one is flat at the rounded-half-up mean
    of its corners (so steep ground becomes terraces with cliffs between).
    """
    c = np.asarray(corners).astype(np.int32)
    cs = np.stack([c[:-1, :-1], c[:-1, 1:], c[1:, 1:], c[1:, :-1]])
    lo = cs.min(axis=0)
    steep = (cs.max(axis=0) - lo) > max_offset
    flat = np.floor(cs.sum(axis=0) / 4 + 0.5).astype(np.int32)
    base = np.where(steep, flat, lo)
    offsets = np.where(steep, 0, cs - lo)
    return base.astype(np.int16), pack_shape(offsets)


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
    vref: np.ndarray = field(default=None)  # int16 relief reference height, 1/16 steps
    vfac: np.ndarray = field(default=None)  # int16 inverse relief factor, 1/4096
    micro_corners: np.ndarray | None = None  # int16 (K·size + 1)² micro-steps, optional

    def __post_init__(self) -> None:
        size = self.base.shape[0]
        if self.micro_corners is not None:
            m = self.micro_corners.shape[0] - 1
            if m < size or m % size or self.micro_corners.shape != (m + 1, m + 1):
                raise ChunkFormatError(
                    f"micro corners must be (K·{size} + 1)², got {self.micro_corners.shape}"
                )
            self.micro_corners = self.micro_corners.astype(np.int16, copy=False)
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

    @property
    def micro_k(self) -> int:
        """Micro-cells per cell edge, 0 without micro-terrain."""
        if self.micro_corners is None:
            return 0
        return (self.micro_corners.shape[0] - 1) // self.size


def _align4(n: int) -> int:
    return (n + 3) & ~3


def encode_chunk(chunk: Chunk) -> bytes:
    payloads: list[tuple[bytes, bytes]] = []
    for name, tag, dtype, fill in LAYERS:
        arr = getattr(chunk, name)
        if name not in _REQUIRED and not np.any(arr != fill):
            continue
        payloads.append((tag, arr.astype(dtype).tobytes()))
    if chunk.micro_corners is not None:
        payloads.append((MICRO_TAG, delta_rows(chunk.micro_corners).astype("<i2").tobytes()))

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
    if MICRO_TAG in sections:
        off, length = sections[MICRO_TAG]
        side = round((length / 2) ** 0.5)
        k = (side - 1) // size if size else 0
        if k < 1 or side != k * size + 1 or side * side * 2 != length:
            raise ChunkFormatError(f"MHGT has {length} bytes, not (K·{size} + 1)² int16")
        d = np.frombuffer(data, dtype="<i2", count=side * side, offset=off).reshape(side, side)
        layers["micro_corners"] = undelta_rows(d)
    return Chunk(x=x, y=y, **layers)


def _v0_mask(mask: np.ndarray) -> np.ndarray:
    if int(mask.max(initial=0)) > 14:
        raise ChunkFormatError("v0 slope mask out of range")
    return mask


def height_range(
    base: np.ndarray,
    shape: np.ndarray,
    micro: tuple[np.ndarray, int] | None = None,
) -> list[int]:
    """[lowest, highest] corner height (steps) of a block of cells, micro-terrain included.

    micro = (micro-corner heights, K). Derived micro-cells never leave the
    range of their corners (a flat one sits at the rounded mean).
    """
    if base.size == 0:
        return [0, 0]
    top = base.astype(np.int32) + unpack_shape(shape).max(axis=0)
    lo, hi = int(base.min()), int(top.max())
    if micro is not None:
        mc, k = micro
        if mc.size:
            lo = min(lo, int(np.floor(mc.min() / k)))
            hi = max(hi, int(np.ceil(mc.max() / k)))
    return [lo, hi]


GEO_FILE = "geo.i32.gz"


def encode_geo(lons: np.ndarray, lats: np.ndarray) -> bytes:
    """Geo grid file: gzip of int32 microdegrees, shape (ny, nx, 2) as (lon, lat),
    each row delta-coded along x (the first point absolute)."""
    q = np.round(np.stack([lons, lats], axis=-1) * 1e6).astype(np.int64)
    d = np.diff(q, axis=1, prepend=0).astype("<i4")
    return gzip.compress(d.tobytes(), compresslevel=9, mtime=0)


def decode_geo(blob: bytes, nx: int, ny: int) -> tuple[np.ndarray, np.ndarray]:
    d = np.frombuffer(gzip.decompress(blob), dtype="<i4").reshape(ny, nx, 2)
    q = np.cumsum(d.astype(np.int64), axis=1) / 1e6
    return q[..., 0], q[..., 1]


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
    vref: np.ndarray | None = None,
    vfac: np.ndarray | None = None,
    chunk_scale: np.ndarray | None = None,
    warp_info: dict[str, Any] | None = None,
    road_classes: dict[int, str] | None = None,
    provinces: dict[int, str] | None = None,
    start: tuple[int, int] | None = None,
    source: dict[str, Any] | None = None,
    generator: dict[str, Any] | None = None,
    render: dict[str, Any] | None = None,
    objects: list[dict[str, Any]] | None = None,
    micro: tuple[np.ndarray, int] | None = None,
    geo: tuple[np.ndarray, np.ndarray, int] | None = None,
    level: str | None = None,
    levels: list[dict[str, Any]] | None = None,
    depiction: dict[str, Any] | None = None,
    compress: bool = False,
    clean: bool = False,
) -> dict[str, Any]:
    """Split full-grid layers into chunks and write manifest.json + chunk files.

    With compress=True chunks are written as deterministic gzip (`.pxwc.gz`,
    mtime 0) and the manifest records the hash of the compressed bytes. With
    clean=True, chunk files left over from earlier builds are removed.
    micro = (micro_corners, K) adds micro-terrain (a (K·cells_y + 1, K·cells_x + 1)
    array of micro-corner heights) and `micro: {k}` to the manifest.
    geo = (lons, lats, step) writes `geo.i32.gz`, the lon/lat of cell corners every
    `step` cells (encode_geo), for moving between scale levels.
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
        "vref": vref,
        "vfac": vfac,
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
            mrange = None
            if micro is not None:
                mc, k = micro
                cs = chunk_size * k
                block = mc[cy * cs : (cy + 1) * cs + 1, cx * cs : (cx + 1) * cs + 1]
                # past the world edge, repeat the edge corners (flat, inside the range)
                pad = ((0, cs + 1 - block.shape[0]), (0, cs + 1 - block.shape[1]))
                layers["micro_corners"] = np.pad(block, pad, mode="edge")
                mrange = (block, k)
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
                    "heightRange": height_range(base[ys, xs], shape[ys, xs], mrange),
                    **(
                        {"metersPerCell": round(float(np.mean(chunk_scale[ys, xs])), 1)}
                        if chunk_scale is not None
                        else {}
                    ),
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
        "heightRange": height_range(base, shape, micro),
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
    if render is not None:
        manifest["render"] = render
    if micro is not None:
        manifest["micro"] = {"k": int(micro[1])}
    if warp_info is not None:
        manifest["warp"] = warp_info
    objects_path = out_dir / "objects.json.gz"
    if objects is not None:
        blob = json.dumps({"version": 1, "instances": objects}, separators=(",", ":")).encode()
        blob = gzip.compress(blob, compresslevel=9, mtime=0)
        objects_path.write_bytes(blob)
        manifest["objects"] = {
            "path": objects_path.name,
            "sha256": hashlib.sha256(blob).hexdigest(),
            "count": len(objects),
        }
    elif clean and objects_path.exists():
        objects_path.unlink()
    if depiction is not None:
        manifest["depiction"] = depiction
    if level is not None:
        manifest["level"] = level
    if levels is not None:
        manifest["levels"] = levels
    geo_path = out_dir / GEO_FILE
    if geo is not None:
        lons, lats, step = geo
        blob = encode_geo(lons, lats)
        geo_path.write_bytes(blob)
        manifest["geo"] = {
            "path": GEO_FILE,
            "step": int(step),
            "size": [int(lons.shape[1]), int(lons.shape[0])],
            "sha256": hashlib.sha256(blob).hexdigest(),
        }
    elif clean and geo_path.exists():
        geo_path.unlink()
    manifest["packageHash"] = package_hash(manifest)
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest
