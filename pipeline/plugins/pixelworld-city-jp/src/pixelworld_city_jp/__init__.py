"""Japan's city pack for the pixelworld pipeline (docs/plugins.md), shared by
every Japanese city: Kyoto and Tokyo first.

It registers, through entry points:
- the `plateau` facts source (`pixelworld.facts`): MLIT's PLATEAU 3D city
  models, per building a footprint, measured height, storeys, year built,
  use, structure and a roof shape from the LoD2 roof surfaces
  (plateau.PlateauFacts);
- the `gsi-dem` terrain source (`pixelworld.sources`): GSI's elevation tiles,
  DEM1A (1 m) where flown, else DEM5A (5 m), else DEM10B (10 m)
  (gsi.GSIElevation).
"""

from .gsi import GSI_DEM, GSIElevation
from .plateau import ATTRIBUTION, FootprintFacts, PlateauFacts

__all__ = ["ATTRIBUTION", "GSI_DEM", "FootprintFacts", "GSIElevation", "PlateauFacts"]
