---
"pixelworld": minor
---

API simplification and package boundary cleanup:

- **Root entry point:** `pixelworld` now exports the common API (`createWorldView`, `openWorld`, `cameraController`, `roverController`, `fogLayer`, `steamLayer`, `veilLayer`, `trafficLayer`, and core types) alongside subpath exports.
- **Dedicated `pixelworld/boards` and `pixelworld/maps` subpaths:** Grid snapshots/pathing/LOS/viewshed (`readCells`, `Boards`, `cutBoard`, …) moved to `pixelworld/boards`, and 2D canvas map widgets (`Minimap`, `TopDownMap`, `viewOnGround`) moved to `pixelworld/maps`.
- **Auto-filtering `plugins`:** Passing `PluginDescriptor[]` to `createWorldView({ plugins })` now automatically selects only the plugins declared in the world's style pack.
- **Standalone `cameraController()`:** Free-camera pan/rotate/zoom controller extracted from `roverController()` without spawning an invisible rover entity.
- **Type-safe queries:** Split headless `WorldQuery` (returned by `openWorld()`) from screen-aware `ViewQuery extends WorldQuery` (`pick`, `pickObject` on `WorldView`).
- **Grouped `WorldViewOptions` and slimmer `WorldView`:** Grouped advanced options into `render?: { scale, objects, scatter, heroes }` and `baking?: { cache, startTiles, chunkBudgetMB, lookAhead, groundFirst, idleBake, workers, workerUrl, recordBakes }`; consolidated building cutaways and lone ghosts onto `view.cutaway` (`enabled`, `set`, `setGhosts`, `clear`) and hero/benchmark helpers onto `view.tools` (`bakeObject`, `tileBakes`, `timeFrames`).
- **Projection & veil improvements:** `createWorldView({ projection })` accepts `"iso" | "steep" | Projection`; `camera.screenDirToGrid(dx, dy, rotation?)` and `rayRise(projection)` avoid mutating camera state; `View` now supplies `rotation`, `projection`, `renderScale`, and `night` to every `ScreenPass` (fixing `VeilLayer` under `STEEP_PROJECTION`); `VeilLayer.below` is now mutable and accepted by `veil.set(rect, values, { below })`.
