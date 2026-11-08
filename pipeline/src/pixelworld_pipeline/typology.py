"""Building typologies (D-055): what kind of building each footprint is, so a
city reads by its ordinary fabric (Victorian rows, stucco rows, apartment
blocks, warehouses) and not only by its landmarks.

Each building gets features from its geometry and the street network (width
and depth, the share of its outline it shares with neighbours, the side that
faces the street, corner lots, whether it stands over water) and, where a
facts source covers it, from public records (year built, storeys, use,
neighbourhood). Rules in the region spec, matched in order, pick its group;
the first match wins and unmatched buildings keep their group:

    objects:
      typology:
        facts: datasf                 # optional; San Francisco's assessor roll
        rules:
          - { group: building.pier, onWater: true }
          - { group: building.rowhouse.victorian, year: [1840, 1906], uses: [residential],
              maxWidth: 11, minParty: 0.15, floors: [2, 4] }

Rule fields (all optional): year [from, to) · uses (residential, mixed,
commercial, industrial, civic) · hoods (neighbourhood names) · minWidth /
maxWidth / minDepth (metres) · minParty / maxParty (share of the outline) ·
floors [min, max] · minHeight / maxHeight (metres) · onWater · corner · from
(groups the rule may replace; default: the generic building groups).

Typed buildings carry hints for their generator: `fr`, the direction their
front faces (0-7, in 45° steps from +x, clockwise on screen as y grows),
`cn` (1 on corner lots), `yr` (year built) and `fl` (storeys).
"""

from __future__ import annotations

import math
from collections import Counter
from typing import Any

import numpy as np
import shapely

GENERIC = ("building.residential", "building.commercial", "building.parking")
FLOOR_METERS = 3.2


def use_group(use: str) -> str:
    """The assessor's use definition as one of a few words rules can name."""
    u = (use or "").lower()
    if "residential" in u:
        return "residential"
    if "mixed" in u:
        return "mixed"
    if u.startswith("commercial"):
        return "commercial"
    if "industrial" in u:
        return "industrial"
    if "government" in u:
        return "civic"
    return ""


def _octant(nx: float, ny: float) -> int:
    return int(round(math.atan2(ny, nx) / (math.pi / 4))) % 8


def features(
    instances: list[dict],
    streets: list | None,
    water: np.ndarray | None,
    m_per_cell: float,
    facts: list[dict | None] | None = None,
) -> list[dict]:
    """Features of each building root (`_grp` groups of one instance; others get {})."""
    groups = Counter(inst.get("_grp") for inst in instances)
    roots = [
        i for i, inst in enumerate(instances) if inst.get("fp") and groups[inst.get("_grp")] == 1
    ]
    polys = {i: shapely.Polygon(instances[i]["fp"]) for i in roots}
    tree = shapely.STRtree([polys[i] for i in roots]) if roots else None
    street_tree = None
    street_geoms: list = []
    if streets:
        for _, _, parts in streets:
            for xs, ys in parts:
                if len(xs) >= 2:
                    street_geoms.append(shapely.LineString(np.column_stack([xs, ys])))
        street_tree = shapely.STRtree(street_geoms) if street_geoms else None
    tol = 0.6 / m_per_cell  # walls within 0.6 m count as shared
    out: list[dict] = [{} for _ in instances]
    for i in roots:
        inst = instances[i]
        poly = polys[i]
        m = float(inst.get("m") or m_per_cell)
        rect = poly.minimum_rotated_rectangle
        rc = np.asarray(rect.exterior.coords)[:4] if rect.geom_type == "Polygon" else None
        f: dict[str, Any] = {"height": float(inst.get("hm") or 0.0)}
        if rc is None:
            out[i] = f
            continue
        sides = [(rc[j], rc[(j + 1) % 4]) for j in range(4)]
        lengths = [float(np.hypot(*(b - a))) * m for a, b in sides]
        f["width"] = min(lengths)
        f["depth"] = max(lengths)
        # shared walls
        shared = 0.0
        near = tree.query(poly.buffer(tol)) if tree is not None else []
        for j in near:
            if roots[j] == i:
                continue
            shared += poly.boundary.intersection(polys[roots[j]].buffer(tol)).length
        f["party"] = min(1.0, shared / max(poly.length, 1e-9))
        # the side facing the nearest street, and corner lots
        centre = rc.mean(axis=0)
        mids = [0.5 * (a + b) for a, b in sides]
        side_shared = []
        for a, b in sides:
            seg = shapely.LineString([a, b])
            s = 0.0
            for j in near:
                if roots[j] != i:
                    s += seg.intersection(polys[roots[j]].buffer(tol)).length
            side_shared.append(s / max(seg.length, 1e-9))
        if street_tree is not None:
            pts = shapely.points(np.asarray(mids))
            _, dist = street_tree.query_nearest(pts, return_distance=True, all_matches=False)
            d = np.asarray(dist, dtype=np.float64) * m
            # a side mostly against a neighbour is not a front
            d = np.where(np.asarray(side_shared) > 0.5, np.inf, d)
            order = np.argsort(d)
            front = int(order[0])
            if np.isfinite(d[front]):
                nvec = mids[front] - centre
                f["front"] = _octant(float(nvec[0]), float(nvec[1]))
                f["frontDist"] = float(d[front])
                second = int(order[1])
                adjacent = (second - front) % 4 in (1, 3)
                f["corner"] = bool(
                    adjacent and np.isfinite(d[second]) and d[second] <= d[front] + 6.0
                )
        if water is not None:
            c = poly.representative_point()
            y, x = int(c.y), int(c.x)
            f["onWater"] = bool(0 <= y < water.shape[0] and 0 <= x < water.shape[1] and water[y, x])
        fact = facts[i] if facts is not None else None
        if fact:
            f["year"] = fact.get("year")
            f["stories"] = float(fact.get("stories") or 0.0)
            f["use"] = use_group(fact.get("use", ""))
            f["hood"] = fact.get("hood") or ""
        f["floors"] = (
            int(round(f["stories"]))
            if f.get("stories")
            else max(1, int(round(f["height"] / FLOOR_METERS)))
        )
        out[i] = f
    return out


def matches(rule: dict, group: str, f: dict) -> bool:
    if not f:
        return False
    if group not in rule.get("from", GENERIC):
        return False
    if "year" in rule:
        y = f.get("year")
        lo, hi = rule["year"]
        if y is None or not (lo <= y < hi):
            return False
    if "uses" in rule and f.get("use", "") not in rule["uses"]:
        return False
    if "hoods" in rule and f.get("hood", "") not in rule["hoods"]:
        return False
    for key, feat, cmp in (
        ("minWidth", "width", 1),
        ("maxWidth", "width", -1),
        ("minDepth", "depth", 1),
        ("minParty", "party", 1),
        ("maxParty", "party", -1),
        ("minHeight", "height", 1),
        ("maxHeight", "height", -1),
    ):
        if key in rule:
            v = f.get(feat)
            if v is None or (v < rule[key] if cmp > 0 else v > rule[key]):
                return False
    if "floors" in rule:
        lo, hi = rule["floors"]
        if not (lo <= f.get("floors", 0) <= hi):
            return False
    if "onWater" in rule and bool(f.get("onWater")) != bool(rule["onWater"]):
        return False
    if "corner" in rule and bool(f.get("corner")) != bool(rule["corner"]):
        return False
    return True


def classify(instances: list[dict], spec: dict, feats: list[dict]) -> dict[str, int]:
    """Retype buildings by the first matching rule, in place; counts per new group."""
    counts: Counter = Counter()
    rules = spec.get("rules", [])
    for inst, f in zip(instances, feats, strict=True):
        if not f:
            continue
        for rule in rules:
            if matches(rule, inst["g"], f):
                inst["g"] = rule["group"]
                counts[rule["group"]] += 1
                if "front" in f:
                    inst["fr"] = f["front"]
                if f.get("corner"):
                    inst["cn"] = 1
                if f.get("year"):
                    inst["yr"] = int(f["year"])
                inst["fl"] = int(f["floors"])
                break
    return dict(counts)
