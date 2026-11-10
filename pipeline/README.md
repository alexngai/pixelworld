# pixelworld-pipeline

The offline geo pipeline: real elevation, land cover, roads and buildings in, gridded world packages out. A region spec (YAML) says where, at what scale and with what data; `pixelworld build` turns it into a package the viewer draws.

```sh
uv sync                                                    # once
uv run pixelworld check ../worlds/jerome/region.yaml       # validate a spec, offline
uv run pixelworld build ../worlds/jerome/region.yaml --out ../fixtures/_try/jerome
uv run pixelworld view ../fixtures/_try/jerome             # serve a package, print the viewer URL
uv run pixelworld --help                                   # every command, the exit codes
```

- **Making a world of your own place:** [docs/worlds.md](../docs/worlds.md), a walkthrough with Jerome, Arizona as the example, and the reference of every spec key (`pixelworld reference` prints it).
- **How the pipeline works:** [docs/architecture.md](../docs/architecture.md) §4–6: the spec, the stages, the warp.
- **The package it writes:** [docs/world-format.md](../docs/world-format.md).
- **Plugins** (terrain and land-cover sources, building facts) and the Python API (`pixelworld_pipeline.build(spec)`): [docs/plugins.md](../docs/plugins.md).
- **Data and licences:** [docs/data-sources.md](../docs/data-sources.md).

**Exit codes:** 0 done; 1 the package was written but its road report found problems; 2 the spec or command line is invalid; 3 the build failed (a download, or a bug) and the output was left as it was.

**Downloads** are cached in `pipeline/.cache/`, or in `$PIXELWORLD_CACHE`, which several checkouts can share.

**Development:** `uv run pytest` (offline), `uv run ruff check . && uv run ruff format --check .`. The spec schema is [`src/pixelworld_pipeline/schema.py`](src/pixelworld_pipeline/schema.py); after changing it, `uv run pixelworld reference --write ../docs/worlds.md` (a test checks the two agree).
