"""Paris's city pack for the pixelworld pipeline (docs/plugins.md).

It registers, through entry points:
- the `apur` facts source (`pixelworld.facts`): APUR's built footprints of
  Paris (construction period, height, roof form, urban fabric) joined to
  IGN's BD TOPO buildings (storeys, dwellings, use) and APUR's quartiers
  (apur.ApurFacts);
- two terrain sources (`pixelworld.sources`): IGN's RGE ALTI 1 m DTM
  (`ign-rgealti`) and its LiDAR HD 50 cm DTM (`ign-lidar-hd-mnt`), read from
  the Géoplateforme's WMS-Raster (ign.IGNElevation).
"""

from .apur import ATTRIBUTION, ApurFacts, FootprintFacts
from .ign import LIDAR_HD_MNT, RGE_ALTI, IGNElevation

__all__ = [
    "ATTRIBUTION",
    "LIDAR_HD_MNT",
    "RGE_ALTI",
    "ApurFacts",
    "FootprintFacts",
    "IGNElevation",
]
