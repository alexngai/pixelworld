---
"pixelworld": minor
---

Engine: `createWorldView({ projection })` lays the world out with another projection (D-195), fixed for the view's life: `ISO_PROJECTION` (2:1, the default) or `STEEP_PROJECTION`, a higher camera with 4:3 tiles. `camera.projection` and `FrameInfo.projection` give it. Tiles, sprites, picking, the see-through around a player, fog, steam and the minimap's outline of the view follow it; its tiles are cached apart from the 2:1 view's; painted-over hero landmarks are left out in any but the 2:1 view. `fogLayer({ followProjection })` thins the fog for a steeper camera. Grid: `Projection` and its presets, `project`, `projectView` and `unprojectAtHeight` take one (2:1 by default), `unprojectView`, `projectionInverse`, `groundInverse`, `sumUV` and `tileAspect`.
