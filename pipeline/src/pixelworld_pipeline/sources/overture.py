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
from shapely.ops import substring

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
        from ..region import RegionError

        raise RegionError(
            f"sources.overture.release: Overture has no release '{release}' (no "
            f"{theme}/{kind} files under {BUCKET}release/{release}/); releases are named "
            "like 2026-10-21.0, see https://docs.overturemaps.org/release-calendar/"
        )
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
    filter_tag: str = "",
) -> list[dict]:
    """Rows (as dicts) from row groups intersecting bbox for which keep(row) is true.

    Results are cached per (release, theme, kind, bbox, columns, filter_tag) as
    JSON with geometries in WKT, sorted by id so repeated builds are
    deterministic. `filter_tag` must describe `keep`: two filters over the same
    box and columns would otherwise share one cache entry.
    """
    w, s, e, n = bbox
    tag = f"{theme}-{kind}-{w:.4f}_{s:.4f}_{e:.4f}_{n:.4f}-{'_'.join(sorted(columns))}"
    if filter_tag:
        tag += f"-{filter_tag}"
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
# what lanes and medians need (M3.5): names pair a divided road's carriageways,
# access restrictions say which ways are one-way, width rules give mapped widths
LANE_COLUMNS = ["names", "access_restrictions", "width_rules"]


def roads(
    release: str,
    bbox: tuple[float, float, float, float],
    classes: list[str],
    exclude_subclasses: list[str] | None = None,
    lanes: bool = False,
) -> list[dict]:
    """Road segments of the given classes (links/ramps and `exclude_subclasses`,
    e.g. parking aisles, left out). With `lanes`, also their names, access
    restrictions and width rules (LANE_COLUMNS), in a cache entry of their own."""
    wanted = set(classes)
    skip = {"link", *(exclude_subclasses or [])}
    return query(
        release,
        "transportation",
        "segment",
        bbox,
        ROAD_COLUMNS + (LANE_COLUMNS if lanes else []),
        lambda r: r["subtype"] == "road" and r["class"] in wanted and r.get("subclass") not in skip,
        filter_tag=f"roads:{','.join(sorted(wanted))}:skip:{','.join(sorted(skip))}",
    )


def road_subclasses(
    release: str,
    bbox: tuple[float, float, float, float],
    subclasses: list[str],
    lanes: bool = False,
) -> list[dict]:
    """Road segments of the given subclasses only (e.g. parking aisles, to join
    service roads that only connect through them), with the columns `roads` reads."""
    wanted = set(subclasses)
    return query(
        release,
        "transportation",
        "segment",
        bbox,
        ROAD_COLUMNS + (LANE_COLUMNS if lanes else []),
        lambda r: r["subtype"] == "road" and r.get("subclass") in wanted,
        filter_tag=f"road-subclasses:{','.join(sorted(wanted))}",
    )


# Footways split by their subclass: sidewalks and crosswalks look different.
FOOTWAY_SUBCLASSES = {"sidewalk", "crosswalk"}
PATH_SOURCE_CLASSES = {"footway", "pedestrian", "path", "steps", "cycleway"}


def path_class(row: dict) -> str:
    """The path class a segment is drawn as: footway subclasses count as their own."""
    if row["class"] == "footway" and row.get("subclass") in FOOTWAY_SUBCLASSES:
        return row["subclass"]
    return row["class"]


def paths(release: str, bbox: tuple[float, float, float, float], classes: list[str]) -> list[dict]:
    """Pedestrian and cycle ways whose path_class is in `classes` (D-050)."""
    wanted = set(classes)
    rows = query(
        release,
        "transportation",
        "segment",
        bbox,
        ROAD_COLUMNS,
        lambda r: r["subtype"] == "road" and r["class"] in PATH_SOURCE_CLASSES,
        filter_tag="paths",
    )
    return [r for r in rows if path_class(r) in wanted]


RAIL_COLUMNS = ["id", "subtype", "class", "names", "rail_flags", "connectors", "geometry"]


def rails(release: str, bbox: tuple[float, float, float, float], classes: list[str]) -> list[dict]:
    """Rail segments of the given classes (tram, light_rail, funicular, …) with
    their names and rail flags (`is_tunnel` and `is_bridge` ranges along them)."""
    wanted = set(classes)
    return query(
        release,
        "transportation",
        "segment",
        bbox,
        RAIL_COLUMNS,
        lambda r: r["subtype"] == "rail" and r["class"] in wanted,
        filter_tag=f"rails:{','.join(sorted(wanted))}",
    )


def rail_open_parts(row: dict) -> list:
    """A rail segment's lon/lat line without its tunnels (`is_tunnel` ranges
    in its rail flags; a flag without a range covers the whole segment)."""
    line = shapely.from_wkt(row["geometry"])
    parts = list(line.geoms) if hasattr(line, "geoms") else [line]
    if line.geom_type != "LineString":
        return parts  # ranges are along a single line; multi-lines are kept whole
    cuts: list[tuple[float, float]] = []
    for flag in row.get("rail_flags") or []:
        if "is_tunnel" not in (flag.get("values") or []):
            continue
        a, b = flag.get("between") or (0.0, 1.0)
        cuts.append((float(a), float(b)))
    if not cuts:
        return [line]
    out, at = [], 0.0
    for a, b in sorted(cuts):
        if a > at:
            out.append(substring(line, at, a, normalized=True))
        at = max(at, b)
    if at < 1.0:
        out.append(substring(line, at, 1.0, normalized=True))
    return [g for g in out if g.geom_type == "LineString" and g.length > 0]


def rail_matches(rule: dict, row: dict) -> bool:
    """A rail segment matches a rule by its class (`rail`), and optionally by
    name (any of `names`, case-insensitive, within its primary name; or
    `unnamed: true`, none) and by a lon/lat box (`bounds`: west, south, east,
    north) that holds all of it."""
    if row["class"] not in set(rule.get("rail") or []):
        return False
    name = (((row.get("names") or {}).get("primary")) or "").lower()
    if rule.get("unnamed") and name:
        return False
    names = [n.lower() for n in rule.get("names") or []]
    if names and not any(n in name for n in names):
        return False
    if "bounds" in rule:
        w, s, e, n = (float(v) for v in rule["bounds"])
        x0, y0, x1, y1 = shapely.from_wkt(row["geometry"]).bounds
        if x0 < w or y0 < s or x1 > e or y1 > n:
            return False
    return True


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

    return query(
        release,
        "base",
        "water",
        bbox,
        ["id", "subtype", "class", "geometry"],
        keep,
        filter_tag=f"rivers:{','.join(sorted(wanted))}",
    )


AREA_COLUMNS = ["id", "subtype", "class", "geometry"]


def _areas(
    release: str, bbox: tuple[float, float, float, float], kind: str, classes: list[str]
) -> list[dict]:
    wanted = set(classes)

    def keep(r) -> bool:
        if r["class"] not in wanted:
            return False
        return shapely.from_wkb(r["geometry"]).geom_type in ("Polygon", "MultiPolygon")

    return query(
        release,
        "base",
        kind,
        bbox,
        AREA_COLUMNS,
        keep,
        filter_tag=f"areas:{','.join(sorted(wanted))}",
    )


def land_use(
    release: str, bbox: tuple[float, float, float, float], classes: list[str]
) -> list[dict]:
    """Land-use polygons of the given classes (base theme `land_use`, from
    OpenStreetMap's landuse and leisure tags): parks, golf courses, pitches,
    cemeteries, gardens, residential land, …"""
    return _areas(release, bbox, "land_use", classes)


def land(release: str, bbox: tuple[float, float, float, float], classes: list[str]) -> list[dict]:
    """Natural land polygons of the given classes (base theme `land`, from
    OpenStreetMap's natural tags): grassland, scrub, heath, beach, sand, …"""
    return _areas(release, bbox, "land", classes)


BUILDING_COLUMNS = [
    "id",
    "class",
    "subtype",
    "height",
    "num_floors",
    "is_underground",
    "has_parts",
    # M3: names (landmarks replace buildings by name), shape and colour hints
    "names",
    "roof_shape",
    "roof_color",
    "facade_color",
    "facade_material",
]
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
