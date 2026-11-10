"""Importance (architecture §5 stage 4): fame of places → extra magnification.

Places come from Wikidata (CC0): items with coordinates inside the region,
scored by their number of sitelinks (Wikipedia articles in any language), a
robust proxy for fame. Classes whose single coordinate doesn't mark a place
worth magnifying (counties, deserts, mountain ranges, rivers, events) are
left out. The query result is a committed snapshot next to the region spec
(`importance.json`), so builds don't depend on the live service; refresh it
with `pixelworld importance <region.yaml>`.

The field: every place adds a Gaussian (σ = sigmaKm) weighted by
log2(sitelinks / minSitelinks) + 1. Magnification rises with the summed
weight up to maxMagnification, reached at the weight of one place with
`reference` sitelinks; it enters the warp as an extra scale term (the finest
of focus areas, importance and background wins).
"""

from __future__ import annotations

import json
import math
import re
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np

from .region import Region
from .sources.http import USER_AGENT

SPARQL = "https://query.wikidata.org/sparql"
# instance-of classes that don't mark a magnifiable place
EXCLUDED = {
    "Q47168",  # county of the United States
    "Q8514",  # desert
    "Q46831",  # mountain range
    "Q4022",  # river
    "Q3624078",  # sovereign state
    "Q35657",  # U.S. state
}

# labels of administrative areas whose class isn't in EXCLUDED (state-specific county classes)
_EXCLUDED_LABEL = re.compile(r" (County|Parish|Borough)$")


def keep(place: dict[str, Any]) -> bool:
    return not _EXCLUDED_LABEL.search(place.get("label", ""))


QUERY = """SELECT ?item ?itemLabel ?coord ?links (GROUP_CONCAT(DISTINCT ?cls) AS ?classes)
       (SAMPLE(?when) AS ?event) WHERE {{
  SERVICE wikibase:box {{
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point({w} {s})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point({e} {n})"^^geo:wktLiteral .
  }}
  ?item wikibase:sitelinks ?links .
  FILTER(?links >= {min_links})
  OPTIONAL {{ ?item wdt:P31 ?cls }}
  OPTIONAL {{ ?item wdt:P585|wdt:P580 ?when }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}} GROUP BY ?item ?itemLabel ?coord ?links ORDER BY DESC(?links)"""


def snapshot_path(region_path: Path) -> Path:
    return Path(region_path).parent / "importance.json"


def fetch(region: Region, min_links: int = 20) -> list[dict[str, Any]]:
    w, s, e, n = region.bounds
    q = QUERY.format(w=w, s=s, e=e, n=n, min_links=min_links)
    req = urllib.request.Request(
        SPARQL + "?format=json&query=" + urllib.parse.quote(q),
        headers={"User-Agent": USER_AGENT, "Accept": "application/sparql-results+json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        rows = json.load(resp)["results"]["bindings"]
    places = []
    for r in rows:
        classes = {c.rsplit("/", 1)[-1] for c in r.get("classes", {}).get("value", "").split()}
        if classes & EXCLUDED or "event" in r:
            continue
        lon, lat = (float(v) for v in r["coord"]["value"][6:-1].split())
        places.append(
            {
                "id": r["item"]["value"].rsplit("/", 1)[-1],
                "label": r["itemLabel"]["value"],
                "lon": round(lon, 5),
                "lat": round(lat, 5),
                "sitelinks": int(r["links"]["value"]),
            }
        )
    places = [p for p in places if keep(p)]
    places.sort(key=lambda p: (-p["sitelinks"], p["id"]))
    return places


def write_snapshot(region_path: Path, min_links: int = 20) -> dict[str, Any]:
    region = Region.load(region_path)
    snap = {
        "source": "Wikidata (CC0), items with coordinates and sitelinks",
        "queried": date.today().isoformat(),
        "minSitelinks": min_links,
        "places": fetch(region, min_links),
    }
    snapshot_path(region_path).write_text(json.dumps(snap, indent=1) + "\n")
    return snap


def load_snapshot(region_path: Path) -> dict[str, Any] | None:
    p = snapshot_path(region_path)
    return json.loads(p.read_text()) if p.exists() else None


def scale_grid(
    places: list[dict[str, Any]],
    to_source,
    width_m: float,
    height_m: float,
    background: float,
    spec: dict[str, Any],
    cell_m: float = 2000.0,
):
    """(metres-per-cell grid, (0, 0) origin, cell size) over the source frame.

    to_source(lons, lats) → source-frame metres.
    """
    min_links = float(spec.get("minSitelinks", 20))
    sigma = float(spec.get("sigmaKm", 4.0)) * 1000
    max_mag = float(spec.get("maxMagnification", 2.0))
    ref = float(spec.get("reference", 100))
    nx = max(1, math.ceil(width_m / cell_m))
    ny = max(1, math.ceil(height_m / cell_m))
    gx, gy = np.meshgrid((np.arange(nx) + 0.5) * cell_m, (np.arange(ny) + 0.5) * cell_m)
    weight = np.zeros((ny, nx))
    kept = [p for p in places if p["sitelinks"] >= min_links and keep(p)]
    if kept:
        sx, sy = to_source([p["lon"] for p in kept], [p["lat"] for p in kept])
        for x, y, p in zip(sx, sy, kept, strict=True):
            w = math.log2(p["sitelinks"] / min_links) + 1.0
            weight += w * np.exp(-((gx - x) ** 2 + (gy - y) ** 2) / (2 * sigma * sigma))
    full = math.log2(ref / min_links) + 1.0
    mag = 1.0 + (max_mag - 1.0) * np.clip(weight / full, 0.0, 1.0)
    return background / mag, (0.0, 0.0), cell_m
