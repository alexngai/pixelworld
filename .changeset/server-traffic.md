---
"pixelworld": minor
---

Traffic a game's server runs (D-126): `trafficLayer({ feed })` draws vehicles a feed gives each frame instead of its own simulation, and `SimOptions.routes` keeps a simulation to some routes, with cars leaving at their ends rather than turning back.
