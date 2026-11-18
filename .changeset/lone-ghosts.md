---
"pixelworld": minor
---

Engine: `view.setLoneGhosts([{ object, alpha }])` draws placed objects on their own over the finished frame, each at its opacity, far to near, where it stands in front of what's drawn (D-162): with `cutDown`, the buildings cut away shown faintly as themselves. Each is baked alone (`BakeService.bakeLone`) once a rotation.
