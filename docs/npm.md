# Using pixelworld from npm

pixelworld is one npm package, `pixelworld`, with an entry point per part (decision D3 in [library.md](library.md#6-decisions)). This guide covers installing it, drawing a world in a page, where worlds and style packs come from, the bake worker, plugins, and how a release is made. The engine's API is in [library.md §7](library.md#7-as-built-the-engine-m4-step-1); the full reference is built with `pnpm docs:api` (§8).

## 1. Install

```sh
npm install pixelworld        # or pnpm add, yarn add
```

- **ESM only,** with TypeScript declarations and source maps. TypeScript needs `"moduleResolution": "bundler"`, `"node16"` or `"nodenext"`, which read the package's `exports`.
- **No dependencies:** everything the package needs is bundled in.
- **Browsers** need WebGL2 and module workers: every current desktop and mobile browser has both.

## 2. A world in a page

```html
<canvas id="world" style="width: 100vw; height: 100vh; image-rendering: pixelated"></canvas>
```

```ts
import { createWorldView, roverController } from "pixelworld/engine";

const canvas = document.querySelector<HTMLCanvasElement>("#world")!;
const view = await createWorldView({
  canvas,
  worldUrl: "/worlds/grand-canyon-m0/",                                   // a world package (§4)
  style: (id) => fetch(`/styles/${id}/style.json`).then((r) => r.json()), // the style pack its manifest names
  controller: roverController({ listen: { keys: window, pointer: canvas } }),
});
await view.ready(); // a complete frame is drawn
```

Arrows drive the rover, WASD or a drag pans, Q/E rotate, 1–6 zoom. From here a page uses the view: `view.camera.lookAt({ lon, lat })`, `view.entities.add(...)`, `view.query.heightAt(x, y)`, `view.query.pick(screenX, screenY)` and the rest of [library.md §7](library.md#7-as-built-the-engine-m4-step-1).

**Traffic** is a layer, for worlds whose packages have routes (San Francisco and the Southwest):

```ts
import { trafficLayer } from "pixelworld/traffic";

const view = await createWorldView({
  canvas,
  worldUrl: "/worlds/sf/",
  style: bayArea, // worlds/_styles/bay-area/style.json
  layers: [trafficLayer()],
});
view.layers.enable("traffic", false); // and back on with true
```

Working projects, each built and run against the packed package in CI: [examples/consumers/](../examples/consumers/) (Vite, webpack 5, plain ESM, and a CDN).

## 3. Entry points

| Import | What | Gzipped, as a consumer bundles it |
|---|---|---|
| `pixelworld/engine` | `createWorldView`; the camera, layers, entities, controllers and queries; `roverController`, `fogLayer`, `listenTo` | 72 KB for `createWorldView` |
| `pixelworld/traffic` | `trafficLayer()` and the deterministic simulation (D-060) | +8 KB beside the engine |
| `pixelworld/format` | the world package format: manifest, chunk and objects codecs, the geo grid, PNG decoding | 3 KB for `parseManifest` and `decodeChunk` |
| `pixelworld/grid` | the projection, rotations, cells, corner heights, road and rail bits | 0.2 KB for `project` |
| `pixelworld/style` | style packs: validation, palettes, materials, night and atmosphere | |
| `pixelworld/generators` | voxel models, meshing, terrain fields, object building and the generators | |
| `pixelworld/bake.worker.js` | the bake worker script, for copying it (§5) | 52 KB (145 KB minified) |

- **Everything** (all six entry points) is 87 KB gzipped (D3 estimated 89 KB).
- **Shared code is shared:** the entry points are built together with code splitting, so an app importing `pixelworld/engine` and `pixelworld/traffic` gets one copy of what they have in common (one generator registry, one set of classes).
- **Tree-shaking:** the package declares no side effects but the worker's, so a bundler keeps only what an app uses: `pixelworld/grid` doesn't bring the engine, and `pixelworld/engine` doesn't bring traffic.
- **What the engine always brings:** all the generators (the engine draws entities' models) and the baker, for the main-thread fallback (§5).

## 4. Worlds and style packs

Neither is in the package. Both are data with their own licences.

**World packages** are directories of static files: `manifest.json`, `chunks/*.pxwc`, and optional objects, routes, heroes and a geo grid ([world-format.md](world-format.md)).
- **Hosting:** any static host. Pass the directory's URL as `worldUrl`. A world on another origin needs CORS headers (`Access-Control-Allow-Origin`), since the engine fetches it.
- **Where they come from:** build your own with the pipeline (`pixelworld build region.yaml`, [README](../README.md)), or copy one of the repository's [fixtures](../fixtures/): `grand-canyon-m0` (116 KB) is the smallest, `sf` and `southwest` are the large ones. The consumer examples copy `grand-canyon-m0`.
- **Licence:** world packages are ODbL 1.0, as databases derived from OpenStreetMap and Overture. Each manifest's `attribution` lists its sources; show them (the viewer's I key does), and credit them under images of a world.

**Style packs** are JSON: palette ramps, surfaces, materials, assets, night and atmosphere ([style-guide.md](style-guide.md)).
- **Choosing one:** a manifest names its pack (`"style": "desert-southwest"`). `style` takes the pack itself (an imported JSON module, say) or a resolver from that name, which can fetch it.
- **Where they come from:** the repository's [`worlds/_styles/`](../worlds/_styles/) (`bay-area` for San Francisco, `desert-southwest` for the Southwest and the Grand Canyon). They will be published as their own packages (D3); until then copy the JSON. They are CC BY 4.0: credit "pixelworld style packs, by The pixelworld contributors".

## 5. The bake worker

The engine bakes tiles in a WebGL2 module worker, `dist/bake.worker.js`, shipped beside it. It starts it with

```js
new Worker(new URL("./bake.worker.js", import.meta.url), { type: "module" })
```

kept literal in the built engine, so each kind of consumer finds it by itself:

| Setup | What happens | Configuration |
|---|---|---|
| **Vite** (dev and build) | the dev server serves the worker from `node_modules`, pre-bundled deps included; a build emits it as `assets/bake.worker-<hash>.js` | none |
| **webpack 5** | sees the pattern and emits the worker as a chunk of its own | none |
| **Plain ESM** from your origin (an import map, or files you host) | the browser resolves the URL beside `engine.js` | none |
| **A CDN** (jsDelivr, esm.sh, unpkg) or other origin | browsers start workers only from the page's origin, so the default can't start | `workerUrl` |
| **Anything else** (a bundler that drops the worker, a strict CSP) | | `workerUrl` |

**`workerUrl`** loads the worker from where you say. Copy the script to your site, and pass its URL:

```ts
// copy node_modules/pixelworld/dist/bake.worker.js (also exported as "pixelworld/bake.worker.js") to /static/
await createWorldView({ canvas, worldUrl, style, workerUrl: "/static/bake.worker.js" });
```

For the package from a CDN, start the worker from a `blob:` URL, which is the page's, and import the CDN's worker in it (CDNs serve it with CORS):

```ts
const cdn = "https://cdn.jsdelivr.net/npm/pixelworld@0.1/dist/";
const { createWorldView } = await import(`${cdn}engine.js`);
const workerUrl = URL.createObjectURL(new Blob([`import "${cdn}bake.worker.js";`], { type: "text/javascript" }));
await createWorldView({ canvas, worldUrl, style, workerUrl });
```

- **The fallback:** if the worker can't start, or can't get WebGL2 (an `OffscreenCanvas` without it), the engine bakes on the main thread. Pages keep working, but frames stutter while tiles bake.
- **Checking:** `view.stats().bakeMode` is `"worker"` or `"inline"`, and `renderer` names the GPU the worker got.
- **CSP:** the worker needs `worker-src 'self'` (and `blob:` for the CDN recipe).

## 6. Plugins

- **City packs** add a city's generators (San Francisco's facades, towers and Chinatown, D4) to what the engine draws. They run inside the bake worker, where the engine loads them. How to write one and load it into a view: [plugins.md](plugins.md).
- **Packaging matters for them:** the published worker is one self-contained file with its own copy of the generators. A plugin registers through what the worker's plugin loader hands it, not by importing `pixelworld/generators` (that would be another copy, which the worker doesn't read).
- **Runtime layers and controllers** are plain objects implementing `Layer` and `Controller` from `pixelworld/engine` ([library.md §7.3, §7.5](library.md#73-layers)); they need no registration.
- **Pipeline plugins** (sources and facts, in Python) are the pipeline's: [plugins.md](plugins.md).

## 7. In this repository

- **The package:** `packages/pixelworld`. Its `src/` re-exports the workspace packages (`@pixelworld/engine`, `@pixelworld/sim` and the rest), which stay private TypeScript sources. In the workspace its `exports` point at `src/`, so apps, examples, vitest and `pnpm typecheck` use source as before; `publishConfig.exports` points the packed manifest at `dist/`.
- **The build:** `pnpm package:build` (also run by `pnpm pack`) runs `packages/pixelworld/build.mjs`: tsup over esbuild, one split ESM build of the six entry points with bundled declarations, then the worker as one minified file. It checks the worker literal, the entry files, and that nothing imports a private package. See [library.md §3.5](library.md#35-publishing).
- **The checks**, each also in CI's npm package job:

| Command | Checks |
|---|---|
| `pnpm package:check` | packs the package and checks the tarball: its files, manifest, `exports`, the worker literal, the licences, and size budgets (tarball, unpacked, JS, worker) |
| `pnpm package:size` | size-limit: what a consumer bundles from each entry point, gzipped, and the worker ([`.size-limit.json`](../packages/pixelworld/.size-limit.json)) |
| `pnpm package:consumers` | packs, then builds and runs the [consumer examples](../examples/consumers/) in headless Chromium, and checks the worker baked their tiles |
| `pnpm docs:api` | the API reference |

## 8. API reference

`pnpm docs:api` builds the TypeDoc reference of the six entry points into `docs/api/` (git-ignored); open `docs/api/index.html`. Its source links point at `main` on GitHub.

## 9. Releases

Publishing is manual: CI builds, packs and checks on every push, and holds no tokens.

**With each change** to what the package ships, add a changeset: `pnpm changeset`, pick `pixelworld` and a bump (patch or minor before 1.0), and write a line for the changelog. Commit the file it writes in `.changeset/`.

**To release `pixelworld`** (a maintainer with npm rights, from a clean `main`):

```sh
pnpm install --frozen-lockfile
pnpm changeset version          # bumps packages/pixelworld/package.json, writes its CHANGELOG.md
git commit -am "Release pixelworld $(node -p 'require("./packages/pixelworld/package.json").version')"
pnpm check && pnpm package:check && pnpm package:size && pnpm package:consumers
cd packages/pixelworld
pnpm publish --access public    # prepack builds dist/; asks for your npm 2FA code
git tag "pixelworld@$(node -p 'require("./package.json").version')" && git push --follow-tags
```

- **Publish with pnpm, not npm:** only pnpm applies `publishConfig.exports`. A tarball packed by npm would point at TypeScript sources it doesn't contain; `pnpm package:check` catches it.
- **Check first:** `pnpm pack` writes the tarball `pnpm publish` would upload; `node tools/pack-check.mjs pixelworld-x.y.z.tgz` and `node tools/consumers.mjs --tarball pixelworld-x.y.z.tgz` check it.

**The Python distributions** (`pixelworld-pipeline` and the city pack `pixelworld-city-sf`) are released by hand too. Bump the versions, build, check, then upload the pipeline first, since the city pack depends on it:

```sh
cd pipeline
uv version --bump minor                                   # pixelworld-pipeline
uv version --bump minor --package pixelworld-city-sf
uv build --all-packages --out-dir dist                    # sdists and wheels of both
uv run --no-project --isolated --with dist/pixelworld_pipeline-*.whl \
  --with dist/pixelworld_city_sf-*.whl pixelworld plugins   # the wheels alone: lists datasf
uv publish dist/pixelworld_pipeline-*                     # token from UV_PUBLISH_TOKEN or a prompt
uv publish dist/pixelworld_city_sf-*
```

Extras (`[lidar]`, `[cityjson]`, library.md §3.5) and a PyPI release job are later work.
