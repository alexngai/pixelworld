# Writing plugins

The pipeline and the generators keep region-specific code out of their own packages (decision D4 in [library.md](library.md)). A city's building records, a country's elevation model or a national land-cover map comes in as a **pipeline plugin**: a Python package that registers what it provides under a name, which a region spec then uses. A city's own building types come in as a **generator plugin**: a TypeScript package that registers generators by name, which a style pack then uses (§9). San Francisco's DataSF facts and its facades, towers and Chinatown are the first ones, in the **city pack** `pixelworld-city-sf` (§6), the template for other cities.

This guide covers:
1. how a region spec names plugins;
2. the registry, and its errors;
3. facts sources;
4. source adapters (terrain and land cover);
5. stage hooks (reserved);
6. the city pack layout;
7. the rules every plugin keeps;
8. the Python API;
9. generator plugins (TypeScript).

## 1. How a region spec names plugins

| What | Spec field | Built in | From a plugin |
|---|---|---|---|
| Elevation | `sources.dem.kind` (and `micro.dem.kind`, if micro-terrain reads another) | `usgs-3dep-1arcsec`, `usgs-3dep-13arcsec` | a `terrain` source adapter |
| Land cover | `sources.landcover.kind` | `esa-worldcover-2021` | a `landcover` source adapter |
| Building facts | `objects.typology.facts` | none | a facts source (`datasf` from `pixelworld-city-sf`) |

```yaml
sources:
  dem: { kind: usgs-3dep-13arcsec, overview: 1 }
  landcover: { kind: esa-worldcover-2021, overview: 1 }
objects:
  typology:
    facts: datasf                                         # a name
    # facts: { plugin: datasf, rollYear: "2025", classCodes: true }   # a name and its options
    rules: [...]
```

A facts source takes options. Write them in the mapping form beside `plugin:`. The older form, options beside a bare name in the typology section (`rollYear:` next to `facts: datasf`), still works.

## 2. The registry

`pixelworld_pipeline.plugins` looks names up in three places, and the first that has the name wins:
1. **Registered in this process** with `plugins.register(group, name, obj)`, or for a `with` block with `plugins.registered(...)`. Tests and scripts use these.
2. **Entry points** of installed packages, in one group per kind of plugin:

| Entry point group | What | The entry point names |
|---|---|---|
| `pixelworld.facts` | per-building facts sources | a factory: `factory(region, options)` returns a facts source (usually a `FactsSource` subclass) |
| `pixelworld.sources` | source adapters: `terrain` and `landcover` | a `RasterSource` instance, or a class the pipeline instantiates without arguments |
| `pixelworld.stages` | build hooks | reserved (§5) |

3. **Built in:** the USGS 3DEP and ESA WorldCover adapters.

An installed entry point can therefore replace a built-in of the same name. Two installed packages that offer the same name are an error.

**Checking early.** A build loads every plugin its spec names before it fetches anything, so a missing one fails in a second rather than minutes in. `pixelworld plugins` lists what is installed; give it a spec to check that spec's plugins too:

```
$ uv run pixelworld plugins ../worlds/sf/walk.yaml
pixelworld.facts (facts sources):
  datasf                   pixelworld-city-sf   pixelworld_city_sf.datasf:DataSFFacts
pixelworld.sources (source adapters):
  esa-worldcover-2021      builtin              pixelworld_pipeline.sources.rasters:ESA_WORLDCOVER_2021
  usgs-3dep-13arcsec       builtin              pixelworld_pipeline.sources.rasters:USGS_3DEP_13ARCSEC
  usgs-3dep-1arcsec        builtin              pixelworld_pipeline.sources.rasters:USGS_3DEP_1ARCSEC
pixelworld.stages (stage hooks):
  (none)
../worlds/sf/walk.yaml: every plugin it names is installed (usgs-3dep-13arcsec, esa-worldcover-2021, datasf)
```

**Errors** are `plugins.PluginError`s. The CLI prints them without a traceback and exits with 2.

| Case | Message |
|---|---|
| A name nobody provides | `no facts source named 'pluto' (named by objects.typology.facts). Installed facts sources: datasf. Install a package that provides it (entry point group 'pixelworld.facts'), or register one with pixelworld_pipeline.plugins.register(). See docs/plugins.md.` |
| A name published from this repository | `no facts source named 'datasf' (…). Installed facts sources: none. 'datasf' comes with the pixelworld-city-sf package: install it (pip install pixelworld-city-sf; in this repository, uv sync in pipeline/ installs it). …` |
| A source of the other role | `source 'esa-worldcover-2021' (named by sources.dem.kind) is a landcover source, not a terrain source` |
| A missing terrain source | `no terrain source named 'ahn-dtm-05' (named by sources.dem.kind). Installed terrain sources: usgs-3dep-13arcsec, usgs-3dep-1arcsec. …` |
| A plugin that fails to import | `facts source 'bag' (from pixelworld-city-nl) failed to import: …` |
| One name, two packages | `facts source 'bag' is provided by both pixelworld-city-a (…) and pixelworld-city-b (…); uninstall one of them` |

## 3. Facts sources

A facts source gives each building facts from public records, for the building typology (D-055; `typology.py`). The pipeline asks for them at each building's projected centroid. A building drawn in parts shares the facts of whichever part stands on a record.

**Interface** (`pixelworld_pipeline.facts.FactsSource`; any object with `at` works):
- `factory(region, options)`: the entry point's target, called once per build. `region` is the `Region` (its CRS is `region.crs`, a transverse Mercator in metres), and `options` the spec's options. Fetch and index the data here.
- `at(xs, ys) -> list[dict | None]`: the facts at each projected point, or None where the source has no record.
- `attribution`, a class attribute: the manifest entry `{name, license, url}` (or a list of them). The build reads it from the class without building a source.
- `summary() -> str`: what was read (a dataset and its vintage), for the build log.

**The facts dict** (every key optional; other keys are kept and ignored):

| Key | Type | Meaning | Read by |
|---|---|---|---|
| `year` | int or None | the year built (the original one) | `year:` rules; the `yr` hint |
| `stories` | float | storeys above ground | `floors:` rules; the `fl` hint |
| `units` | float | dwelling units | (nothing yet) |
| `use` | str | `residential`, `mixed`, `commercial`, `industrial` or `civic`, or the source's own wording, which `typology.use_group` maps to those | `uses:` rules |
| `class` | str | the source's native building class code (PLUTO's `bldgclass`, Boston's `BLDG_TYPE`, DataSF's property class) | `classes:` rules |
| `hood` | str | the neighbourhood | `hoods:` rules |
| `roof` | str | the roof shape in Overture's words (`flat`, `gabled`, `hipped`, `mansard`, …) | `roofs:` rules |
| `material` | str | the main facade material | (nothing yet) |

**Rules that read them:**
- `classes: [A4, "C*"]` matches a class code exactly, or by a prefix ending in `*`.
- `roofs: [mansard]` matches the facts' roof shape, or, where the facts have none, Overture's (`roof_shape`, every value it records, not only the shapes the generator draws).

In most cities the iconic type is in the class code rather than in year plus use (see [second-region.md](second-region.md) §2), so map the source's native class to `class` unchanged and let the spec's rules name codes.

**A minimal facts source.** A whole plugin: a package with one module and one entry point. This one reads a GeoJSON file of lots whose properties already use the keys above:

```toml
# pyproject.toml
[project]
name = "pixelworld-facts-geojson"
version = "0.1.0"
dependencies = ["pixelworld-pipeline", "shapely>=2.2", "rasterio>=1.4"]

[project.entry-points."pixelworld.facts"]
geojson-lots = "pixelworld_facts_geojson:GeoJSONLots"
```

```python
# src/pixelworld_facts_geojson/__init__.py
import json
from pathlib import Path

import shapely
from pixelworld_pipeline.facts import FACT_KEYS, FactsSource
from rasterio.warp import transform_geom


class GeoJSONLots(FactsSource):
    """Lots from a GeoJSON file (lon/lat) whose properties are facts."""

    attribution = {"name": "My city's lots", "license": "CC0 1.0", "url": "https://example.org"}

    def __init__(self, region, options=None):
        super().__init__(region, options)
        self.path = Path(self.options["path"])
        doc = json.loads(self.path.read_text())
        self.lots = [
            shapely.geometry.shape(transform_geom("EPSG:4326", region.crs, f["geometry"]))
            for f in doc["features"]
        ]
        self.facts = [{k: f["properties"].get(k) for k in FACT_KEYS} for f in doc["features"]]
        self.tree = shapely.STRtree(self.lots)

    def at(self, xs, ys):
        out = [None] * len(xs)
        points, lots = self.tree.query(shapely.points(xs, ys), predicate="within")
        for i, j in sorted(zip(points.tolist(), lots.tolist(), strict=True)):
            if out[i] is None:
                out[i] = self.facts[j]  # overlapping lots: the first in the file wins
        return out

    def summary(self):
        return f"lots from {self.path.name}"
```

```yaml
# region.yaml
objects:
  typology:
    facts: { plugin: geojson-lots, path: data/lots.geojson }
    rules:
      - { group: building.rowhouse.brownstone, classes: [A4, B1], year: [1840, 1900] }
```

## 4. Source adapters: terrain and land cover

A source adapter is a `RasterSource` (`pixelworld_pipeline.sources.rasters`). The pipeline does the rest:
- reprojecting onto the region's grid, cell corners and micro-corners;
- resampling (averaged for elevation, the mode for land cover);
- for warped worlds, the pyramid of levels in fixed blocks;
- filling small gaps;
- caching every result, keyed by the grid and the spec's `kind` and options.

**Attributes:**

| Attribute | Meaning |
|---|---|
| `role` | `terrain`: elevation in metres, float (gaps NaN, filled from their neighbours). `landcover`: ESA WorldCover class codes, uint8 (`rasters.WORLDCOVER`; 0 is no data). A land-cover source in another scheme maps its classes to these. |
| `native_m` | the source's pixel size in metres. Warped worlds read levels at `native_m × 2^i`. |
| `deepest_overview` | the largest decimation factor the files' internal overviews reach (None: deep enough). Coarser levels read that overview and average it down. |
| `attribution` | the manifest entry `{name, license, url}` |

**Methods**, one of:
- `tiles(bounds) -> list[str]`: the GeoTIFFs covering a lon/lat box (west, south, east, north), as URLs (cloud-optimized GeoTIFFs are read over HTTP range requests, through GDAL's `/vsicurl/`) or local paths. Tiles that don't exist are skipped. The file's own CRS is used, so a national grid (EPSG:28992, Lambert-93) needs nothing special.
- `read_into(dst, transform, crs, bounds, overview, resampling, nodata) -> list[str]`: for anything that isn't a list of GeoTIFFs (a WCS, a mosaic, files that must be downloaded and unzipped first). It fills `dst` in place and returns what it couldn't read.

USGS 3DEP is the first terrain adapter (`rasters.USGS3DEP`); it implements `tiles`.

**A non-US terrain source** is a plugin like any other. None ships yet. Each candidate needs its licence confirmed first, as [data-sources.md](data-sources.md) requires:
- the Dutch **AHN** 0.5 m DTM (CC0; PDOK's ATOM feed or WCS);
- the French **LiDAR HD** or RGE ALTI DTM (licence metadata to check; see second-region.md);
- **Copernicus GLO-30** as a global fallback (a surface model, not bare earth).

A sketch for Copernicus GLO-30's public cloud-optimized tiles. Check the tile naming and the licence's attribution text before you use it:

```python
import math

from pixelworld_pipeline.sources.rasters import RasterSource


class CopernicusGLO30(RasterSource):
    role = "terrain"
    native_m = 30.0
    attribution = {"name": "Copernicus DEM GLO-30 (…as the licence requires…)", "license": "…", "url": "…"}

    def tiles(self, bounds):
        w, s, e, n = bounds
        out = []
        for lat in range(math.floor(s), math.ceil(n)):
            for lon in range(math.floor(w), math.ceil(e)):
                ns = f"N{lat:02d}" if lat >= 0 else f"S{-lat:02d}"
                ew = f"E{lon:03d}" if lon >= 0 else f"W{-lon:03d}"
                name = f"Copernicus_DSM_COG_10_{ns}_00_{ew}_00_DEM"
                out.append(f"https://copernicus-dem-30m.s3.amazonaws.com/{name}/{name}.tif")
        return out


COPERNICUS_GLO30 = CopernicusGLO30()
```

```toml
[project.entry-points."pixelworld.sources"]
copernicus-glo30 = "pixelworld_city_eu.terrain:COPERNICUS_GLO30"
```

```yaml
sources:
  dem: { kind: copernicus-glo30, overview: 1 }
```

**Sources served as whole files to download** rather than cloud-optimized GeoTIFFs (as AHN's tiles may be): download what covers the box into `cache_dir("<name>")` inside `tiles`, and return the local paths.

## 5. Stage hooks

The group `pixelworld.stages` is reserved for build hooks: code a plugin runs at named points of a build, for example after objects are placed. Nothing loads it yet. If you need a hook, propose its points and what a hook may change. Changes must stay deterministic.

## 6. The city pack layout

A **city pack** is a package of everything one place needs beyond the shared pipeline. `pipeline/plugins/pixelworld-city-sf/` is the template:

```
pipeline/plugins/pixelworld-city-sf/
├── pyproject.toml              distribution pixelworld-city-sf: dependencies and entry points
├── README.md                   what it provides, its options, its data and licences
├── src/pixelworld_city_sf/
│   ├── __init__.py
│   └── datasf.py               DataSF: Socrata paging and caching, lot aggregation,
│                               ParcelFacts (lookups by point), DataSFFacts (the plugin)
└── tests/
    └── test_city_sf.py         offline (fetchers monkeypatched), plus the entry point
```

```toml
[project]
name = "pixelworld-city-sf"
dependencies = ["numpy>=2.0", "pixelworld-pipeline", "rasterio>=1.4", "shapely>=2.2.0"]

[project.entry-points."pixelworld.facts"]
datasf = "pixelworld_city_sf.datasf:DataSFFacts"
```

**Conventions:**
- **Names:** the distribution `pixelworld-city-<place>` and the module `pixelworld_city_<place>`. Name plugins after their data (`datasf`, `pluto`, `bag`, `ahn-dtm-05`), not the city, since one dataset can serve a whole country.
- **Contents:** a pack can hold several plugins: facts sources, terrain and land-cover adapters, and later 3D city model readers. Its browser half is a TypeScript package of the same name with the city's generators (§9): San Francisco's is `packages/city-sf`. Its style pack (`worlds/_styles/bay-area`) is still with the others, and names the plugin it needs.
- **In this repository:** a pack lives in `pipeline/plugins/` and is a member of the pipeline's uv workspace (`[tool.uv.workspace] members = ["plugins/*"]`). If a committed world needs it, add it to the pipeline's `plugins` dependency group, which `uv sync` installs by default. Its tests run with the pipeline's (`uv run pytest`), and `uv build --package pixelworld-city-<place>` builds its wheel.
- **Outside this repository:** a pack is an ordinary package that depends on `pixelworld-pipeline`. `pip install` it next to the pipeline and the registry finds it.

## 7. Rules for every plugin

- **Deterministic:** the same spec and cached inputs must give the same package, byte for byte.
  - Pin what can change: a roll year, a dataset release, a tile index.
  - Make every choice by a stable order (sort keys; break ties the same way every time).
- **Cache downloads** under `pixelworld_pipeline.sources.http.cache_dir("<name>")`. That is `$PIXELWORLD_CACHE/<name>/` if set, else `pipeline/.cache/<name>/` in a checkout of this repository, else `~/.cache/pixelworld/<name>/` for an installed pipeline. Every checkout and worktree that links the cache then shares them. Name cache files by what they hold (dataset, vintage, columns), and change the name when the query changes, so an old file is never read for a new query.
- **Fetch politely:** use `pixelworld_pipeline.sources.http.get` (the project's User-Agent, retries with backoff).
- **Licences:** only openly licensed data, checked when integrated and recorded in [data-sources.md](data-sources.md). Credit it in `attribution`, which goes into every world that uses the plugin.
- **No network in tests:** monkeypatch the fetchers, as `test_city_sf.py` does.
- **Don't write into the package.** Plugins return data; the pipeline writes the world package.

## 8. The Python API

Builds can be driven from Python as well as from the CLI:

```python
import pixelworld_pipeline

report = pixelworld_pipeline.build("worlds/sf/walk.yaml", out_dir="out/sf-walk")
report = pixelworld_pipeline.build(spec_dict, base_dir="worlds/sf", routes=False)
assert report["roads"]["ok"]
```

- `spec`: a path, or a dict as its YAML would load. A dict's `extends:`, `warp:` file, landmark registry and `importance.json` are found from `base_dir`.
- `out_dir`: `fixtures/<id>` of the checkout by default.
- Returns the build report. Raises `RegionError` for a bad spec and `PluginError` for a missing plugin.

The module of the build stages is still `pixelworld_pipeline.build`: `from pixelworld_pipeline.build import ...` reaches it. The package attribute `pixelworld_pipeline.build` is the API function.

## 9. Generator plugins (TypeScript)

A style pack maps each asset group to a **generator** by name (D-030): `"building.rowhouse.victorian": { "generator": "rowhouse", … }`. `@pixelworld/generators` holds a registry of them. The built-ins cover what every region uses: terrain, trees, rocks, the generic building, city blocks, dams, signs, the landmark kit's generic landmarks, street props and vehicles. A city's own building types come from a **generator plugin** (D-071). San Francisco's is the browser half of its city pack: `pixelworld-city-sf` (`packages/city-sf`), with `rowhouse` (Victorians, Edwardians and the Sunset's stucco rows), `block` (apartments, Chinatown, piers), `decoTower`, `sfTower`, and Chinatown's `gate` and `lanterns`.

### 9.1 Using one

A style pack names the plugins its generators come from:

```json
{ "id": "bay-area", "name": "San Francisco Bay Area", "plugins": ["pixelworld-city-sf"], … }
```

A world view loads them, in its bake worker and on the main thread, before its first bake:

```ts
import { createWorldView } from "@pixelworld/engine";
import { cityPlugin } from "pixelworld-city-sf";

const view = await createWorldView({ canvas, worldUrl: "/sf/", style: bayArea, plugins: [cityPlugin] });

// or let the style pack choose among the plugins a page has (the viewer does this):
const PLUGINS = { [cityPlugin.name]: cityPlugin };
createWorldView({ canvas, worldUrl, style, plugins: (names) => names.flatMap((n) => PLUGINS[n] ?? []) });
```

- **A plugin the style names but the view doesn't load** is a console warning when the view starts (`the style pack bay-area needs the plugin pixelworld-city-sf, which this view didn't load: …`), and each model that needs it fails to bake with a `MissingGeneratorError`.
- **Without a view** (tests, tools, a page that generates models itself), register a plugin on the thread that generates: `import { register } from "pixelworld-city-sf"; register();`, or `registerPlugin(plugin)` from `@pixelworld/generators`.
- **In this repository:** the viewer (`apps/web`) loads the city pack for the bay-area pack's worlds, so the bench page and the hero bake tool, which drive the viewer, do too. `examples/minimal-viewer` passes it.

### 9.2 The registry

| Function (`@pixelworld/generators`) | What it does |
|---|---|
| `registerGenerators(record, { source?, replace? })`, `registerGenerator(name, fn, opts)` | register generators by name, under a source (a plugin's name; default `app`) |
| `hasGenerator(name)`, `getGenerator(name, group?)` | look one up; `getGenerator` throws a `MissingGeneratorError` |
| `listGenerators()` | every registered generator and its source, by name; the built-ins' source is `@pixelworld/generators` |
| `unregisterGenerators(source)` | remove a source's generators (tests, hot reloads) |
| `definePlugin({ name, register })`, `registerPlugin(plugin)`, `loadPlugin({ name, url })` | plugins: define one in its worker module; register one in this realm; import one by URL and register it |

- **One registry per realm:** the main thread and each bake worker have their own. A plugin is registered in each realm that generates models, once.
- **Names:** registering a name again from the same source replaces it (a plugin registered twice, a hot reload). A name another source registered, a built-in included, is an error unless `replace: true`. A call with a bad entry registers nothing.
- **Known plugins:** core knows which generators the plugins published from this repository provide (`KNOWN_PLUGIN_GENERATORS`), as the pipeline's registry knows `datasf`, so their errors say what to load.

**Errors:**

| Case | Message |
|---|---|
| A generator of a known plugin that isn't loaded | `no generator named 'rowhouse' (asked for by building.rowhouse.victorian). 'rowhouse' comes with the plugin pixelworld-city-sf, which isn't loaded here: pass it to createWorldView({ plugins }), which loads it in the bake worker and on the main thread, or register it with registerPlugin() where models are generated outside a view. See docs/plugins.md.` |
| A generator nobody provides | `no generator named 'brownstone' (asked for by building.rowhouse.brownstone). No plugin known here provides it: load the plugin that does (…), or register it with registerGenerators(). Registered generators: archBridge, blob, … See docs/plugins.md.` |
| A name another source has | `generator 'building' is already registered by @pixelworld/generators, so my-city can't register it too (pass { replace: true } to replace it)` |
| A plugin's module that fails to load | `plugin pixelworld-city-sf (https://…/assets/worker-….js) failed to import: …`; `createWorldView` rejects with it |
| A module that defines no plugin, or another one | `https://… defines no plugin: the module must call definePlugin({ name, register }) (docs/plugins.md §9)`; `https://… defines the plugin x, not y` |

### 9.3 How a plugin reaches the bake worker

Generators run where tiles are meshed: in the bake worker (`@pixelworld/runtime`). Functions can't be posted to a worker, so a plugin travels as a **module URL**:

1. `createWorldView` resolves the plugins (the option, or its function given the style's `plugins`) and makes each URL absolute.
2. The main thread registers each: the descriptor's `plugin` if it carries one, else it imports the URL.
3. The bake service starts the worker and, once it is ready, sends `loadPlugins` with the names and URLs, before `init`.
4. The worker imports each URL in order. The module calls `definePlugin(plugin)`, which announces the plugin to the realm (a list under `Symbol.for("pixelworld.plugins")`). The worker finds it by name, or takes the module's default export, and calls `plugin.register(api)` with an API bound to *its own* registry. Messages that arrive meanwhile wait.
5. The worker answers `pluginsLoaded` with each plugin's generators, or an `error`; `init` and the bakes follow. A plugin that fails to load fails `createWorldView`.
6. Without a worker (no WebGL2 in workers), the inline baker uses the main thread's registry, where step 2 put the plugins.

**Why the announcement:** a bundler builds the worker module on its own, and may drop its exports (Vite does for every worker bundle) or give it its own copy of `@pixelworld/generators`. `definePlugin` is a side effect, so it survives either, and the plugin registers through the API it is given, never through its own copy's registry.

### 9.4 Writing one

A plugin package has its generators, a plugin object, the module the worker imports, and a main entry:

```
packages/city-sf/                       npm: pixelworld-city-sf
├── package.json                        exports "." (src/index.ts) and "./worker" (src/worker.ts)
├── src/
│   ├── facades.ts, towers.ts, chinatown.ts   the generators
│   ├── generators.ts                   PLUGIN_NAME, sfGenerators(): name → generator
│   ├── plugin.ts                       the plugin: { name, register(api) }
│   ├── worker.ts                       what the bake worker imports: export default definePlugin(plugin)
│   └── index.ts                        cityPlugin (the descriptor), register(), the generators
└── test/                               the generators' tests, and the plugin's (plugin.test.ts)
```

A sketch for another city:

```ts
// generators.ts: a generator is (ctx: GenContext) => VoxelModel (GenContext: see assets.ts)
import { VoxelModel, type Generator } from "@pixelworld/generators";
export const PLUGIN_NAME = "pixelworld-city-nyc";
const brownstone: Generator = ({ rand, ramp, param, mask, heightVox, hints }) => { /* … */ return new VoxelModel(1, 1, 1); };
export function cityGenerators(): Record<string, Generator> {
  return { brownstone }; // a function, so a page that only names the plugin doesn't bundle the generators
}

// plugin.ts
import type { Plugin } from "@pixelworld/generators";
export const plugin: Plugin = { name: PLUGIN_NAME, register: (api) => api.registerGenerators(cityGenerators()) };

// worker.ts: the bake worker imports this module by URL
import { definePlugin } from "@pixelworld/generators";
export default definePlugin(plugin);

// index.ts: the main entry
import { registerPlugin, type PluginDescriptor } from "@pixelworld/generators";
import workerUrl from "./worker?worker&url"; // Vite: the worker module built on its own, and its URL
export const cityPlugin: PluginDescriptor = { name: PLUGIN_NAME, url: workerUrl };
export const register = () => registerPlugin(plugin);
```

```json
{ "id": "nyc", "plugins": ["pixelworld-city-nyc"], "assets": { "building.rowhouse.brownstone": { "generator": "brownstone", "ramps": { … } } } }
```

**The descriptor** (`PluginDescriptor`): `name`; `url`, the module a worker imports; optionally `plugin`, the plugin itself, when the page bundles it anyway (the main thread then registers it instead of importing the URL); optionally `version`, which keys the tile cache.

**Rules:**
- **Deterministic:** a generator draws the same model for the same context, in every realm. Use `ctx.rand` (seeded), never `Math.random` or the clock. Baked tiles are cached by package, style, baker and plugin (name and `version`): bump `version` when your plugin draws differently.
- **Generic depictions:** no names, lettering or logos (D-051), and the style guide's building rules (inside the footprint, no overhangs, glass only on the skin), as the built-ins keep. San Francisco's tests (`packages/city-sf/test`) check them over many footprints and seeds.
- **Colours come from the style:** a generator asks for ramps by role (`ctx.ramp("wall")`, or `ctx.ramps("wall")` for the `wall.*` variants) and the style pack maps roles to its ramps.
- **Names:** generators are named for what they draw (`rowhouse`, `brownstone`), the plugin for its package.

### 9.5 Shipping one

**The worker module must load on its own:** an ES module that is self-contained, or that imports only absolute URLs. A worker can't resolve a bare `@pixelworld/generators`.
- **In this repository (Vite, from source):** `import url from "./worker?worker&url"`. Vite builds the module and its dependencies into one file (`assets/worker-<hash>.js`, 28 KB for San Francisco) and gives its URL; in dev it serves the module from source. The app's Vite config needs only `worker: { format: "es" }`, as the bake worker does.
- **Published to npm:** build `worker.ts` into one self-contained file (`dist/worker.js`, its dependencies bundled), and have the published entry point the descriptor at it with the standard pattern, which Vite, webpack 5 and Rollup follow, copying the file into the app's build. `?worker&url` is for apps: a library build turns it into a root-absolute `/assets/…` path that the consuming app doesn't serve.

  ```ts
  export const cityPlugin = { name: PLUGIN_NAME, url: new URL("./worker.js", import.meta.url).href };
  ```

  If a dev server pre-bundles the package and its worker URL then 404s, exclude the package from pre-bundling (Vite: `optimizeDeps.exclude`).
- **Anywhere else** (a CDN, plain ESM): any absolute URL of the bundled module works, e.g. `{ name, url: "https://cdn.example.org/pixelworld-city-nyc@1.0.0/dist/worker.js" }`.

**Testing:** register on the test's thread (`await register()`, or `registerPlugin(plugin)`) and generate with `generateModel` (`packages/city-sf/test`). For the worker path, `loadPlugin({ name, url }, importer)` takes an importer in place of `import()`; `packages/runtime/test/plugins.test.ts` runs the worker's message loop with the city pack's module that way.
