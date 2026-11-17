---
"pixelworld": minor
---

Engine: `view.cutDown(Map<object, height>)` draws placed objects cut down to a height, as a cutaway (D-159): what's above isn't drawn and the inside of their far walls shows dark, as solid; only the drawing changes, and the tiles they reach bake again without meshing again. `BakeOptions.cut` in the bake.
