"""The plugin registry: facts sources, source adapters and stage hooks, by name.

A region spec names what it needs (`sources.dem.kind: usgs-3dep-13arcsec`,
`objects.typology.facts: datasf`), and the pipeline looks each name up here.
Names come from three places, the first that has a name winning:

1. **Registered in this process** with `register()` (tests, scripts, notebooks).
2. **Installed packages' entry points**, in one group per kind of plugin:
   - `pixelworld.facts`: per-building facts sources. The entry point names a
     factory, `factory(region, options)`, usually a `FactsSource` subclass
     (facts.py).
   - `pixelworld.sources`: source adapters, of role `terrain` or `landcover`.
     The entry point names a `RasterSource` instance, or a class to
     instantiate (sources/rasters.py).
   - `pixelworld.stages`: build hooks. Reserved: nothing loads them yet.

   A plugin package declares them in its pyproject.toml:

       [project.entry-points."pixelworld.facts"]
       datasf = "pixelworld_city_sf.datasf:DataSFFacts"

3. **Built in**: USGS 3DEP elevation and ESA WorldCover land cover.

A name nobody provides raises PluginNotFoundError, whose message lists what is
installed and, for the city packs we know, which package to install. See
docs/plugins.md.
"""

from __future__ import annotations

import functools
import importlib
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from importlib import metadata
from typing import Any

FACTS = "pixelworld.facts"
SOURCES = "pixelworld.sources"
STAGES = "pixelworld.stages"
GROUPS = {FACTS: "facts source", SOURCES: "source adapter", STAGES: "stage hook"}

# Shipped with the pipeline, as "module:attribute" (loaded on first use).
BUILTIN: dict[str, dict[str, str]] = {
    FACTS: {},
    SOURCES: {
        "usgs-3dep-1arcsec": "pixelworld_pipeline.sources.rasters:USGS_3DEP_1ARCSEC",
        "usgs-3dep-13arcsec": "pixelworld_pipeline.sources.rasters:USGS_3DEP_13ARCSEC",
        "esa-worldcover-2021": "pixelworld_pipeline.sources.rasters:ESA_WORLDCOVER_2021",
    },
    STAGES: {},
}

# Plugins published from this repository: the hint a missing name's error gives.
KNOWN: dict[tuple[str, str], str] = {
    (FACTS, "datasf"): "pixelworld-city-sf",
    (FACTS, "pluto"): "pixelworld-city-nyc",
    (FACTS, "apur"): "pixelworld-city-paris",
    (SOURCES, "ign-rgealti"): "pixelworld-city-paris",
    (SOURCES, "ign-lidar-hd-mnt"): "pixelworld-city-paris",
    (FACTS, "plateau"): "pixelworld-city-jp",
    (SOURCES, "gsi-dem"): "pixelworld-city-jp",
}

_registered: dict[str, dict[str, Any]] = {g: {} for g in GROUPS}
_MISSING = object()


class PluginError(LookupError):
    """A plugin that can't be used: missing, ambiguous, or of the wrong kind."""


class PluginNotFoundError(PluginError):
    """No plugin by that name: the message lists the installed ones (of `role`,
    for source adapters) and says which package to install where it knows."""

    def __init__(
        self,
        group: str,
        name: str,
        available: list[str],
        where: str | None = None,
        role: str | None = None,
    ):
        self.group, self.name, self.available, self.where = group, name, available, where
        what = f"{role} source" if role else GROUPS.get(group, group)
        at = f" (named by {where})" if where else ""
        have = ", ".join(available) if available else "none"
        lines = [
            f"no {what} named '{name}'{at}.",
            f"Installed {what}s: {have}.",
        ]
        dist = KNOWN.get((group, name))
        if dist:
            lines.append(
                f"'{name}' comes with the {dist} package: install it (pip install {dist}; "
                "in this repository, `uv sync` in pipeline/ installs it)."
            )
        else:
            lines.append(
                f"Install a package that provides it (entry point group '{group}'), "
                "or register one with pixelworld_pipeline.plugins.register()."
            )
        lines.append("See docs/plugins.md.")
        super().__init__(" ".join(lines))


@dataclass(frozen=True)
class Plugin:
    """Where a name comes from: `registered`, `builtin`, or an installed distribution."""

    group: str
    name: str
    origin: str
    ref: str  # "module:attribute", or repr() of a registered object


@functools.cache
def _entry_points(group: str) -> tuple[metadata.EntryPoint, ...]:
    """Installed entry points of a group, read once per process (see refresh)."""
    return tuple(metadata.entry_points(group=group))


def refresh() -> None:
    """Forget the installed entry points read so far (after installing a plugin)."""
    _entry_points.cache_clear()


def _dist_name(ep: metadata.EntryPoint) -> str:
    dist = getattr(ep, "dist", None)
    return dist.name if dist is not None else "unknown distribution"


def _installed(group: str) -> dict[str, metadata.EntryPoint]:
    """Entry points by name; two distributions offering one name is an error."""
    out: dict[str, metadata.EntryPoint] = {}
    for ep in _entry_points(group):
        if ep.name in out and out[ep.name].value != ep.value:
            raise PluginError(
                f"{GROUPS.get(group, group)} '{ep.name}' is provided by both "
                f"{_dist_name(out[ep.name])} ({out[ep.name].value}) and "
                f"{_dist_name(ep)} ({ep.value}); uninstall one of them"
            )
        out[ep.name] = ep
    return out


def _check_group(group: str) -> None:
    if group not in GROUPS:
        raise ValueError(f"unknown plugin group '{group}' (one of {', '.join(GROUPS)})")


def available(group: str) -> dict[str, Plugin]:
    """Every name in a group, sorted, with where it comes from."""
    _check_group(group)
    out: dict[str, Plugin] = {}
    for name, ref in BUILTIN[group].items():
        out[name] = Plugin(group, name, "builtin", ref)
    for name, ep in _installed(group).items():
        out[name] = Plugin(group, name, _dist_name(ep), ep.value)
    for name, obj in _registered[group].items():
        out[name] = Plugin(group, name, "registered", repr(obj))
    return dict(sorted(out.items()))


def names(group: str) -> list[str]:
    return list(available(group))


def _import(ref: str) -> Any:
    module, _, attr = ref.partition(":")
    obj: Any = importlib.import_module(module)
    for part in attr.split(".") if attr else []:
        obj = getattr(obj, part)
    return obj


def load(group: str, name: str, *, where: str | None = None) -> Any:
    """The object a plugin name stands for (a class, an instance or a function),
    from the first of: registered, installed entry points, built in."""
    _check_group(group)
    if not isinstance(name, str) or not name:
        raise PluginError(f"a {GROUPS[group]} name must be a non-empty string, got {name!r}")
    if name in _registered[group]:
        return _registered[group][name]
    installed = _installed(group)
    try:
        if name in installed:
            return installed[name].load()
        if name in BUILTIN[group]:
            return _import(BUILTIN[group][name])
    except ImportError as e:
        origin = _dist_name(installed[name]) if name in installed else "the pipeline"
        raise PluginError(f"{GROUPS[group]} '{name}' (from {origin}) failed to import: {e}") from e
    raise PluginNotFoundError(group, name, names(group), where)


def register(group: str, name: str, obj: Any, *, replace: bool = False) -> None:
    """Make `name` resolve to `obj` in this process, ahead of installed plugins."""
    _check_group(group)
    if name in _registered[group] and not replace:
        raise PluginError(f"{GROUPS[group]} '{name}' is already registered")
    _registered[group][name] = obj


def unregister(group: str, name: str) -> None:
    _check_group(group)
    _registered[group].pop(name, None)


@contextmanager
def registered(group: str, name: str, obj: Any) -> Iterator[Any]:
    """`register()` for the length of a `with` block (tests); restores what was there."""
    _check_group(group)
    before = _registered[group].get(name, _MISSING)
    _registered[group][name] = obj
    try:
        yield obj
    finally:
        if before is _MISSING:
            _registered[group].pop(name, None)
        else:
            _registered[group][name] = before


def spec_plugins(raw_or_region: Any) -> list[tuple[str, str, str]]:
    """The plugins a region spec names, as (group, name, where): checked before a
    build starts, so a missing one fails in a second rather than minutes in."""
    from .facts import facts_ref

    get = (
        raw_or_region.get
        if isinstance(raw_or_region, dict)
        else lambda k, d=None: getattr(raw_or_region, k, d)
    )
    out: list[tuple[str, str, str]] = []
    sources = get("sources") or {}
    for key in ("dem", "landcover"):
        kind = (sources.get(key) or {}).get("kind")
        if kind:
            out.append((SOURCES, str(kind), f"sources.{key}.kind"))
    micro_dem = ((get("micro") or {}).get("dem") or {}).get("kind")
    if micro_dem:
        out.append((SOURCES, str(micro_dem), "micro.dem.kind"))
    ref = facts_ref((get("objects") or {}).get("typology") or {})
    if ref is not None:
        out.append((FACTS, ref[0], "objects.typology.facts"))
    return out


def check(raw_or_region: Any) -> None:
    """Load every plugin a region spec names; raises PluginError for the first
    that is missing or of the wrong kind."""
    from .sources.rasters import source as raster_source

    for group, name, where in spec_plugins(raw_or_region):
        if group == SOURCES:
            role = "landcover" if where == "sources.landcover.kind" else "terrain"
            raster_source(name, role, where=where)
        else:
            load(group, name, where=where)
