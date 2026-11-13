"""The contract of role `features`: the vector map a world is built from (D-110).

A features source answers each method with rows for a lon/lat box (west,
south, east, north): dicts with an `id` (stable, unique within the source),
a `geometry` as WKT in lon/lat (EPSG:4326), and the fields listed per method.
Rows are sorted by id. The fields and their vocabularies are Overture Maps'
schema (https://docs.overturemaps.org/schema/): road and path classes, water
subtypes, land-use classes and the rest. The built-in `overture` source reads
them from Overture's releases; a source for other data (OpenStreetMap, a
city's own) maps its classes to Overture's words. A field it can't fill is
left out or None.

The row helpers below (path_class, rail_open_parts, without_tunnels, rail_matches) read rows
of this shape, whatever their source.
"""

from __future__ import annotations

import math
from typing import Any

import shapely
from shapely.ops import substring

from ..plugins import Source

Box = tuple[float, float, float, float]
Rows = list[dict[str, Any]]


class FeatureSource(Source):
    """Roads, paths, rails, water, land, barriers, buildings and transit lines.

    Fields beyond `id` and `geometry`:
    - roads, road_subclasses, paths: subtype ("road"), class, subclass,
      connectors ([{connector_id, at}], where segments join), road_flags
      ([{values, between}]: `is_tunnel` ranges along the segment); with
      `lanes`, also names ({primary}), access_restrictions and width_rules.
    - rails: subtype ("rail"), class, names, rail_flags ([{values, between}]:
      `is_tunnel`, `is_bridge` ranges along the segment), connectors.
    - rivers, water_areas, land_use, land, barriers: subtype, class.
    - buildings: class, subtype, height, num_floors, is_underground, has_parts,
      names, roof_shape, roof_color, facade_color, facade_material.
    - building_parts: building_id, height, min_height, num_floors, is_underground.
    - streets: class, names: segments of the given classes with their names.
    - transit: subtype ("rail" or "water", a ferry), class, subclass, name,
      routes ([{name, ref, network}]), flags (rail flag values).
    """

    role = "features"
    # the manifest's entry for the buildings it gives, beside `attribution`
    buildings_attribution: dict | list[dict] | None = None

    def _todo(self, what: str):
        raise NotImplementedError(f"{type(self).__name__} gives no {what}")

    def roads(
        self,
        bbox: Box,
        classes: list[str],
        exclude_subclasses: list[str] | None = None,
        lanes: bool = False,
    ) -> Rows:
        """Road segments of the given classes, without ramps (subclass `link`)
        and `exclude_subclasses`."""
        return self._todo("roads")

    def road_subclasses(self, bbox: Box, subclasses: list[str], lanes: bool = False) -> Rows:
        """Road segments of the given subclasses only (parking aisles, driveways)."""
        return self._todo("road subclasses")

    def paths(self, bbox: Box, classes: list[str]) -> Rows:
        """Footways and cycleways whose path_class is in `classes`."""
        return self._todo("paths")

    def streets(self, bbox: Box, classes: list[str]) -> Rows:
        """Segments of the given classes with their names (rules that pick streets by name)."""
        return self._todo("street names")

    def rails(self, bbox: Box, classes: list[str]) -> Rows:
        """Rail segments of the given classes (tram, light_rail, funicular, …)."""
        return self._todo("rails")

    def rivers(self, bbox: Box, subtypes: list[str]) -> Rows:
        """Water lines (LineString or MultiLineString) of the given subtypes."""
        return self._todo("rivers")

    def water_areas(self, bbox: Box, classes: list[str]) -> Rows:
        """Water polygons of the given classes (pond, moat, lake, ocean, …)."""
        return self._todo("water areas")

    def land_use(self, bbox: Box, classes: list[str]) -> Rows:
        """Land-use polygons of the given classes (park, cemetery, …)."""
        return self._todo("land use")

    def land(self, bbox: Box, classes: list[str]) -> Rows:
        """Natural land polygons of the given classes (forest, sand, …)."""
        return self._todo("land")

    def barriers(self, bbox: Box, classes: list[str]) -> Rows:
        """Barrier lines of the given classes (retaining_wall, wall, …)."""
        return self._todo("barriers")

    def buildings(self, bbox: Box) -> Rows:
        """Building footprints above ground, with height and floors where known."""
        return self._todo("buildings")

    def building_parts(self, bbox: Box) -> Rows:
        """Parts (towers, wings) of buildings that have them."""
        return self._todo("building parts")

    def transit(self, bbox: Box) -> Rows:
        """Rail and ferry lines, with the routes they carry (ambient traffic)."""
        return self._todo("transit lines")


# ---- helpers over rows of this shape ----------------------------------------------------

# Footways split by their subclass: sidewalks and crosswalks look different.
FOOTWAY_SUBCLASSES = {"sidewalk", "crosswalk"}
PATH_SOURCE_CLASSES = {"footway", "pedestrian", "path", "steps", "cycleway"}


def path_class(row: dict) -> str:
    """The path class a segment is drawn as: footway subclasses count as their own."""
    if row["class"] == "footway" and row.get("subclass") in FOOTWAY_SUBCLASSES:
        return row["subclass"]
    return row["class"]


def _tunnel_cuts(row: dict) -> list[tuple[float, float]]:
    """A segment's `is_tunnel` ranges (0..1 along it) from its road or rail
    flags; a flag without a range covers the whole segment."""
    cuts = []
    for flag in (row.get("rail_flags") or []) + (row.get("road_flags") or []):
        if "is_tunnel" in (flag.get("values") or []):
            a, b = flag.get("between") or (0.0, 1.0)
            cuts.append((float(a), float(b)))
    return sorted(cuts)


def _runs(cuts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Sorted cuts with overlapping or touching ones merged."""
    out: list[tuple[float, float]] = []
    for a, b in cuts:
        if out and a <= out[-1][1] + 1e-9:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def _open_spans(cuts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """The ranges (0..1) between sorted cuts."""
    out, at = [], 0.0
    for a, b in cuts:
        if a > at:
            out.append((at, a))
        at = max(at, b)
    if at < 1.0:
        out.append((at, 1.0))
    return out


def rail_open_parts(row: dict) -> list:
    """A rail segment's lon/lat line without its tunnels (`is_tunnel` ranges
    in its rail flags; a flag without a range covers the whole segment)."""
    line = shapely.from_wkt(row["geometry"])
    parts = list(line.geoms) if hasattr(line, "geoms") else [line]
    if line.geom_type != "LineString":
        return parts  # ranges are along a single line; multi-lines are kept whole
    cuts = _tunnel_cuts(row)
    if not cuts:
        return [line]
    out = [substring(line, a, b, normalized=True) for a, b in _open_spans(cuts)]
    return [g for g in out if g.geom_type == "LineString" and g.length > 0]


def _metres(line) -> float:
    """A lon/lat line's length in metres (equirectangular: fine at a segment's size)."""
    c = shapely.get_coordinates(line)
    kx = 111_320.0 * math.cos(math.radians(float(c[:, 1].mean())))
    return float(math.fsum(math.hypot(dx * kx, dy * 110_540.0) for dx, dy in c[1:] - c[:-1]))


TUNNEL_MIN_M = 150.0


def without_tunnels(rows: Rows, min_m: float = TUNNEL_MIN_M) -> Rows:
    """Road or path rows with their tunnels cut out: harbour crossings and
    tunnels through hills aren't drawn over the water or the hill. A row wholly
    in a tunnel is dropped; one open on both sides becomes a row per stretch
    (ids `<id>~1`, `<id>~2`), each keeping the connectors on it with `at`
    rescaled to the stretch. Tunnels shorter than `min_m` stay drawn: Overture
    doesn't tell an underpass or a building passage from a bored tunnel, and
    those carry the street across at grade."""
    # ponytail: a length threshold stands in for the tunnel's kind, judged per
    # segment: a tunnel cut into segments under min_m each stays drawn. Join
    # tunnel runs across shared connectors, or read OSM's `tunnel=` and `layer`
    # if Overture ever carries them.
    out = []
    for row in rows:
        cuts = _tunnel_cuts(row)
        line = shapely.from_wkt(row["geometry"]) if cuts else None
        if line is None or line.geom_type != "LineString":
            out.append(row)
            continue
        total = _metres(line)
        # adjacent ranges (flags that differ only in another value) are one tunnel
        tunnels = [(a, b) for a, b in _runs(cuts) if (b - a) * total >= min_m]
        if not tunnels:
            out.append(row)
            continue
        spans = _open_spans(tunnels)
        for k, (a, b) in enumerate(spans):
            part = substring(line, a, b, normalized=True)
            if part.geom_type != "LineString" or part.length == 0:
                continue
            conns = [
                {**c, "at": min(1.0, max(0.0, (float(c.get("at") or 0.0) - a) / (b - a)))}
                for c in row.get("connectors") or []
                if a - 1e-9 <= float(c.get("at") or 0.0) <= b + 1e-9
            ]
            sid = row["id"] if len(spans) == 1 else f"{row['id']}~{k + 1}"
            # its flags' ranges were the whole segment's: the stretch has no tunnel left
            out.append(
                {**row, "id": sid, "geometry": part.wkt, "connectors": conns, "road_flags": None}
            )
    return out


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
