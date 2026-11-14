"""Placed objects by chunk (D-123): `pixelworld object-chunks` on a built package."""

import gzip
import json

from pixelworld_pipeline.object_chunks import split_objects, write_object_chunks
from pixelworld_pipeline.world_format import decode_objects, encode_objects, package_hash

INSTANCES = [
    {"g": "tree.conifer", "x": 3.5, "y": 2.5, "s": 1},  # chunk 0,0
    {
        "g": "building.house",
        "x": 62.0,
        "y": 10.0,
        "s": 2,
        "fp": [[61.0, 9.0], [66.0, 9.0], [66.0, 11.0], [61.0, 11.0]],
    },  # over the edge into 1,0
    {
        "g": "landmark.tower",
        "x": 70.25,
        "y": 70.25,
        "s": 3,
        "id": "tower",
    },  # a landmark: its own file
    {"g": "rock", "x": 127.5, "y": 0.5, "s": 4},  # 1,0
]


def package(tmp_path):
    (tmp_path / "objects.json.gz").write_bytes(encode_objects([dict(i) for i in INSTANCES]))
    manifest = {
        "id": "t",
        "chunkSize": 64,
        "cellsX": 128,
        "cellsY": 128,
        "objects": {"path": "objects.json.gz"},
    }
    manifest["packageHash"] = package_hash(manifest)
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))
    (tmp_path / "build-report.json").write_text(
        json.dumps({"packageHash": manifest["packageHash"]})
    )
    return tmp_path


def test_split_files_each_instance_by_every_chunk_its_bounds_touch_and_landmarks_apart():
    landmarks, chunks = split_objects(INSTANCES, 64, 128, 128)
    assert [i["id"] for i in landmarks] == ["tower"]
    assert sorted(chunks) == [(0, 0), (1, 0)]
    assert [i["s"] for i in chunks[(0, 0)]] == [1, 2]
    assert [i["s"] for i in chunks[(1, 0)]] == [2, 4]


def test_writes_the_files_and_the_manifest_entry_deterministically(tmp_path):
    out = package(tmp_path)
    before = json.loads((out / "manifest.json").read_text())["packageHash"]
    summary = write_object_chunks(out)
    assert summary == {"chunks": 2, "landmarks": 1, "instances": 4}
    manifest = json.loads((out / "manifest.json").read_text())
    entry = manifest["objectChunks"]
    assert entry["path"] == "objects/{x}_{y}.json.gz"
    assert [(c["x"], c["y"], c["count"]) for c in entry["chunks"]] == [(0, 0, 2), (1, 0, 2)]
    assert entry["landmarks"]["count"] == 1
    assert manifest["packageHash"] == package_hash(manifest) != before
    assert json.loads((out / "build-report.json").read_text())["objectChunks"] == summary
    # the house's footprint reads back the same from either chunk
    house = [i for i in decode_objects((out / "objects/1_0.json.gz").read_bytes()) if i["s"] == 2][
        0
    ]
    assert house["fp"] == INSTANCES[1]["fp"]
    first = (out / "objects/0_0.json.gz").read_bytes()
    write_object_chunks(out)
    assert (out / "objects/0_0.json.gz").read_bytes() == first
    assert json.loads(gzip.decompress(first))["version"] == 2
