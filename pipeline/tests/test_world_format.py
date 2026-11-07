import json

import numpy as np
import pytest

from pixelworld_pipeline.golden import GOLDEN_DIR, golden_chunk
from pixelworld_pipeline.world_format import (
    NO_WATER,
    Chunk,
    ChunkFormatError,
    decode_chunk,
    encode_chunk,
)


def test_round_trip():
    chunk = golden_chunk()
    out = decode_chunk(encode_chunk(chunk))
    assert (out.x, out.y, out.size) == (chunk.x, chunk.y, chunk.size)
    for name in ("base", "slope", "surface", "water"):
        np.testing.assert_array_equal(getattr(out, name), getattr(chunk, name))


def test_golden_file_matches_expected():
    data = (GOLDEN_DIR / "chunk-v0-small.pxwc").read_bytes()
    expected = json.loads((GOLDEN_DIR / "chunk-v0-small.json").read_text())
    chunk = decode_chunk(data)
    assert (chunk.x, chunk.y, chunk.size) == (expected["x"], expected["y"], expected["size"])
    for name in ("base", "slope", "surface", "water"):
        assert getattr(chunk, name).flatten().tolist() == expected[name]


def test_golden_file_is_byte_stable():
    data = (GOLDEN_DIR / "chunk-v0-small.pxwc").read_bytes()
    assert encode_chunk(golden_chunk()) == data


def test_water_section_is_optional():
    size = 2
    chunk = Chunk(
        x=0,
        y=0,
        base=np.zeros((size, size), np.int16),
        slope=np.zeros((size, size), np.uint8),
        surface=np.zeros((size, size), np.uint8),
    )
    blob = encode_chunk(chunk)
    assert b"WATR" not in blob[:64]
    assert (decode_chunk(blob).water == NO_WATER).all()


def test_rejects_bad_magic_and_version():
    blob = bytearray(encode_chunk(golden_chunk()))
    bad = bytes(b"XXXX" + blob[4:])
    with pytest.raises(ChunkFormatError):
        decode_chunk(bad)
    blob[4] = 9
    with pytest.raises(ChunkFormatError):
        decode_chunk(bytes(blob))
