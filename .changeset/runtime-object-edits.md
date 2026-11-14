---
"pixelworld": minor
---

Runtime world edits (D-124): `view.edits` (and `openWorld(…).edits`) take the level's placed objects out and put them back, by `ObjectHit.index`, as a log of ops a game can send and replay. The queries stop answering for removed objects at once; a view bakes again only the tiles they touch, keeping each old image on screen until its new one is ready, and caches edited tiles under their own key. `query.pickObject(x, y)` answers the placed object drawn under a canvas point.
