"""Region spec schema: every key a region spec may hold, its type, default and
meaning, checked before a build starts and printed as the spec reference.

    issues = validate(raw, spec_path=path, lines=lines)   # [] when the spec is fine
    print(reference())                                     # Markdown, as in docs/worlds.md

The schema is the one place the keys are listed: `validate` reports unknown
keys (with "did you mean"), wrong types and out-of-range values with the key
path and, for specs read from a file, the file and line; `reference` writes
docs/worlds.md's reference section, which a test keeps in step
(`pixelworld reference --write docs/worlds.md`).
"""

from __future__ import annotations

import datetime as _dt
import difflib
import math
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# A key's place in a spec: ("sources", "dem", "kind"), ("objects", "vegetation", 0, "group").
KeyPath = tuple[str | int, ...]
# Where each key was written: path → (file, line), lines counted from 1.
Lines = dict[KeyPath, tuple[Path, int]]


def dotted(path: KeyPath) -> str:
    out = ""
    for p in path:
        out += f"[{p}]" if isinstance(p, int) else (f".{p}" if out else str(p))
    return out or "(the spec)"


@dataclass
class Issue:
    """One problem with a spec: an error stops the build, a warning doesn't."""

    path: KeyPath
    message: str
    level: str = "error"
    file: Path | None = None
    line: int | None = None

    def __str__(self) -> str:
        where = f"{self.file}:{self.line}: " if self.file and self.line else ""
        if self.file and not self.line:
            where = f"{self.file}: "
        tag = "warning: " if self.level == "warning" else ""
        key = dotted(self.path) if self.path else ""
        return f"{where}{tag}{key + ': ' if key else ''}{self.message}"


class Ctx:
    """What a validation pass carries: the issues found and where keys were written."""

    def __init__(self, lines: Lines | None, spec_path: Path | None, show_file: bool = True):
        self.issues: list[Issue] = []
        self.lines = lines or {}
        self.spec_path = spec_path
        self.show_file = show_file

    def add(self, path: KeyPath, message: str, level: str = "error") -> None:
        file, line = self.where(path)
        self.issues.append(Issue(path, message, level, file, line))

    def where(self, path: KeyPath) -> tuple[Path | None, int | None]:
        """The file and line of a key, or of the nearest key above it."""
        p = tuple(path)
        while p:
            if p in self.lines:
                return self.lines[p]
            p = p[:-1]
        return (self.spec_path, None) if self.spec_path and self.show_file else (None, None)


def _kind(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true/false"
    if isinstance(v, (int, float)):
        return "a number"
    if isinstance(v, str):
        return f"the text {v!r}"
    if isinstance(v, list):
        return "a list"
    if isinstance(v, dict):
        return "a mapping"
    if isinstance(v, (_dt.date, _dt.datetime)):
        return f"a date ({v})"
    return type(v).__name__


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def suggest(word: str, known: Iterable[str]) -> str:
    """ "; did you mean 'x'?" for the known word closest to `word`, or "": the
    same word in other case, a close spelling, or the one name that starts with
    it (`desert` for `desert-southwest`)."""
    known = list(known)
    lower = {k.lower(): k for k in known}
    if word.lower() in lower:
        return f"; did you mean '{lower[word.lower()]}'?"
    close = difflib.get_close_matches(word, known, n=1, cutoff=0.6)
    if not close and len(word) >= 3:
        close = [k for k in known if k.lower().startswith(word.lower())]
        close = close if len(close) == 1 else []
    return f"; did you mean '{close[0]}'?" if close else ""


# ---- types -------------------------------------------------------------------------


class Type:
    """A value's type: checks a value and names itself for the reference."""

    name = "any"

    def check(self, v: Any, path: KeyPath, ctx: Ctx) -> None:
        pass


class AnyValue(Type):
    def __init__(self, name: str = "any"):
        self.name = name


class Str(Type):
    """Text, optionally one of a fixed set (`choices`, a list or a function
    giving one; `strict=False` warns instead of failing), or matching a pattern."""

    def __init__(
        self,
        choices: Iterable[str] | Callable[[], Iterable[str]] | None = None,
        *,
        strict: bool = True,
        pattern: str | None = None,
        pattern_doc: str = "",
        name: str | None = None,
    ):
        self._choices = choices
        self.strict = strict
        self.pattern = re.compile(pattern) if pattern else None
        self.pattern_doc = pattern_doc
        self._name = name

    def choices(self) -> list[str] | None:
        c = self._choices
        if c is None:
            return None
        return list(c() if callable(c) else c)

    @property
    def name(self) -> str:  # type: ignore[override]
        if self._name:
            return self._name
        c = self.choices()
        if c and self.strict and len(c) <= 12:
            return "one of " + ", ".join(f"`{x}`" for x in c)
        return "string"

    def check(self, v: Any, path: KeyPath, ctx: Ctx) -> None:
        if isinstance(v, (_dt.date, _dt.datetime)):
            ctx.add(path, f"YAML read {v} as a date; quote it to keep it text: '{v}'")
            return
        if not isinstance(v, str):
            ctx.add(path, f"must be text, not {_kind(v)}")
            return
        c = self.choices()
        if c is not None and v not in c:
            listed = ", ".join(c) if len(c) <= 24 else f"{len(c)} values"
            ctx.add(
                path,
                f"unknown value '{v}'{suggest(v, c)} (use one of: {listed})",
                "error" if self.strict else "warning",
            )
        if self.pattern and not self.pattern.fullmatch(v):
            ctx.add(path, f"'{v}' isn't {self.pattern_doc}")


class Num(Type):
    """A number in a range: `lo`/`hi` inclusive unless `lo_open`/`hi_open`;
    `integer` for whole numbers; `power_of_two` for overview factors."""

    def __init__(
        self,
        lo: float | None = None,
        hi: float | None = None,
        *,
        integer: bool = False,
        lo_open: bool = False,
        hi_open: bool = False,
        power_of_two: bool = False,
        unit: str = "",
    ):
        self.lo, self.hi, self.integer = lo, hi, integer
        self.lo_open, self.hi_open, self.power_of_two, self.unit = (
            lo_open,
            hi_open,
            power_of_two,
            unit,
        )

    @property
    def name(self) -> str:  # type: ignore[override]
        base = "integer" if self.integer else "number"
        if self.power_of_two:
            return "1, 2, 4, 8, …"
        rng = self._range()
        unit = f" ({self.unit})" if self.unit else ""
        return f"{base}{', ' + rng if rng else ''}{unit}"

    def _range(self) -> str:
        if self.lo is not None and self.hi is not None:
            if self.integer and not self.lo_open and not self.hi_open:
                return f"{self.lo:g}–{self.hi:g}"
            a = "(" if self.lo_open else "["
            b = ")" if self.hi_open else "]"
            return f"in {a}{self.lo:g}, {self.hi:g}{b}"
        if self.lo is not None:
            return f"{'>' if self.lo_open else '≥'} {self.lo:g}"
        if self.hi is not None:
            return f"{'<' if self.hi_open else '≤'} {self.hi:g}"
        return ""

    def check(self, v: Any, path: KeyPath, ctx: Ctx) -> None:
        if not _num(v):
            ctx.add(path, f"must be a number, not {_kind(v)}")
            return
        if self.integer and v != int(v):
            ctx.add(path, f"must be a whole number, not {v}")
            return
        if self.power_of_two and not (v >= 1 and v == int(v) and int(v) & (int(v) - 1) == 0):
            ctx.add(path, f"must be a power of two (1, 2, 4, 8, …), not {v}")
            return
        lo_bad = self.lo is not None and (v <= self.lo if self.lo_open else v < self.lo)
        hi_bad = self.hi is not None and (v >= self.hi if self.hi_open else v > self.hi)
        if lo_bad or hi_bad:
            ctx.add(path, f"must be {self._range()}, not {v:g}")


class Bool(Type):
    name = "true/false"

    def check(self, v: Any, path: KeyPath, ctx: Ctx) -> None:
        if not isinstance(v, bool):
            ctx.add(path, f"must be true or false, not {_kind(v)}")


class ListOf(Type):
    def __init__(self, item: Type, *, min_items: int = 0, name: str | None = None):
        self.item, self.min_items, self._name = item, min_items, name

    @property
    def name(self) -> str:  # type: ignore[override]
        if self._name:
            return self._name
        inner = self.item.name
        if isinstance(self.item, Map):
            inner = "mapping"
        if inner.startswith("one of "):
            return f"list of {inner[7:]}"
        return f"list of {inner}s" if " " not in inner else f"list of ({inner})"

    def check(self, v: Any, path: KeyPath, ctx: Ctx) -> None:
        if isinstance(v, str) and isinstance(self.item, Str):
            ctx.add(path, f"must be a list, not {_kind(v)}: write [{v}]")
            return
        if not isinstance(v, list):
            ctx.add(path, f"must be a list, not {_kind(v)}")
            return
        if len(v) < self.min_items:
            ctx.add(path, f"needs at least {self.min_items} item{'s' * (self.min_items > 1)}")
        for i, x in enumerate(v):
            self.item.check(x, (*path, i), ctx)


class Fixed(Type):
    """A list of a fixed length: [west, south, east, north], [from, to], [lon, lat]."""

    def __init__(self, parts: list[tuple[str, Type]], name: str, rule=None):
        self.parts, self._name, self.rule = parts, name, rule

    @property
    def name(self) -> str:  # type: ignore[override]
        return self._name

    def check(self, v: Any, path: KeyPath, ctx: Ctx) -> None:
        names = ", ".join(n for n, _ in self.parts)
        if not isinstance(v, (list, tuple)) or len(v) != len(self.parts):
            ctx.add(path, f"must be [{names}], not {_kind(v)}")
            return
        before = len(ctx.issues)
        for (_, t), x in zip(self.parts, v, strict=True):
            t.check(x, path, ctx)
        if self.rule and len(ctx.issues) == before:
            msg = self.rule(v)
            if msg:
                ctx.add(path, msg)


LON = Num(-180, 180)
LAT = Num(-90, 90)


def _bbox_rule(v) -> str | None:
    w, s, e, n = v
    if not (w < e and s < n):
        return f"must be [west, south, east, north] with west < east and south < north, not {v}"
    return None


def _range_rule(v) -> str | None:
    return None if v[0] <= v[1] else f"must be [from, to] with from ≤ to, not {v}"


BBOX = Fixed(
    [("west", LON), ("south", LAT), ("east", LON), ("north", LAT)],
    "[west, south, east, north] (lon/lat)",
    _bbox_rule,
)
POINT = Fixed([("lon", LON), ("lat", LAT)], "[lon, lat]")


def num_range(name: str = "[from, to]") -> Fixed:
    return Fixed([("from", Num()), ("to", Num())], name, _range_rule)


@dataclass
class Key:
    """A key of a mapping: its type, meaning and default (`default` is shown in
    the reference as written; `required` keys have none)."""

    type: Type
    doc: str
    default: str | None = None
    required: bool = False


class Map(Type):
    """A mapping with known keys. `options` names what other keys are (a plugin's
    options): they are kept, but one close to a known key is reported as a typo."""

    def __init__(
        self,
        keys: dict[str, Key],
        *,
        name: str = "mapping",
        options: str | None = None,
        rule: Callable[[dict, KeyPath, Ctx], None] | None = None,
        doc: str = "",
    ):
        self.keys, self._name, self.options, self.rule, self.doc = keys, name, options, rule, doc

    @property
    def name(self) -> str:  # type: ignore[override]
        return self._name

    def check(self, v: Any, path: KeyPath, ctx: Ctx) -> None:
        if not isinstance(v, dict):
            ctx.add(path, f"must be a mapping ({{key: value, …}}), not {_kind(v)}")
            return
        misspelt: set[str] = set()
        for k, x in v.items():
            k = str(k)
            if k not in self.keys:
                hint = suggest(k, self.keys)
                if self.options and not hint:
                    continue  # an option for the plugin
                where = f" in {dotted(path)}" if path else ""
                listed = ", ".join(self.keys)
                ctx.add((*path, k), f"unknown key{where}{hint or f' (known keys: {listed})'}")
                if hint:
                    misspelt.add(hint.split("'")[1])
                continue
            if x is None:
                continue  # null: not set, or removed from the spec it extends
            self.keys[k].type.check(x, (*path, k), ctx)
        for k, key in self.keys.items():
            # a required key spelt wrong was reported above, with the spelling
            if key.required and v.get(k) is None and k not in misspelt:
                ctx.add((*path, k) if path else (k,), "is missing (required)")
        if self.rule:
            self.rule(v, path, ctx)


class MapOf(Type):
    """A mapping from names (optionally a fixed set) to values of one type."""

    def __init__(self, key: Str, value: Type, name: str):
        self.key, self.value, self._name = key, value, name

    @property
    def name(self) -> str:  # type: ignore[override]
        return self._name

    def check(self, v: Any, path: KeyPath, ctx: Ctx) -> None:
        if not isinstance(v, dict):
            ctx.add(path, f"must be a mapping ({{name: value, …}}), not {_kind(v)}")
            return
        for k, x in v.items():
            self.key.check(str(k), (*path, str(k)), ctx)
            self.value.check(x, (*path, str(k)), ctx)


class OneOf(Type):
    """The first alternative whose shape matches (`accepts`) checks the value."""

    def __init__(self, *alts: tuple[Callable[[Any], bool], Type], name: str):
        self.alts, self._name = alts, name

    @property
    def name(self) -> str:  # type: ignore[override]
        return self._name

    def check(self, v: Any, path: KeyPath, ctx: Ctx) -> None:
        for accepts, t in self.alts:
            if accepts(v):
                t.check(v, path, ctx)
                return
        ctx.add(path, f"must be {self._name}, not {_kind(v)}")


def is_map(v) -> bool:
    return isinstance(v, dict)


def is_str(v) -> bool:
    return isinstance(v, str)


# ---- names the pipeline knows (imported late: these modules import region.py) -----------


def road_classes() -> list[str]:
    from .build import ROAD_ORDER

    return [c for c in reversed(ROAD_ORDER) if c != "brick"]


def all_road_classes() -> list[str]:
    from .build import ROAD_ORDER

    return list(reversed(ROAD_ORDER))


def path_classes() -> list[str]:
    from .build import PATH_ORDER

    return list(PATH_ORDER)


def landcover_classes() -> list[str]:
    from .sources.rasters import WORLDCOVER

    return list(WORLDCOVER.values())


def surface_names() -> list[str]:
    from .build import SURFACES
    from .ground import SURFACES as GROUND

    return [n for n in (SURFACES | GROUND).values() if n != "none"]


def rail_draw_kinds() -> list[str]:
    from .roads import RAIL_KINDS

    return list(RAIL_KINDS)


def vehicle_kinds() -> list[str]:
    from .routes import RAIL_KINDS

    return sorted(set(RAIL_KINDS.values()) | {"cablecar"})


OVERTURE_RAIL_CLASSES = [
    "standard_gauge",
    "light_rail",
    "tram",
    "subway",
    "funicular",
    "monorail",
    "narrow_gauge",
    "unknown",
]
OVERTURE_WATER_LINES = ["river", "stream", "canal", "drain", "ditch"]
RESAMPLING = ["average", "bilinear", "cubic", "nearest", "mode", "min", "max", "med"]
LEVEL_NAMES_DOC = "a level name"

# ---- the schema ------------------------------------------------------------------------

OVERVIEW = Num(1, integer=True, power_of_two=True)
OVERVIEW_DOC = (
    "Read the source's overview this many times coarser than its full resolution "
    "(1: full). Match it to the cell size: 1 for 10–20 m cells from a 10 m source."
)
SOURCE = {
    "kind": Key(
        Str(),
        "The terrain source: `usgs-3dep-13arcsec` (10 m, United States), "
        "`usgs-3dep-1arcsec` (30 m, United States), or a plugin's "
        "(`pixelworld plugins` lists them).",
        required=True,
    ),
    "overview": Key(OVERVIEW, OVERVIEW_DOC, "4"),
}
DEM = Map(
    SOURCE
    | {
        "resampling": Key(
            Str(RESAMPLING),
            "How source pixels become cell corners: `average` when cells are coarser "
            "than the source, `bilinear` when they're finer.",
            "`average`",
        )
    },
    name="mapping",
)
LANDCOVER = Map(
    {
        "kind": Key(
            Str(),
            "The land-cover source: `esa-worldcover-2021` (10 m, worldwide), or a plugin's.",
            required=True,
        ),
        "overview": Key(OVERVIEW, OVERVIEW_DOC, "16"),
    },
    name="mapping",
)

RAIL_RULE = Map(
    {
        "draw": Key(
            Str(rail_draw_kinds),
            "How the track is drawn: `street` (in the road), `cable` (with the "
            "cable's slot), `train` (its own way).",
            required=True,
        ),
        "rail": Key(
            ListOf(Str(OVERTURE_RAIL_CLASSES, strict=False)),
            "Overture rail classes the rule takes.",
            required=True,
        ),
        "names": Key(ListOf(Str()), "Only lines whose name contains one of these."),
        "unnamed": Key(Bool(), "Only lines without a name."),
        "bounds": Key(BBOX, "Only lines wholly inside this box."),
        "bundle": Key(
            Num(0, lo_open=True, unit="m"),
            "Parallel tracks within this distance are drawn as one corridor along its centre "
            "line, with its track count (D-094; micro-terrain worlds).",
        ),
    }
)

SOURCES = Map(
    {
        "dem": Key(DEM, "Elevation: the terrain source.", required=True),
        "landcover": Key(LANDCOVER, "Land cover: surfaces, water and vegetation.", required=True),
        "overture": Key(
            Map(
                {
                    "release": Key(
                        Str(
                            pattern=r"\d{4}-\d{2}-\d{2}\.\d+",
                            pattern_doc="an Overture release like 2026-10-21.0",
                        ),
                        "The Overture Maps release roads, rivers, buildings and land use "
                        "come from, pinned so builds repeat (e.g. `2026-10-21.0`).",
                        required=True,
                    )
                }
            ),
            "Overture Maps: roads, paths, rivers, rail, buildings, land use.",
            required=True,
        ),
        "roads": Key(
            Map(
                {
                    "classes": Key(
                        ListOf(Str(road_classes), min_items=1),
                        "The Overture road classes drawn.",
                        required=True,
                    ),
                    "excludeSubclasses": Key(
                        ListOf(Str()),
                        "Overture road subclasses left out (e.g. `parking_aisle`, "
                        "`driveway`); ramps (`link`) always are.",
                    ),
                    "joinIslands": Key(
                        ListOf(Str()),
                        "Subclasses kept only where a road needs them to join the network.",
                    ),
                }
            ),
            "The road network.",
            required=True,
        ),
        "rivers": Key(
            Map(
                {
                    "subtypes": Key(
                        ListOf(Str(OVERTURE_WATER_LINES, strict=False)),
                        "Overture water lines burned in as rivers (`river`, `stream`, "
                        "`canal`, …). Lakes and the sea come from land cover.",
                        "`[river]`",
                    )
                }
            ),
            "River lines.",
            "`{ subtypes: [river] }`",
        ),
        "paths": Key(
            Map(
                {
                    "classes": Key(
                        ListOf(Str(path_classes), min_items=1),
                        "The path classes drawn (sidewalks and crosswalks are "
                        "Overture footways of those subclasses).",
                        required=True,
                    )
                }
            ),
            "Footways and cycleways (walking levels).",
        ),
        "rails": Key(
            ListOf(RAIL_RULE),
            "Rails drawn in the street, each segment by the first rule it matches.",
        ),
    }
)

PROVINCE = Map(
    {
        "name": Key(Str(), "The province's name (the style pack's strata set).", required=True),
        "polygon": Key(
            ListOf(POINT, min_items=3, name="list of [lon, lat]"),
            "Its outline.",
            required=True,
        ),
    }
)

LEVEL = Map(
    {
        "name": Key(Str(), "The level's name (`fly`, `drive`, `walk`).", required=True),
        "world": Key(Str(), "The id of the package built for it.", required=True),
        "label": Key(Str(), "Shown in the viewer."),
    }
)

FOCUS = Map(
    {
        "name": Key(Str(), "Its name, in the build report.", required=True),
        "lon": Key(LON, "Centre longitude.", required=True),
        "lat": Key(LAT, "Centre latitude.", required=True),
        "radiusKm": Key(
            Num(0, lo_open=True), "Inside this radius the target holds.", required=True
        ),
        "falloffKm": Key(
            Num(0), "It blends back to the background over this distance.", "`radiusKm`"
        ),
        "metersPerCell": Key(
            Num(0, lo_open=True), "The target scale inside the area.", required=True
        ),
        "reliefMax": Key(Num(0, lo_open=True), "A lower cap on relief exaggeration here."),
    }
)
PIN = Map(
    {
        "name": Key(Str(), "Its name.", required=True),
        "lon": Key(LON, "The place's longitude.", required=True),
        "lat": Key(LAT, "The place's latitude.", required=True),
        "x": Key(Num(), "The world cell it's held at (x).", required=True),
        "y": Key(Num(), "The world cell it's held at (y).", required=True),
    }
)
WARP = Map(
    {
        "background": Key(
            Num(0, lo_open=True, unit="m"),
            "Metres per cell where nothing is magnified.",
            required=True,
        ),
        "focus": Key(ListOf(FOCUS), "Areas drawn finer than the background."),
        "pins": Key(ListOf(PIN), "Places held at given cells."),
        "method": Key(Str(["v1", "v2"]), "The solver.", "`v2`"),
        "meshKm": Key(
            Num(0, lo_open=True),
            "The solver's mesh spacing; keep it well under the smallest focus radius.",
            "2",
        ),
        "focusScale": Key(
            Num(0, lo_open=True), "Multiplies every focus area's metresPerCell (levels).", "1"
        ),
        "vertical": Key(
            Map(
                {
                    "gamma": Key(Num(0), "Relief grows as (base / local m per cell)^gamma.", "1"),
                    "referenceSigmaKm": Key(
                        Num(0, lo_open=True),
                        "Relief is measured from elevation smoothed over this.",
                        "6",
                    ),
                    "min": Key(Num(0, lo_open=True), "Smallest relief factor.", "0.5"),
                    "max": Key(Num(0, lo_open=True), "Largest relief factor.", "4"),
                }
            ),
            "Exaggerate relief where the map is magnified, so it keeps its proportions.",
        ),
        "importance": Key(
            Map(
                {
                    "minSitelinks": Key(
                        Num(0), "Places with fewer Wikidata sitelinks are ignored.", "20"
                    ),
                    "sigmaKm": Key(Num(0, lo_open=True), "How far a place's pull reaches.", "4"),
                    "maxMagnification": Key(Num(1), "The most a place magnifies.", "2"),
                    "reference": Key(
                        Num(0, lo_open=True), "Sitelinks that give full magnification.", "100"
                    ),
                }
            ),
            "Magnify famous places automatically (`importance.json`, `pixelworld importance`).",
        ),
    }
)

KEEP_RULE = Map(
    {
        "bounds": Key(BBOX, "Ways wholly inside this box keep their real geometry.", required=True),
        "class": Key(Str(all_road_classes), "Draw the kept roads as this class (e.g. `brick`)."),
        "width": Key(Num(0, lo_open=True, unit="m"), "Their width."),
        "widen": Key(Num(0, lo_open=True), "Swing their bends this many times wider."),
        "within": Key(
            Num(0, lo_open=True, unit="m"), "…but never past this far from the axis.", "15"
        ),
        "surface": Key(Str(surface_names), "The surface between the swung bends."),
    }
)
SNAP = Map(
    {
        "roads": Key(
            Map(
                {
                    "angle": Key(
                        Num(0, 45),
                        "Edges within this many degrees of a grid direction run along it.",
                        "16",
                    ),
                    "simplify": Key(Num(0), "Cells of wiggle removed first.", "0.75"),
                    "deviation": Key(
                        Num(0),
                        "How far (cells) an in-between road may stray to keep long runs.",
                        "1",
                    ),
                    "maxShift": Key(Num(0), "No junction moves further than this (cells).", "2"),
                    "directions": Key(
                        OneOf(
                            (lambda v: v in (8, 16) and not isinstance(v, bool), AnyValue()),
                            name="8 or 16",
                        ),
                        "Snap to the 8 grid directions, or 16 with the 2:1 ones (D-082).",
                        "8",
                    ),
                    "keep": Key(ListOf(KEEP_RULE), "Streets left as mapped (a crooked street)."),
                }
            ),
            "Straighten roads toward the 8 grid directions, which draw as clean pixel lines.",
        ),
        "buildings": Key(
            Map(
                {
                    "angle": Key(
                        Num(0, 45), "Footprints within this many degrees turn to the grid.", "12"
                    ),
                    "follow": Key(
                        Num(0), "Objects within this many cells of a road move with it.", "3"
                    ),
                    "clearRoads": Key(
                        Map(
                            {
                                "nudgeMeters": Key(
                                    Num(0),
                                    "Nudge buildings off the drawn asphalt by up to this.",
                                    "5",
                                )
                            }
                        ),
                        "Move buildings off the drawn roads.",
                    ),
                }
            ),
            "Turn buildings to the grid and move them with their streets.",
        ),
    }
)

WAY_RULE = Map(
    {
        "names": Key(ListOf(Str()), "Roads whose name contains one of these."),
        "bounds": Key(BBOX, "Roads whose middle lies in this box."),
        "oneway": Key(Bool(), "Only one-way carriageways (true) or two-way roads (false)."),
        "meters": Key(Num(0, lo_open=True, unit="m"), "Their width."),
        "lanes": Key(Num(1, 15, integer=True), "Their lane count."),
    }
)
WIDTHS = Map(
    {
        "scale": Key(Num(0, lo_open=True), "Ways are drawn this many times their real width.", "1"),
        "minCells": Key(Num(0), "…never narrower than this (cells).", "0.1"),
        "centrelines": Key(
            Bool(),
            "Draw ways along their own centre lines rather than their cells' connections "
            "(any angle, curves; D-082).",
            "false",
        ),
        "roads": Key(
            MapOf(Str(road_classes), Num(0, lo_open=True), "mapping of road class → metres"),
            "Real width per road class (defaults: motorway 16, trunk and primary 14, "
            "secondary 12, tertiary 10, residential 8, unclassified 7, living_street 6, "
            "service 5).",
        ),
        "paths": Key(
            MapOf(Str(path_classes), Num(0, lo_open=True), "mapping of path class → metres"),
            "Real width per path class (defaults: pedestrian 8, crosswalk 4, sidewalk, "
            "footway and steps 3, cycleway 2.5, path 2).",
        ),
        "lanes": Key(
            Map(
                {
                    "meters": Key(Num(0, lo_open=True, unit="m"), "A lane's width.", "3.5"),
                    "lines": Key(Bool(), "Store lane counts (lane lines are drawn).", "true"),
                    "medianMeters": Key(
                        Num(0), "How far apart a divided road's carriageways may run.", "60"
                    ),
                }
            ),
            "Lanes and medians.",
        ),
        "ways": Key(
            ListOf(WAY_RULE), "Widths and lanes for particular roads; the first match wins."
        ),
    }
)

LAWN = Map(
    {
        "landUse": Key(
            ListOf(Str()),
            "Overture land-use classes that are lawns (`park`, `golf_course`, …).",
            required=True,
        ),
        "over": Key(ListOf(Str(surface_names)), "Surfaces a lawn replaces.", "`[grass]`"),
        "keep": Key(ListOf(Str()), "Natural land (Overture base `land` classes) left as it is."),
        "maxSlope": Key(Num(0), "A park steeper than this (rise over run) stays wild.", "0.2"),
        "slopeMeters": Key(Num(0), "Slopes are measured over about this distance.", "50"),
        "wooded": Key(
            Map(
                {
                    "over": Key(
                        ListOf(Str(surface_names)),
                        "Tree-covered surfaces that can be lawn.",
                        "`[woodland]`",
                    ),
                    "maxCover": Key(
                        Num(0, 1), "…where the canopy covers at most this share.", "0.5"
                    ),
                    "canopy": Key(
                        Num(0, unit="m"), "Trees at least this tall count as cover.", "3"
                    ),
                }
            ),
            "Lawn under open tree cover.",
        ),
        "spread": Key(
            Map(
                {
                    "over": Key(
                        ListOf(Str(surface_names)), "Surfaces it spreads into.", "`[grass]`"
                    ),
                    "meters": Key(Num(0), "How far.", "0"),
                }
            ),
            "Spread lawns into the open ground around them.",
        ),
    }
)
YARD = Map(
    {
        "near": Key(
            ListOf(Str()), "Building groups (prefixes) that have yards.", "`[building.residential]`"
        ),
        "over": Key(ListOf(Str(surface_names)), "Surfaces a yard replaces.", "`[urban]`"),
        "reachMeters": Key(Num(0), "Cells this close to a house are yard.", "15"),
        "paved": Key(Num(0, 1), "Share of yard cells left paved.", "0"),
    }
)

LIDAR = Map(
    {
        "project": Key(
            Str(),
            "The USGS 3DEP lidar project (e.g. `USGS_LPC_NV_LasVegas_QL1_2016_LAS_2018`).",
            required=True,
        ),
        "res": Key(Num(0, lo_open=True, unit="m"), "Height grid resolution.", "4"),
        "depth": Key(Num(0, integer=True), "Point-cloud octree depth read.", "6"),
        "towerGap": Key(Num(0, unit="m"), "Roofs this far above the median are tower parts.", "25"),
        "minTowerArea": Key(Num(0, unit="m²"), "Smallest tower part.", "600"),
    }
)
BOXES = OneOf(
    (lambda v: isinstance(v, list) and v and isinstance(v[0], list), ListOf(BBOX)),
    (lambda v: True, BBOX),
    name="a box or a list of boxes",
)
BUILDINGS = Map(
    {
        "bounds": Key(
            BOXES,
            "Only buildings in this box (or these boxes).",
            "the whole region",
        ),
        "minArea": Key(Num(0, unit="m²"), "Smaller footprints are left out.", "30"),
        "towerMeters": Key(Num(0, unit="m"), "Buildings this tall are towers.", "45"),
        "podiumMeters": Key(Num(0, unit="m"), "A tower's podium height.", "15"),
        "tiers": Key(
            Bool(),
            "Parts standing on others (setback tiers) are drawn from the ground where they "
            "stand over their building, not dropped.",
            "off",
        ),
        "houseMaxArea": Key(
            Num(0, unit="m²"), "Residential footprints up to this size are houses (0: none).", "0"
        ),
        "simplifyMeters": Key(Num(0, unit="m"), "Footprint simplification.", "2"),
        "courtyards": Key(
            Bool(),
            "Keep footprints' courtyards (their holes, as `fh`) instead of filling them.",
            "false",
        ),
        "implausible": Key(
            Map(
                {
                    "maxArea": Key(Num(0, unit="m²"), "At most this big…", "200"),
                    "minHeight": Key(Num(0, unit="m"), "…at least this tall…", "8"),
                    "minAspect": Key(Num(0), "…and this many times taller than wide.", "2.5"),
                    "landUse": Key(
                        ListOf(Str()), "The park land uses it applies in.", "`ground.lawn.landUse`"
                    ),
                }
            ),
            "Footprints in parks that are really trees are dropped (null keeps every one).",
            "on",
        ),
        "lidar": Key(LIDAR, "Heights and tower parts from USGS 3DEP lidar."),
    }
)

TYPOLOGY_RULE = Map(
    {
        "group": Key(Str(), "The group a matching building gets.", required=True),
        "from": Key(ListOf(Str()), "Groups the rule may replace.", "the generic building groups"),
        "year": Key(num_range("[from, to)"), "Year built."),
        "uses": Key(
            ListOf(Str()), "Uses (`residential`, `mixed`, `commercial`, `industrial`, `civic`)."
        ),
        "hoods": Key(ListOf(Str()), "Neighbourhood names (from the facts source)."),
        "classes": Key(
            ListOf(AnyValue("string")), "Class codes: exact, or a prefix ending in `*`."
        ),
        "roofs": Key(ListOf(AnyValue("string")), "Roof shapes."),
        "materials": Key(
            ListOf(AnyValue("string")), "Facade materials (from the facts source; any case)."
        ),
        "names": Key(
            ListOf(AnyValue("string")),
            "Overture names (a building's primary name; its parts share it), exactly.",
        ),
        "minWidth": Key(Num(0, unit="m"), "Narrowest."),
        "maxWidth": Key(Num(0, unit="m"), "Widest."),
        "minDepth": Key(Num(0, unit="m"), "Shallowest."),
        "maxDepth": Key(Num(0, unit="m"), "Deepest (the footprint's long side)."),
        "minParty": Key(Num(0, 1), "Least share of outline shared with neighbours."),
        "maxParty": Key(Num(0, 1), "Most share of outline shared with neighbours."),
        "floors": Key(num_range("[min, max]"), "Storeys."),
        "minHeight": Key(Num(0, unit="m"), "Lowest."),
        "maxHeight": Key(Num(0, unit="m"), "Tallest."),
        "onWater": Key(Bool(), "Stands over water."),
        "corner": Key(Bool(), "On a corner lot."),
        "bounds": Key(
            BOXES, "Only buildings whose centroid is in this box (or these boxes): a neighbourhood."
        ),
    }
)
TYPOLOGY = Map(
    {
        "facts": Key(
            OneOf(
                (is_str, Str()),
                (
                    is_map,
                    Map(
                        {"plugin": Key(Str(), "The facts source plugin.", required=True)},
                        options="plugin options",
                    ),
                ),
                (lambda v: v is False, Bool()),
                name="a plugin name, or { plugin, …options }",
            ),
            "A facts source plugin (year built, use, storeys) by name: `datasf`, or "
            "`{ plugin: datasf, …options }`.",
        ),
        "rules": Key(ListOf(TYPOLOGY_RULE), "Matched in order; the first match picks the group."),
    },
    options="facts source options (the older form)",
)


def _scatter_rule(v: dict, path: KeyPath, ctx: Ctx) -> None:
    if "landcover" not in v and "canopy" not in v:
        ctx.add(path, "needs `landcover` (ESA WorldCover classes) or `canopy` (metres)")


def _row_rule(v: dict, path: KeyPath, ctx: Ctx) -> None:
    if v.get("at") == "junctions" or "canopy" in v:
        return
    if v.get("spacing") is None:
        ctx.add((*path, "spacing"), "is missing (required for rows along roads)")


VEGETATION_RULE = Map(
    {
        "group": Key(Str(), "The semantic group placed (the style pack draws it).", required=True),
        "spacing": Key(
            Num(0, lo_open=True, unit="m"), "Grid spacing of candidate spots.", required=True
        ),
        "density": Key(Num(0, 1), "Share of spots kept.", "1"),
        "landcover": Key(
            ListOf(Str(landcover_classes)),
            "ESA WorldCover classes it grows on: `tree`, `shrub`, `grass`, `crop`, "
            "`built`, `bare`, `snow`, `water`, `wetland`, `mangrove`, `moss`.",
        ),
        "canopy": Key(
            Num(0, unit="m"), "Instead: where the canopy height map is at least this tall."
        ),
        "byLandcover": Key(
            MapOf(Str(landcover_classes), ListOf(Str()), "mapping of class → groups"),
            "Pick the group by the land cover it stands on.",
        ),
    },
    rule=_scatter_rule,
)
ROW_RULE_KEYS = {
    "group": Key(Str(), "The semantic group placed.", required=True),
    "roads": Key(
        ListOf(Str(all_road_classes), min_items=1), "Road classes it lines.", required=True
    ),
    "spacing": Key(Num(0, lo_open=True, unit="m"), "Distance between them.", "12 with `canopy`"),
    "offset": Key(
        Num(0, unit="m"), "Distance from the road's centre line.", "12 (0 with `canopy`)"
    ),
    "name": Key(Str(), "Only roads whose name contains this."),
    "bounds": Key(BBOX, "Only within this box."),
    "landcover": Key(ListOf(Str(landcover_classes)), "Only on these land-cover classes."),
    "across": Key(Bool(), "Over the road, turned across it (strung lanterns)."),
    "canopy": Key(
        Num(0, unit="m"),
        "On the verge past the drawn asphalt, where the canopy map has trees this tall.",
    ),
    "kerb": Key(Num(0, unit="m"), "With `canopy`: distance past the drawn asphalt.", "2"),
    "search": Key(Num(0, unit="m"), "With `canopy`: how far to look for a mapped tree.", "3"),
    "density": Key(Num(0, 1), "With `canopy`: share of spots kept.", "1"),
}
STREET_TREE_RULE = Map(dict(ROW_RULE_KEYS), rule=_row_rule)
STREET_PROP_RULE = Map(
    ROW_RULE_KEYS
    | {
        "at": Key(Str(["junctions"]), "Two per junction of 3+ roads, on opposite corners."),
        "wires": Key(
            Str(),
            "Strung props (D-095): one row on each street's left at `offset` (default 3 m), "
            "joined through junctions where the street runs on straight, and a span of "
            "this group from each prop to the next.",
        ),
    },
    rule=_row_rule,
)
LANDMARK_PART = Map(
    {
        "group": Key(Str(), "The part's group.", required=True),
        "along": Key(Num(0, 1), "Where along the line.", "0.5"),
        "offset": Key(Num(unit="m"), "How far to the line's left.", "0"),
        "aboveCrest": Key(Num(unit="m"), "Its top above the crest.", "0"),
        "height": Key(Num(0, unit="m"), "Its height."),
    }
)
LANDMARK = Map(
    {
        "id": Key(Str(), "A landmark in the registry (`worlds/_landmarks/<id>.yaml`)."),
        "group": Key(Str(), "Inline: its semantic group."),
        "lon": Key(LON, "Inline: anchor longitude."),
        "lat": Key(LAT, "Inline: anchor latitude."),
        "line": Key(
            ListOf(POINT, min_items=2, name="[[lon, lat], [lon, lat]]"),
            "Inline: a line landmark's ends (dams, bridges).",
        ),
        "hm": Key(Num(0, unit="m"), "Height."),
        "crestMeters": Key(Num(unit="m"), "A line landmark's crest or deck, above sea level."),
        "baseMeters": Key(Num(unit="m"), "A line landmark's foot."),
        "reservoir": Key(Num(0, unit="m"), "A dam's lake stands this far below its crest."),
        "thicknessM": Key(Num(0, unit="m"), "Across a line landmark.", "60"),
        "bulge": Key(Num(), "How far a line landmark bows to its left.", "0.15"),
        "segmentCells": Key(
            Num(0, lo_open=True), "A line landmark's pieces are at most this long."
        ),
        "snap": Key(Bool(), "A bridge turns to its road's grid direction."),
        "clear": Key(Num(0, unit="m"), "Other buildings are kept this far away.", "0"),
        "orient": Key(Num(integer=True), "Quarter turns.", "0"),
        "scale": Key(
            Num(0, lo_open=True), "Drawn this many times its size.", "`depiction.landmarks.scale`"
        ),
        "replaces": Key(ListOf(Str()), "Overture building names or ids it stands in for."),
        "footprint": Key(
            Bool(), "Drawn on the footprint of the building it replaces, not on a box.", "off"
        ),
        "parts": Key(ListOf(LANDMARK_PART), "Sub-objects along a line landmark."),
        "hero": Key(Bool(), "Baked offline and painted over."),
    },
    name="mapping",
)


def _landmark_rule(v: dict, path: KeyPath, ctx: Ctx) -> None:
    if "id" not in v and "group" not in v:
        ctx.add(path, "needs an `id` (a registry landmark) or a `group` (an inline one)")
    if "group" in v and "id" not in v and not ("line" in v or ("lon" in v and "lat" in v)):
        ctx.add(path, "an inline landmark needs `lon` and `lat`, or a `line`")


LANDMARK.rule = _landmark_rule

DEPICTION = Map(
    {
        "heightStretch": Key(
            Num(0, lo_open=True),
            "Objects drawn this many times taller (overrides the style pack's).",
        ),
        "scatter": Key(Num(0), "Density of the client's scatter (shrubs, rocks) by surface."),
        "vehicleScale": Key(
            Num(0, lo_open=True), "Traffic drawn at most this many times its size."
        ),
        "buildings": Key(
            Map(
                {
                    "scale": Key(Num(0, lo_open=True), "Drawn this many times their size.", "1"),
                    "minHeightMeters": Key(Num(0, unit="m"), "Lower buildings are left out.", "0"),
                }
            ),
            "Oversize buildings on coarse levels.",
        ),
        "landmarks": Key(
            Map({"scale": Key(Num(0, lo_open=True), "Drawn this many times their size.", "1")}),
            "Oversize landmarks.",
        ),
    }
)

OBJECTS = Map(
    {
        "buildings": Key(BUILDINGS, "Buildings from Overture footprints (`{}` for the defaults)."),
        "typology": Key(TYPOLOGY, "What each building is (rowhouse, tower, …), by rules."),
        "vegetation": Key(ListOf(VEGETATION_RULE), "Trees and shrubs scattered by land cover."),
        "streetTrees": Key(ListOf(STREET_TREE_RULE), "Rows of trees along roads."),
        "streetProps": Key(
            ListOf(STREET_PROP_RULE), "Street lights and signals: rows, or at junctions."
        ),
        "landmarks": Key(
            ListOf(
                OneOf(
                    (is_str, Str(name="registry id")), (is_map, LANDMARK), name="an id or a mapping"
                ),
                name="list of ids or mappings",
            ),
            "Landmarks: registry ids (`worlds/_landmarks/`), `{ id, …overrides }`, or "
            "inline mappings.",
        ),
        "landmarkDepiction": Key(Str(), "Which registry depiction to draw.", "`generic`"),
        "depiction": Key(DEPICTION, "How big things are drawn at this scale level."),
        "lowrise": Key(
            Map(
                {
                    "group": Key(Str(), "The group.", "`city.blocks`"),
                    "heightMeters": Key(Num(0, unit="m"), "Their real height.", "8"),
                }
            ),
            "Built-up land as blocks of low buildings (coarse levels).",
        ),
    }
)

ROUTES = Map(
    {
        "rail": Key(
            OneOf(
                (lambda v: v is False, Bool()),
                (
                    is_map,
                    Map(
                        {
                            "unnamedTram": Key(
                                Str(vehicle_kinds),
                                "Tram lines with no name anywhere run this vehicle.",
                            ),
                            "classes": Key(
                                MapOf(
                                    Str(OVERTURE_RAIL_CLASSES),
                                    Str(vehicle_kinds),
                                    "mapping of class → vehicle",
                                ),
                                "Vehicle per Overture rail class (adds to the defaults).",
                            ),
                        }
                    ),
                ),
                name="false, or a mapping",
            ),
            "Rail routes (false: none).",
        ),
        "ferries": Key(Bool(), "Ferry routes.", "true"),
    }
)


def _region_rule(v: dict, path: KeyPath, ctx: Ctx) -> None:
    bounds, start = v.get("bounds"), v.get("start")
    if (
        isinstance(bounds, list)
        and len(bounds) == 4
        and all(_num(b) for b in bounds)
        and isinstance(start, dict)
        and _num(start.get("lon"))
        and _num(start.get("lat"))
    ):
        w, s, e, n = bounds
        if not (w <= start["lon"] <= e and s <= start["lat"] <= n):
            ctx.add(("start",), f"({start['lon']}, {start['lat']}) must lie inside bounds {bounds}")
    levels = v.get("levels")
    if isinstance(levels, list):
        names = [lv.get("name") for lv in levels if isinstance(lv, dict)]
        dupes = sorted({n for n in names if names.count(n) > 1 and isinstance(n, str)})
        if dupes:
            ctx.add(("levels",), f"level names must be unique ({', '.join(dupes)} repeated)")
        level = v.get("level")
        if isinstance(level, str) and names and level not in names:
            ctx.add(
                ("level",),
                f"'{level}' is not one of levels"
                + suggest(level, [n for n in names if isinstance(n, str)]),
            )


REGION = Map(
    {
        "id": Key(
            Str(
                pattern=r"[A-Za-z0-9][A-Za-z0-9_.-]*",
                pattern_doc="a plain id (letters, digits, - _ .)",
            ),
            "The package id: the directory it's built into (`fixtures/<id>`) and the "
            "viewer's `?world=/<id>/`.",
            required=True,
        ),
        "name": Key(Str(), "The world's name, shown in the viewer.", required=True),
        "extends": Key(
            Str(),
            "Another spec file (relative to this one) this one builds on: mappings "
            "merge key by key, anything else replaces, null removes a section.",
        ),
        "bounds": Key(BBOX, "The area in degrees: `[west, south, east, north]`.", required=True),
        "metersPerCell": Key(
            Num(0, lo_open=True, unit="m"),
            "Real metres per cell (uniform; a `warp` varies it).",
            required=True,
        ),
        "verticalExaggeration": Key(
            Num(0, lo_open=True), "Heights are drawn this many times true (1: real slopes).", "2.5"
        ),
        "maxSlope": Key(
            Num(1, 3, integer=True),
            "The steepest slope tile, in height steps per cell; steeper ground "
            "becomes terraces and cliffs.",
            "2",
        ),
        "chunkSize": Key(Num(8, 1024, integer=True), "Cells per package chunk side.", "64"),
        "style": Key(
            Str(),
            "The style pack that draws it: a directory of `worlds/_styles/` "
            "(`desert-southwest`, `bay-area`).",
            required=True,
        ),
        "start": Key(
            Map(
                {
                    "lon": Key(LON, "Longitude.", required=True),
                    "lat": Key(LAT, "Latitude.", required=True),
                }
            ),
            "Where the viewer starts: `{ lon, lat }` inside bounds.",
            required=True,
        ),
        "sources": Key(SOURCES, "Where the data comes from.", required=True),
        "smoothing": Key(
            Map(
                {
                    "bilateralCells": Key(Num(0), "Edge-preserving smoothing radius (cells).", "0"),
                    "bilateralMeters": Key(
                        Num(0, unit="m"), "…across height differences up to this.", "0"
                    ),
                }
            ),
            "Smooth elevation before it's cut into steps (coarse worlds).",
        ),
        "geology": Key(
            Map(
                {
                    "default": Key(Str(), "The province everywhere else.", "`default`"),
                    "provinces": Key(ListOf(PROVINCE), "Areas with their own strata."),
                }
            ),
            "Geology provinces: which strata set cliffs show (the style pack's `provinces`).",
        ),
        "terrain": Key(
            Map(
                {
                    "minLakeArea": Key(Num(0, unit="m²"), "Smaller water bodies are dropped.", "0"),
                    "maxLakeRelief": Key(
                        Num(0, unit="m"), "Water whose ground spans more than this isn't a lake."
                    ),
                    "riverWidthMeters": Key(
                        Num(0, lo_open=True, unit="m"), "Rivers drawn this wide."
                    ),
                    "cliffSlope": Key(
                        Num(0, lo_open=True), "Cells steeper than this (rise over run) are rock."
                    ),
                }
            ),
            "Rules for water and cliffs.",
        ),
        "micro": Key(
            Map(
                {
                    "k": Key(
                        Num(2, 8, integer=True),
                        "Micro-cells per cell side: 2, 4 or 8.",
                        required=True,
                    ),
                    "dem": Key(
                        Map(
                            {
                                "kind": Key(Str(), "Another terrain source.", "`sources.dem.kind`"),
                                "overview": Key(
                                    SOURCE["overview"].type,
                                    SOURCE["overview"].doc,
                                    "`sources.dem.overview`",
                                ),
                                "resampling": DEM.keys["resampling"],
                            }
                        ),
                        "Overrides `sources.dem` for the micro-terrain (usually a finer overview).",
                    ),
                    "smooth": Key(
                        MapOf(Str(surface_names), Num(0, unit="m"), "mapping of surface → metres"),
                        "Smooth these surfaces' micro-terrain over this many metres.",
                    ),
                },
                rule=lambda v, p, c: (
                    c.add((*p, "k"), f"must be 2, 4 or 8, not {v['k']}")
                    if _num(v.get("k")) and v["k"] not in (2, 4, 8)
                    else None
                ),
            ),
            "Micro-terrain: finer heights inside each cell.",
        ),
        "render": Key(
            Map(
                {
                    "scale": Key(
                        Num(0, 1, lo_open=True),
                        "A cell's size on screen relative to a normal one.",
                        required=True,
                    ),
                    "tileSize": Key(Num(1, integer=True), "Cells per baked tile side.", "32"),
                }
            ),
            "Draw a fine world smaller on screen.",
        ),
        "warp": Key(
            OneOf((is_str, Str()), (is_map, WARP), name="a file, or a mapping"),
            "An elastic map: magnify focus areas over a background scale. Usually a "
            "file of its own (`warp: warp.yaml`), which the editor writes.",
        ),
        "level": Key(Str(), "This spec's level, one of `levels`."),
        "levels": Key(ListOf(LEVEL), "Every scale level of the region (each its own package)."),
        "snap": Key(SNAP, "Isometric snapping of roads and buildings to the 8 grid directions."),
        "widths": Key(WIDTHS, "Draw ways at their real width (else at the style's fixed width)."),
        "ground": Key(
            Map(
                {
                    "lawn": Key(LAWN, "Parks, golf courses, pitches and gardens."),
                    "yard": Key(YARD, "Open ground beside houses."),
                }
            ),
            "Ground surfaces from land use (lawns, yards).",
        ),
        "objects": Key(OBJECTS, "Buildings, vegetation, street furniture and landmarks."),
        "routes": Key(ROUTES, "Ambient traffic routes."),
    },
    rule=_region_rule,
)


# ---- checks that need more than the spec ------------------------------------------------

STYLES_DIRNAME = "_styles"


def styles_dir(spec_path: Path | None) -> Path | None:
    """The nearest `_styles` directory at or above the spec's directory."""
    if spec_path is None:
        return None
    for d in [spec_path.parent, *spec_path.parent.parents]:
        cand = d / STYLES_DIRNAME
        if cand.is_dir():
            return cand
    return None


def repo_styles_dir() -> Path | None:
    """worlds/_styles of the repository checkout the pipeline runs from, if any."""
    repo = Path(__file__).resolve().parents[3]
    cand = repo / "worlds" / STYLES_DIRNAME
    return cand if cand.is_dir() and (repo / "pipeline" / "pyproject.toml").is_file() else None


def style_packs(root: Path) -> list[str]:
    return sorted(p.name for p in root.iterdir() if (p / "style.json").is_file())


def _check_style(raw: dict, ctx: Ctx) -> None:
    style = raw.get("style")
    if not isinstance(style, str):
        return
    near = styles_dir(ctx.spec_path)
    root = near or repo_styles_dir()
    if root is None:
        return
    known = style_packs(root)
    if style in known:
        return
    msg = f"no style pack '{style}' in {root}{suggest(style, known)} (there: {', '.join(known)})"
    if near is None:
        # a style pack of your own: the nearest _styles/ above the spec comes first
        msg += f"; a pack of your own goes in a {STYLES_DIRNAME}/ directory beside the spec"
    ctx.add(("style",), msg)


def _check_landmarks(raw: dict, ctx: Ctx) -> None:
    from .landmarks import registry_dir

    entries = ((raw.get("objects") or {}).get("landmarks")) or []
    if not isinstance(entries, list) or ctx.spec_path is None:
        return
    root = registry_dir(ctx.spec_path)
    for i, e in enumerate(entries):
        ref = e if isinstance(e, str) else (e.get("id") if isinstance(e, dict) else None)
        if not isinstance(ref, str) or (isinstance(e, dict) and "group" in e):
            continue
        if root is None:
            ctx.add(
                ("objects", "landmarks", i),
                f"'{ref}' needs a landmark registry "
                "(a `_landmarks/` directory beside or above the spec)",
            )
            continue
        if not (root / f"{ref}.yaml").is_file():
            known = sorted(p.stem for p in root.glob("*.yaml"))
            ctx.add(
                ("objects", "landmarks", i), f"no landmark '{ref}' in {root}{suggest(ref, known)}"
            )


def _check_size(raw: dict, ctx: Ctx) -> None:
    bounds, mpc = raw.get("bounds"), raw.get("metersPerCell")
    if not (
        isinstance(bounds, list)
        and len(bounds) == 4
        and all(_num(b) for b in bounds)
        and _num(mpc)
        and mpc > 0
    ):
        return
    w, s, e, n = bounds
    if not (w < e and s < n):
        return
    km_x = (e - w) * 111.32 * math.cos(math.radians((s + n) / 2))
    km_y = (n - s) * 110.57
    cells = (km_x * 1000 / mpc) * (km_y * 1000 / mpc)
    if cells > 4_000_000 and not raw.get("warp"):
        ctx.add(
            ("metersPerCell",),
            f"{km_x:.0f} × {km_y:.0f} km at {mpc:g} m per cell is about {cells / 1e6:.0f} million "
            "cells: expect a long build and a large package "
            "(raise metersPerCell, or shrink bounds)",
            "warning",
        )


def validate(
    raw: Any,
    *,
    spec_path: Path | None = None,
    lines: Lines | None = None,
    show_file: bool = True,
) -> list[Issue]:
    """Every problem with a resolved region spec (after `extends:` and `warp:`
    files are read, before landmark ids are expanded): unknown keys, missing
    required keys, wrong types and values out of range, a start outside the
    bounds, unknown style packs and landmarks. Errors first, then warnings.
    `spec_path` places the spec (style packs and landmarks are found from it);
    `show_file=False` (a spec given as a dict) leaves it out of the messages."""
    ctx = Ctx(lines, Path(spec_path) if spec_path else None, show_file)
    if isinstance(raw, dict) and not ({"id", "bounds", "sources"} & raw.keys()):
        # a file that isn't a region spec: say what it is rather than list every key
        if raw.keys() & {"background", "focus", "pins"}:
            ctx.add((), "this is a warp file (a region spec names it: `warp: <file>`)")
            return ctx.issues
        if raw.keys() & {"depictions", "anchor", "line"}:
            ctx.add((), "this is a landmark registry file (a region spec names it by id)")
            return ctx.issues
    REGION.check(raw, (), ctx)
    if isinstance(raw, dict):
        _check_style(raw, ctx)
        _check_landmarks(raw, ctx)
        _check_size(raw, ctx)
    return sorted(ctx.issues, key=lambda i: (i.level != "error", str(i.file or ""), i.line or 0))


# ---- the reference ----------------------------------------------------------------------


def _sections(t: Type, path: str, out: list[tuple[str, Map]]) -> None:
    """Mappings to document, depth first: (dotted path, mapping)."""
    if isinstance(t, Map):
        out.append((path, t))
        for k, key in t.keys.items():
            _sections(key.type, f"{path}.{k}" if path else k, out)
    elif isinstance(t, ListOf):
        _sections(t.item, f"{path}[]", out)
    elif isinstance(t, OneOf):
        for _, alt in t.alts:
            _sections(alt, path, out)


def _type_cell(t: Type, path: str, documented: set[str]) -> str:
    name = t.name
    if isinstance(t, Map) or (isinstance(t, ListOf) and isinstance(t.item, Map)):
        target = path if isinstance(t, Map) else f"{path}[]"
        if target in documented:
            name = f"[{name}](#{_anchor(target)})"
    if isinstance(t, OneOf):
        maps = [alt for _, alt in t.alts if isinstance(alt, Map)]
        if maps and path in documented:
            name = f"[{name}](#{_anchor(path)})"
    return name


def _anchor(path: str) -> str:
    return "spec-" + re.sub(r"[^a-z0-9]+", "-", path.lower()).strip("-")


def reference() -> str:
    """The spec reference in Markdown: a table per mapping, every key with its
    type, default and meaning. docs/worlds.md holds this text."""
    sections: list[tuple[str, Map]] = []
    _sections(REGION, "", sections)
    seen: set[str] = set()
    unique = []
    for path, m in sections:
        if path in seen:
            continue
        seen.add(path)
        unique.append((path, m))
    lines = []
    for path, m in unique:
        if path and not m.keys:
            continue
        title = f"`{path}`" if path else "Top level"
        lines.append(f'<a id="{_anchor(path or "top")}"></a>')
        lines.append(f"#### {title}")
        lines.append("")
        if m.options:
            lines.append(f"Other keys here are {m.options}.")
            lines.append("")
        lines.append("| Key | Type | Default | Meaning |")
        lines.append("|---|---|---|---|")
        for k, key in m.keys.items():
            sub = f"{path}.{k}" if path else k
            default = "**required**" if key.required else (key.default or "—")
            doc = key.doc.replace("|", "\\|")
            lines.append(f"| `{k}` | {_type_cell(key.type, sub, seen)} | {default} | {doc} |")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


BEGIN = (
    "<!-- spec-reference: generated by `pixelworld reference --write docs/worlds.md` "
    "(pipeline/src/pixelworld_pipeline/schema.py); don't edit it here -->"
)
END = "<!-- spec-reference: end -->"


def splice(doc: str, ref: str) -> str:
    """`doc` with the text between the reference markers replaced by `ref`."""
    a, b = doc.index(BEGIN) + len(BEGIN), doc.index(END)
    return doc[:a] + "\n\n" + ref + "\n" + doc[b:]
