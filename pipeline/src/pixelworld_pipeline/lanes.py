"""Lanes and medians (M3.5): what each road's cells say about its lanes.

Overture carries no lane counts, and its `width_rules` are rarely filled in,
but it does say which segments are one-way (`access_restrictions`). A road
mapped as two one-way carriageways of the same name, side by side and running
opposite ways, is a divided road with a median between them. Lane counts
follow from each way's width (its class width, `width_rules` where mapped, or
a spec rule): one carriageway of 14 m is four lanes of 3.5 m.

LANE layer encoding (u8 per cell, for the widest road through it, like RWID):
  bits 0-3  lanes across the way (0: no lane count, nothing drawn)
  bit 4     one-way: every lane runs the same way (no centre line)
  bit 5     divided: a carriageway with its partner across a median
"""

from __future__ import annotations

from typing import Any

import numpy as np
import shapely

ONEWAY = 1 << 4
DIVIDED = 1 << 5
LANE_COUNT_MASK = 0x0F
MAX_LANES = 15
# conditions that make a restriction apply to some traffic only
_CONDITIONS = ("during", "using", "recognized", "mode", "vehicle")


def travel_sign(row: dict) -> int:
    """+1 where a segment is one-way along its geometry, -1 against it, 0 two-way:
    an unconditional `denied` restriction on one heading (`access_restrictions`)."""
    for rule in row.get("access_restrictions") or []:
        when = rule.get("when") or {}
        if rule.get("access_type") != "denied" or any(when.get(k) for k in _CONDITIONS):
            continue
        if when.get("heading") == "backward":
            return 1
        if when.get("heading") == "forward":
            return -1
    return 0


def mapped_width(row: dict) -> float | None:
    """The widest `width_rules` value (metres) of a segment, if it has any."""
    values = [float(w["value"]) for w in row.get("width_rules") or [] if w.get("value")]
    return max(values) if values else None


def lane_count(width_m: float, oneway: bool, lane_m: float) -> int:
    """Lanes across a way `width_m` wide: whole lanes of about `lane_m`, an even
    number (as many each way) on a two-way road."""
    if oneway:
        n = round(width_m / lane_m)
        return int(np.clip(n, 1, MAX_LANES))
    n = 2 * round(width_m / (2 * lane_m))
    return int(np.clip(n, 2, MAX_LANES - 1))


def _name(row: dict) -> str:
    return (((row.get("names") or {}).get("primary")) or "").strip().lower()


def way_rule(rules: list[dict], row: dict, at: tuple[float, float] | None) -> dict | None:
    """The first `widths.ways` rule a road matches: by name (any of `names`,
    case-insensitive, within its primary name), by a lon/lat box (`bounds`:
    west, south, east, north) its middle lies in (`at`, lon/lat), and by
    whether it is one-way (`oneway`: a carriageway of a road mapped as two)."""
    name = _name(row)
    for rule in rules:
        names = [n.lower() for n in rule.get("names") or []]
        if names and not any(n in name for n in names):
            continue
        if "oneway" in rule and bool(rule["oneway"]) != (travel_sign(row) != 0):
            continue
        if "bounds" in rule:
            if at is None:
                continue
            w, s, e, n = (float(v) for v in rule["bounds"])
            if not (w <= at[0] <= e and s <= at[1] <= n):
                continue
        return rule
    return None


def divided(
    lines: list[tuple[str, int, list[tuple[np.ndarray, np.ndarray]]]],
    rows: dict[str, dict],
    sign: dict[str, int],
    reach: float,
) -> set[str]:
    """One-way carriageways with a partner: another one-way way of the same
    name running the opposite way, roughly parallel, within `reach` cells of its
    middle (lines in cells, before straightening)."""
    cands: list[tuple[str, str, Any, int]] = []
    for seg_id, _, parts in lines:
        s = sign.get(seg_id, 0)
        name = _name(rows[seg_id]) if seg_id in rows else ""
        if not s or not name:
            continue
        for xs, ys in parts:
            if len(xs) >= 2:
                cands.append((seg_id, name, shapely.LineString(np.column_stack([xs, ys])), s))
    if not cands:
        return set()
    tree = shapely.STRtree([c[2] for c in cands])

    def heading(g, at: float, s: int) -> np.ndarray:
        # the travel direction along g at distance `at`
        step = min(0.25, 0.5 * g.length)
        a = g.interpolate(max(0.0, at - step))
        b = g.interpolate(min(g.length, at + step))
        v = np.array([b.x - a.x, b.y - a.y]) * s
        n = float(np.hypot(*v))
        return v / n if n > 0 else v

    out: set[str] = set()
    for i, (seg_id, name, g, s) in enumerate(cands):
        if g.length <= 0:
            continue
        mid = g.interpolate(0.5, normalized=True)
        t = heading(g, 0.5 * g.length, s)
        for j in tree.query(mid, predicate="dwithin", distance=reach):
            other, name2, g2, s2 = cands[int(j)]
            if j == i or other == seg_id or name2 != name:
                continue
            d = g2.distance(mid)
            if d < 0.05 or d > reach:  # the same carriageway split in two
                continue
            t2 = heading(g2, g2.project(mid), s2)
            if float(t @ t2) < -0.8:
                out.add(seg_id)
                break
    return out


def report(layer: np.ndarray) -> dict[str, int]:
    """Cells of a LANE layer with two or more lanes, one-way and divided."""
    return {
        "counted": int(((layer & LANE_COUNT_MASK) >= 2).sum()),
        "oneway": int((layer & ONEWAY != 0).sum()),
        "divided": int((layer & DIVIDED != 0).sum()),
    }


def lane_bytes(
    lines: list[tuple[str, int, list[tuple[np.ndarray, np.ndarray]]]],
    rows: list[dict],
    widths_m: dict[str, float],
    spec: dict[str, Any],
    metres_per_cell: float,
    counts: dict[str, int] | None = None,
) -> dict[str, int]:
    """Segment id → LANE byte (module docstring) for every road: its lane
    count (unless `lines: false`), one-way and divided flags. `widths_m` holds
    the width each road is drawn at (metres), `counts` lane counts a spec rule
    gives; `spec` is `widths.lanes`: `meters` (a lane, default 3.5), `lines`
    (store lane counts, default true), `medianMeters` (how far apart a divided
    road's carriageways may run, default 60). `lines` are the roads in cells,
    as mapped."""
    lane_m = float(spec.get("meters", 3.5))
    lines_on = bool(spec.get("lines", True))
    reach = float(spec.get("medianMeters", 60.0)) / metres_per_cell
    counts = counts or {}
    by_id = {r["id"]: r for r in rows}
    sign = {r["id"]: travel_sign(r) for r in rows}
    pairs = divided(lines, by_id, sign, reach)
    out: dict[str, int] = {}
    for r in rows:
        seg = r["id"]
        oneway = sign[seg] != 0
        v = (ONEWAY if oneway else 0) | (DIVIDED if seg in pairs else 0)
        if lines_on and seg in counts:
            v |= int(np.clip(counts[seg], 1, MAX_LANES))
        elif lines_on and seg in widths_m:
            v |= lane_count(widths_m[seg], oneway, lane_m)
        out[seg] = v
    return out
