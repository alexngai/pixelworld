---
name: Bug report
about: Something renders, runs or builds wrongly
labels: bug
---

**What happened**

<!-- What you saw, and what you expected instead. A screenshot helps for anything drawn. -->

**How to see it**

<!--
The steps, or the viewer URL that shows it, e.g.
http://localhost:5173/?world=/sf/&at=-122.4327,37.7760&zoom=3&rot=0&hud=0
For a pixel that looks wrong, `__pixelworld.inspect(x, y)` in the console (or Alt+click) says what drew it.
For a baking problem, check whether it persists with `cache=0` in the URL.
-->

**Where**

- Commit: <!-- git rev-parse --short HEAD -->
- Part: <!-- viewer, game, editor, pipeline, npm package, model preview -->
- Browser and GPU (rendering problems): <!-- e.g. Chrome 140, the renderer line from the HUD (H) -->
- OS, Node and Python versions (build and pipeline problems):

**Logs**

<!-- Console errors, the HUD's error line, or the failing command's output. -->
