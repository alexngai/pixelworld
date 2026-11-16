---
"pixelworld": patch
---

The tile cache key's plugins part hashes each plugin module by its path, not its full URL: tiles baked for one host (start tiles prebaked on a build server) now match the same build served from another. Tiles already cached under a plugin are baked again once.
