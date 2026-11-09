# pixelworld

An interactive world built from real places and drawn as isometric pixel art in the browser. Geography is compressed and rearranged around recognizable landmarks, so you can drive from the Las Vegas Strip past Hoover Dam to the Grand Canyon in minutes, then fly through it.

**Status:** M1 (real region at uniform scale) is done. The whole US Southwest, about 410 × 280 km from Las Vegas to the Grand Canyon, is built from real elevation, land-cover and road data. It streams into the browser and is baked into isometric pixel art you can explore in 4 rotations with a placeholder rover. The M0 Grand Canyon slice is still available at `?world=/grand-canyon-m0/`.

![Grand Canyon South Rim, rotation 1](docs/images/m0-south-rim-r1.png)

## Run it

Requires Node 22+ and pnpm 10, plus a browser with WebGL2.

```sh
pnpm install
pnpm dev            # http://localhost:5173
```

| Input | Action |
|---|---|
| WASD / drag | pan |
| arrow keys | drive the rover (it can't climb cliffs or steep slopes, or enter water) |
| Q / E | rotate the view 90° |
| 1–6 | zoom |
| F | toggle camera follow |
| N | toggle no-clip |
| H | hide or show the HUD |

Press **I** for the data sources and licenses.

URL parameters, useful for repeatable views: `world` (package URL, default `/southwest/`), `rot`, `zoom`, `fx`/`fy` (focus cell), `rover=x,y`, `w`/`h` (fixed canvas size), `hud=0`, `cache=0` (skip the IndexedDB tile cache).

The viewer is built on the engine, `@pixelworld/engine`, which other games can build on too ([library.md §7](docs/library.md#7-as-built-the-engine-m4-step-1)). `pnpm example:minimal` runs the smallest client of it (http://localhost:5180): San Francisco, the rover and traffic, in about 45 lines. `pnpm --filter @pixelworld/game dev` runs M4's example game (http://localhost:5252): drive Las Vegas → Hoover Dam → the Grand Canyon, take off from a straight road and fly the canyon (H for keys; `?world=/sf/` starts on the Embarcadero, `?run=1` drives and flies the run by itself and reports its frame times).

## Install from npm

The engine, the world format, the generators and traffic are one npm package, `pixelworld`, ESM with types:

```sh
npm install pixelworld
```

```ts
import { createWorldView, roverController } from "pixelworld/engine";

const canvas = document.querySelector<HTMLCanvasElement>("#world")!;
const view = await createWorldView({
  canvas,
  worldUrl: "/worlds/grand-canyon-m0/",                                   // a world package, e.g. a copy of fixtures/grand-canyon-m0
  style: (id) => fetch(`/styles/${id}/style.json`).then((r) => r.json()), // its style pack, from worlds/_styles/
  controller: roverController({ listen: { keys: window, pointer: canvas } }),
});
```

It isn't published yet: `cd packages/pixelworld && pnpm pack` makes the tarball, which `npm install ./pixelworld-0.0.0.tgz` takes. Worlds and style packs are data you host; the bake worker works in Vite, webpack 5 and plain ESM without configuration. See [Using pixelworld from npm](docs/npm.md) and the [example consumers](examples/consumers/).

## Checks

```sh
pnpm check          # eslint + tsc + vitest
pnpm test:e2e       # Playwright golden images + behaviour tests (headless Chromium, SwiftShader)
pnpm package:check  # the npm package: pack it, check the tarball and its size budgets (also package:size, package:consumers)
cd pipeline && uv run ruff check . && uv run pytest
```

To measure tile bakes, frames and memory on your own GPU, run `pnpm bench` (it opens the benchmark page in your browser); see [Benchmarks](docs/architecture.md#benchmarks).

To rebuild the Southwest from its region spec (downloads are cached in `pipeline/.cache/`; about 20 s once cached):

```sh
cd pipeline && uv run pixelworld build ../worlds/southwest/region.yaml
```

To regenerate the M0 fixture (it fetches the USGS DEM and the OSM river):

```sh
cd pipeline && uv run python -m pixelworld_pipeline.fixtures.grand_canyon_m0
```

To make the terrain more or less dramatic, pass `--exaggeration E`. E is vertical exaggeration relative to true proportions: 1.0 is real slopes and the default is 2.5. `--max-slope K` (1–3, default 2) sets how steep a continuous slope tile can be before terrain turns into terraces and cliffs. See [fixtures/README.md](fixtures/README.md) to try a value without overwriting the committed fixture.

## Docs

Start with the [docs index](docs/README.md):

- [Architecture](docs/architecture.md)
- [Using pixelworld from npm](docs/npm.md)
- [Roadmap](docs/roadmap.md), including the M0 results
- [Style guide](docs/style-guide.md)
- [World format](docs/world-format.md)
- [Data sources and licensing](docs/data-sources.md)
- [Decision log](docs/decisions.md)

## Data attribution

Elevation: USGS 3D Elevation Program (public domain). River: © OpenStreetMap contributors (ODbL 1.0). See [fixtures/README.md](fixtures/README.md).

## License

pixelworld is open source:

- **Code** (TypeScript packages, apps, tools and the Python pipeline): licensed under either of the [MIT License](LICENSE-MIT) or the [Apache License 2.0](LICENSE-APACHE), at your option.
- **Style packs** (`worlds/_styles/`): [CC BY 4.0](worlds/_styles/LICENSE.md).
- **World packages** (`fixtures/`): [ODbL 1.0](fixtures/LICENSE.md), as databases derived from OpenStreetMap and Overture Maps. Each package's manifest lists its sources and their licences; see [data sources and licensing](docs/data-sources.md).

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in this project by you, as defined in the Apache-2.0 licence, shall be dual-licensed as above, without any additional terms or conditions.
