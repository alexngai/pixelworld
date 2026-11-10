---
"pixelworld": minor
---

Level switches no longer hang when a layer moves to a new view (bakes settle on destroy; layers and controllers belong to one view at a time), and the view gains game time (`paused`, `timeScale`, `started`, `time`: `dt` is 0 until the first complete frame), `camera.project` (world → canvas CSS pixels), baking ahead (`prefetch`, `isDrawn`, `lookAhead`), controller state in `serialize()`, and landmark plans in `objectsAt`. `FrameEvent.dt` is now game time; `realDt` is the wall clock.
