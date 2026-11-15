---
"pixelworld": patch
---

A world package may let steeper micro-cells slope (`micro.maxSlope` in its manifest, micro-steps, 3 or more): micro-cells up to that steep are drawn as planes through their corners rather than flat terraces, so sheer walls read as faces. `microCellCorners` and `emptyMicro` take it; without it micro-terrain is drawn as before.
