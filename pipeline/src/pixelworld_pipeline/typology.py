"""Building typologies (D-055): what kind of building each footprint is, so a
city reads by its ordinary fabric (Victorian rows, stucco rows, apartment
blocks, warehouses) and not only by its landmarks.

Each building gets features from its geometry and the street network (width
and depth, the share of its outline it shares with neighbours, the side that
faces the street, corner lots, whether it stands over water), its roof shape
(Overture's), and, where a facts source covers it, from public records (year
built, storeys, use, class code, neighbourhood, roof shape). Facts sources are
plugins (facts.py, docs/plugins.md). Rules in the region spec, matched in
order, pick its group; the first match wins and unmatched buildings keep their
group:

    objects:
      typology:
        facts: datasf                 # optional; a facts source plugin (San Francisco's
                                      # assessor roll), or { plugin: datasf, ...options }
        rules:
          - { group: building.pier, onWater: true }
          - { group: building.rowhouse.victorian, year: [1840, 1906], uses: [residential],
              maxWidth: 11, minParty: 0.15, floors: [2, 4] }
          - { group: building.rowhouse.brownstone, classes: [A4, "B*"], roofs: [flat] }

Rule fields (all optional): year [from, to) · uses (residential, mixed,
commercial, industrial, civic) · hoods (neighbourhood names) · classes (the
facts' class codes: exact, or a prefix ending in `*`) · names (Overture's
primary name of the building, exactly; its parts share it) · roofs (roof shapes:
the facts' where they have one, else Overture's) · minWidth / maxWidth /
minDepth / maxDepth (metres) · minParty / maxParty (share of the outline) ·
floors [min, max] · minHeight / maxHeight (metres) · onWater · corner · bounds
(a lon/lat box or a list of them, holding the building's centroid: a
neighbourhood where the facts have none) · from (groups the rule may replace;
default: the generic building groups).

Buildings drawn in parts (Overture's parts, lidar's tower parts) share their
building's facts, and each part has its own height and storeys but no
geometry features. They match only rules with an explicit `from`, such as
towers by year: generic rules would draw a podium or a roof part as a whole
building of its own.

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
USE_GROUPS = ("residential", "mixed", "commercial", "industrial", "civic")


def use_group(use: str) -> str:
    """A facts source's use (one of USE_GROUPS, or an assessor's use
    definition) as one of the few words rules can name."""
    u = (use or "").lower()
    if u in USE_GROUPS:
        return u
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
    """Features of each building: whole buildings (`_grp` groups of one
    instance) get geometry, street and facts features; parts of a building get
    its facts and their own height (`parts`); instances without a footprint get {}."""
    groups = Counter(inst.get("_grp") for inst in instances)
    roots = [
        i for i, inst in enumerate(instances) if inst.get("fp") and groups[inst.get("_grp")] == 1
    ]
    in_parts = [
        i for i, inst in enumerate(instances) if inst.get("fp") and groups[inst.get("_grp")] > 1
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
        f: dict[str, Any] = {
            "height": float(inst.get("hm") or 0.0),
            "name": inst.get("_name") or "",
        }
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
            f["class"] = str(fact.get("class") or "")
            f["material"] = str(fact.get("material") or "")
        roof = _roof(inst, fact)
        if roof:
            f["roof"] = roof
        f["floors"] = (
            int(round(f["stories"]))
            if f.get("stories")
            else max(1, int(round(f["height"] / FLOOR_METERS)))
        )
        out[i] = f
    # parts share the facts of whichever part stands on a lot (one with a year first)
    shared: dict[Any, dict] = {}
    for i in in_parts if facts is not None else []:
        fact, g = facts[i], instances[i].get("_grp")
        if fact and (g not in shared or (fact.get("year") and not shared[g].get("year"))):
            shared[g] = fact
    for i in in_parts:
        f = {
            "height": float(instances[i].get("hm") or 0.0),
            "parts": True,
            "name": instances[i].get("_name") or "",
        }
        fact = shared.get(instances[i].get("_grp"))
        if fact:
            f["year"] = fact.get("year")
            f["use"] = use_group(fact.get("use", ""))
            f["hood"] = fact.get("hood") or ""
            f["class"] = str(fact.get("class") or "")
            f["material"] = str(fact.get("material") or "")
        roof = _roof(instances[i], fact)
        if roof:
            f["roof"] = roof
        f["floors"] = max(1, int(round(f["height"] / FLOOR_METERS)))
        out[i] = f
    return out


def _roof(inst: dict, fact: dict | None) -> str:
    """The roof shape: the facts' where they say, else Overture's (`_roof`, every
    shape it records; `rs`, the ones the generator draws)."""
    return str((fact or {}).get("roof") or inst.get("_roof") or inst.get("rs") or "")


def class_matches(patterns: list, code: Any) -> bool:
    """A class code against a rule's `classes`: exact, or a prefix ending in `*`
    (`[A4, "C*"]` matches A4, C0 … C9, but not A40)."""
    code = str(code or "")
    if not code:
        return False
    for p in patterns:
        p = str(p)
        if code == p or (p.endswith("*") and code.startswith(p[:-1])):
            return True
    return False


def matches(rule: dict, group: str, f: dict) -> bool:
    if not f:
        return False
    if group not in rule.get("from", GENERIC):
        return False
    if f.get("parts") and "from" not in rule:
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
    if "classes" in rule and not class_matches(rule["classes"], f.get("class")):
        return False
    if "roofs" in rule and f.get("roof", "") not in [str(r) for r in rule["roofs"]]:
        return False
    if "materials" in rule and str(f.get("material") or "").casefold() not in {
        str(m).casefold() for m in rule["materials"]
    }:
        return False
    if "names" in rule and f.get("name", "") not in [str(n) for n in rule["names"]]:
        return False
    for key, feat, cmp in (
        ("minWidth", "width", 1),
        ("maxWidth", "width", -1),
        ("minDepth", "depth", 1),
        ("maxDepth", "depth", -1),
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
    if "bounds" in rule:
        ll = f.get("lonlat")
        b = rule["bounds"]
        boxes = b if isinstance(b[0], (list, tuple)) else [b]
        if ll is None or not any(w <= ll[0] <= e and s <= ll[1] <= n for w, s, e, n in boxes):
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
