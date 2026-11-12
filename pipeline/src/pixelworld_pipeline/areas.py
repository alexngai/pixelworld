"""The `areas` facts source (D-107): facts from the spec itself, by
neighbourhood box, for places with no building records. Each building in an
area gets the area's name as its `hood`, and its typical height for buildings
Overture gives no height or floors; `use` if the area sets one.

    objects:
      typology:
        facts:
          plugin: areas
          areas:   # first match wins
            - { hood: Mong Kok, bounds: [114.165, 22.315, 114.175, 22.325], floors: 7, use: mixed }
            - { hood: Tsim Sha Tsui, bounds: [[...], [...]], floors: 12 }

`bounds` is one lon/lat box (west, south, east, north) or a list of them.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from rasterio.warp import transform as transform_points

from .facts import FactsSource, FactsSpecError
from .typology import FLOOR_METERS


def _boxes(bounds) -> list[tuple[float, float, float, float]]:
    if bounds and isinstance(bounds[0], (int, float)):
        bounds = [bounds]
    out = []
    for b in bounds or []:
        if len(b) != 4 or not (b[0] < b[2] and b[1] < b[3]):
            raise FactsSpecError(f"areas: bounds must be [west, south, east, north], not {b!r}")
        out.append(tuple(float(v) for v in b))
    return out


def _inside(x: float, y: float, boxes) -> bool:
    return any(w <= x <= e and s <= y <= n for w, s, e, n in boxes)


class AreaFacts(FactsSource):
    attribution = None  # written in the spec, not read from a dataset

    def __init__(self, region, options: dict[str, Any] | None = None):
        super().__init__(region, options)
        self.areas = []
        for a in self.options.get("areas") or []:
            facts = {"hood": str(a["hood"])} if a.get("hood") else {}
            if a.get("floors"):
                facts["height"] = float(a["floors"]) * FLOOR_METERS
            if a.get("use"):
                facts["use"] = str(a["use"])
            self.areas.append((_boxes(a.get("bounds")), facts))
        if not self.areas:
            raise FactsSpecError("objects.typology.facts: the areas source needs `areas:`")

    def at(self, xs: np.ndarray, ys: np.ndarray) -> list[dict | None]:
        if len(xs) == 0:
            return []
        lon, lat = transform_points(self.region.crs, "EPSG:4326", list(xs), list(ys))
        out: list[dict | None] = []
        for x, y in zip(lon, lat, strict=True):
            hit = next((f for boxes, f in self.areas if _inside(x, y, boxes)), None)
            out.append(dict(hit) if hit is not None else None)
        return out

    def summary(self) -> str:
        return f"{len(self.areas)} areas from the spec"
