"""Japan's building facts from PLATEAU (D-089): the 3D city models of the
Ministry of Land, Infrastructure, Transport and Tourism (MLIT), one CityGML
file of buildings per 1 km mesh, read per building into a footprint, its
measured height, storeys, year built, use, structure and roof shape.

The `plateau` facts source (PlateauFacts) is registered through the
`pixelworld.facts` entry point. A region names it in its typology section:

    objects:
      typology:
        facts: plateau
        # or pinned to the PLATEAU release its extracts were cached from:
        facts: { plugin: plateau, year: 2025 }

Options:
- year: the PLATEAU release (the year the city's models were published).
  The data catalog serves only each city's current release; a pinned year
  reads the extracts cached from it, and fails if the catalog has moved on
  and one is missing.
- keepGml: true keeps each mesh's CityGML (gzipped, 1–45 MB) in the cache
  beside its extract. By default only the extract is kept.

How it reads: the region's box gives the 3rd-level (1 km) mesh codes of the
Japanese standard grid (JIS X 0410); PLATEAU's data catalog API lists each
mesh's `bldg` file for every city whose models cover it (a Tokyo ward's
package repeats its neighbours' border meshes: one copy is read). Each file
(10–330 MB of XML, served gzip-encoded at 4–14% of that) is streamed
through ElementTree's iterparse, and a compact extract per mesh is cached
under plateau/ in the shared download cache, named by city code, release
year, spec and mesh.

Facts are looked up by point in footprint (the LoD0 roof edge or footprint,
else the bottom of the LoD1 solid).

Licence (checked 2026-11-11, second-region.md §9): PLATEAU's site policy
puts the 3D city models (copyright: each municipality) under the Public Data
License 1.0, compatible with CC BY 4.0, credited "出典：国土交通省
PLATEAUウェブサイト"; edits must be stated, and edited data mustn't be
presented as MLIT's.
"""

from __future__ import annotations

import gzip
import io
import itertools
import json
import math
import os
import xml.etree.ElementTree as ET
from collections import Counter
from collections.abc import Iterator
from typing import Any

import numpy as np
import shapely
from rasterio.warp import transform as transform_points

from pixelworld_pipeline import progress
from pixelworld_pipeline.facts import FactsSource
from pixelworld_pipeline.sources.http import cache_dir, get

CATALOG = "https://api.plateau.reearth.io/datacatalog/citygml/m:"
JGD2011 = "EPSG:6668"  # the files' EPSG:6697 is JGD2011 lat/lon plus heights
# the box's margin (degrees): footprints that cross it
PAD_DEG = 0.002
# what an extract holds; bump it when that changes, so old extracts are re-read
EXTRACT = 3

ATTRIBUTION = [
    {
        "name": (
            "出典：国土交通省 PLATEAUウェブサイト (3D city models, building models, CityGML; "
            "the cities, release and spec as fetched, see the build log; copyright: each "
            "municipality). Processed: footprints, heights, storeys, years, uses, structures "
            "and roof shapes extracted per building (PLATEAUの3D都市モデルを加工して作成)"
        ),
        "license": "Public Data License 1.0 (PDL 1.0), compatible with CC BY 4.0",
        "url": "https://www.mlit.go.jp/plateau/site-policy/",
    }
]

# Code lists, as shipped in each city's package (codelists/, spec 5.0; read
# from Kyoto's 2025 release). bldg:usage (Building_usage.xml) → use group.
USAGE = {
    401: ("業務施設", "commercial"),  # offices
    402: ("商業施設", "commercial"),  # shops, restaurants, entertainment
    403: ("宿泊施設", "commercial"),  # hotels, ryokan
    404: ("商業系複合施設", "commercial"),  # commercial complexes
    411: ("住宅", "residential"),  # houses
    412: ("共同住宅", "residential"),  # flats
    413: ("店舗等併用住宅", "mixed"),  # a house with a shop
    414: ("店舗等併用共同住宅", "mixed"),  # flats over shops
    415: ("作業所併用住宅", "mixed"),  # a house with a workshop
    421: ("官公庁施設", "civic"),  # government offices
    422: ("文教厚生施設", "civic"),  # schools, hospitals, temples, shrines
    431: ("運輸倉庫施設", "industrial"),  # transport and warehouses
    441: ("工場", "industrial"),  # factories
    451: ("農林漁業用施設", "industrial"),  # farm, forestry and fishery buildings
    452: ("供給処理施設", "industrial"),  # utilities and waste
    453: ("防衛施設", "civic"),  # defence
    454: ("その他", ""),  # other
    461: ("不明", ""),  # unknown
}

# uro:buildingStructureType (BuildingDetailAttribute_buildingStructureType.xml) → material
STRUCTURE = {
    601: ("木造・土蔵造", "wood"),  # timber, and earthen storehouses
    602: ("鉄骨鉄筋コンクリート造", "steel reinforced concrete"),
    603: ("鉄筋コンクリート造", "reinforced concrete"),
    604: ("鉄骨造", "steel"),
    605: ("軽量鉄骨造", "light steel"),
    606: ("レンガ造・コンクリートブロック造・石造", "masonry"),  # brick, block, stone
    610: ("非木造", "non-wood"),
    611: ("不明", ""),  # unknown
}

# Kept in the extract, not read as facts (yet): Tokyo's models have no
# structure but give these. uro:fireproofStructureType
# (BuildingDetailAttribute_fireproofStructureType.xml): 1001 耐火 fireproof,
# 1002 準耐火造 quasi-fireproof, 1003 その他 other, 1011 不明 unknown; and
# uro:detailedUsage (BuildingDetailAttribute_detailedUsage.xml), a finer use
# whose code starts with its bldg:usage code (412102 マンション, 403102 旅館).

# placeholders: year 0001 is unknown; storeys 0 and 9999 are unknown
NO_YEAR = 1
NO_STOREYS = (0, 9999)


def write_atomic(path, data: bytes) -> None:
    """Write a cache file whole or not at all: the cache is shared between
    worktrees, and a killed or concurrent build mustn't leave half a file."""
    tmp = path.with_name(f"{path.name}.{os.getpid()}.part")
    tmp.write_bytes(data)
    os.replace(tmp, path)


# ---- mesh codes -----------------------------------------------------------------------------


def mesh_codes(bounds: tuple[float, float, float, float]) -> list[str]:
    """The 3rd-level (1 km: 30" of latitude by 45" of longitude) mesh codes of
    the Japanese standard grid covering a lon/lat box."""
    w, s, e, n = bounds
    out = []
    for r in range(math.floor(s * 120), math.ceil(n * 120)):
        for c in range(math.floor((w - 100) * 80), math.ceil((e - 100) * 80)):
            out.append(f"{r // 80:02d}{c // 80:02d}{r % 80 // 10}{c % 80 // 10}{r % 10}{c % 10}")
    return out


def mesh_bounds(code: str) -> tuple[float, float, float, float]:
    """A 3rd-level mesh's lon/lat box."""
    r = int(code[0:2]) * 80 + int(code[4]) * 10 + int(code[6])
    c = int(code[2:4]) * 80 + int(code[5]) * 10 + int(code[7])
    return 100 + c / 80, r / 120, 100 + (c + 1) / 80, (r + 1) / 120


# ---- the catalog ----------------------------------------------------------------------------


def catalog(mesh: str) -> list[dict]:
    """The building files PLATEAU's catalog lists for a mesh, one per distinct
    dataset: {city, cityName, year, spec, url, size, features, lods}. Tokyo's
    wards each list their border meshes in full; those copies (the same
    counts of features and of LoD0–2 models, sizes 0.5–2% apart) are read
    once. Buildings are deduplicated by id anyway, so a copy read twice only
    costs a download."""
    doc = json.loads(get(CATALOG + mesh, timeout=120))
    out: list[dict] = []
    for city in doc.get("cities", []):
        for f in city.get("files", {}).get("bldg", []):
            if f.get("code") != mesh:
                continue
            entry = {
                "city": str(city["cityCode"]),
                "cityName": city.get("cityName", ""),
                "year": int(city["year"]),
                "spec": str(city.get("spec", "")),
                "url": f["url"],
                "size": int(f.get("fileSize") or 0),
                "features": int(f.get("features") or 0),
                "lods": [int(f.get(f"lod{i}") or 0) for i in range(3)],
            }
            if not any(
                (o["features"], o["lods"]) == (entry["features"], entry["lods"])
                and entry["features"] > 0
                and abs(o["size"] - entry["size"]) <= 0.05 * o["size"]
                for o in out
            ):
                out.append(entry)
    return out


# ---- parsing --------------------------------------------------------------------------------


def _local(tag: str) -> str:
    return tag.rpartition("}")[2]


def _rings(elem: ET.Element) -> list[tuple[np.ndarray, list[np.ndarray]]]:
    """Every gml:Polygon under elem: (exterior, interiors), each (n, 3) arrays
    of latitude, longitude, height."""
    out = []
    for poly in elem.iter():
        if _local(poly.tag) != "Polygon":
            continue
        ext, holes = None, []
        for part in poly:
            kind = _local(part.tag)
            for pl in part.iter():
                if _local(pl.tag) == "posList" and pl.text:
                    ring = np.array(pl.text.split(), dtype=float).reshape(-1, 3)
                    if kind == "exterior":
                        ext = ring
                    elif kind == "interior":
                        holes.append(ring)
        if ext is not None and len(ext) >= 4:
            out.append((ext, holes))
    return out


def _footprint(polys) -> shapely.Geometry | None:
    """A (multi)polygon in lon/lat from (exterior, interiors) rings in lat/lon."""
    shapes = []
    for ext, holes in polys:
        p = shapely.Polygon(ext[:, [1, 0]], [h[:, [1, 0]] for h in holes if len(h) >= 4])
        if not p.is_valid:
            p = shapely.make_valid(p)
        if not p.is_empty and p.area > 0:
            shapes.append(p)
    if not shapes:
        return None
    # the union flattens what make_valid nests (a collection of a multipolygon and a line)
    g = [p for p in shapely.get_parts(shapely.union_all(shapes)) if p.geom_type == "Polygon"]
    return None if not g else g[0] if len(g) == 1 else shapely.MultiPolygon(g)


def _bottom(polys) -> list:
    """The polygons of an LoD1 solid lying at its lowest height (its base)."""
    if not polys:
        return []
    z0 = min(float(ext[:, 2].min()) for ext, _ in polys)
    return [(e, h) for e, h in polys if float(e[:, 2].max()) <= z0 + 0.01]


# ---- roof shapes from LoD2 roof surfaces ----------------------------------------------------

FLAT_DEG = 5.0  # facets flatter than this are flat (陸屋根 drains at 1–2°)
FLAT_SHARE = 0.5  # of the roof's plan area, for a flat roof
SHED_SHARE = 0.8  # of the sloped plan area facing one way, for a shed (skillion) roof


def _local_xyz(ring: np.ndarray, lat0: float, lon0: float) -> np.ndarray:
    """A lat/lon/height ring in local metres (east, north, up)."""
    k = math.cos(math.radians(lat0))
    return np.column_stack(
        [(ring[:, 1] - lon0) * 111_320.0 * k, (ring[:, 0] - lat0) * 110_574.0, ring[:, 2]]
    )


def _normal(xyz: np.ndarray) -> np.ndarray:
    """Newell's normal of a ring (its length is twice the ring's area), pointing up."""
    x, y, z = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    x1, y1, z1 = np.roll(x, -1), np.roll(y, -1), np.roll(z, -1)
    n = np.array(
        [((y - y1) * (z + z1)).sum(), ((z - z1) * (x + x1)).sum(), ((x - x1) * (y + y1)).sum()]
    )
    return -n if n[2] < 0 else n


def roof_shape(rings: list[np.ndarray]) -> str:
    """A roof's shape in Overture's words from its LoD2 roof surfaces (the
    exterior rings, lat/lon/height): `flat`, `skillion` (a shed roof),
    `gabled` or `hipped`; "" without roof surfaces.

    Flat: at least half the roof's plan area slopes less than 5°. Skillion:
    80% of the sloped area faces one way (the building's four directions are
    found from the facets themselves). Otherwise the sloped edges decide
    (roof_edges): more hip than gable verge, in plan length, is hipped. So an
    L- or T-shaped gable (valleys, one or two hips at outer corners) stays
    gabled, and a hip-and-gable roof (入母屋), whose small gable sits on a
    hipped skirt instead of running down to the eaves, is hipped."""
    rings = [r for r in rings if len(r) >= 4]
    if not rings:
        return ""
    lat0, lon0 = float(rings[0][0, 0]), float(rings[0][0, 1])
    facets = []  # (xyz, plan area, slope°, aspect radians)
    for r in rings:
        xyz = _local_xyz(r, lat0, lon0)
        n = _normal(xyz)
        plan = abs(n[2]) / 2
        horiz = math.hypot(n[0], n[1])
        if plan < 1e-6 and horiz < 1e-6:
            continue
        slope = math.degrees(math.atan2(horiz, abs(n[2])))
        if slope > 80:  # a wall-like sliver tagged as roof
            continue
        facets.append((xyz, plan, slope, math.atan2(n[1], n[0])))
    total = sum(f[1] for f in facets)
    if total <= 0:
        return ""
    sloped = [i for i, f in enumerate(facets) if f[2] >= FLAT_DEG]
    if total - sum(facets[i][1] for i in sloped) >= FLAT_SHARE * total or not sloped:
        return "flat"
    # the building's axes, from the facets' aspects modulo 90° (weighted by plan area)
    w = np.array([facets[i][1] for i in sloped])
    th = np.array([facets[i][3] for i in sloped])
    axis = math.atan2((w * np.sin(4 * th)).sum(), (w * np.cos(4 * th)).sum()) / 4
    side = np.full(len(facets), -1)  # each sloped facet's way (0–3); -1 is flat
    side[sloped] = np.round((th - axis) / (math.pi / 2)).astype(int) % 4
    shares = np.bincount(side[sloped], weights=w, minlength=4) / w.sum()
    if shares.max() >= SHED_SHARE:
        return "skillion"
    hips, _, verges = roof_edges(facets, side)
    return "hipped" if hips > verges else "gabled"


def roof_edges(facets: list, side: np.ndarray) -> tuple[float, float, float]:
    """Plan lengths of a roof's sloped edges: (hips, valleys, gable verges).

    A hip or a valley joins two sloped facets facing different ways: a hip
    where both fall away from it, a valley where they fall towards it. A gable
    verge belongs to one roof facet only and runs down to that facet's eave
    (a level edge at its foot that no other roof facet shares); a hip-and-gable
    roof's gable, which stands on its hipped skirt, has none. Edges between
    coplanar pieces of one slope are neither."""
    edges: dict[tuple, list[int]] = {}
    for i, (xyz, _, _, _) in enumerate(facets):
        for a, b in zip(xyz, np.roll(xyz, -1, axis=0), strict=True):
            if math.hypot(a[0] - b[0], a[1] - b[1]) >= 0.05:
                key = tuple(sorted((tuple(np.round(a, 2)), tuple(np.round(b, 2)))))
                edges.setdefault(key, []).append(i)
    eave_ends: dict[int, set] = {}  # each facet's eaves' end points
    for (p, q), users in edges.items():
        if len(users) == 1 and abs(p[2] - q[2]) < 0.05:
            i = users[0]
            if p[2] <= facets[i][0][:, 2].min() + 0.05:
                eave_ends.setdefault(i, set()).update((p, q))
    hips = valleys = verges = 0.0
    for (p, q), users in edges.items():
        users = [i for i in users if side[i] >= 0]
        run = math.hypot(p[0] - q[0], p[1] - q[1])
        if not users or abs(p[2] - q[2]) < math.tan(math.radians(FLAT_DEG)) * run:
            continue
        if len(users) == 1:
            if min(p, q, key=lambda v: v[2]) in eave_ends.get(users[0], ()):
                verges += run
        elif len({int(side[i]) for i in users}) > 1:
            # does the facet fall away from the edge (a hip) or towards it (a valley)?
            xyz, _, _, aspect = facets[users[0]]
            a, b = np.array(p[:2]), np.array(q[:2])
            d = (b - a) / run
            v = xyz[:-1, :2].mean(axis=0) - (a + b) / 2
            if (v - (v @ d) * d) @ (math.cos(aspect), math.sin(aspect)) > 0:
                hips += run
            else:
                valleys += run
    return hips, valleys, verges


# ---- buildings ------------------------------------------------------------------------------

# the elements read from a building, by local name
_ATTRS = {
    "yearOfConstruction": "year",
    "measuredHeight": "height",
    "storeysAboveGround": "storeys",
    "usage": "usage",
    "buildingStructureType": "structure",
    "fireproofStructureType": "fireproof",
    "detailedUsage": "detailed",
}


def _own(elem: ET.Element) -> Iterator[ET.Element]:
    """An element's descendants, without its building parts."""
    for child in elem:
        if _local(child.tag) != "consistsOfBuildingPart":
            yield child
            yield from _own(child)


def _building(elem: ET.Element) -> dict | None:
    """One bldg:Building (with its parts) as an extract record, or None
    without a footprint."""
    rec: dict[str, Any] = {"id": elem.get("{http://www.opengis.net/gml}id", "")}
    lod0: list = []
    lod0_edge: list = []
    lod1: list = []
    roofs: list[np.ndarray] = []
    # the building's own attributes first, its parts' where it has none
    for child in itertools.chain(_own(elem), elem.iter()):
        key = _ATTRS.get(_local(child.tag))
        if key is not None and key not in rec and child.text and child.text.strip():
            rec[key] = child.text.strip()
    for child in elem.iter():
        name = _local(child.tag)
        if name == "lod0FootPrint":
            lod0 += _rings(child)
        elif name == "lod0RoofEdge":
            lod0_edge += _rings(child)
        elif name == "lod1Solid":
            lod1 += _rings(child)
        elif name == "RoofSurface":
            roofs += [ext for ext, _ in _rings(child)]
    for polys in (lod0, lod0_edge, _bottom(lod1)):
        geom = _footprint(polys)
        if geom is not None:
            break
    else:
        return None
    geom = shapely.set_precision(geom, 1e-7)  # about a centimetre
    if geom.is_empty:
        return None
    rec["geom"] = shapely.geometry.mapping(geom)["coordinates"]
    rec["kind"] = geom.geom_type
    rec["roof"] = roof_shape(roofs)
    return rec


def parse(stream) -> Iterator[dict]:
    """The extract records of a PLATEAU building file (CityGML), streamed."""
    root = None
    depth = 0
    for event, elem in ET.iterparse(stream, events=("start", "end")):
        if event == "start":
            root = elem if root is None else root
            depth += 1
            continue
        depth -= 1
        if _local(elem.tag) == "Building" and elem.get("{http://www.opengis.net/gml}id"):
            rec = _building(elem)
            if rec is not None:
                yield rec
        if depth == 1:
            root.clear()  # a member of the model is read: drop it (and appearances, textures)


def _extract_path(entry: dict, mesh: str):
    spec = entry["spec"].replace(".", "_")
    return cache_dir("plateau") / f"{entry['city']}-{entry['year']}-spec{spec}-{mesh}-x{EXTRACT}"


def extract(entry: dict, mesh: str, keep_gml: bool = False) -> list[dict]:
    """A mesh's extract records from one catalog entry, cached."""
    base = _extract_path(entry, mesh)
    path = base.with_suffix(".json.gz")
    if path.exists():
        return json.loads(gzip.decompress(path.read_bytes()))
    gml = base.with_name(f"{entry['city']}-{entry['year']}-{mesh}_bldg.gml.gz")
    if gml.exists():
        data = gml.read_bytes()
    else:
        progress.log(f"plateau: {entry['cityName']} {entry['year']} mesh {mesh}")
        data = get(entry["url"], headers={"Accept-Encoding": "gzip"}, timeout=900)
    stream = gzip.GzipFile(fileobj=io.BytesIO(data)) if data[:2] == b"\x1f\x8b" else None
    records = list(parse(stream if stream is not None else io.BytesIO(data)))
    if keep_gml and not gml.exists():
        write_atomic(gml, data if stream is not None else gzip.compress(data))
    write_atomic(path, gzip.compress(json.dumps(records, separators=(",", ":")).encode()))
    return records


# ---- facts ----------------------------------------------------------------------------------


def _int(v: Any) -> int | None:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def building_facts(rec: dict) -> dict[str, Any]:
    """One building's facts from its extract record."""
    year = _int(rec.get("year"))
    storeys = _int(rec.get("storeys"))
    usage = _int(rec.get("usage"))
    structure = _int(rec.get("structure"))
    height = float(rec.get("height") or 0.0)
    return {
        "year": year if year is not None and year > NO_YEAR else None,
        "stories": float(storeys) if storeys is not None and storeys not in NO_STOREYS else 0.0,
        "use": USAGE.get(usage, ("", ""))[1],
        "class": str(rec.get("usage") or ""),
        "material": STRUCTURE.get(structure, ("", ""))[1],
        "roof": rec.get("roof", ""),
        "height": max(0.0, height),
    }


def _shape(rec: dict) -> shapely.Geometry:
    return shapely.geometry.shape({"type": rec["kind"], "coordinates": rec["geom"]})


class FootprintFacts:
    """Facts per PLATEAU building, looked up by projected point."""

    def __init__(self, crs, bounds, year: int | None = None, keep_gml: bool = False):
        self.meshes = mesh_codes(bounds)
        self.datasets: Counter = Counter()  # (city name, year, spec) → meshes
        self.records: list[dict] = []
        seen: set[str] = set()
        for mesh in self.meshes:
            for entry in self._entries(mesh, year):
                self.datasets[(entry["cityName"], entry["year"], entry["spec"])] += 1
                for rec in extract(entry, mesh, keep_gml):
                    if rec["id"] in seen:
                        continue
                    seen.add(rec["id"])
                    self.records.append(rec)
        geoms = np.array([_shape(r) for r in self.records], dtype=object)
        keep = shapely.intersects(geoms, shapely.box(*bounds)) if len(geoms) else geoms
        self.records = [r for r, k in zip(self.records, keep, strict=True) if k]
        geoms = geoms[keep] if len(geoms) else geoms
        self.facts = [building_facts(r) for r in self.records]

        def project(xy: np.ndarray) -> np.ndarray:
            if not len(xy):
                return xy
            xs, ys = transform_points(JGD2011, crs, xy[:, 0].tolist(), xy[:, 1].tolist())
            return np.column_stack([xs, ys])

        self.geoms = shapely.transform(geoms, project) if len(geoms) else geoms
        self.tree = shapely.STRtree(self.geoms)

    @staticmethod
    def _entries(mesh: str, year: int | None) -> list[dict]:
        """A mesh's catalog entries. Each answer is kept, named by the releases
        it lists (`catalog-<mesh>-2025.json`, `…-2024_2025.json`, `…-none.json`
        for a mesh without models); a pinned year reads the newest that lists
        it (or none), so a pinned build needs no network."""
        cache = cache_dir("plateau")
        if year is not None:
            kept = [
                p
                for p in cache.glob(f"catalog-{mesh}-*.json")
                if str(year) in p.stem.split("-")[-1].split("_") or p.stem.endswith("-none")
            ]
            if kept:
                return json.loads(max(kept, key=lambda p: p.stat().st_mtime).read_text())
        entries = catalog(mesh)
        years = sorted({e["year"] for e in entries})
        if year is not None and entries and year not in years:
            raise RuntimeError(
                f"plateau: mesh {mesh} isn't cached from the {year} release, and the "
                f"catalog now serves {', '.join(map(str, years))}: unpin `year` (or set "
                "it to the catalog's) to read the current release"
            )
        tag = "_".join(map(str, years)) or "none"
        write_atomic(cache / f"catalog-{mesh}-{tag}.json", json.dumps(entries).encode())
        return entries

    def at(self, xs: np.ndarray, ys: np.ndarray) -> list[dict | None]:
        """Facts of the footprint containing each projected point (None outside every one)."""
        out: list[dict | None] = [None] * len(xs)
        idx_pt, idx_fp = self.tree.query(shapely.points(xs, ys), predicate="within")
        for i, j in sorted(zip(idx_pt.tolist(), idx_fp.tolist(), strict=True)):
            if out[i] is None:
                out[i] = self.facts[j]
        return out


OPTIONS = ("year", "keepGml")


class PlateauFacts(FactsSource):
    """The `plateau` facts source: PLATEAU's building models of a Japanese city."""

    attribution = ATTRIBUTION

    def __init__(self, region, options: dict[str, Any] | None = None):
        super().__init__(region, options)
        unknown = sorted(set(self.options) - set(OPTIONS))
        if unknown:
            raise ValueError(
                f"plateau facts: unknown option(s) {', '.join(unknown)} "
                f"(it takes {', '.join(OPTIONS)})"
            )
        year = self.options.get("year")
        self.footprints = FootprintFacts(
            region.crs,
            region.lonlat_envelope(PAD_DEG),
            int(year) if year is not None else None,
            bool(self.options.get("keepGml", False)),
        )

    def at(self, xs: np.ndarray, ys: np.ndarray) -> list[dict | None]:
        return self.footprints.at(xs, ys)

    def summary(self) -> str:
        f = self.footprints
        sets = ", ".join(f"{name} {year} (spec {spec})" for name, year, spec in sorted(f.datasets))
        n = len(f.meshes)
        return f"PLATEAU {sets or 'no data'}: {len(f.facts)} buildings in {n} mesh{'es' * (n != 1)}"
