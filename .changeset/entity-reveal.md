---
"pixelworld": minor
---

Entities can see through what stands in front of them (`reveal: { margin?, density? }`): buildings and landmarks in front of the entity are dithered away within a margin of its sprite, over tiles baked a second time without them. Tall objects keep their tiles in view as far up as they reach, and the depth range holds their tops, so tall towers no longer go missing or sort wrongly at the view's edge.
