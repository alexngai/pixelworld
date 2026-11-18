---
"pixelworld": minor
---

Engine: `view.bakeSpriteTopDown(boxes, { px, sun })` bakes an entity model from above (D-164); `bakeTopDown` and the bake take a light direction of their own (`sun`, `BakeOptions.sun`), for short shadows from above.
