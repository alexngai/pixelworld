---
"pixelworld": minor
---

Voxel models can carry one-pixel lines (`VoxelModel.lines`, `model.line(a, b, material)`, in voxel coordinates) beside their voxels. The bake draws a unique object's lines as GL lines a native pixel wide at any angle, in their ramp's darkest shade, casting no shadow (`ObjectMeshes.lines`, a mesh with `primitive: "lines"`): something as thin as a wire stays thin.
