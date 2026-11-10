"""San Francisco's city pack for the pixelworld pipeline: the first city pack,
and the template for others (docs/plugins.md).

It registers, through entry points:
- the `datasf` facts source (`pixelworld.facts`): DataSF's assessor roll and
  parcels, giving each building its year built, storeys, use, property class
  and neighbourhood (datasf.DataSFFacts).
"""

from .datasf import ATTRIBUTION, DataSFFacts, ParcelFacts

__all__ = ["ATTRIBUTION", "DataSFFacts", "ParcelFacts"]
