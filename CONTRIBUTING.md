# Contributing to pixelworld

How to set up, find your way round, run the checks CI runs, test a change, and record it. The [README](README.md) says what pixelworld is; [docs/](docs/README.md) says how it works.

## 1. Setup

- **Node 22.12 or later** (`.nvmrc`: `nvm use`) and **pnpm 10** (`corepack enable` picks the version in `package.json`).
- **Python 3.12 or later and [uv](https://docs.astral.sh/uv/)**, for the pipeline only (`pipeline/`).
- **Playwright's Chromium**, for the e2e tests. They render with SwiftShader (software WebGL2), so no GPU is needed.

```sh
pnpm install
pnpm exec playwright install chromium   # once; on a fresh Linux machine: --with-deps chromium
(cd pipeline && uv sync)                 # pipeline work only
pnpm dev                                 # the viewer, http://localhost:5173
```

The committed world packages in `fixtures/` are served as they are, so the viewer shows a world with no data step. Without a GPU (software WebGL), the first view takes 30 s or more to bake; later loads come from the tile cache (§6).

## 2. Where things live

| Path | What it is |
|---|---|
| `packages/grid` | Coordinates, the isometric projection, rotations, the cell model |
| `packages/world-format` | World package codecs: manifest, chunks, objects, geo grid (the Python writer is in `pipeline/`) |
| `packages/style` | Style pack validation, the palette, the shader's material tables |
| `packages/generators` | Terrain meshes, the built-in object generators (`builtins.ts`, `trees.ts`, `landmarkKit.ts`, `vehicleModels.ts`), the generator registry and plugin API, scatter |
| `packages/city-sf` | San Francisco's city pack, browser half: its generators (rowhouses, towers, Chinatown) as a plugin (D-071) |
| `packages/bake` | The WebGL2 baker: shadow, G-buffer and composite passes (`shaders.ts`), `BAKE_VERSION` |
| `packages/runtime` | Chunk streaming, the tile cache, the bake worker and service, the compositor, fog fields (internal to the engine) |
| `packages/engine` | The public world view: `createWorldView`, layers, entities (the rover), controllers, queries |
| `packages/sim` | Ambient traffic: routes, the simulation, vehicle models, the traffic layer |
| `packages/multiplayer` | Optional multiplayer (D-112–D-114): rooms on a WebSocket server (relayed, or a game the server runs at a fixed tick), prediction, smoothing other players into entities, serving a built game. Demos in `src/demos/`: the dogfight, on the example game's plane |
| `packages/pixelworld` | The npm package `pixelworld`: entry points over the packages above ([docs/npm.md](docs/npm.md)) |
| `apps/web` | The viewer (URL parameters, HUD, the `__pixelworld` debug API), the model preview (`model.html`), the bench (`bench.html`) |
| `apps/editor` | Editor v0: focus areas and pins against `pixelworld serve` |
| `apps/game` | M4's example game: a car and a plane on the engine's public API |
| `examples/` | The minimal viewer, and the npm package's consumers (Vite, webpack 5, plain ESM) |
| `pipeline/` | The Python geo pipeline and its CLI (`pixelworld build`, `serve`, `routes`); `pipeline/src/pixelworld_pipeline/sources/` holds every data source, the city ones too (D-110) |
| `worlds/` | Region specs, style packs (`worlds/_styles/<pack>/style.json`), the landmark registry with hero bakes and paint-overs |
| `fixtures/` | The committed world packages the viewer and tests use ([fixtures/README.md](fixtures/README.md)) |
| `e2e/` | Playwright tests and their golden images (`e2e/__screenshots__/`) |
| `tools/` | Headless tools: the e2e server, the hero bake, the bench, the package checks |
| `docs/` | Architecture, decisions, roadmap, specs ([docs/README.md](docs/README.md)) |

**Where to change what you see:**

- **A colour:** a ramp in the style pack, `worlds/_styles/<pack>/style.json` (style rules: [docs/style-guide.md](docs/style-guide.md)). To find which ramp drew a pixel, `__pixelworld.inspect(x, y)` or Alt+click in the viewer (§7).
- **A building's, tree's or vehicle's shape:** the style pack's `assets[group].generator` names the generator; built-ins are in `packages/generators/src/`, San Francisco's in `packages/city-sf/src/`. Look at it alone with `pnpm models` (§7).
- **Light, shadows, outlines, terrain patterns:** `packages/bake/src/shaders.ts`.
- **What stands where** (which group, footprint, height): the pipeline, `pipeline/src/pixelworld_pipeline/` (`objects.py`, `typology.py`), and a rebuilt package.
- **The rover, the camera, layers:** `packages/engine/src/`; traffic: `packages/sim/src/`; the viewer's keys and HUD: `apps/web/src/main.ts`.

## 3. The checks, as CI runs them

`.github/workflows/ci.yml` is the source of truth; these are its jobs' steps. Every pull request and push to `main` runs `web`, `pipeline` and the e2e smoke subset, about 10 minutes of runner time. The full e2e suite and the npm package's consumers run on demand, about 75 minutes: `gh workflow run ci.yml --ref <branch>`, for a change to rendering, the game or what a package ships, and before a release.

```sh
# web: lint, typecheck, unit tests (together: pnpm check)
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test

# web-e2e-smoke: the tests tagged @smoke
pnpm exec playwright install --with-deps chromium
pnpm test:e2e:smoke

# web-e2e (on demand): the whole Playwright suite (on CI in four shards, --shard=1/4 … 4/4)
pnpm test:e2e

# package (on demand, and on the "Version packages" pull request): the npm packages (pack, tarball contents and size budgets, API docs, consumers)
pnpm package:check && pnpm package:size && pnpm docs:api && pnpm package:consumers

# pipeline
cd pipeline && uv sync && uv run ruff check . && uv run ruff format --check . && uv run pytest
```

`pnpm check` takes about 20 s. The full e2e suite takes 15 to 20 minutes in software rendering on four cores; run what covers your change (§4) and let CI run the rest.

## 4. Running some of the tests

- **One unit-test package or file:** `pnpm test packages/generators`, `pnpm test packages/generators/test/buildings.test.ts`; one test by name: `pnpm test -t "steps tall towers back"`; watch mode: `pnpm exec vitest packages/generators`.
- **One pipeline test:** `cd pipeline && uv run pytest tests/test_objects.py -k footprint`.
- **One e2e test:** `pnpm test:e2e -g "Las Vegas at 2"` (a title's part), or a file: `pnpm test:e2e e2e/model.spec.ts`. `--last-failed` re-runs the failures.
- **The slow tests:** `pnpm test:e2e:slow`, the tests tagged `@slow`: the game's changes of map (take-off and landing, any vehicle on any map). CI leaves them out, since a 2-core runner takes eight to nine times as long as a desktop; run them when you change the game, its levels or how a view replaces another.
- **The smoke subset:** `pnpm test:e2e:smoke`, the tests tagged `@smoke` (2 to 3 minutes): the M0 and Las Vegas goldens, San Francisco's walking level, the sources screen, the pixel inspector, the model preview, the editor and the game.
- **Which spec covers what:** `render.spec.ts`, the viewer's goldens and behaviour (terrain and rotations, the Southwest, scale levels, hero landmarks, San Francisco, traffic, fog); `inspect.spec.ts`, the pixel inspector; `model.spec.ts`, the model preview; `editor.spec.ts`, the editor against a mocked pipeline server; `game.spec.ts`, the example game.
- **Reports:** a run writes `playwright-report/`; `pnpm exec playwright show-report` opens it, with each failed golden's expected, actual and diff images.

**Ports.** A run starts three dev servers, all on ports from `PW_PORT` (default 5199): the viewer on `PW_PORT`, the editor on `PW_PORT − 1`, the game on `PW_PORT − 2` (`PW_EDITOR_PORT` and `PW_GAME_PORT` override those two). To run beside another checkout, give each its own: `PW_PORT=5261 pnpm test:e2e`.

- **No silent reuse:** a server already on one of those ports fails the run. `PW_REUSE=1` reuses servers that are up, and only if they serve this checkout: `tools/e2e-server.mjs` marks every response with its checkout, and `e2e/global-setup.ts` checks it. To keep a server between runs: `node tools/e2e-server.mjs web 5199`, then `PW_REUSE=1 pnpm test:e2e -g "…"`.
- **Workers:** one by default, since software rendering takes every core it gets; `PW_WORKERS=2` for more.

## 5. Golden images

The renderer's goldens are in `e2e/__screenshots__/<spec>/<name>.png`, made in headless Chromium with SwiftShader (the config forces it), never on a GPU: GPU rasterization differs between devices.

- **A golden fails:** open the report (`pnpm exec playwright show-report`), or the files in `test-results/<test>/`: `*-expected.png`, `*-actual.png` and `*-diff.png`. The message gives the share of pixels that differ (the tolerance is 0.2%).
- **The change is intended:** update only the goldens it touches, after looking at them: `pnpm test:e2e -g "<title>" --update-snapshots`.
- **Review the diff:** `git status e2e/__screenshots__` lists what changed; compare old and new side by side (`git show HEAD:e2e/__screenshots__/render.spec.ts/<name>.png > /tmp/old.png`, or GitHub's image diff in the pull request). Every changed pixel should be one the change explains.
- **Say why:** the commit and the pull request name each updated golden and what changed in it. A golden that changes without a reason is a bug.

## 6. The tile cache

The viewer keeps baked tiles in IndexedDB between visits, keyed by what they are baked from: the world package, the style pack, a hash of the code that bakes tiles, and the plugins loaded with a hash of their code (D-072). A tile whose key matches comes from the cache without being baked, so an edit to a generator, a city pack or the baker shows on the next reload by itself (the dev servers compute the hash with `tools/bake-code.mjs`'s Vite plugin); an edit elsewhere (the compositor, the camera, the HUD) reloads from the cache in about a second.

- **`?cache=0`** bakes every tile fresh and reads nothing from the cache. Use it to be sure every tile on screen comes from the code as it is now, for timings, or if a change doesn't show (and then tell us: the key should have caught it). The HUD's `bake` line says how many tiles were baked and how many came from the cache.
- **To clear the cache,** clear the site's data in the browser's developer tools (Application, Storage).
- The e2e tests open every view with `cache=0`, except the one that tests the cache.

## 7. Debugging tools

- **The debug API,** `window.__pixelworld` in the viewer: `ready()`, `stats()`, `lookAt()`, `setRover()`, `inspect()`, traffic and fog controls and more. Every function, and every URL parameter, is in [docs/viewer.md](docs/viewer.md).
- **What is this pixel?** `__pixelworld.inspect(x, y)` (or Alt+click) gives the pixel's ramp and shade, where the style pack uses that ramp, the ground under it, and the placed object drawn there with its asset group, generator, plugin and landmark id.
- **One model alone:** `pnpm models` opens the model preview: an asset group's models from a style pack, any seeds, footprints and heights, in four rotations, by day and night, re-baked on every save ([docs/viewer.md §4](docs/viewer.md#4-the-model-preview-pnpm-models)).
- **Repeatable views:** `hud=0&cache=0&ground=0&w=640&h=360&traffic=0&fog=0` and a place (`rover=`, `at=`, `fx=`/`fy=`) fix a scene; `objects=0`, `paint=0`, `palette=night` isolate a change.
- **Performance:** `pnpm bench` (your GPU) or `pnpm bench:headless` ([docs/architecture.md, Benchmarks](docs/architecture.md#benchmarks)).

## 8. Decisions and the roadmap

- **A decision** (a format, an architecture choice, a rule the art follows, a trade-off someone will ask about) gets an entry at the end of [docs/decisions.md](docs/decisions.md): `### D-0xx: <what was decided> (<status>, <milestone>)`, then bullets with bold lead-ins: why, what, the rejected alternatives, what's left for later. Add its row to the index table at the top. Never rewrite an old entry: mark it **Superseded by D-0xx** and add a new one. Cite the number in code comments where the decision shows (`// D-060`).
- **The roadmap** ([docs/roadmap.md](docs/roadmap.md)) has a section per milestone. When work finishes, update its milestone: what was done, measured results, what's left.
- **[docs/architecture.md](docs/architecture.md)** describes what we're building toward; keep it current rather than historical.

## 9. Changesets and commits

- **Changesets:** a change to what the npm package `pixelworld` ships (the code under `packages/` it bundles: grid, world-format, style, generators, bake, runtime, engine, sim) needs a changeset: run `pnpm changeset`, pick `pixelworld` and a bump (patch or minor before 1.0), write one line for the changelog, and commit the file it adds in `.changeset/`. Apps, examples, the pipeline, docs and tests don't need one. Releases: [docs/npm.md §9](docs/npm.md#9-releases).
- **Commits:** one logical change each. The subject names the area, then the change, without a full stop: `Generators: palms lean away from the road`, `e2e: …`, `Docs: D-077, …`, `Pipeline: …`. The body says why, in short bullets where there are several points, with the decision number if there is one, and names any golden it updates.
- **Pull requests:** the template asks for the checks you ran, the goldens you changed and why, and the changeset and decision if needed.

## Licence

Contributions are dual-licensed as the [README](README.md#license) says: code under MIT or Apache-2.0, style packs under CC BY 4.0, world packages under the ODbL.
