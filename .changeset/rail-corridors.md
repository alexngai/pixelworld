---
"pixelworld": minor
---

Rail corridors (D-097): a world package's chunks may carry the centre lines of rail corridors (optional sections `TSG0`–`TSG5`, `TerrainLayers.railSeg`) with each corridor cell's track count in the `RAIL` layer's bits 8–10, and the micro-terrain bake draws a corridor's tracks side by side along its line, on one ballast bed. Packages without them draw as before.
