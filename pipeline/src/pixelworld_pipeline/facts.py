"""Facts sources: per-building facts from public records, for building
typologies (D-055).

A facts source is a plugin (entry point group `pixelworld.facts`; see
plugins.py and docs/plugins.md) that a region's typology section names:

    objects:
      typology:
        facts: datasf                                  # by name
        facts: { plugin: datasf, rollYear: "2025" }    # by name, with options

The pipeline calls the plugin with the region and the options, and asks the
source for the facts at each building's projected centroid (`at`). Each
answer is None (no record there) or a dict with any of these keys:

    year      int | None  the year built (the original one)
    stories   float       storeys above ground
    units     float       dwelling units
    use       str         residential, mixed, commercial, industrial or civic,
                          or the source's own wording, which typology.use_group
                          maps to those
    class     str         the source's native building class code (PLUTO's
                          `bldgclass`, DataSF's property class, …), matched by
                          `classes:` rules
    hood      str         the neighbourhood, matched by `hoods:` rules
    roof      str         the roof shape in Overture's words (flat, gabled,
                          hipped, mansard, …), matched by `roofs:` rules
    material  str         the main facade material, matched by `materials:` rules
    height    float       the building's height in metres, for buildings Overture
                          gives no height or floors (D-084)

Other keys are kept and ignored.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from . import plugins
from .region import RegionError

FACT_KEYS = ("year", "stories", "units", "use", "class", "hood", "roof", "material", "height")
# keys of the typology section itself: anything else beside a bare `facts: name`
# is an option for the facts source (the older form, `rollYear:` beside `facts: datasf`)
TYPOLOGY_KEYS = ("facts", "rules", "roofHints")


class FactsSource:
    """Base class for facts sources; any object with `at` (and optionally
    `attribution` and `summary`) works.

    The registry's entry point names the class (or any factory): the pipeline
    calls it as `factory(region, options)` once per build, so the constructor
    is where data is fetched and indexed. Cache downloads under
    `pixelworld_pipeline.sources.http.cache_dir(<name>)`.
    """

    # the manifest's attribution entry (or entries) for worlds that use it; read
    # from the class, without building a source
    attribution: dict | list[dict] | None = None

    def __init__(self, region, options: dict[str, Any] | None = None):
        self.region = region
        self.options = dict(options or {})

    def at(self, xs: np.ndarray, ys: np.ndarray) -> list[dict | None]:
        """The facts at each point (projected metres in the region's CRS,
        `region.crs`), or None where the source has no record."""
        raise NotImplementedError

    def summary(self) -> str:
        """What was read (a dataset and its vintage), for the build log."""
        return type(self).__name__


class FactsSpecError(RegionError):
    """A typology section whose `facts:` isn't a name or a mapping with `plugin:`."""


def facts_ref(typology: dict[str, Any] | None) -> tuple[str, dict[str, Any]] | None:
    """(plugin name, options) from a typology section's `facts:`, or None."""
    ref = (typology or {}).get("facts")
    if ref is None or ref is False:
        return None
    if isinstance(ref, str):
        extra = {k: v for k, v in typology.items() if k not in TYPOLOGY_KEYS}
        return ref, extra
    if isinstance(ref, dict):
        if not isinstance(ref.get("plugin"), str) or not ref["plugin"]:
            raise FactsSpecError(
                "objects.typology.facts needs a plugin name: `facts: datasf` or "
                "`facts: { plugin: datasf, ...options }`"
            )
        return ref["plugin"], {k: v for k, v in ref.items() if k != "plugin"}
    raise FactsSpecError(f"objects.typology.facts must be a name or a mapping, not {ref!r}")


def factory(name: str):
    """The facts source plugin called `name` (its class or factory)."""
    return plugins.load(plugins.FACTS, name, where="objects.typology.facts")


def open_facts(region, typology: dict[str, Any] | None):
    """The facts source a typology section names, built for the region (None without one)."""
    ref = facts_ref(typology)
    if ref is None:
        return None
    name, options = ref
    return factory(name)(region, options)


def attribution(typology: dict[str, Any] | None) -> list[dict]:
    """The attribution entries of the facts source a typology section names
    (read from the plugin without fetching anything)."""
    ref = facts_ref(typology)
    if ref is None:
        return []
    got = getattr(factory(ref[0]), "attribution", None)
    if not got:
        return []
    return [got] if isinstance(got, dict) else list(got)


def describe(source) -> str:
    fn = getattr(source, "summary", None)
    return fn() if callable(fn) else type(source).__name__
