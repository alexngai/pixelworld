"""Coarse heights (D-123): `pixelworld coarse-heights` on a built package."""

import gzip
import json

import numpy as np

from pixelworld_pipeline.coarse import NO_DATA, coarse_heights, write_coarse
from pixelworld_pipeline.world_format import NO_WATER, Chunk, encode_chunk, pack_shape, package_hash


def chunk(x, y, size=16, micro=False):
    base = np.arange(size, dtype=np.int16)[None, :].repeat(
        size, axis=0
    )  # rises one step a cell eastward
    offsets = np.zeros((4, size, size), dtype=np.uint8)
    offsets[1, 0, 0] = 2  # one corner of the north-west cell two steps up
    water = np.full((size, size), NO_WATER, dtype=np.int16)
    water[size - 1, 0] = 30  # a pool in the south-west cell
    c = Chunk(
        x=x,
        y=y,
        base=base,
        shape=pack_shape(offsets),
        surface=np.zeros((size, size), np.uint8),
        water=water,
    )
    if micro:
        c.micro_corners = np.full(
            (2 * size + 1, 2 * size + 1), 10, dtype=np.int16
        )  # 5 steps everywhere (k 2)
        c.micro_corners[0, 0] = -4
    return c


def test_each_block_holds_its_lowest_ground_and_highest_top_in_sixteenths():
    g = coarse_heights(
        [chunk(0, 0)], 16, 24, 16
    )  # the world ends in the middle of its second chunk column
    assert g.shape == (2, 3, 2)
    assert g[0, 0].tolist() == [
        0,
        7 * 16,
    ]  # cells 0..7 stand 0 to 7 steps (the raised corner reaches only 2)
    assert g[0, 1].tolist() == [8 * 16, 15 * 16]
    assert g[1, 0].tolist() == [0, 30 * 16]  # the pool stands over the ground
    assert g[0, 2].tolist() == [NO_DATA, NO_DATA]  # no chunk there
    m = coarse_heights([chunk(0, 0, micro=True)], 16, 16, 16)
    assert m[0, 0].tolist() == [-2 * 16, 5 * 16]  # micro-corners in half steps


def test_writes_the_file_and_the_manifest_entry(tmp_path):
    (tmp_path / "chunks").mkdir()
    (tmp_path / "chunks/0_0.pxwc").write_bytes(encode_chunk(chunk(0, 0)))
    manifest = {
        "chunkSize": 16,
        "cellsX": 16,
        "cellsY": 16,
        "chunks": [{"x": 0, "y": 0, "path": "chunks/0_0.pxwc"}],
    }
    manifest["packageHash"] = package_hash(manifest)
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))
    entry = write_coarse(tmp_path)
    assert entry["block"] == 8 and entry["path"] == "coarse.i16.gz"
    after = json.loads((tmp_path / "manifest.json").read_text())
    assert after["coarse"] == entry and after["packageHash"] == package_hash(after)
    data = np.frombuffer(gzip.decompress((tmp_path / "coarse.i16.gz").read_bytes()), "<i2")
    assert data.tolist() == coarse_heights([chunk(0, 0)], 16, 16, 16).ravel().tolist()
