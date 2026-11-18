---
"pixelworld": minor
---

Engine: `view.cutGhost` (0–1, default 0) shows the buildings cut down (`cutDown`, D-159) faintly where they stood in front, by blending their plain tiles over the frame in its palette pass (D-160): a cutaway that keeps the sense of the solid buildings. `view.setCutGhostMask(image)` gives the opacity pixel by pixel, from an image the app paints (D-161), with no tile baked again.
