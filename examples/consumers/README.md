# Consumers of the npm packages

Three small projects that use `pixelworld` and San Francisco's city pack `@pixelworlds/city-sf` the way a project outside this repository does: from their npm tarballs, not from the workspace's sources. Each draws two worlds with the rover and reports whether its tiles were baked in the bake worker:
- **the Grand Canyon slice** (`fixtures/grand-canyon-m0`), by default;
- **San Francisco's flying level** (`fixtures/sf-fly`) with `?world=sf-fly`. Its style pack (`bay-area`) names the city pack, so the page loads it: `plugins: (names) => names.flatMap((n) => PLUGINS[n] ?? [])`.

| Directory | Tooling | What it shows |
|---|---|---|
| [`vite/`](vite/) | Vite 8, TypeScript | the dev server and a production build; the packages' types checked with `skipLibCheck` off |
| [`webpack/`](webpack/) | webpack 5 | a production build; webpack emits the bake worker as its own chunk and the city pack's worker module as an asset, with no configuration |
| [`esm/`](esm/) | none | `index.html`: the packages' files served as they are, with an import map (`?workerUrl=` tries the `workerUrl` option); `cdn.html`: `pixelworld` from another origin, as from a CDN, with the worker started from a `blob:` URL |

They aren't workspace packages (`pnpm-workspace.yaml` lists `examples/*`, not `examples/*/*`), and they don't hold the worlds or style packs they draw: the test copies them in. They depend on the packages' current versions (`^0.0.0` until the first release), which a unit test keeps in step (`tools/version-pins.mjs`).

## Run them

```sh
pnpm package:consumers                 # pack both packages, then all three
node tools/consumers.mjs vite          # one of them
node tools/consumers.mjs --tarball pixelworld-x.y.z.tgz --city-tarball pixelworlds-city-sf-x.y.z.tgz --out /tmp/consumers
```

`tools/consumers.mjs` copies each project to a scratch directory (the system temp directory unless `--out` says otherwise). It adds the worlds under `worlds/<id>/` and their style packs under `styles/<id>/style.json`, runs `npm install` with both tarballs, builds the project, serves it and opens each world in headless Chromium. It fails unless:
- the view becomes ready with its tiles baked in a worker, with no error or plugin warning;
- for San Francisco, the city pack's worker module loads from where the bundler put it, tiles bake, and at least half the frame is drawn. Without the pack, 4% is.

It writes a screenshot of each run to `<out>/screenshots/`. CI runs it on every push (`.github/workflows/ci.yml`, the npm package job).

By hand, in a copy of one of them outside the repository:

```sh
npm install /path/to/pixelworld-x.y.z.tgz /path/to/pixelworlds-city-sf-x.y.z.tgz   # or, once published, npm install
npm run dev                                  # vite/; or npm run build (webpack/), or serve esm/ statically
```
