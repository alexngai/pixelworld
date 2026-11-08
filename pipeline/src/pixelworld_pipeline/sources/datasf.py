"""DataSF, the City and County of San Francisco's open data (ODC PDDL 1.0): the
assessor's secured property tax roll (year built, storeys, units, use) joined
to parcel polygons, so every building in the city can be typed by its age and
use (building typologies, D-055).

Datasets are read through the Socrata API, paged, and cached under
.cache/datasf as gzipped JSON.
"""

from __future__ import annotations

import gzip
import json
import urllib.parse
from collections import Counter
from typing import Any

import numpy as np
import shapely
from rasterio.warp import transform as transform_points

from .http import CACHE_ROOT, get

BASE = "https://data.sf.gov/resource/"
ASSESSOR = "wv5m-vpq2"  # Assessor Historical Secured Property Tax Rolls
PARCELS = "acdm-wktn"  # Parcels – Active and Retired
PAGE = 50000
ATTRIBUTION = {
    "name": "DataSF: Assessor Historical Secured Property Tax Rolls, Parcels",
    "license": "ODC PDDL 1.0",
    "url": "https://data.sf.gov/",
}

ASSESSOR_COLUMNS = [
    "block",
    "lot",
    "year_property_built",
    "number_of_stories",
    "number_of_units",
    "use_definition",
    "property_class_code_definition",
    "construction_type",
    "lot_frontage",
    "analysis_neighborhood",
]


def _soql(dataset: str, params: dict[str, str], name: str) -> list[dict]:
    """Every row of a SoQL query, paged; cached by name."""
    path = CACHE_ROOT / "datasf" / f"{name}.json.gz"
    if path.exists():
        return json.loads(gzip.decompress(path.read_bytes()))
    rows: list[dict] = []
    while True:
        q = {**params, "$limit": str(PAGE), "$offset": str(len(rows)), "$order": ":id"}
        url = BASE + dataset + ".json?" + urllib.parse.urlencode(q)
        page = json.loads(get(url, timeout=300))
        rows += page
        if len(page) < PAGE:
            break
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(json.dumps(rows).encode()))
    return rows


def latest_roll_year() -> str:
    url = (
        BASE
        + ASSESSOR
        + ".json?"
        + urllib.parse.urlencode({"$select": "max(closed_roll_year) as y"})
    )
    return json.loads(get(url))[0]["y"]


def assessor_roll(year: str) -> list[dict]:
    return _soql(
        ASSESSOR,
        {"$select": ",".join(ASSESSOR_COLUMNS), "$where": f"closed_roll_year='{year}'"},
        f"assessor-{year}-v2",
    )


def parcels() -> list[dict]:
    return _soql(
        PARCELS,
        {"$select": "blklot,mapblklot,shape", "$where": "active=true"},
        "parcels-active",
    )


def _num(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def aggregate(records: list[dict]) -> dict[str, Any]:
    """One map lot's facts from its assessor records (condominium units share a lot).

    year: the earliest plausible year built; stories: the most; units: the sum;
    use: the most common use (by records)."""
    if not records:
        return {
            "year": None,
            "stories": 0.0,
            "units": 0.0,
            "use": "",
            "class": "",
            "construction": "",
            "hood": "",
        }
    years = [int(_num(r.get("year_property_built"))) for r in records]
    years = [y for y in years if 1840 <= y <= 2100]
    uses = Counter(r.get("use_definition") or "" for r in records)
    classes = Counter(r.get("property_class_code_definition") or "" for r in records)
    return {
        "year": min(years) if years else None,
        "stories": max((_num(r.get("number_of_stories")) for r in records), default=0.0),
        "units": sum(_num(r.get("number_of_units")) for r in records),
        "use": uses.most_common(1)[0][0] if uses else "",
        "class": classes.most_common(1)[0][0] if classes else "",
        "construction": Counter(r.get("construction_type") or "" for r in records).most_common(1)[
            0
        ][0],
        "hood": Counter(r.get("analysis_neighborhood") or "" for r in records).most_common(1)[0][0],
    }


class ParcelFacts:
    """Assessor facts per map lot, looked up by projected point."""

    def __init__(self, crs, year: str | None = None):
        year = year or latest_roll_year()
        self.year = year
        by_lot: dict[str, list[dict]] = {}
        for r in assessor_roll(year):
            by_lot.setdefault(f"{r.get('block', '')}{r.get('lot', '')}", []).append(r)
        lots: dict[str, dict] = {}  # mapblklot → geometry
        members: dict[str, list[str]] = {}
        for p in parcels():
            m = p.get("mapblklot") or p.get("blklot")
            if not m or not p.get("shape"):
                continue
            lots.setdefault(m, p["shape"])
            members.setdefault(m, []).append(p.get("blklot") or m)
        keys = sorted(lots)
        geoms = np.array([shapely.geometry.shape(lots[k]) for k in keys], dtype=object)

        def project(xy: np.ndarray) -> np.ndarray:
            if not len(xy):
                return xy
            xs, ys = transform_points("EPSG:4326", crs, xy[:, 0].tolist(), xy[:, 1].tolist())
            return np.column_stack([xs, ys])

        self.geoms = shapely.transform(geoms, project)
        self.facts = [aggregate([r for b in members[k] for r in by_lot.get(b, [])]) for k in keys]
        self.keys = keys
        self.tree = shapely.STRtree(self.geoms)

    def at(self, xs: np.ndarray, ys: np.ndarray) -> list[dict | None]:
        """Facts of the lot containing each projected point (None outside every lot)."""
        pts = shapely.points(xs, ys)
        out: list[dict | None] = [None] * len(pts)
        idx_pt, idx_lot = self.tree.query(pts, predicate="within")
        for i, j in zip(idx_pt.tolist(), idx_lot.tolist(), strict=True):
            if out[i] is None or (self.facts[j]["year"] and not out[i].get("year")):
                out[i] = self.facts[j]
        return out
