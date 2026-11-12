"""Facts sources: per-building facts from public records, for building
typologies (D-055).

A facts source is a source of role `facts` (plugins.py, docs/plugins.md) that
the region spec selects, with its options:

    sources:
      facts: { kind: datasf, rollYear: "2025" }

The pipeline opens it with the region and the options, and asks the source
for the facts at each building's projected centroid (`at`). Each answer is
None (no record there) or a dict with any of these keys:

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

import numpy as np

from . import plugins
from .region import RegionError

FACT_KEYS = ("year", "stories", "units", "use", "class", "hood", "roof", "material", "height")


class FactsSource(plugins.Source):
    """The contract of role `facts`.

    The pipeline opens it as `cls(region, options)` once per build, so the
    constructor is where data is fetched and indexed. Cache downloads under
    `pixelworld_pipeline.sources.http.cache_dir(<name>)`.
    """

    role = "facts"

    def at(self, xs: np.ndarray, ys: np.ndarray) -> list[dict | None]:
        """The facts at each point (projected metres in the region's CRS,
        `region.crs`), or None where the source has no record."""
        raise NotImplementedError


class FactsSpecError(RegionError):
    """A facts source's options that don't make sense."""


def open_facts(region):
    """The facts source the region's spec selects, opened (None without one)."""
    if plugins.spec_ref(region, "facts") is None:
        return None
    return plugins.source(region, "facts")


def describe(source) -> str:
    fn = getattr(source, "summary", None)
    return fn() if callable(fn) else type(source).__name__
