---
"pixelworld": minor
---

For games on a level: `readCells(query, rect)` reads a rectangle of the world's cells once (ground heights, water, what walls each cell and how high it stands, trees, surfaces, road classes), with A* paths (`findPath`, costs and the steepest step a game's own), straight lines walked (`lineClear`), lines of sight over the ground, buildings and canopies (`lineOfSight`), what an eye sees around it (`viewshed`), and edits applied (`setRemoved`, `followEdits`). `fogSampler(world, query)` gives the style's fog as a number at a place, height and time, as the fog layer draws it, on a server too. `veilLayer({ ramp })` darkens cells by a field the game sets (a fog of war), drawn like the fog pixel by pixel; fog passes now chain, one per layer, and a fog field may cover part of a world (`x0`, `y0`).
