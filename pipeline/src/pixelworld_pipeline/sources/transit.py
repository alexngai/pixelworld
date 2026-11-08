"""Rail and ferry lines from Overture transportation segments, for ambient
traffic routes (routes.py). Roads come from the built package itself, so only
the lines a package doesn't draw are read here.

Overture segments carry `subtype` rail (class standard_gauge, light_rail,
tram, subway, funicular, monorail, narrow_gauge, unknown) and water (ferry
routes), and `routes`: the transit routes a segment belongs to, by name and
ref (an F line streetcar, a cable car line).
"""

from __future__ import annotations

from .overture import query

TRANSIT_COLUMNS = ["id", "subtype", "class", "subclass", "rail_flags", "routes", "names"]


def _clean(row: dict) -> dict:
    """Keep what routes.py reads: plain names, route names and refs, flags."""
    names = row.get("names") or {}
    routes = [
        {k: r.get(k) for k in ("name", "ref", "network") if r.get(k)}
        for r in (row.get("routes") or [])
    ]
    flags = sorted({v for f in (row.get("rail_flags") or []) for v in (f.get("values") or [])})
    return {
        "id": row["id"],
        "subtype": row["subtype"],
        "class": row.get("class"),
        "subclass": row.get("subclass"),
        "name": names.get("primary"),
        "routes": routes,
        "flags": flags,
        "geometry": row["geometry"],
    }


def segments(release: str, bbox: tuple[float, float, float, float]) -> list[dict]:
    """Rail and water (ferry) segments in bbox, sorted by id (cached)."""
    rows = query(
        release,
        "transportation",
        "segment",
        bbox,
        TRANSIT_COLUMNS,
        lambda r: r["subtype"] in ("rail", "water"),
        filter_tag="transit:rail,water",
    )
    return [_clean(r) for r in rows]
