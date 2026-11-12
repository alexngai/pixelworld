---
"pixelworld": minor
---

`createWorldView`'s `startTiles` is opt-in: `true` reads `start-tiles.bin` in the world package, or pass the file's URL. A world without one no longer logs a 404.
