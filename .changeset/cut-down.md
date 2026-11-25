---
"pixelworld": minor
---

Engine: `view.cutDown(Map<object, height>)` draws placed objects cut down to a height, as a cutaway (D-159): what's above isn't drawn and the inside of their far walls shows dark, as solid; only the drawing changes, and the tiles they reach bake again without meshing again; cuts can be given per rotation of the view (`cutDown(cuts, rotation)`), so the tiles of the other rotations, baked while idle, keep theirs. `BakeOptions.cut` in the bake.
