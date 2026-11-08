"""Overture Maps GeoParquet over HTTP range requests, pruned by bounding box.

Overture files are spatially clustered and every row group carries bbox
statistics, so we index each file's row groups once (footers only, cached as
JSON) and later download just the column chunks of row groups that intersect
the region. Releases are pinned for reproducibility.
"""

from __future__ import annotations

import hashlib
import json
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

import pyarrow.parquet as pq
import shapely

from .http import CACHE_ROOT, HttpRangeFile, get

BUCKET = "https://overturemaps-us-west-2.s3.amazonaws.com/"
BBOX_COLS = ("bbox.xmin", "bbox.ymin", "bbox.xmax", "bbox.ymax")


def list_files(prefix: str) -> list[tuple[str, int]]:
    """(key, size) for every object under prefix (handles S3 pagination)."""
    out: list[tuple[str, int]] = []
    token = None
    while True:
        url = f"{BUCKET}?list-type=2&prefix={prefix}"
        if token:
            url += "&continuation-token=" + quote(token, safe="")
        xml = get(url).decode()
        for key, size in re.findall(r"<Key>([^<]+)</Key>.*?<Size>(\d+)</Size>", xml, re.S):
            if key.endswith(".parquet"):
                out.append((key, int(size)))
        m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", xml)
        if not m:
            return sorted(out)
        token = m.group(1)


def _index_file(key: str, size: int) -> dict:
    f = HttpRangeFile(BUCKET + key, size)
    md = pq.ParquetFile(f).metadata
    rg0 = md.row_group(0)
    cols = {rg0.column(i).path_in_schema: i for i in range(rg0.num_columns)}
    groups = []
    for g in range(md.num_row_groups):
        rg = md.row_group(g)
        stats = [rg.column(cols[c]).statistics for c in BBOX_COLS]
        if any(s is None or not s.has_min_max for s in stats):
            box = [-180.0, -90.0, 180.0, 90.0]  # unknown: never prune
        else:
            box = [stats[0].min, stats[1].min, stats[2].max, stats[3].max]
        groups.append([g, *box, rg.num_rows])
    return {"key": key, "size": size, "row_groups": groups}


def build_index(release: str, theme: str, kind: str, workers: int = 6) -> list[dict]:
    """Row-group bbox index for one Overture type, cached under pipeline/.cache."""
    path = CACHE_ROOT / "overture" / release / f"{theme}-{kind}-index.json"
    if path.exists():
        return json.loads(path.read_text())
    files = list_files(f"release/{release}/theme={theme}/type={kind}/")
    if not files:
        raise RuntimeError(f"no Overture files for {release} {theme}/{kind}")
    with ThreadPoolExecutor(workers) as pool:
        index = list(pool.map(lambda kv: _index_file(*kv), files))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(index))
    return index


def query(
    release: str,
    theme: str,
    kind: str,
    bbox: tuple[float, float, float, float],
    columns: list[str],
    keep,
    workers: int = 6,
) -> list[dict]:
    """Rows (as dicts) from row groups intersecting bbox for which keep(row) is true.

    Results are cached per (release, theme, kind, bbox, columns) as JSON with
    geometries in WKT, sorted by id so repeated builds are deterministic.
    """
    w, s, e, n = bbox
    tag = f"{theme}-{kind}-{w:.4f}_{s:.4f}_{e:.4f}_{n:.4f}-{'_'.join(sorted(columns))}"
    path = CACHE_ROOT / "overture" / release / f"{hashlib.sha1(tag.encode()).hexdigest()[:16]}.json"
    meta_path = path.with_suffix(".tag")
    if path.exists() and meta_path.exists() and meta_path.read_text() == tag:
        return json.loads(path.read_text())

    index = build_index(release, theme, kind, workers)
    jobs = [
        (f["key"], f["size"], g[0])
        for f in index
        for g in f["row_groups"]
        if not (g[3] < w or g[1] > e or g[4] < s or g[2] > n)
    ]
    cols = sorted(set(columns) | {"id", "bbox", "geometry"})

    def read(job):
        key, size, g = job
        table = pq.ParquetFile(HttpRangeFile(BUCKET + key, size)).read_row_group(g, columns=cols)
        rows = []
        for row in table.to_pylist():
            b = row["bbox"]
            if b["xmax"] < w or b["xmin"] > e or b["ymax"] < s or b["ymin"] > n:
                continue
            if not keep(row):
                continue
            row["geometry"] = shapely.from_wkb(row["geometry"]).wkt
            del row["bbox"]
            rows.append(row)
        return rows

    with ThreadPoolExecutor(workers) as pool:
        rows = [r for chunk in pool.map(read, jobs) for r in chunk]
    rows.sort(key=lambda r: r["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows, default=str))
    meta_path.write_text(tag)
    return rows


ROAD_COLUMNS = ["id", "subtype", "class", "subclass", "connectors", "geometry"]


def roads(release: str, bbox: tuple[float, float, float, float], classes: list[str]) -> list[dict]:
    """Road segments of the given classes (links/ramps excluded)."""
    wanted = set(classes)
    return query(
        release,
        "transportation",
        "segment",
        bbox,
        ROAD_COLUMNS,
        lambda r: r["subtype"] == "road" and r["class"] in wanted and r.get("subclass") != "link",
    )


def rivers(
    release: str, bbox: tuple[float, float, float, float], subtypes: list[str]
) -> list[dict]:
    """Water lines (e.g. rivers) of the given subtypes; polygons are left to land cover."""
    wanted = set(subtypes)

    def keep(r) -> bool:
        if r["subtype"] not in wanted:
            return False
        geom_type = shapely.from_wkb(r["geometry"]).geom_type
        return geom_type in ("LineString", "MultiLineString")

    return query(release, "base", "water", bbox, ["id", "subtype", "class", "geometry"], keep)


BUILDING_COLUMNS = ["id", "class", "subtype", "height", "num_floors", "is_underground", "has_parts"]
PART_COLUMNS = ["id", "building_id", "height", "min_height", "num_floors", "is_underground"]


def buildings(release: str, bbox: tuple[float, float, float, float]) -> list[dict]:
    """Building footprints (above ground) with class and height where known."""
    return query(
        release,
        "buildings",
        "building",
        bbox,
        BUILDING_COLUMNS,
        lambda r: not r.get("is_underground"),
    )


def building_parts(release: str, bbox: tuple[float, float, float, float]) -> list[dict]:
    """Building parts (towers, wings) of buildings that have them, with their heights."""
    return query(
        release,
        "buildings",
        "building_part",
        bbox,
        PART_COLUMNS,
        lambda r: not r.get("is_underground"),
    )
