---
"pixelworld": minor
---

Engine: terrain edits and boards at any resolution (D-147, D-148). `edits.cells([{ x, y, surface?, water?, height? }])` edits terrain cells as `remove` and `restore` edit objects: the queries answer with them at once, a server's `openWorld` too, and a view bakes the tiles they reach again, caching each under its edits. `WorldEdit` is now a union of the object ops and `{ op: "cells", cells }`. `query.object(index)` gives a placed object's data. `cutBoard` and `Boards` cut `Cells` from a world at any cell size and keep several to its edits; `followEdits` takes the queries to read cells again under terrain edits.
