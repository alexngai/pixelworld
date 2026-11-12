---
"pixelworld": minor
---

`openWorld({ worldUrl, style })` in `pixelworld/engine`: a world's queries without a view, canvas or GPU, for a game server or a bot that must agree with the players' views (it runs in Node). `EntitySpec.wait: false` for other players and effects: their sprite bakes no longer hold up `ready()` (D-111).
