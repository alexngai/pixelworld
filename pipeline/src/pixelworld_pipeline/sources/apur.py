"""Paris building facts (D-084): APUR's built footprints of Paris ("Emprise
bâtie Paris": construction period, median height, roof form, urban fabric)
joined to IGN's BD TOPO buildings (storeys, dwellings, use), with APUR's
quartier as the neighbourhood.

The `apur` facts source (ApurFacts) is built in. A region selects it:

    sources:
      facts: { kind: apur }
      # or pinned to the downloads it cached:
      facts: { kind: apur, version: "2026-07-30" }

Options:
- version: the tag the downloads are cached under (default: the date APUR
  last updated its layer, asked of ArcGIS Online). Both services serve only
  their current data; the option keeps a build reading the cache it made.

Facts are looked up by point in APUR footprint. A footprint finds its BD TOPO
building by its representative point, and its quartier by its centroid.
APUR's layers are read through its ArcGIS REST service, BD TOPO through the
Géoplateforme's WFS, both limited to the region's box, paged, and cached in
the shared download cache under paris/.

Licences (checked 2026-11-10, second-region.md §8): APUR's layers are under
the ODbL; BD TOPO under the Licence Ouverte / Open Licence 2.0 (Etalab),
which asks for the source and the date of its last update.
"""

from __future__ import annotations

import gzip
import json
import urllib.parse
from datetime import UTC, datetime
from typing import Any

import numpy as np
import shapely
from rasterio.warp import transform as transform_points

from pixelworld_pipeline.facts import FactsSource
from pixelworld_pipeline.schema import Key, Str
from pixelworld_pipeline.sources.http import cache_dir, get

APUR = "https://carto2.apur.org/apur/rest/services/OPENDATA/"
EMPRISE = "EMPRISE_BATIE_PARIS/MapServer/0"
QUARTIER = "QUARTIER/MapServer/0"
EMPRISE_ITEM = "85fa0a4303744ad4ab6e2a89882b5fca"  # the layer's ArcGIS Online item
WFS = "https://data.geopf.fr/wfs/ows?"
BDTOPO = "BDTOPO_V3:batiment"
APUR_PAGE = 2000  # the service's maxRecordCount is 3000
WFS_PAGE = 5000  # the Géoplateforme's CountDefault
# the box's margin (degrees): footprints that cross it
PAD_DEG = 0.002

APUR_FIELDS = "OBJECTID,an_const,c_perconst,h_med,c_forme_toit,c_tissu"
BDTOPO_FIELDS = "cleabs,usage_1,usage_2,nombre_d_etages,nombre_de_logements,geometrie"

ATTRIBUTION = [
    {
        "name": (
            "Apur, Emprise bâtie Paris (sources: Apur, DGFiP, Ville de Paris; version as "
            "fetched, see the build log; modified: joined per footprint into year, storeys, "
            "use, fabric class, roof form, height, quartier)"
        ),
        "license": "ODbL 1.0",
        "url": "https://opendata.apur.org/datasets/Apur::emprise-batie-paris",
    },
    {
        "name": "Apur, Quartier de Paris",
        "license": "ODbL 1.0",
        "url": "https://opendata.apur.org/datasets/Apur::quartier-de-paris",
    },
    {
        "name": (
            "IGN, BD TOPO® (bâtiments; as served by the Géoplateforme on the fetch date in "
            "the build log; modified: storeys, dwellings and use joined to APUR's footprints)"
        ),
        "license": "Licence Ouverte / Open Licence 2.0 (Etalab)",
        "url": "https://cartes.gouv.fr/rechercher-une-donnee/dataset/IGNF_BD-TOPO",
    },
]

# APUR's construction periods (`c_perconst`): code → (first year, last year,
# the year a building of the period stands for when it has no year of its
# own). There is no code 4; 99 is undated.
PERIODS: dict[int, tuple[int, int, int]] = {
    1: (1000, 1800, 1750),
    2: (1801, 1850, 1830),
    3: (1851, 1914, 1880),
    5: (1915, 1939, 1930),
    6: (1940, 1967, 1958),
    7: (1968, 1975, 1971),
    8: (1976, 1981, 1978),
    9: (1982, 1989, 1985),
    10: (1990, 1999, 1995),
    11: (2000, 2007, 2003),
    12: (2008, 2100, 2012),
}

# APUR's roof forms (`c_forme_toit`) in Overture's words: flat, two slopes in
# tile, two slopes of small-scale fabric, and brisis-terrasson (a mansard)
ROOFS = {1: "flat", 2: "gabled", 3: "gabled", 4: "mansard"}

# BD TOPO's `usage_1` / `usage_2`
USES = {
    "Résidentiel": "residential",
    "Commercial et services": "commercial",
    "Industriel": "industrial",
    "Agricole": "industrial",
    "Religieux": "civic",
    "Sportif": "civic",
}


def _int(v: Any) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def _box(bounds: tuple[float, float, float, float]) -> str:
    w, s, e, n = bounds
    return f"{w:.4f}_{s:.4f}_{e:.4f}_{n:.4f}"


def _cached(name: str, fetch) -> list[dict]:
    path = cache_dir("paris") / f"{name}.json.gz"
    if path.exists():
        return json.loads(gzip.decompress(path.read_bytes()))
    rows = fetch()
    path.write_bytes(gzip.compress(json.dumps(rows).encode()))
    return rows


def _arcgis(layer: str, params: dict[str, str]) -> list[dict]:
    """Every GeoJSON feature of an ArcGIS REST query, paged by OBJECTID."""
    rows: list[dict] = []
    while True:
        q = {
            **params,
            "outSR": "4326",
            "orderByFields": "OBJECTID",
            "resultOffset": str(len(rows)),
            "resultRecordCount": str(APUR_PAGE),
            "f": "geojson",
        }
        page = json.loads(get(APUR + layer + "/query?" + urllib.parse.urlencode(q), timeout=300))
        if "error" in page:
            raise RuntimeError(f"APUR {layer}: {page['error']}")
        feats = page.get("features", [])
        rows += feats
        if len(feats) < APUR_PAGE:
            return rows


def _envelope(bounds) -> dict[str, str]:
    w, s, e, n = bounds
    return {
        "geometry": f"{w},{s},{e},{n}",
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
    }


def current_version() -> str:
    """The date APUR last updated its footprints (e.g. "2026-07-30")."""
    url = f"https://www.arcgis.com/sharing/rest/content/items/{EMPRISE_ITEM}?f=json"
    ms = json.loads(get(url))["modified"]
    return datetime.fromtimestamp(ms / 1000, UTC).strftime("%Y-%m-%d")


def footprints(bounds, version: str) -> list[dict]:
    """APUR's built footprints in the box, as GeoJSON features (lon/lat)."""
    params = {"where": "1=1", "outFields": APUR_FIELDS, **_envelope(bounds)}
    return _cached(f"emprise-{_box(bounds)}-{version}", lambda: _arcgis(EMPRISE, params))


def quartiers(version: str) -> list[dict]:
    """Paris's 80 administrative quartiers (lon/lat)."""
    params = {"where": "1=1", "outFields": "L_QU,C_AR"}
    return _cached(f"quartiers-{version}", lambda: _arcgis(QUARTIER, params))


def bdtopo(bounds, version: str) -> list[dict]:
    """IGN's BD TOPO buildings in the box, as GeoJSON features (lon/lat)."""
    w, s, e, n = bounds

    def fetch() -> list[dict]:
        rows: list[dict] = []
        while True:
            q = {
                "SERVICE": "WFS",
                "VERSION": "2.0.0",
                "REQUEST": "GetFeature",
                "TYPENAMES": BDTOPO,
                "BBOX": f"{s},{w},{n},{e},urn:ogc:def:crs:EPSG::4326",
                "SRSNAME": "EPSG:4326",
                "PROPERTYNAME": BDTOPO_FIELDS,
                "SORTBY": "cleabs",
                "COUNT": str(WFS_PAGE),
                "STARTINDEX": str(len(rows)),
                "outputFormat": "application/json",
            }
            page = json.loads(get(WFS + urllib.parse.urlencode(q), timeout=300))
            rows += page.get("features", [])
            if len(page.get("features", [])) < WFS_PAGE:
                return rows

    return _cached(f"bdtopo-{_box(bounds)}-{version}", fetch)


def year_of(props: dict) -> int | None:
    """The year built: APUR's own year where it falls in its period (they are
    often rounded to ten), else the year the period stands for."""
    period = PERIODS.get(_int(props.get("c_perconst")))
    if period is None:
        return None
    lo, hi, typical = period
    y = _int(props.get("an_const"))
    return y if lo <= y <= hi else typical


def use_of(props: dict) -> str:
    """BD TOPO's use: residential over shops or offices (either way round) is mixed."""
    uses = {USES.get(props.get("usage_1") or ""), USES.get(props.get("usage_2") or "")}
    if {"residential", "commercial"} <= uses:
        return "mixed"
    return USES.get(props.get("usage_1") or "", "")


def building_facts(apur: dict, ign: dict | None, hood: str) -> dict[str, Any]:
    """One footprint's facts from its APUR properties, its BD TOPO building and its quartier."""
    ign = ign or {}
    return {
        "year": year_of(apur),
        "stories": float(max(0, _int(ign.get("nombre_d_etages")))),
        "units": float(max(0, _int(ign.get("nombre_de_logements")))),
        "use": use_of(ign),
        "class": str(apur.get("c_tissu") or ""),
        "hood": hood,
        "roof": ROOFS.get(_int(apur.get("c_forme_toit")), ""),
        "height": max(0.0, float(apur.get("h_med") or 0.0)),
    }


def _shapes(features: list[dict]) -> np.ndarray:
    return np.array(
        [shapely.force_2d(shapely.geometry.shape(f["geometry"])) for f in features], dtype=object
    )


class FootprintFacts:
    """Facts per APUR footprint, looked up by projected point."""

    def __init__(self, crs, bounds, version: str):
        self.version = version
        fps = [f for f in footprints(bounds, version) if f.get("geometry")]
        ign = [f for f in bdtopo(bounds, version) if f.get("geometry")]
        qus = [f for f in quartiers(version) if f.get("geometry")]
        geoms = _shapes(fps)

        # each footprint's BD TOPO building (by its representative point) and quartier
        building: list[dict | None] = [None] * len(fps)
        if ign and len(geoms):
            tree = shapely.STRtree(_shapes(ign))
            pts, hits = tree.query(shapely.point_on_surface(geoms), predicate="within")
            for i, j in sorted(zip(pts.tolist(), hits.tolist(), strict=True)):
                if building[i] is None:
                    building[i] = ign[j]["properties"]
        hood = [""] * len(fps)
        if qus and len(geoms):
            tree = shapely.STRtree(_shapes(qus))
            pts, hits = tree.query(shapely.centroid(geoms), predicate="within")
            for i, j in zip(pts.tolist(), hits.tolist(), strict=True):
                hood[i] = qus[j]["properties"].get("L_QU") or ""
        self.facts = [
            building_facts(f["properties"], building[i], hood[i]) for i, f in enumerate(fps)
        ]
        self.matched = sum(b is not None for b in building)

        def project(xy: np.ndarray) -> np.ndarray:
            if not len(xy):
                return xy
            xs, ys = transform_points("EPSG:4326", crs, xy[:, 0].tolist(), xy[:, 1].tolist())
            return np.column_stack([xs, ys])

        self.geoms = shapely.transform(geoms, project)
        self.tree = shapely.STRtree(self.geoms)

    def at(self, xs: np.ndarray, ys: np.ndarray) -> list[dict | None]:
        """Facts of the footprint containing each projected point (None outside every one)."""
        out: list[dict | None] = [None] * len(xs)
        idx_pt, idx_fp = self.tree.query(shapely.points(xs, ys), predicate="within")
        for i, j in sorted(zip(idx_pt.tolist(), idx_fp.tolist(), strict=True)):
            if out[i] is None:
                out[i] = self.facts[j]
        return out


OPTIONS = ("version",)


class ApurFacts(FactsSource):
    """The `apur` facts source: APUR's footprints of Paris with IGN's BD TOPO buildings."""

    options_schema = {
        "version": Key(Str(), "The APUR download date the cache is named by (`2026-07-30`)."),
    }

    attribution = ATTRIBUTION

    def __init__(self, region, options: dict[str, Any] | None = None):
        super().__init__(region, options)
        unknown = sorted(set(self.options) - set(OPTIONS))
        if unknown:
            raise ValueError(
                f"apur facts: unknown option(s) {', '.join(unknown)} "
                f"(it takes {', '.join(OPTIONS)})"
            )
        version = str(self.options.get("version") or current_version())
        self.footprints = FootprintFacts(region.crs, region.lonlat_envelope(PAD_DEG), version)

    def at(self, xs: np.ndarray, ys: np.ndarray) -> list[dict | None]:
        return self.footprints.at(xs, ys)

    def summary(self) -> str:
        f = self.footprints
        return (
            f"APUR footprints and IGN BD TOPO, {f.version}: {len(f.facts)} footprints, "
            f"{f.matched} on a BD TOPO building"
        )
