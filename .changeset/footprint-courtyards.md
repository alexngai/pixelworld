---
"pixelworld": patch
---

Footprints can have courtyards: an object instance's optional `fh` (rings of cells, stored relative to its anchor as `fp` is) is left out of its footprint mask (`footprintMask(fp, voxel, holes)`), so a building round a courtyard is drawn round it.
