"""NYC Open Data building facts (D-080): each building footprint of the city's
BUILDING dataset joined to its tax lot in PLUTO (class, land use, year,
floors, units) and, inside designated landmarks and historic districts, to
the Landmarks Preservation Commission's building database (date, facade
material), with its 2020 Neighborhood Tabulation Area as the neighbourhood.

The `pluto` facts source (PlutoFacts) is built in. A region selects it:

    sources:
      facts: { kind: pluto }
      # or pinned to a PLUTO release:
      facts: { kind: pluto, version: "26v2" }

Options:
- version: the PLUTO release the downloads are cached under (default: the
  current one, asked of the portal). The portal serves only the current
  release; the option keeps a build reading the cache it made before.

Facts are looked up by point in footprint. PLUTO's lot polygons aren't served
by the API (its `geom` column is empty), so lots join footprints by BBL.
Datasets are read through the Socrata API, paged, limited to the region's
box, and cached in the shared download cache under nyc/.

Licence: NYC Admin Code §23-502(d) makes the city's public data sets
available "without any registration requirement, license requirement or
restrictions on their use"; the city may ask users to name each data set's
source and version and to describe their modifications, as ATTRIBUTION does.
"""

from __future__ import annotations

import gzip
import json
import urllib.parse
from typing import Any

import numpy as np
import shapely
from rasterio.warp import transform as transform_points

from pixelworld_pipeline.facts import FactsSource
from pixelworld_pipeline.schema import Key, Str
from pixelworld_pipeline.sources.http import cache_dir, get

BASE = "https://data.cityofnewyork.us/resource/"
FOOTPRINTS = "5zhs-2jue"  # BUILDING (OTI)
PLUTO = "64uk-42ks"  # Primary Land Use Tax Lot Output (DCP)
LPC = "gpmc-yuvp"  # Individual Landmark and Historic District Building Database (LPC)
NTA = "9nt8-h7nd"  # 2020 Neighborhood Tabulation Areas (DCP)
PAGE = 50000
# the box's margin (degrees): lots whose centroid is just outside it, footprints that cross it
PAD_DEG = 0.002

_MODIFIED = (
    "joined per building footprint into year, storeys, units, use, class, material, neighbourhood"
)
_LICENCE = "NYC Open Data, no restrictions on use (NYC Admin Code §23-502(d))"
ATTRIBUTION = [
    {
        "name": (
            f"NYC Open Data: {name} ({agency}, {dataset}; version as fetched, see the build log; "
            f"modified: {_MODIFIED})"
        ),
        "license": _LICENCE,
        "url": f"https://data.cityofnewyork.us/d/{dataset}",
    }
    for name, agency, dataset in (
        ("BUILDING footprints", "OTI", FOOTPRINTS),
        ("PLUTO", "DCP", PLUTO),
        ("Individual Landmark and Historic District Building Database", "LPC", LPC),
        ("2020 Neighborhood Tabulation Areas", "DCP", NTA),
    )
]

# PLUTO land use (data dictionary): 01–03 one/two-family, walk-up and elevator
# residential; 04 mixed residential and commercial; 05 commercial and office;
# 06 industrial and manufacturing; 07 transportation and utility; 08 public
# facilities and institutions; 09 open space; 10 parking; 11 vacant
LAND_USE = {
    1: "residential",
    2: "residential",
    3: "residential",
    4: "mixed",
    5: "commercial",
    6: "industrial",
    7: "civic",
    8: "civic",
}


def _soql(dataset: str, params: dict[str, str], name: str) -> list[dict]:
    """Every row of a SoQL query, paged; cached by name."""
    path = cache_dir("nyc") / f"{name}.json.gz"
    if path.exists():
        return json.loads(gzip.decompress(path.read_bytes()))
    rows: list[dict] = []
    while True:
        q = {**params, "$limit": str(PAGE), "$offset": str(len(rows)), "$order": ":id"}
        page = json.loads(get(BASE + dataset + ".json?" + urllib.parse.urlencode(q), timeout=300))
        rows += page
        if len(page) < PAGE:
            break
    path.write_bytes(gzip.compress(json.dumps(rows).encode()))
    return rows


def current_version() -> str:
    """The PLUTO release the portal serves (e.g. "26v2")."""
    url = BASE + PLUTO + ".json?" + urllib.parse.urlencode({"$select": "version", "$limit": "1"})
    return json.loads(get(url))[0]["version"]


def _box(bounds: tuple[float, float, float, float]) -> str:
    w, s, e, n = bounds
    return f"{w:.4f}_{s:.4f}_{e:.4f}_{n:.4f}"


def _within(bounds: tuple[float, float, float, float], column: str = "the_geom") -> str:
    w, s, e, n = bounds
    return f"within_box({column}, {n}, {w}, {s}, {e})"


def footprints(bounds, version: str) -> list[dict]:
    return _soql(
        FOOTPRINTS,
        {
            "$select": "bin,base_bbl,mappluto_bbl,construction_year,the_geom",
            "$where": _within(bounds),
        },
        f"footprints-{_box(bounds)}-{version}",
    )


def lots(bounds, version: str) -> list[dict]:
    w, s, e, n = bounds
    return _soql(
        PLUTO,
        {
            "$select": "bbl,bldgclass,landuse,yearbuilt,numfloors,unitsres,version",
            "$where": f"latitude between {s} and {n} and longitude between {w} and {e}",
        },
        f"pluto-{_box(bounds)}-{version}",
    )


def landmarks(bounds, version: str) -> list[dict]:
    return _soql(
        LPC,
        {"$select": "bin,date_low,mat_prim,style_prim,hist_dist", "$where": _within(bounds)},
        f"lpc-{_box(bounds)}-{version}",
    )


def neighbourhoods(version: str) -> list[dict]:
    return _soql(NTA, {"$select": "ntaname,the_geom"}, f"nta2020-{version}")


def _int(v: Any) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def _bbl(v: Any) -> str:
    """A BBL as its ten digits (PLUTO's API gives "1020680003.00000000")."""
    return str(_int(v)) if _int(v) else ""


def building_facts(fp: dict, lot: dict | None, lpc: dict | None, hood: str) -> dict[str, Any]:
    """One footprint's facts from its lot, its LPC record and its neighbourhood.

    year: LPC's earliest date, else the footprint's construction year (1900
    is a placeholder there), else PLUTO's year built; stories, units, class
    and use from the lot; material from LPC."""
    lot = lot or {}
    lpc = lpc or {}
    year = None
    for y, placeholder in (
        (_int(lpc.get("date_low")), None),
        (_int(fp.get("construction_year")), 1900),
        (_int(lot.get("yearbuilt")), None),
    ):
        if 1600 <= y <= 2100 and y != placeholder:
            year = y
            break
    material = str(lpc.get("mat_prim") or "")
    return {
        "year": year,
        "stories": float(lot.get("numfloors") or 0.0),
        "units": float(lot.get("unitsres") or 0.0),
        "use": LAND_USE.get(_int(lot.get("landuse")), ""),
        "class": str(lot.get("bldgclass") or ""),
        "hood": hood,
        "material": "" if material.lower() in ("", "not determined") else material,
    }


class FootprintFacts:
    """Facts per building footprint, looked up by projected point."""

    def __init__(self, crs, bounds, version: str):
        self.version = version
        self.bounds = bounds
        by_bbl = {_bbl(r.get("bbl")): r for r in lots(bounds, version)}
        by_bin = {str(_int(r.get("bin"))): r for r in landmarks(bounds, version)}
        fps = [r for r in footprints(bounds, version) if r.get("the_geom")]

        def project(xy: np.ndarray) -> np.ndarray:
            if not len(xy):
                return xy
            xs, ys = transform_points("EPSG:4326", crs, xy[:, 0].tolist(), xy[:, 1].tolist())
            return np.column_stack([xs, ys])

        geoms = np.array([shapely.geometry.shape(r["the_geom"]) for r in fps], dtype=object)
        # the neighbourhood of each footprint's centre (in lon/lat, as the NTAs are)
        ntas = [r for r in neighbourhoods(version) if r.get("the_geom")]
        hood = [""] * len(fps)
        if ntas and len(geoms):
            nta_tree = shapely.STRtree([shapely.geometry.shape(r["the_geom"]) for r in ntas])
            idx_pt, idx_nta = nta_tree.query(shapely.centroid(geoms), predicate="within")
            for i, j in zip(idx_pt.tolist(), idx_nta.tolist(), strict=True):
                hood[i] = ntas[j].get("ntaname") or ""
        self.facts = []
        self.matched = {"lot": 0, "lpc": 0}
        for i, r in enumerate(fps):
            lot = by_bbl.get(_bbl(r.get("base_bbl"))) or by_bbl.get(_bbl(r.get("mappluto_bbl")))
            lpc = by_bin.get(str(_int(r.get("bin"))))
            self.matched["lot"] += lot is not None
            self.matched["lpc"] += lpc is not None
            self.facts.append(building_facts(r, lot, lpc, hood[i]))
        self.geoms = shapely.transform(geoms, project)
        self.tree = shapely.STRtree(self.geoms)

    def at(self, xs: np.ndarray, ys: np.ndarray) -> list[dict | None]:
        """Facts of the footprint containing each projected point (None outside every one)."""
        pts = shapely.points(xs, ys)
        out: list[dict | None] = [None] * len(pts)
        idx_pt, idx_fp = self.tree.query(pts, predicate="within")
        for i, j in zip(idx_pt.tolist(), idx_fp.tolist(), strict=True):
            if out[i] is None or (self.facts[j]["year"] and not out[i].get("year")):
                out[i] = self.facts[j]
        return out


OPTIONS = ("version",)


class PlutoFacts(FactsSource):
    """The `pluto` facts source: New York's footprints, tax lots and landmark records."""

    options_schema = {
        "version": Key(Str(), "The PLUTO release the downloads are cached under (e.g. `26v2`)."),
    }

    attribution = ATTRIBUTION

    def __init__(self, region, options: dict[str, Any] | None = None):
        super().__init__(region, options)
        unknown = sorted(set(self.options) - set(OPTIONS))
        if unknown:
            raise ValueError(
                f"pluto facts: unknown option(s) {', '.join(unknown)} "
                f"(it takes {', '.join(OPTIONS)})"
            )
        version = str(self.options.get("version") or current_version())
        self.footprints = FootprintFacts(region.crs, region.lonlat_envelope(PAD_DEG), version)

    def at(self, xs: np.ndarray, ys: np.ndarray) -> list[dict | None]:
        return self.footprints.at(xs, ys)

    def summary(self) -> str:
        f = self.footprints
        return (
            f"NYC Open Data, PLUTO {f.version}: {len(f.facts)} footprints, "
            f"{f.matched['lot']} on a PLUTO lot, {f.matched['lpc']} with an LPC record"
        )
