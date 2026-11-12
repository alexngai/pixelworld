"""Data sources by name: the registry, and the base every source shares (D-110).

Everything a build reads from outside comes from a *source* with a *role*.
A region spec selects one per role under `sources:`, by name, with the
source's own options beside it:

    sources:
      dem:        { kind: gsi-dem, overview: 4 }
      landcover:  { kind: esa-worldcover-2021 }
      features:   { kind: overture, release: 2026-10-21.0 }
      facts:      { kind: plateau, year: 2025 }
      canopy:     { kind: meta-chm }                # the default
      heights:    { kind: usgs-3dep-lidar, project: USGS_LPC_… }
      importance: { kind: wikidata }                # the default

Each role has a contract, a base class in the module that consumes it:

| role | spec key | contract |
|---|---|---|
| terrain | `sources.dem`, `micro.dem` | sources/rasters.py `RasterSource` |
| landcover | `sources.landcover` | sources/rasters.py `RasterSource` |
| features | `sources.features` | sources/features.py `FeatureSource` |
| facts | `sources.facts` | facts.py `FactsSource` |
| canopy | `sources.canopy` | sources/canopy.py `CanopySource` |
| heights | `sources.heights` | sources/lidar.py `HeightSource` |
| importance | `sources.importance` | importance.py `ImportanceSource` |

A name stands for an instance of one of them, used as it is, or a class,
which the pipeline calls as `cls(region, options)`: `options` is the spec
block without `kind` and the pipeline's own keys (`overview`, `resampling`).
Names come from three places, the first that has a name winning:

1. **Registered in this process** with `register()` (tests, scripts, notebooks).
2. **Installed packages' entry points**, group `pixelworld.sources`:

       [project.entry-points."pixelworld.sources"]
       my-dem = "my_package.dem:MyDEM"

3. **Built in** (BUILTIN).

`pixelworld.stages` is reserved for build hooks; nothing loads them yet. See
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

SOURCES = "pixelworld.sources"
STAGES = "pixelworld.stages"
GROUPS = {SOURCES: "source", STAGES: "stage hook"}

# role → (its key under `sources:`, the kind used when the spec has none)
ROLES: dict[str, tuple[str, str | None]] = {
    "terrain": ("dem", None),
    "landcover": ("landcover", None),
    "features": ("features", None),
    "facts": ("facts", None),
    "canopy": ("canopy", "meta-chm"),
    "heights": ("heights", "usgs-3dep-lidar"),
    "importance": ("importance", "wikidata"),
}
# keys of a spec block that are the pipeline's, not the source's options
PIPELINE_KEYS = ("kind", "overview", "resampling")

_P = "pixelworld_pipeline"
# Shipped with the pipeline, as "module:attribute" (loaded on first use).
BUILTIN: dict[str, dict[str, str]] = {
    SOURCES: {
        # terrain
        "usgs-3dep-1arcsec": f"{_P}.sources.rasters:USGS_3DEP_1ARCSEC",
        "usgs-3dep-13arcsec": f"{_P}.sources.rasters:USGS_3DEP_13ARCSEC",
        "copernicus-glo30": f"{_P}.sources.rasters:COPERNICUS_GLO30",
        "copernicus-glo30-ground": f"{_P}.sources.rasters:COPERNICUS_GLO30_GROUND",
        "ign-rgealti": f"{_P}.sources.ign:RGE_ALTI",
        "ign-lidar-hd-mnt": f"{_P}.sources.ign:LIDAR_HD_MNT",
        "gsi-dem": f"{_P}.sources.gsi:GSI_DEM",
        # landcover
        "esa-worldcover-2021": f"{_P}.sources.rasters:ESA_WORLDCOVER_2021",
        # features
        "overture": f"{_P}.sources.overture:Overture",
        # facts
        "areas": f"{_P}.areas:AreaFacts",
        "datasf": f"{_P}.sources.datasf:DataSFFacts",
        "pluto": f"{_P}.sources.pluto:PlutoFacts",
        "apur": f"{_P}.sources.apur:ApurFacts",
        "plateau": f"{_P}.sources.plateau:PlateauFacts",
        # canopy, heights, importance
        "meta-chm": f"{_P}.sources.canopy:META_CHM",
        "usgs-3dep-lidar": f"{_P}.sources.lidar:USGSLidar",
        "wikidata": f"{_P}.importance:WIKIDATA",
    },
    STAGES: {},
}

_registered: dict[str, dict[str, Any]] = {g: {} for g in GROUPS}
_MISSING = object()


class Source:
    """The base of every source. Subclass the role's contract (see the module
    docstring), not this.

    role: what it provides (a key of ROLES).
    attribution: the manifest's entry (or entries, a list) for worlds that use
      it, {name, license, url}; read from the class, without opening the source.
    options_schema: the options it takes (schema.Key by name), for `pixelworld
      check` and the spec reference.
    """

    role: str = ""
    attribution: dict | list[dict] | None = None
    # the options it takes, as schema.Key by name: `pixelworld check` checks a spec's
    # against them before anything is fetched (None: it checks them itself when opened)
    options_schema: dict[str, Any] | None = None

    def __init__(self, region=None, options: dict[str, Any] | None = None):
        self.region = region
        self.options = dict(options or {})

    def summary(self) -> str:
        """What was read (a dataset and its vintage), for the build log."""
        return type(self).__name__


class PluginError(LookupError):
    """A plugin that can't be used: missing, ambiguous, or of the wrong kind."""


class PluginNotFoundError(PluginError):
    """No plugin by that name: the message lists the ones there are (of `role`,
    for a source)."""

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
        super().__init__(
            f"no {what} named '{name}'{at}. {what.capitalize()}s: {have}. "
            f"Install a package that provides it (entry point group '{group}'), or register "
            "one with pixelworld_pipeline.plugins.register(). See docs/plugins.md."
        )


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


def available(group: str = SOURCES) -> dict[str, Plugin]:
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


def names(group: str = SOURCES) -> list[str]:
    return list(available(group))


def _import(ref: str) -> Any:
    module, _, attr = ref.partition(":")
    obj: Any = importlib.import_module(module)
    for part in attr.split(".") if attr else []:
        obj = getattr(obj, part)
    return obj


def load(group: str, name: str, *, where: str | None = None) -> Any:
    """The object a plugin name stands for (a class or an instance), from the
    first of: registered, installed entry points, built in."""
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


def role_of(name: str) -> str:
    """The role of the source called `name` ('' if it has none or won't load)."""
    try:
        return getattr(load(SOURCES, name), "role", "") or ""
    except PluginError:
        return ""


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


# ---- sources by role ----------------------------------------------------------------------


def split_ref(ref: str | dict[str, Any], where: str | None = None) -> tuple[str, dict[str, Any]]:
    """(kind, options) of a spec block (`{kind, …options}`) or a bare name."""
    if isinstance(ref, str):
        return ref, {}
    if not isinstance(ref, dict) or not isinstance(ref.get("kind"), str) or not ref["kind"]:
        at = where or "a source"
        raise PluginError(f"{at} needs a `kind:` naming the source, got {ref!r}")
    return ref["kind"], {k: v for k, v in ref.items() if k not in PIPELINE_KEYS}


def load_source(role: str, kind: str, *, where: str | None = None) -> Any:
    """The class or instance the source `kind` stands for, checked to have `role`
    (nothing is opened: no download, no options)."""
    if role not in ROLES:
        raise ValueError(f"unknown source role '{role}' (one of {', '.join(ROLES)})")
    try:
        obj = load(SOURCES, kind, where=where)
    except PluginNotFoundError as e:
        same = [n for n in e.available if role_of(n) == role]
        raise PluginNotFoundError(SOURCES, kind, same, where, role) from None
    have = getattr(obj, "role", "") or ""
    if have != role:
        at = f" (named by {where})" if where else ""
        raise PluginError(
            f"source '{kind}'{at} is a {have or 'role-less'} source, not a {role} source"
        )
    return obj


def open_source(role: str, ref: str | dict[str, Any], region=None, *, where: str | None = None):
    """The source a spec block names for `role`, opened for the region: an
    instance as it is, a class called as `cls(region, options)`."""
    kind, options = split_ref(ref, where)
    obj = load_source(role, kind, where=where)
    if isinstance(obj, type):
        return obj(region, options)
    if options:
        at = f" (named by {where})" if where else ""
        raise PluginError(f"source '{kind}'{at} takes no options, got {', '.join(sorted(options))}")
    return obj


def spec_ref(region_or_sources: Any, role: str) -> str | dict[str, Any] | None:
    """What the spec selects for `role` (its block, or the role's default kind;
    None when it has neither)."""
    key, default = ROLES[role]
    sources = (
        region_or_sources
        if isinstance(region_or_sources, dict)
        else getattr(region_or_sources, "sources", None)
    ) or {}
    ref = sources.get(key)
    return ref if ref else default


def source(region, role: str):
    """The source the region's spec selects for `role`, opened (a PluginError if
    it selects none)."""
    key = ROLES[role][0]
    ref = spec_ref(region, role)
    if ref is None:
        raise PluginError(f"sources.{key} isn't set: name a {role} source (`kind:`)")
    return open_source(role, ref, region, where=f"sources.{key}")


def attribution(region, role: str) -> list[dict]:
    """The attribution entries of the source the spec selects for `role`, read
    from the plugin without opening it."""
    ref = spec_ref(region, role)
    if ref is None:
        return []
    key = ROLES[role][0]
    return entries(load_source(role, split_ref(ref)[0], where=f"sources.{key}").attribution)


def entries(attribution: dict | list[dict] | None) -> list[dict]:
    """An `attribution` (one entry, a list of them, or None) as a list."""
    if not attribution:
        return []
    return [attribution] if isinstance(attribution, dict) else list(attribution)


def spec_plugins(raw_or_region: Any) -> list[tuple[str, str, str]]:
    """The sources a region spec names, as (role, kind, where): checked before a
    build starts, so a missing one fails in a second rather than minutes in."""
    get = (
        raw_or_region.get
        if isinstance(raw_or_region, dict)
        else lambda k, d=None: getattr(raw_or_region, k, d)
    )
    sources = get("sources") or {}
    out: list[tuple[str, str, str]] = []
    for role, (key, _) in ROLES.items():
        ref = sources.get(key)
        if ref:
            kind = ref if isinstance(ref, str) else ref.get("kind")
            out.append((role, str(kind), f"sources.{key}.kind"))
    micro_dem = ((get("micro") or {}).get("dem") or {}).get("kind")
    if micro_dem:
        out.append(("terrain", str(micro_dem), "micro.dem.kind"))
    return out


def check(raw_or_region: Any) -> None:
    """Load every source a region spec names; raises PluginError for the first
    that is missing or of the wrong role."""
    for role, kind, where in spec_plugins(raw_or_region):
        load_source(role, kind, where=where)
