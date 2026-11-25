---
"pixelworld": minor
---

Engine: `view.bakeTopDown(x0, y0, x1, y1, { px?, tilt?, shadows? })` bakes a rectangle of the world from above, north up, once (D-155): its terrain, roads and placed objects (but those the edits removed), shaded and outlined as the tiles are, as RGBA in the day palette and as the baked indices. `paletteImage(image, palette)` colours any baked image. The bake's projection is now a parameter (`BakeOptions.projection`, `ISO_PROJECTION`, `topDownProjection`).
