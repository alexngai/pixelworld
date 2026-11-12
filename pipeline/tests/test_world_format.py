import gzip
import json

import numpy as np
import pytest

from pixelworld_pipeline.golden import GOLDEN_DIR, golden_chunk, golden_objects
from pixelworld_pipeline.world_format import (
    NO_WATER,
    Chunk,
    ChunkFormatError,
    decode_chunk,
    decode_objects,
    encode_chunk,
    encode_objects,
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


def _footprint_bits(instances):
    return [[[v.hex() for v in p] for p in inst.get("fp", [])] for inst in instances]


def test_objects_v2_round_trips_to_the_same_instances():
    rng = np.random.default_rng(11)
    instances = []
    for i in range(500):
        # anchors with three decimals and footprints with two, as placement writes them
        x, y = (round(float(v), 3) for v in rng.uniform(-2, 600, size=2))
        offsets = rng.normal(0, 3, size=(5, 2))
        fp = [[round(x + float(dx), 2), round(y + float(dy), 2)] for dx, dy in offsets]
        instances.append({"g": "building", "x": x, "y": y, "s": i, "fp": fp, "hm": 6.0})
    instances.append({"g": "tree", "x": 1.0, "y": 2.0, "s": 1, "r": 3})
    for version in (1, 2):
        blob = encode_objects(instances, version)
        assert blob == encode_objects(instances, version)  # deterministic
        back = decode_objects(blob)
        assert back == instances
        assert _footprint_bits(back) == _footprint_bits(instances)  # float for float
    assert len(encode_objects(instances, 2)) < 0.85 * len(encode_objects(instances, 1))
    with pytest.raises(ValueError):
        encode_objects(instances, 3)
    with pytest.raises(ValueError):
        decode_objects(json.dumps({"version": 3, "instances": []}).encode())


def test_objects_golden_files_hold_the_same_instances():
    expected = golden_objects()
    for version in (1, 2):
        blob = (GOLDEN_DIR / f"objects-v{version}.json").read_bytes()
        assert blob == gzip.decompress(encode_objects(expected, version)) + b"\n"
        assert decode_objects(blob) == expected
        assert _footprint_bits(decode_objects(blob)) == _footprint_bits(expected)
    v2 = json.loads((GOLDEN_DIR / "objects-v2.json").read_text())
    # 245.125 sits on a rounding boundary: the anchor rounds half up, to 245.13
    assert v2["version"] == 2 and v2["instances"][0]["fp"][0] == [-23, -28]


def test_rail_corridor_pieces_round_trip_and_are_left_out_when_empty():
    # D-097: TSG sections, one per used slot, beside the RAIL layer's counts
    chunk = golden_chunk()
    n = chunk.base.shape[0]
    chunk.rail = np.zeros((n, n), np.uint16)
    chunk.rail[1, 2] = (3 << 12) | (3 << 8) | 0x800
    chunk.rail_seg0 = np.zeros((n, n), np.uint32)
    chunk.rail_seg0[1, 2] = 0x10FF2000
    data = encode_chunk(chunk)
    assert b"TSG0" in data and b"TSG1" not in data
    out = decode_chunk(data)
    assert int(out.rail[1, 2]) == (3 << 12) | (3 << 8) | 0x800
    assert int(out.rail_seg0[1, 2]) == 0x10FF2000
    assert b"TSG" not in encode_chunk(golden_chunk())
