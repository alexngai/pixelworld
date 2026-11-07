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
    pack_shape,
    shape_from_v0_mask,
    unpack_shape,
)


def test_round_trip():
    chunk = golden_chunk()
    out = decode_chunk(encode_chunk(chunk))
    assert (out.x, out.y, out.size) == (chunk.x, chunk.y, chunk.size)
    for name in ("base", "shape", "surface", "water", "road", "road_class", "geology"):
        np.testing.assert_array_equal(getattr(out, name), getattr(chunk, name))


def test_golden_v1_file_matches_expected():
    data = (GOLDEN_DIR / "chunk-v1-small.pxwc").read_bytes()
    expected = json.loads((GOLDEN_DIR / "chunk-v1-small.json").read_text())
    chunk = decode_chunk(data)
    assert (chunk.x, chunk.y, chunk.size) == (expected["x"], expected["y"], expected["size"])
    for name, key in (
        ("base", "base"),
        ("shape", "shape"),
        ("surface", "surface"),
        ("water", "water"),
        ("road", "road"),
        ("road_class", "roadClass"),
        ("geology", "geology"),
    ):
        assert getattr(chunk, name).flatten().tolist() == expected[key]
    assert unpack_shape(chunk.shape).max() == 3  # exercises multi-step offsets


def test_golden_v1_file_is_byte_stable():
    data = (GOLDEN_DIR / "chunk-v1-small.pxwc").read_bytes()
    assert encode_chunk(golden_chunk()) == data


def test_v0_files_still_decode():
    data = (GOLDEN_DIR / "chunk-v0-small.pxwc").read_bytes()
    expected = json.loads((GOLDEN_DIR / "chunk-v0-small.json").read_text())
    chunk = decode_chunk(data)
    assert chunk.base.flatten().tolist() == expected["base"]
    mask = np.array(expected["slope"], dtype=np.uint8)
    assert chunk.shape.flatten().tolist() == shape_from_v0_mask(mask).tolist()


def test_shape_packing_round_trips():
    offsets = np.array([[0, 3], [1, 0], [2, 1], [3, 2]])
    np.testing.assert_array_equal(unpack_shape(pack_shape(offsets)), offsets)


def test_rejects_unnormalized_shapes():
    with pytest.raises(ChunkFormatError):
        Chunk(
            x=0,
            y=0,
            base=np.zeros((1, 1), np.int16),
            shape=pack_shape(np.ones((4, 1, 1), np.uint8)),  # all corners raised
            surface=np.zeros((1, 1), np.uint8),
        )


def test_water_section_is_optional():
    size = 2
    chunk = Chunk(
        x=0,
        y=0,
        base=np.zeros((size, size), np.int16),
        shape=np.zeros((size, size), np.uint8),
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


def test_gzip_chunks_decode_and_package_hash_is_stable(tmp_path):
    from pixelworld_pipeline.world_format import write_package

    size = 8
    rng = np.random.default_rng(5)
    base = rng.integers(0, 20, size=(size, 10)).astype(np.int16)
    args = dict(
        world_id="t",
        name="t",
        base=base,
        shape=np.zeros_like(base, dtype=np.uint8),
        surface=np.ones_like(base, dtype=np.uint8),
        water=np.full_like(base, NO_WATER),
        road=np.where(base > 15, 4, 0).astype(np.uint16),
        chunk_size=4,
        scale={"metersPerCell": 1, "metersPerStep": 1, "elevationDatumMeters": 0},
        surfaces={1: "rock"},
        style="s",
        attribution=[],
        start=(3, 2),
        compress=True,
    )
    a = write_package(tmp_path / "a", **args)
    b = write_package(tmp_path / "b", **args)
    assert a["packageHash"] == b["packageHash"]
    assert a["heightRange"] == [int(base.min()), int(base.max())]
    ref = a["chunks"][0]
    assert ref["path"].endswith(".pxwc.gz")
    chunk = decode_chunk((tmp_path / "a" / ref["path"]).read_bytes())
    np.testing.assert_array_equal(chunk.base, base[:4, :4])
    args["road"] = np.zeros_like(base, dtype=np.uint16)
    c = write_package(tmp_path / "c", **args)
    assert c["packageHash"] != a["packageHash"]
