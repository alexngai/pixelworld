---
"pixelworld": minor
---

Roads and paths can be drawn along their own centre lines (D-082): world packages built with `widths.centrelines` carry the stretches of centre line inside each cell (`TerrainLayers.roadSeg`, `pathSeg`), which the micro-terrain bake draws instead of the cells' connections, so streets at any angle run straight. Packages without them draw as before.
