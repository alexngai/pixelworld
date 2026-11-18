---
"pixelworld": minor
---

Engine: `cutDown`'s cuts are baked into a cutaway variant of each tile they reach, kept beside the plain tile, and `view.cutaway` (default true) says which shows, so turning the cutaway on and off is immediate (D-167). Runtime: `TileRequest.cutaway`.

`cutDown(cuts, rotation, { always: true })` keeps a second set of cuts, made in the plain tiles as well, whether the cutaway shows or not (D-168).
