---
"pixelworld": minor
---

Instanced objects draw their one-pixel lines too (each variant's lines a batch of their own), and `meshLines` places a model's lines as `meshVoxels` places its voxels. The built-in `streetLight` and `trafficSignal` take `lines: 1` (with `reach`): a slender mast whose arm curves out to the lamp, and a pole with a mast arm over the street and a three-lamp head, in one-pixel lines. Off by default: without it they draw as before.
