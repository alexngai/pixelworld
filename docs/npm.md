# Using pixelworld from npm

pixelworld is one npm package, `pixelworld`, with an entry point per part (decision D3 in [library.md](library.md#6-decisions)). This guide covers installing it, drawing a world in a page, where worlds and style packs come from, the bake worker, plugins (city packs, packages of their own such as San Francisco's `@pixelworlds/city-sf`), and how a release is made. The engine's API is in [library.md §7](library.md#7-as-built-the-engine-m4-step-1); the full reference is built with `pnpm docs:api` (§8).

## 1. Install

```sh
npm install pixelworld        # or pnpm add, yarn add
```

- **ESM only,** with TypeScript declarations and source maps. TypeScript needs `"moduleResolution": "bundler"`, `"node16"` or `"nodenext"`, which read the package's `exports`.
- **No dependencies:** everything the package needs is bundled in.
- **Browsers** need WebGL2 and module workers: every current desktop and mobile browser has both.
- **San Francisco** also needs its city pack, which draws its buildings: `npm install @pixelworlds/city-sf` (§6). Without it, San Francisco bakes almost nothing.
- **An unreleased change:** pack both from a checkout of the repository and install the tarballs:

  ```sh
  pnpm install && pnpm --filter pixelworld --filter @pixelworlds/city-sf pack --pack-destination /tmp/pw
  npm install /tmp/pw/*.tgz    # in your project: both tarballs
  ```

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

**Traffic** is a layer, for worlds whose packages have routes (San Francisco and the Southwest). San Francisco's buildings come from its city pack, a plugin the view loads (§6):

```ts
import { trafficLayer } from "pixelworld/traffic";
import { cityPlugin } from "@pixelworlds/city-sf";

const view = await createWorldView({
  canvas,
  worldUrl: "/worlds/sf/",
  style: bayArea, // worlds/_styles/bay-area/style.json
  plugins: [cityPlugin], // San Francisco's generators: its rows, towers and Chinatown
  layers: [trafficLayer()],
});
view.layers.enable("traffic", false); // and back on with true
```

Working projects, each built and run against the packed packages in CI: [examples/consumers/](../examples/consumers/) (Vite, webpack 5, plain ESM, and a CDN). Each draws the Grand Canyon slice, and San Francisco with its city pack (`?world=sf-fly`).

## 3. Entry points

| Import | What | Gzipped, as a consumer bundles it |
|---|---|---|
| `pixelworld/engine` | `createWorldView`; the camera, layers, entities, controllers and queries; `roverController`, `fogLayer`, `listenTo` | 75 KB for `createWorldView` |
| `pixelworld/traffic` | `trafficLayer()` and the deterministic simulation (D-060) | +8 KB beside the engine |
| `pixelworld/format` | the world package format: manifest, chunk and objects codecs, the geo grid, PNG decoding | 3 KB for `parseManifest` and `decodeChunk` |
| `pixelworld/grid` | the projection, rotations, cells, corner heights, road and rail bits | 0.2 KB for `project` |
| `pixelworld/style` | style packs: validation, palettes, materials, night and atmosphere | |
| `pixelworld/generators` | voxel models, meshing, terrain fields, object building and the generators | |
| `pixelworld/bake.worker.js` | the bake worker script, for copying it (§5) | 46 KB (129 KB minified) bundled; 61 KB as shipped (§7) |
| `pixelworld/style-pack.v1.schema.json` | the style pack JSON Schema, for a pack's `"$schema"` in editors ([style guide](style-guide.md) §18) | |

- **Everything** (all six entry points, nothing tree-shaken) is 96 KB gzipped (D3 estimated 89 KB). It grew with style pack validation (D-075), contained model failures (D-072) and the game API (D-073); an app that draws a world bundles 75 KB of it.
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
- **Writing or changing one:** point its `"$schema"` at `./node_modules/pixelworld/dist/style-pack.v1.schema.json` (relative to the pack) for completion and checks in your editor. A variant can `"extends": "<pack id>"` and list only what changes; a resolver then loads the parent by id ([style guide](style-guide.md) §18).

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
const cdn = "https://cdn.jsdelivr.net/npm/pixelworld@0.0.0/dist/";
const { createWorldView } = await import(`${cdn}engine.js`);
const workerUrl = URL.createObjectURL(new Blob([`import "${cdn}bake.worker.js";`], { type: "text/javascript" }));
await createWorldView({ canvas, worldUrl, style, workerUrl });
```

- **The fallback:** if the worker can't start, or can't get WebGL2 (an `OffscreenCanvas` without it), the engine bakes on the main thread. Pages keep working, but frames stutter while tiles bake.
- **Checking:** `view.stats().bakeMode` is `"worker"` or `"inline"`, and `renderer` names the GPU the worker got.
- **CSP:** the worker needs `worker-src 'self'` (and `blob:` for the CDN recipe).

## 6. Plugins

- **City packs** add a city's generators to what the engine draws (D4). They run inside the bake worker, where the engine loads them. A world's style pack names the ones it needs (`"plugins"`), and a view that lacks one can't bake the tiles holding that pack's buildings.
- **San Francisco's** is `@pixelworlds/city-sf` (its facades, towers and Chinatown; `pixelworld` is its peer dependency). Pass its descriptor to the view, or let the style choose among the packs a page has:

  ```ts
  import { cityPlugin } from "@pixelworlds/city-sf";

  await createWorldView({ canvas, worldUrl: "/worlds/sf/", style, plugins: [cityPlugin] });
  // or: plugins: (names) => names.flatMap((n) => (n === cityPlugin.name ? [cityPlugin] : []))
  ```

  - **Bundlers:** the descriptor names the pack's worker module with `new URL("./worker.js", import.meta.url)`, which Vite (dev and build) and webpack 5 follow, copying it into your build with no configuration.
  - **Plain ESM:** add the pack and `pixelworld/generators`, which it imports, to the import map (the [ESM example](../examples/consumers/esm/index.html) does).
- **Packaging matters for them:** the published worker is one self-contained file with its own copy of the generators. A plugin registers through what the worker's plugin loader hands it, not by importing `pixelworld/generators` (that would be another copy, which the worker doesn't read).
- **Your own city pack:** the quickstart in [plugins.md §9.6](plugins.md#96-quickstart-a-city-pack-of-your-own) builds one in a project that depends on `pixelworld`, and loads it into a view.
- **Runtime layers and controllers** are plain objects implementing `Layer` and `Controller` from `pixelworld/engine` ([library.md §7.3, §7.5](library.md#73-layers)); they need no registration.
- **Pipeline plugins** (sources and facts, in Python) are the pipeline's: [plugins.md](plugins.md).

## 7. In this repository

- **Names:** the published packages are the unscoped `pixelworld` and the city packs, scoped `@pixelworlds/city-*` (`@pixelworlds/city-sf`, [plugins.md](plugins.md)). The workspace's other packages are scoped `@pixelworlds/*` too, the npm organization; they are private, bundled into `pixelworld`, and never published.
- **The package:** `packages/pixelworld`. Its `src/` re-exports the workspace packages (`@pixelworlds/engine`, `@pixelworlds/sim` and the rest), which stay private TypeScript sources. In the workspace its `exports` point at `src/`, so apps, examples, vitest and `pnpm typecheck` use source as before; `publishConfig.exports` points the packed manifest at `dist/`.
- **The build:** `pnpm package:build` (also run by `pnpm pack`) runs `packages/pixelworld/build.mjs`: tsup over esbuild, one split ESM build of the six entry points with bundled declarations, then the worker as one file, minified but for whitespace (196 KB; bundlers minify it to 145 KB), because esbuild drops comments with whitespace and a dynamic `import(url)` needs its `/* webpackIgnore: true */` to reach webpack. It sets the bake code's identity, which keys the tile cache, to a hash of the bake's sources (`tools/bake-code.mjs`, D-072), so an upgrade that draws differently never shows a returning visitor the old tiles. It checks the worker literal, the entry files, that the identity is set, that nothing imports a private package, and that every dynamic `import(url)` carries `/* @vite-ignore */ /* webpackIgnore: true */`. See [library.md §3.5](library.md#35-publishing).
- **The city pack** (D-074): `packages/city-sf` is built the same way by its own `build.mjs` (`pnpm package:build` runs both): `dist/index.js` with its declarations, `pixelworld` left external as a peer, and `dist/worker.js`, the worker module, self-contained and minified (28 KB). In the workspace its `exports` point at `src/` too, so the apps run it unbuilt ([plugins.md §9.5](plugins.md#95-shipping-one)).
- **The checks**, each also in CI's npm package job:

| Command | Checks |
|---|---|
| `pnpm package:check` | packs the packages and checks the tarballs. `pixelworld`: its files, manifest, `exports`, the worker literal, the licences, and size budgets (tarball, unpacked, JS, worker). Each city pack (`tools/city-pack-check.mjs`, all of `packages/city-*`): its files, manifest (`pixelworld` its only peer), `exports`, the descriptor's `new URL("./worker.js", import.meta.url)`, and its worker module, imported alone, which must define the plugin and register its generators |
| `pnpm package:size` | size-limit: what a consumer bundles from each entry point, gzipped, and the worker ([`.size-limit.json`](../packages/pixelworld/.size-limit.json)) |
| `pnpm package:consumers` | packs both, then builds and runs the [consumer examples](../examples/consumers/) in headless Chromium: the Grand Canyon, and San Francisco with its city pack. It checks the worker baked their tiles, and that San Francisco's buildings did (`--tarball`, `--city-tarball` to reuse packed ones) |
| `pnpm docs:api` | the API reference |

- **Version pins:** the consumer examples, the CDN recipe (§5) and the city pack quickstart name the packages' versions; a unit test fails when they drift from the packages' `package.json`, and `node tools/version-pins.mjs --write` sets them.

## 8. API reference

`pnpm docs:api` builds the TypeDoc reference of the six entry points into `docs/api/` (git-ignored); open `docs/api/index.html`. Its source links point at `main` on GitHub.

## 9. Releases

The npm packages are `pixelworld` and the six city packs, `@pixelworlds/city-sf`, `-nyc`, `-paris`, `-kyoto`, `-tokyo` and `-hongkong`. CI releases them ([`.github/workflows/release.yml`](../.github/workflows/release.yml), D-105) through npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers): npm trusts that workflow in this repository, so no npm token is stored anywhere.

**With each change** to what a package ships, add a changeset: `pnpm changeset`, pick the packages and a bump (patch or minor before 1.0), and write a line for the changelog. Commit the file it writes in `.changeset/`. The packages version on their own; a `pixelworld` release that leaves the city packs' peer range bumps them too ([.changeset/README.md](../.changeset/README.md)).

**A release,** once changesets are on `main`:

1. The release workflow opens (or updates) the **Version packages** pull request: `pnpm release:version` bumps the versions, writes each `CHANGELOG.md` and sets the version pins (§7).
2. CI's checks on the pull request include the npm consumer check. Before a release worth the runner time, run the full e2e suite on it too: `gh workflow run ci.yml --ref changeset-release/main`. If CI shows nothing on the pull request, GitHub didn't run it for a pull request the workflow opened; that command runs it.
3. **Merge it.** The workflow packs every package whose version isn't on npm yet, checks the tarballs (`pnpm package:check`), publishes them, and tags and releases each on GitHub (`pixelworld@0.2.0`).

- **Publish with pnpm, not npm:** only pnpm applies `publishConfig.exports` and turns the city packs' `workspace:^` peer range into `^<pixelworld's version>`. A tarball packed by npm would point at TypeScript sources it doesn't contain; `node tools/pack-check.mjs` and `node tools/city-pack-check.mjs` reject one. The workflow packs with pnpm; pnpm publishes through the npm CLI (11.5.1 or later for trusted publishing).
- **Provenance:** npm attests where each version was built when it is published from a public repository.

**One-time setup** (a maintainer, before the first release):

1. **npm:** an account with 2FA, and the npm organization `pixelworlds`, which owns the `@pixelworlds/*` names.
2. **GitHub:** Settings → Actions → General → *Allow GitHub Actions to create and approve pull requests*, for the version pull request.
3. **The first release, by hand:** npm attaches a trusted publisher only to a package that exists. Once the version pull request is open, publish from a clean worktree of its branch, not from a checkout with uncommitted changes, since `prepack` builds what is on disk:

   ```sh
   git fetch origin && git worktree add ../pixelworld-release origin/changeset-release/main
   cd ../pixelworld-release && pnpm install --frozen-lockfile
   pnpm check && pnpm package:check && pnpm package:size && pnpm package:consumers
   npm login
   for p in pixelworld @pixelworlds/city-sf @pixelworlds/city-nyc @pixelworlds/city-paris \
            @pixelworlds/city-kyoto @pixelworlds/city-tokyo @pixelworlds/city-hongkong; do
     pnpm --filter "$p" publish --access public --no-git-checks || break
   done
   ```

   - `pixelworld` goes first: the city packs name it as a peer.
   - **One package at a time**, so npm asks for each one's 2FA code (or a browser confirmation) while it is fresh.
   - **`--no-git-checks`:** pnpm otherwise publishes only from `main`.
   - **Check:** `npm view pixelworld version` and `npm view @pixelworlds/city-sf version` show 0.1.0.

   Then merge the pull request. The workflow finds everything published and publishes nothing; tag the release by hand if you want the tags (below).
4. **Trusted publishers:** on npmjs.com, for each of the seven packages, Settings → Trusted publishing → GitHub Actions: organization or user `alexngai`, repository `pixelworld`, workflow `release.yml`, no environment.
5. **Lock it down:** for each package, Settings → Publishing access → *Require two-factor authentication and disallow tokens*. Trusted publishing keeps working.

**By hand, if CI can't** (an outage): as step 3, from a clean `main` after merging the version pull request, then tag each package (`git tag -a <name>@<version>`) and `git push --follow-tags`.

**The Python distribution** (`pixelworld-pipeline`, the only one since D-110) is released by a tag. CI ([`.github/workflows/pypi.yml`](../.github/workflows/pypi.yml), D-129) publishes it through PyPI's [trusted publishing](https://docs.pypi.org/trusted-publishers/), so no PyPI token is stored anywhere.

**One-time setup:** on pypi.org, Account → Publishing → *Add a new pending publisher*, GitHub: project `pixelworld-pipeline`, owner `alexngai`, repository `pixelworld`, workflow `pypi.yml`, no environment (GitHub's free plan has no environments for a private repository). Unlike npm, PyPI trusts a publisher for a project that doesn't exist yet, so the first release goes through CI too. A pending publisher doesn't reserve the name: until the first upload, anyone can take it. After that upload, it is the project's publisher (Settings → Publishing).

**A release:**
1. **Bump the version on a branch** (`cd pipeline && uv version --bump minor`) and merge it.
2. **Tag `main`** with that version, and push the tag:

   ```sh
   git fetch origin && git tag pipeline-v0.1.0 origin/main && git push origin pipeline-v0.1.0
   ```

   The workflow fails a tag that doesn't name `pipeline/pyproject.toml`'s version. It builds the sdist and the wheel, checks that the wheel alone lists every built-in source by role (`pixelworld plugins`), and publishes both. If the publish job fails, re-run it from the run's page.

- **Upload once:** PyPI never takes the same version twice, so a mistake means a new version. A bad release can be yanked.
- **By hand, if CI can't** (an outage, or no runner minutes): from a clean worktree of `main`, with a PyPI API token (scoped to the whole account for the first upload, since the project doesn't exist yet; to `pixelworld-pipeline` after it). Give it as the password, with `__token__` as the user name, and delete it afterwards.

  ```sh
  git fetch origin && git worktree add ../pixelworld-pypi origin/main && cd ../pixelworld-pypi/pipeline
  uv build --out-dir dist                    # the sdist and the wheel
  uv run --no-project --isolated --with dist/pixelworld_pipeline-*.whl \
    pixelworld plugins                       # the wheel alone: lists every built-in source by role
  uv publish dist/pixelworld_pipeline-*      # asks for a token, or reads UV_PUBLISH_TOKEN
  ```

- **A dry run:** `uv publish --publish-url https://test.pypi.org/legacy/ dist/pixelworld_pipeline-*` uploads to TestPyPI, with a token of its own.

**Before the repository is public:**
- **Publishing makes the code public:** the npm tarballs' source maps hold the TypeScript sources, and the sdist holds the pipeline's.
- **Links lead nowhere yet:** the packages' homepage, repository and README links point at the private repository, which others can't open.
- **No provenance:** npm adds provenance only for a public repository, and the PyPI workflow uploads no attestations. Trusted publishing works either way.

Extras (`[lidar]`, `[cityjson]`, library.md §3.5) are later work.
