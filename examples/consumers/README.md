# Consumers of the npm package

Three small projects that use `pixelworld` the way a project outside this repository does: from its npm tarball, not from the workspace's sources. Each draws the Grand Canyon slice (`fixtures/grand-canyon-m0`) with the rover, and reports whether its tiles were baked in the bake worker.

| Directory | Tooling | What it shows |
|---|---|---|
| [`vite/`](vite/) | Vite 8, TypeScript | the dev server and a production build; the package's types checked with `skipLibCheck` off |
| [`webpack/`](webpack/) | webpack 5 | a production build; webpack emits the worker as its own chunk, with no configuration |
| [`esm/`](esm/) | none | the package's files served as they are, with an import map; `?workerUrl=` tries the `workerUrl` option |

They aren't workspace packages (`pnpm-workspace.yaml` lists `examples/*`, not `examples/*/*`), and they don't hold the world or style pack they draw: the test copies them in.

## Run them

```sh
pnpm package:consumers                 # pack packages/pixelworld, then all three
node tools/consumers.mjs vite          # one of them
node tools/consumers.mjs --tarball pixelworld-0.1.0.tgz --out /tmp/consumers
```

`tools/consumers.mjs` copies each project to a scratch directory (the system temp directory unless `--out` says otherwise), adds the world under `worlds/grand-canyon-m0/` and its style pack under `styles/desert-southwest/style.json`, runs `npm install <tarball>`, builds it, serves it and opens it in headless Chromium. It fails unless the view becomes ready with its tiles baked in a worker, and it writes a screenshot of each to `<out>/screenshots/`. CI runs it on every push (`.github/workflows/ci.yml`, the npm package job).

By hand, in a copy of one of them outside the repository:

```sh
npm install /path/to/pixelworld-0.1.0.tgz   # or, once published, npm install
npm run dev                                  # vite/; or npm run build (webpack/), or serve esm/ statically
```
