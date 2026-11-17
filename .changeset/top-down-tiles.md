---
"pixelworld": minor
---

Engine: `TopDownMap` bakes the whole world from above in square tiles on demand (`tiles(x0, y0, x1, y1)`, `onChange`, `forget(rect)`), nearest first and a couple at a time, for maps that pan over a world (D-158); `bakeTopDown`'s `cache` option keeps its images with the view's tiles.
