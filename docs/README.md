# Pixelworld docs

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | The target architecture: grid, coordinate spaces, geo pipeline, warp, generators, baking, runtime, gameplay, repo layout |
| [roadmap.md](roadmap.md) | Technology choices, milestones with exit criteria, per-technology tracks, risks, open questions |
| [data-sources.md](data-sources.md) | Allowed and forbidden sources, how semantic layers are fused, coverage tiers, licensing, depiction policy |
| [library.md](library.md) | pixelworld as a library: packages, the engine API, extension points, the export tool, publishing, licences and the decisions taken |
| [npm.md](npm.md) | Using pixelworld from npm: install, a world in a page, entry points and sizes, worlds and style packs, the bake worker, plugins, releases |
| [second-region.md](second-region.md) | Research: which cities have open data for a San Francisco-grade world, and the adapters each would need |
| [cities.md](cities.md) | Places to build: every place built, in progress or proposed, what open data each has, and a shortlist (iconic places with strong data, and the global-data path for those without) |
| [worlds.md](worlds.md) | Make your own world: from a place to a rendered world (Jerome, Arizona, as the example), checking, building and viewing it, and the reference of every region spec key |
| [plugins.md](plugins.md) | Writing pipeline plugins: facts sources, source adapters, the registry's entry points, the city pack layout, the Python API |
| [decisions.md](decisions.md) | Decision log: what we decided, why, and whether it's settled |
| [style-guide.md](style-guide.md) | The art rules every baked pixel follows: palette, light, materials, outlines, dithering |
| [world-format.md](world-format.md) | World package format v0: manifest and chunk binary layout |
| [viewer.md](viewer.md) | The viewer's keys, every URL parameter, the `__pixelworld` debug API (`inspect`), and the model preview page |
| [tactics/](tactics/README.md) | Hold the Block, the tactics game: its design docs (the map survey: finding good boards across a city) |

To work on the code, start with [CONTRIBUTING.md](../CONTRIBUTING.md): setup, a map of the repo, the checks, golden images and the debugging tools.

How to keep these useful:

- `architecture.md` describes what we're building toward. Keep it current rather than historical.
- Any change to a decision gets a new entry in `decisions.md`. Old entries are marked superseded, never rewritten.
- Format and style specs live here next to the architecture doc.
