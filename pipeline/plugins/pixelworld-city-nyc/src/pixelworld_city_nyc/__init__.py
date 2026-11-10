"""New York City's city pack for the pixelworld pipeline (docs/plugins.md).

It registers, through entry points:
- the `pluto` facts source (`pixelworld.facts`): NYC Open Data's building
  footprints joined to PLUTO tax lots and the Landmarks Preservation
  Commission's building database, giving each building its year built,
  storeys, units, use, building class, facade material and neighbourhood
  (pluto.PlutoFacts).
"""

from .pluto import ATTRIBUTION, FootprintFacts, PlutoFacts

__all__ = ["ATTRIBUTION", "FootprintFacts", "PlutoFacts"]
