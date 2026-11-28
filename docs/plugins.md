# Writing plugins

The pipeline and the generators keep region-specific code out of their core (decision D4 in [library.md](library.md)). Everything the pipeline reads from outside comes from a **source**: elevation, land cover, the vector map, a city's building records, tree canopy, measured building heights and place fame. Each source has a **role**, and a region spec picks one per role by name, with that source's options (D-110). The pipeline ships a source for every role, and a Python package can add more, which any spec can then select. A city's own building types come in as a **generator plugin**: a TypeScript package that registers generators by name, which a style pack then uses (§9). San Francisco's facades, towers and Chinatown are the first, in the npm package `@pixelworlds/city-sf`.

This guide covers:
1. how a region spec selects sources;
2. the registry, and its errors;
3. facts sources;
4. the other roles: terrain and land cover, features, canopy, heights and importance;
5. stage hooks (reserved);
6. adding a place's sources;
7. the rules every source keeps;
8. the Python API;
9. generator plugins (TypeScript), with a quickstart for a city pack of your own (§9.6) and the viewer's list of city packs (§9.7).

## 1. How a region spec selects sources

Each role has a key under `sources:`. Its block names the source (`kind`) and holds the source's options beside it:

```yaml
sources:
  dem: { kind: usgs-3dep-13arcsec, overview: 1 }          # the pipeline's keys: overview, resampling
  landcover: { kind: esa-worldcover-2021, overview: 1 }
  features: { kind: overture, release: 2026-10-21.0 }      # release: the overture source's option
  facts: { kind: datasf, rollYear: "2025" }
  # canopy, heights and importance have defaults:
  # canopy: { kind: meta-chm }
  # heights: { kind: usgs-3dep-lidar, project: USGS_LPC_NV_LasVegas_QL1_2016_LAS_2018 }
  # importance: { kind: wikidata }
```

| Role | Spec key | Used by | Built in |
|---|---|---|---|
| `terrain` | `sources.dem` (and `micro.dem`, if micro-terrain reads another) | every build | `usgs-3dep-1arcsec`, `usgs-3dep-13arcsec` (United States); `copernicus-glo30`, `copernicus-glo30-ground` (worldwide, D-107); `ign-rgealti`, `ign-lidar-hd-mnt` (France, D-084); `gsi-dem` (Japan, D-089) |
| `landcover` | `sources.landcover` | every build | `esa-worldcover-2021` |
| `features` | `sources.features` | every build: roads, paths, rivers, rails, water, land use, barriers, buildings, transit | `overture` (option `release`, required) |
| `facts` | `sources.facts` | `objects.typology` | `datasf` (San Francisco), `pluto` (New York), `apur` (Paris), `plateau` (Japan), `areas` (facts written in the spec, by neighbourhood box, D-107) |
| `canopy` | `sources.canopy` (default `meta-chm`) | `canopy:` rules, `ground.lawn.wooded` | `meta-chm` |
| `heights` | `sources.heights` (default `usgs-3dep-lidar`) | `objects.buildings.lidar` | `usgs-3dep-lidar` (option `project`, required) |
| `importance` | `sources.importance` (default `wikidata`) | `warp.importance` (`pixelworld importance`) | `wikidata` |

- **Options:** every key of the block but `kind` and the pipeline's own (`overview`, `resampling`) goes to the source. A source that declares its options has them checked by `pixelworld check` before anything is fetched; the others check them when opened.
- **A role the spec doesn't use** isn't opened: a spec without `objects.typology` reads no facts, whatever `sources.facts` says.

## 2. The registry

`pixelworld_pipeline.plugins` looks names up in three places, and the first that has the name wins:
1. **Registered in this process** with `plugins.register(plugins.SOURCES, name, obj)`, or for a `with` block with `plugins.registered(...)`. Tests, scripts and notebooks use these.
2. **Entry points** of installed packages, in the group `pixelworld.sources`:

   ```toml
   [project.entry-points."pixelworld.sources"]
   geojson-lots = "pixelworld_facts_geojson:GeoJSONLots"
   ```

3. **Built in** (`plugins.BUILTIN`): the sources in §1's table.

A name stands for a class or an instance. The pipeline opens a class as `cls(region, options)` (once per use), and uses an instance as it is (it takes no options). Either way it has a `role` (§4 lists the contracts); a name used for the wrong role is an error. An installed entry point can replace a built-in of the same name. Two installed packages that offer the same name are an error.

**Checking early.** A build loads every source its spec names before it fetches anything, so a missing one fails in a second rather than minutes in. `pixelworld plugins` lists the sources by role; give it a spec to check that spec's too:

```
$ uv run pixelworld plugins ../worlds/sf/walk.yaml
terrain (sources.dem):
  copernicus-glo30         builtin  pixelworld_pipeline.sources.rasters:COPERNICUS_GLO30
  …
facts (sources.facts):
  apur                     builtin  pixelworld_pipeline.sources.apur:ApurFacts
  …
canopy (sources.canopy, default meta-chm):
  meta-chm                 builtin  pixelworld_pipeline.sources.canopy:META_CHM
…
../worlds/sf/walk.yaml: every source it names is installed (usgs-3dep-13arcsec, esa-worldcover-2021, overture, datasf)
```

**Errors** are `plugins.PluginError`s. The CLI prints them without a traceback and exits with 2.

| Case | Message |
|---|---|
| A name nobody provides | `no facts source named 'cadastre' (named by sources.facts). Facts sources: apur, areas, datasf, plateau, pluto. Install a package that provides it (entry point group 'pixelworld.sources'), or register one with pixelworld_pipeline.plugins.register(). See docs/plugins.md.` |
| A source of another role | `source 'esa-worldcover-2021' (named by sources.dem) is a landcover source, not a terrain source` |
| Options for a source that takes none | `source 'usgs-3dep-1arcsec' (named by sources.dem) takes no options, got tileset` |
| A source that fails to import | `source 'bag' (from pixelworld-city-nl) failed to import: …` |
| One name, two packages | `source 'bag' is provided by both pixelworld-city-a (…) and pixelworld-city-b (…); uninstall one of them` |

## 3. Facts sources

A facts source (role `facts`) gives each building facts from public records, for the building typology (D-055; `typology.py`). The pipeline asks for them at each building's projected centroid. A building drawn in parts shares the facts of whichever part stands on a record.

**Contract** (`pixelworld_pipeline.facts.FactsSource`; any class with `role = "facts"` and `at` works):
- `cls(region, options)`: called once per build. `region` is the `Region` (its CRS is `region.crs`, a transverse Mercator in metres), and `options` the spec's options. Fetch and index the data here.
- `at(xs, ys) -> list[dict | None]`: the facts at each projected point, or None where the source has no record.
- `attribution`, a class attribute: the manifest entry `{name, license, url}` (or a list of them). The build reads it from the class without opening the source.
- `options_schema`, a class attribute: the options it takes, as `pixelworld_pipeline.schema.Key`s by name, for `pixelworld check` (optional).
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
| `material` | str | the main facade material | `materials:` rules |
| `height` | float | the building's height in metres | buildings the features source gives no height or floors take it, and become towers at `towerMeters` (D-084) |

**Rules that read them:**
- `classes: [A4, "C*"]` matches a class code exactly, or by a prefix ending in `*`.
- `roofs: [mansard]` matches the facts' roof shape, or, where the facts have none, the features source's (`roof_shape`, every value it records, not only the shapes the generator draws).

In most cities the iconic type is in the class code rather than in year plus use (see [second-region.md](second-region.md) §2), so map the source's native class to `class` unchanged and let the spec's rules name codes.

**A minimal facts source.** A whole package: one module and one entry point. This one reads a GeoJSON file of lots whose properties already use the keys above:

```toml
# pyproject.toml
[project]
name = "pixelworld-facts-geojson"
version = "0.1.0"
dependencies = ["pixelworld-pipeline", "shapely>=2.2", "rasterio>=1.4"]

[project.entry-points."pixelworld.sources"]
geojson-lots = "pixelworld_facts_geojson:GeoJSONLots"
```

```python
# src/pixelworld_facts_geojson/__init__.py
import json
from pathlib import Path

import shapely
from pixelworld_pipeline.facts import FACT_KEYS, FactsSource
from pixelworld_pipeline.schema import Key, Str
from rasterio.warp import transform_geom


class GeoJSONLots(FactsSource):
    """Lots from a GeoJSON file (lon/lat) whose properties are facts."""

    attribution = {"name": "My city's lots", "license": "CC0 1.0", "url": "https://example.org"}
    options_schema = {"path": Key(Str(), "The GeoJSON file.", required=True)}

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
sources:
  facts: { kind: geojson-lots, path: data/lots.geojson }
objects:
  typology:
    rules:
      - { group: building.rowhouse.brownstone, classes: [A4, B1], year: [1840, 1900] }
```

## 4. The other roles

Each role's contract is a base class in the module that consumes it. Subclass it, set `attribution`, and implement its methods.

### 4.1 Terrain and land cover

A raster source is a `RasterSource` (`pixelworld_pipeline.sources.rasters`) of role `terrain` or `landcover`. The pipeline does the rest:
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

USGS 3DEP and Copernicus GLO-30 implement `tiles` (`sources/rasters.py`). IGN's (`sources/ign.py`, D-084) and GSI's (`sources/gsi.py`, D-089) override `read_into`: the Géoplateforme's WMS-Raster resamples to any resolution, so IGN's asks for tiles at `native_m × overview` on a fixed Lambert-93 grid; GSI serves PNG tiles on the Web Mercator grid, so GSI's picks the zoom just finer than `native_m × overview`, takes each tile from the finest of three DEMs that has it, decodes, mosaics and reprojects them.

**A source of your own files** takes their paths as an option:

```python
from pixelworld_pipeline.schema import Key, ListOf, Str
from pixelworld_pipeline.sources.rasters import RasterSource


class LocalDTM(RasterSource):
    """A national DTM downloaded as GeoTIFFs (the Dutch AHN, say)."""

    role = "terrain"
    native_m = 0.5
    attribution = {"name": "AHN", "license": "CC0 1.0", "url": "https://www.ahn.nl"}
    options_schema = {"files": Key(ListOf(Str()), "The GeoTIFFs.", required=True)}

    def tiles(self, bounds):
        return list(self.options["files"])
```

```yaml
sources:
  dem: { kind: local-dtm, overview: 4, files: [data/ahn/M_25GN1.tif, data/ahn/M_25GN2.tif] }
```

**Sources served as whole files to download** rather than cloud-optimized GeoTIFFs: download what covers the box into `cache_dir("<name>")` inside `tiles`, and return the local paths.

### 4.2 Features

The vector map (`pixelworld_pipeline.sources.features.FeatureSource`, role `features`): roads, paths, rails, rivers, water areas, land use, natural land, barriers, buildings and their parts, and transit lines. Each method takes a lon/lat box and returns rows: dicts with an `id` (stable and unique), a `geometry` in WKT (lon/lat), and the fields the contract lists per method, sorted by id. The fields and their vocabularies are Overture Maps' schema: road classes (`primary`, `residential`, …), path classes, water subtypes, land-use classes, building heights and floors. The built-in `overture` source reads them from Overture's releases. A source for other data (OpenStreetMap directly, a city's own centre lines) maps its classes to Overture's words; a field it can't fill is left out.

| Method | Rows |
|---|---|
| `roads(bbox, classes, exclude_subclasses, lanes)`, `road_subclasses(bbox, subclasses, lanes)` | road segments: class, subclass, connectors (where segments join); with `lanes`, names, access restrictions and width rules |
| `paths(bbox, classes)` | footways and cycleways (`features.path_class` gives a row's drawn class) |
| `streets(bbox, classes)` | segments with their names, for rules that pick streets by name |
| `rails(bbox, classes)` | rail segments: class, names, rail flags (tunnels and bridges along them) |
| `rivers(bbox, subtypes)`, `water_areas(bbox, classes)` | water lines; water polygons |
| `land_use(bbox, classes)`, `land(bbox, classes)` | land-use polygons (parks, cemeteries); natural land (forest, sand) |
| `barriers(bbox, classes)` | barrier lines (retaining walls) |
| `buildings(bbox)`, `building_parts(bbox)` | footprints with height, floors, class, names and roof and facade hints; their parts |
| `transit(bbox)` | rail and ferry lines with the routes they carry, for ambient traffic |

A method a source doesn't implement raises `NotImplementedError`, so a spec that needs it fails with the source's name. `attribution` covers the map; `buildings_attribution` is added when a world places buildings.

### 4.3 Canopy, heights and importance

| Role | Contract | Method |
|---|---|---|
| `canopy` | `sources/canopy.py` `CanopySource` | `grid(box)`: an object whose `sample(xs, ys, crs)` gives tree heights in metres at projected points, 0 where there are none |
| `heights` | `sources/lidar.py` `HeightSource` | `height_grid(box, crs, res, max_depth) -> HeightGrid | None`: heights of buildings above the ground on a `res`-metre grid in the region's CRS, None where there is no data |
| `importance` | `importance.py` `ImportanceSource` | `places(region, min_links)`: `{id, label, lon, lat, sitelinks}` for famous places in the region, `sitelinks` scoring fame as Wikipedia's article count does |

## 5. Stage hooks

The group `pixelworld.stages` is reserved for build hooks: code a package runs at named points of a build, for example after objects are placed. Nothing loads it yet. If you need a hook, propose its points and what a hook may change. Changes must stay deterministic.

## 6. Adding a place's sources

**In this repository,** a place's sources are modules of the pipeline (`pipeline/src/pixelworld_pipeline/sources/`), registered in `plugins.BUILTIN`, with offline tests in `pipeline/tests/` (`test_city_sf.py` and the others). The city packs' Python halves were separate distributions until D-110; they share the pipeline's dependencies, so they ship with it. A place's browser half is still a package of its own (§9): its generators are what a page downloads.

**Outside this repository,** a source is an ordinary package that depends on `pixelworld-pipeline` and declares an entry point in `pixelworld.sources` (§3's example). `pip install` it next to the pipeline and every spec can select it.

**Names:** name a source after its data (`datasf`, `pluto`, `bag`, `ahn-dtm-05`), not the city, since one dataset can serve a whole country. A package of several is named `pixelworld-<place>` or after its data.

## 7. Rules for every source

- **Deterministic:** the same spec and cached inputs must give the same package, byte for byte.
  - Pin what can change: a roll year, a dataset release, a tile index. Take it as an option, so the spec pins it.
  - Make every choice by a stable order (sort keys; break ties the same way every time).
- **Cache downloads** under `pixelworld_pipeline.sources.http.cache_dir("<name>")`. That is `$PIXELWORLD_CACHE/<name>/` if set, else `pipeline/.cache/<name>/` in a checkout of this repository, else `~/.cache/pixelworld/<name>/` for an installed pipeline. Every checkout and worktree that links the cache then shares them. Name cache files by what they hold (dataset, vintage, columns), and change the name when the query changes, so an old file is never read for a new query.
- **Fetch politely:** use `pixelworld_pipeline.sources.http.get` (the project's User-Agent, retries with backoff).
- **Licences:** only openly licensed data, checked when integrated and recorded in [data-sources.md](data-sources.md). Credit it in `attribution`, which goes into every world that uses the source.
- **No network in tests:** monkeypatch the fetchers, as `test_city_sf.py` does.
- **Don't write into the package.** Sources return data; the pipeline writes the world package.

## 8. The Python API

Builds can be driven from Python as well as from the CLI:

```python
import pixelworld_pipeline
from pixelworld_pipeline import plugins

report = pixelworld_pipeline.build("worlds/sf/walk.yaml", out_dir="out/sf-walk")
report = pixelworld_pipeline.build(spec_dict, base_dir="worlds/sf", routes=False)
assert report["roads"]["ok"]

# a source of your own, for this process only
with plugins.registered(plugins.SOURCES, "geojson-lots", GeoJSONLots):
    pixelworld_pipeline.build(spec_dict | {"sources": {**spec_dict["sources"], "facts": {"kind": "geojson-lots", "path": "lots.geojson"}}})
```

- `spec`: a path, or a dict as its YAML would load. A dict's `extends:`, `warp:` file, landmark registry and `importance.json` are found from `base_dir`.
- `out_dir`: `fixtures/<id>` of the checkout by default.
- Returns the build report. Raises `RegionError` for a bad spec and `PluginError` for a missing source.
- `plugins.source(region, role)` opens the source a region selects for a role, for scripts that want the data without a build.

The module of the build stages is still `pixelworld_pipeline.build`: `from pixelworld_pipeline.build import ...` reaches it. The package attribute `pixelworld_pipeline.build` is the API function.

## 9. Generator plugins (TypeScript)

A style pack maps each asset group to a **generator** by name (D-030): `"building.rowhouse.victorian": { "generator": "rowhouse", … }`. `pixelworld/generators` holds a registry of them. The workspace's private packages import the same module as `@pixelworlds/generators`; a city pack imports the public name, as `packages/city-sf` does, and so does the code here. The built-ins cover what every region uses: terrain, trees, rocks, the generic building, city blocks, dams, signs, the landmark kit's generic landmarks, street props and vehicles. A city's own building types come from a **generator plugin** (D-071). San Francisco's is the browser half of its city pack: `@pixelworlds/city-sf` (`packages/city-sf`), with `rowhouse` (Victorians, Edwardians and the Sunset's stucco rows), `block` (apartments, Chinatown, piers), `decoTower`, `sfTower`, and Chinatown's `gate` and `lanterns`. New York's is `@pixelworlds/city-nyc` (`packages/city-nyc`, D-081), with `brownstone`, `tenement`, `castIronLoft` and `prewarBlock`. Its style pack names San Francisco's too, for `block` and the towers. Paris's is `@pixelworlds/city-paris` (`packages/city-paris`, D-085, D-087), with `haussmann`, `faubourg` and `hbm`, a `palace` for the Louvre's and the Invalides' wings, and eight landmark shapes drawn on the proportions of Paris's landmarks: `cathedral`, `triumphalArch`, `latticeArchTower`, `operaHouse`, `steelArchBridge`, `domedChurch`, `glassPalace` and `stoneArchBridge`; its style pack names San Francisco's too. Kyoto's is `@pixelworlds/city-kyoto` (`packages/city-kyoto`, D-090), with `machiya`, `midrise`, `kura`, `utilityPole` and `stoneWall` for the town, `templeHall`, `towerGate`, `pagoda` and `torii` for its temples, shrines and palaces, `goldenPavilion` for Kinkaku-ji and `candleTower` for Kyoto Tower; its style pack names Tokyo's too, for `wireSpan` (D-106). Tokyo's is `@pixelworlds/city-tokyo` (`packages/city-tokyo`, D-092), with `zakkyo`, `mansion` and `kodate`, the landmark shapes `twinTowerHall`, `cylinderTower` and `myojinTorii`, and the street props `utilityPoles` and `wireSpan`; its style pack names San Francisco's too. Hong Kong's is `@pixelworlds/city-hongkong` (`packages/city-hongkong`, D-108), with `tongLau`, `compositeTower` and `pencilTower` for Kowloon's tenements, composite buildings, malls and residential towers, the landmark shapes `curvedRoofHall` and `grandHotel`, and `neonSign`, the signs hung over the street from both sides; its style pack names San Francisco's too.

### 9.1 Using one

A style pack names the plugins its generators come from:

```json
{ "id": "bay-area", "name": "San Francisco Bay Area", "plugins": ["@pixelworlds/city-sf"], … }
```

A world view loads them, in its bake worker and on the main thread, before its first bake. A city pack is an npm package (`npm install pixelworld @pixelworlds/city-sf`; until their first release, pack both from this repository, [npm.md §1](npm.md#1-install)):

```ts
import { createWorldView } from "pixelworld/engine";
import { cityPlugin } from "@pixelworlds/city-sf";

const view = await createWorldView({ canvas, worldUrl: "/sf/", style: bayArea, plugins: [cityPlugin] });

// or let the style pack choose among the plugins a page has (the viewer and the consumer examples do this):
const PLUGINS = { [cityPlugin.name]: cityPlugin };
createWorldView({ canvas, worldUrl, style, plugins: (names) => names.flatMap((n) => PLUGINS[n] ?? []) });
```

- **A plugin the style names but the view doesn't load** is a console warning when the view starts (`the style pack bay-area needs the plugin @pixelworlds/city-sf, which this view didn't load: …`), and each model that needs it fails to bake with a `MissingGeneratorError`. San Francisco without its pack draws none of its rows or towers.
- **Without a view** (tests, tools, a page that generates models itself), register a plugin on the thread that generates: `import { register } from "@pixelworlds/city-sf"; register();`. Where the page has its own copy of the generators package (a bundled build), register through that copy: `registerPlugin(plugin)` from it, or `register(api)` with its `pluginApi(name)`.
- **Bundlers:** the descriptor's URL is `new URL("./worker.js", import.meta.url)`, so Vite (dev and build) and webpack 5 copy the pack's worker module into the app with no configuration; plain ESM needs an import map entry for the pack and for `pixelworld/generators`, which it imports. The [consumer examples](../examples/consumers/) do each, and CI checks them (§9.5).
- **In this repository:** the viewer (`apps/web`) loads the city packs listed in `apps/web/src/plugins.ts` (§9.7) for the worlds whose style names them, so the bench page and the hero bake tool, which drive the viewer, do too. `examples/minimal-viewer` and the example game pass `cityPlugin`.

### 9.2 The registry

| Function (`pixelworld/generators`) | What it does |
|---|---|
| `registerGenerators(record, { source?, replace? })`, `registerGenerator(name, fn, opts)` | register generators by name, under a source (a plugin's name; default `app`) |
| `hasGenerator(name)`, `getGenerator(name, group?)` | look one up; `getGenerator` throws a `MissingGeneratorError` |
| `listGenerators()` | every registered generator and its source, by name; the built-ins' source is `@pixelworlds/generators` |
| `unregisterGenerators(source)` | remove a source's generators (tests, hot reloads) |
| `definePlugin({ name, register })`, `registerPlugin(plugin)`, `loadPlugin({ name, url })` | plugins: define one in its worker module; register one in this realm; import one by URL and register it |

- **One registry per realm:** the main thread and each bake worker have their own. A plugin is registered in each realm that generates models, once.
- **Names:** registering a name again from the same source replaces it (a plugin registered twice, a hot reload). A name another source registered, a built-in included, is an error unless `replace: true`. A call with a bad entry registers nothing.
- **Known plugins:** core knows which generators the plugins published from this repository provide (`KNOWN_PLUGIN_GENERATORS`), as the pipeline's registry knows `datasf`, so their errors say what to load.

**Errors:**

| Case | Message |
|---|---|
| A generator of a known plugin that isn't loaded | `no generator named 'rowhouse' (asked for by building.rowhouse.victorian). 'rowhouse' comes with the plugin @pixelworlds/city-sf, which isn't loaded here: pass it to createWorldView({ plugins }), which loads it in the bake worker and on the main thread, or register it with registerPlugin() where models are generated outside a view. See docs/plugins.md.` |
| A generator nobody provides | `no generator named 'adobe' (asked for by building.residential.adobe). No plugin known here provides it: load the plugin that does (…), or register it with registerGenerators(). Registered generators: archBridge, blob, … See docs/plugins.md.` |
| A name another source has | `generator 'building' is already registered by @pixelworlds/generators, so my-city can't register it too (pass { replace: true } to replace it)` |
| A plugin's module that fails to load | `plugin @pixelworlds/city-sf (https://…/assets/worker-….js) failed to import: …`; `createWorldView` rejects with it |
| A module that defines no plugin, or another one | `https://… defines no plugin: the module must call definePlugin({ name, register }) (docs/plugins.md §9)`; `https://… defines the plugin x, not y` |
| A generator nobody registered, when a view starts (D-075) | `style pack "nyc": assets["building.rowhouse.brownstone"].generator: no generator named "brownstne" (did you mean "brownstone"?): none is registered, and no plugin known here provides it (docs/plugins.md §9)`; `createWorldView` rejects with it. Skipped while a plugin the style names isn't loaded |

### 9.3 How a plugin reaches the bake worker

Generators run where tiles are meshed: in the bake worker (`@pixelworlds/runtime`). Functions can't be posted to a worker, so a plugin travels as a **module URL**:

1. `createWorldView` resolves the plugins (the option, or its function given the style's `plugins`) and makes each URL absolute.
2. The main thread registers each: the descriptor's `plugin` if it carries one, else it imports the URL.
3. The bake service starts the worker and, once it is ready, sends `loadPlugins` with the names and URLs, before `init`.
4. The worker imports each URL in order. The module calls `definePlugin(plugin)`, which announces the plugin to the realm (a list under `Symbol.for("pixelworld.plugins")`). The worker takes the module's exported plugin (its default export, or `register` and `name` exports) or finds the announced one by name, and calls `plugin.register(api)` with an API bound to *its own* registry. Messages that arrive meanwhile wait.
5. The worker answers `pluginsLoaded` with each plugin's generators, or an `error`; `init` and the bakes follow. A plugin that fails to load fails `createWorldView`.
6. Without a worker (no WebGL2 in workers), the inline baker uses the main thread's registry, where step 2 put the plugins.

**Why the announcement:** a bundler builds the worker module on its own, and may drop its exports (Vite does for every worker bundle) or give it its own copy of `pixelworld/generators`. `definePlugin` is a side effect, so it survives either, and the plugin registers through the API it is given, never through its own copy's registry.

### 9.4 Writing one

A plugin package has its generators, a plugin object, the module the worker imports, and a main entry. San Francisco's:

```
packages/city-sf/                       npm: @pixelworlds/city-sf (D-074)
├── package.json                        exports src/ in the workspace and dist/ when packed (publishConfig);
│                                       pixelworld as a peer dependency
├── build.mjs                           the package build (tsup): dist/index.js, index.d.ts and worker.js
├── README.md                           its npm page
├── src/
│   ├── facades.ts, towers.ts, chinatown.ts   the generators
│   ├── generators.ts                   PLUGIN_NAME, sfGenerators(): name → generator
│   ├── plugin.ts                       the plugin: { name, register(api) }
│   ├── worker.ts                       what the bake worker imports: export default definePlugin(plugin)
│   └── index.ts                        cityPlugin (the descriptor), register(), the generators
└── test/                               the generators' tests, and the plugin's (plugin.test.ts)
```

The quickstart (§9.6) writes each of these files for a new pack, outside this repository.

**The descriptor** (`PluginDescriptor`): `name`; `url`, the module a worker imports; optionally `plugin`, the plugin itself, when the page bundles it anyway (the main thread then registers it instead of importing the URL); optionally `version`, which keys the tile cache beside the plugin's code (D-072; San Francisco's is its package version).

**Rules:**
- **Register through the API you are handed:** never into the generators package your module imports. The published bake worker is one file with its own registry, and your bundle's copy of the package is not it.
- **Deterministic:** a generator draws the same model for the same context, in every realm. Use `ctx.rand` (seeded), never `Math.random` or the clock. Baked tiles are cached by package, style, bake code and plugin: its name, `version` and code, the source of the generators it registers and the text of its module and what that imports by URL (D-072), so an edit shows after a reload, in a dev server too. A generator that throws is drawn as a missing-model marker and reported once, with the group, seed and footprint to reproduce it.
- **Generic depictions:** no names, lettering or logos (D-051), and the style guide's building rules (inside the footprint, no overhangs, glass only on the skin), as the built-ins keep. San Francisco's tests (`packages/city-sf/test`) check them over many footprints and seeds.
- **Colours come from the style:** a generator asks for ramps by role (`ctx.ramp("wall")`, or `ctx.ramps("wall")` for the `wall.*` variants) and the style pack maps roles to its ramps.
- **Names:** generators are named for what they draw (`rowhouse`, `brownstone`), the plugin for its npm package (`@pixelworlds/city-sf`; the pipeline's sources for the place are named after their data, `datasf`).

### 9.5 Shipping one

**The worker module must load on its own:** an ES module that is self-contained, or that imports only absolute URLs. A worker can't resolve a bare `pixelworld/generators`, so bundle what you import from it (`VoxelModel`, `definePlugin`) into the module. Don't build a plugin into the bake worker itself: it has a size budget, and plugins load by URL.
- **Published to npm:** build `worker.ts` into one self-contained file (`dist/worker.js`), and point the descriptor at it with the standard pattern, which Vite, webpack 5 and Rollup follow, copying the file into the app's build:

  ```ts
  export const cityPlugin = { name: PLUGIN_NAME, url: new URL("./worker.js", import.meta.url).href, version };
  ```

  - **Vite:** the dev server pre-bundles the pack and points the URL at the file in `node_modules`; a build emits it as `assets/worker-<hash>.js`, or inlines one under 4 KB as a `data:` URL (`build.assetsInlineLimit`), which works too unless a CSP forbids `data:` scripts.
  - **webpack 5:** emits it as an asset of its own, `<hash>.js`.
  - **`pixelworld` is a peer dependency,** external in `dist/index.js`, so `register()` and the generators use the app's copy and its one registry.
- **In this repository (Vite, from source):** the apps use the workspace's `src/` exports unbuilt. `src/index.ts` imports `./worker?worker&url`, which Vite builds into one file (`assets/worker-<hash>.js`, 28 KB) and serves from source in dev; the app's Vite config needs only `worker: { format: "es" }`, as the bake worker does. `?worker&url` is for apps: a library build would turn it into a root-absolute `/assets/…` path that the consuming app doesn't serve, so `build.mjs` rewrites that line to the `new URL` pattern.
- **Anywhere else** (a CDN, plain ESM): any absolute URL of the bundled module works, e.g. `{ name, url: "https://cdn.example.org/@my-org/city-nyc@1.0.0/dist/worker.js" }`. The entry imports `pixelworld/generators`, so an import map names it (or a CDN that rewrites bare imports serves it).

**San Francisco's pack, packed** (D-074): `pnpm --filter @pixelworlds/city-sf pack` builds and packs it (`prepack` runs `build.mjs`). On every push, CI's npm job:
- checks the tarball (`node tools/city-pack-check.mjs`, also in `pnpm package:check`): its files; its manifest (`pixelworld` its only peer, no dependencies, `publishConfig` applied); the descriptor's `new URL`; and the worker module, imported in Node with nothing beside it, which must define the plugin and register the generators core names for it (`KNOWN_PLUGIN_GENERATORS`). It also checks size budgets.
- draws San Francisco's flying level (`fixtures/sf-fly`) with both tarballs in each [consumer example](../examples/consumers/) (Vite dev and build, webpack 5, plain ESM): the pack's worker module must load from where the bundler put it, and at least half the frame must be drawn (`tools/consumers.mjs`). Without the pack, 4% is.

Releases: [npm.md §9](npm.md#9-releases).

**A loader of your own** (`loadPlugin` is the one to use) imports by URL with `import(/* @vite-ignore */ /* webpackIgnore: true */ url)`, so that bundlers leave the import to the browser.

**Testing:** register on the test's thread (`await register()`, or `registerPlugin(plugin)`) and generate with `generateModel` (`packages/city-sf/test`, and §9.6 step 8). For the worker path, `loadPlugin({ name, url }, importer)` takes an importer in place of `import()`; `packages/runtime/test/plugins.test.ts` runs the worker's message loop with the city pack's module that way.

### 9.6 Quickstart: a city pack of your own

A pack for a project outside this repository that depends on `pixelworld`: one generator, `adobe`, an adobe house for Las Vegas's residential streets, which a variant of the `desert-southwest` style pack names. About 90 lines in all. Each step below was run as written, against the packed `pixelworld`.

**1. Scaffold** the package, with `pixelworld` to build against (before its first release, its tarball: [npm.md §1](npm.md#1-install)):

```sh
mkdir city-vegas && cd city-vegas && npm init -y
npm install --save-dev pixelworld tsup typescript
```

Then, in `package.json`:

```json
{
  "name": "@my-org/city-vegas",
  "version": "0.1.0",
  "type": "module",
  "sideEffects": ["./dist/worker.js"],
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./worker.js": "./dist/worker.js"
  },
  "files": ["dist"],
  "scripts": { "build": "tsup", "prepack": "tsup" },
  "peerDependencies": { "pixelworld": "^0.4.0" }
}
```

- **`pixelworld` is a peer:** the app installs it, and the pack's entry must use the app's copy, which holds the one registry. Set the range to the version you build against.
- **`tsconfig.json`:** `"module": "ESNext"`, `"moduleResolution": "Bundler"`, `"strict": true`, `"resolveJsonModule": true`, `"include": ["src"]`.

**2. A generator** (`src/generators.ts`). A generator is `(ctx: GenContext) => VoxelModel`. It gets the footprint (`mask`, in voxels: x east, y south), the height (`heightVox`), a seeded `rand`, the ramp the style pack gives each role (`ramp("wall")`) and the asset's `params` (`param`), and returns a voxel model (z up). Keep the style guide's building rules: inside the footprint, no overhangs.

```ts
import { VoxelModel, type Generator } from "pixelworld/generators";

/** The plugin's name: the npm package's, and what style packs name in "plugins". */
export const PLUGIN_NAME = "@my-org/city-vegas";

/** An adobe house: walls over the footprint, a flat roof behind a parapet, viga ends, windows and a door. */
const adobe: Generator = ({ rand, ramp, param, mask, heightVox }) => {
  if (!mask) throw new Error("adobe needs a footprint");
  const { sx, sy, on } = mask;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < sx && y < sy && on[y * sx + x] === 1;
  const edge = (x: number, y: number) => !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
  const H = Math.max(3, Math.round(heightVox ?? 4)); // the walls' height
  const m = new VoxelModel(sx, sy, H + 1); // + the parapet
  const [wall, roof, trim, glass] = ["wall", "roof", "trim", "window"].map((role) => m.material(ramp(role)));
  const windows = param("windows", 0.5); // the share of wall bays with a window
  const door = Math.floor(rand() * sx); // along the south wall
  for (let y = 0; y < sy; y++)
    for (let x = 0; x < sx; x++) {
      if (!inside(x, y)) continue;
      m.fill(x, y, 0, x + 1, y + 1, H, wall);
      if (!edge(x, y)) {
        m.set(x, y, H - 1, roof);
        continue;
      }
      m.set(x, y, H, wall); // the parapet
      if ((x + y) % 2 === 0) m.set(x, y, H - 1, trim); // viga ends, flush with the wall
      if ((x + y) % 3 === 1 && H >= 4 && rand() < windows) m.set(x, y, 1, glass);
      if (x === door && !inside(x, y + 1)) m.fill(x, y, 0, x + 1, y + 1, 2, trim);
    }
  return m;
};

/** The pack's generators by the names style packs give them: a function, so a page that only loads the descriptor doesn't bundle them. */
export function cityGenerators(): Record<string, Generator> {
  return { adobe };
}
```

**3. The plugin and its worker module.** The plugin registers the generators through the API it is handed, in each realm that loads it. The worker module is what the bake worker imports by URL; `definePlugin` announces the plugin there, so it is found even if a bundler drops the module's exports.

```ts
// src/plugin.ts
import type { Plugin } from "pixelworld/generators";
import { PLUGIN_NAME, cityGenerators } from "./generators";

export const plugin: Plugin = { name: PLUGIN_NAME, register: (api) => api.registerGenerators(cityGenerators()) };

// src/worker.ts
import { definePlugin } from "pixelworld/generators";
import { plugin } from "./plugin";

export default definePlugin(plugin);
```

**4. The descriptor** (`src/index.ts`): the worker module's URL beside the built entry, which bundlers follow, and the version, which keys the tile cache.

```ts
import { registerPlugin, type PluginDescriptor } from "pixelworld/generators";
import { version } from "../package.json";
import { PLUGIN_NAME } from "./generators";
import { plugin } from "./plugin";

export const vegasPlugin: PluginDescriptor = { name: PLUGIN_NAME, url: new URL("./worker.js", import.meta.url).href, version };

/** The generators on this thread, without a view (tests, tools). */
export const register = () => registerPlugin(plugin);
export { PLUGIN_NAME, cityGenerators } from "./generators";
export { plugin };
```

**5. Build** with `tsup.config.ts`, then `npm run build`. It writes `dist/index.js` (2 KB, `pixelworld` left external), `dist/index.d.ts`, and `dist/worker.js`: 2.5 KB, self-contained, with what it uses of `pixelworld` bundled in.

```ts
import { defineConfig } from "tsup";

export default defineConfig([
  // the entry: the descriptor and register(); pixelworld, a peer, stays external
  { entry: { index: "src/index.ts" }, format: "esm", target: "es2022", dts: true, sourcemap: true },
  // the worker module: one self-contained file (a worker can't resolve "pixelworld/generators")
  { entry: { worker: "src/worker.ts" }, format: "esm", target: "es2022", noExternal: [/.*/], minify: true },
]);
```

**6. A style pack that names it:** a copy of `worlds/_styles/desert-southwest/style.json` with a new `id`, the plugin, and the group pointed at the generator. Its roles map to ramps the pack already has.

```json
{
  "id": "desert-adobe",
  "name": "Desert Southwest, adobe",
  "plugins": ["@my-org/city-vegas"],
  "assets": {
    "building.residential": {
      "generator": "adobe",
      "ramps": { "wall": "stucco", "roof": "roof-flat", "trim": "bark", "window": "glass" },
      "params": { "windows": 0.6 }
    }
  }
}
```

Only the changed keys are shown; the rest of the copy stays as it is.

**7. Load it into a view.** In the app, run `npm pack` in the pack, then `npm install ../city-vegas/my-org-city-vegas-0.1.0.tgz`. That gives an installed copy, as npm would; a linked directory would bring the pack's own `pixelworld`. Serve the world (here `fixtures/southwest-walk`) and the style pack from `public/`:

```ts
import { createWorldView } from "pixelworld/engine";
import { vegasPlugin } from "@my-org/city-vegas";

const view = await createWorldView({
  canvas: document.querySelector<HTMLCanvasElement>("#world")!,
  worldUrl: "/worlds/southwest-walk/",
  // the world names desert-southwest: draw it with the variant, which names the plugin
  style: () => fetch("/styles/desert-adobe/style.json").then((r) => r.json()),
  plugins: [vegasPlugin],
  camera: { x: 14, y: 70, zoom: 3 }, // a residential neighbourhood west of the Strip
});
await view.ready();
```

- **Bundlers:** Vite's dev server and build need no configuration, nor does webpack 5 (§9.5).
- **Your own world:** a world built for your city names your pack in its region spec's `style`, and needs no override.
- **While you change a generator,** turn the tile cache off (`cache: false`), or reload with a new `version`: tiles are cached by the plugin's name and version, not its code.

**8. Test it** with vitest: register on the test's thread and generate one model with the style pack's catalog.

```ts
import { readFileSync } from "node:fs";
import { generateModel, type AssetCatalog } from "pixelworld/generators";
import { expect, it } from "vitest";
import { register } from "../src/index";

await register();
const style = JSON.parse(readFileSync("styles/desert-adobe/style.json", "utf8")) as { assets: AssetCatalog; ramps: object };
const rampIds = new Map(Object.keys(style.ramps).map((name, i) => [name, i + 1]));

it("draws an adobe house over its footprint, the parapet one voxel up", () => {
  const mask = { sx: 8, sy: 6, on: new Uint8Array(48).fill(1) };
  const m = generateModel(style.assets, rampIds, "building.residential", { seed: 1, mask, heightVox: 5 });
  expect([m.sx, m.sy, m.sz]).toEqual([8, 6, 6]);
  expect(m.get(0, 0, 5)).not.toBe(0); // the parapet
  expect(m.get(3, 3, 5)).toBe(0); // the roof, behind it
});
```

**Publishing:** `npm publish --access public` (`prepack` builds). Before that, check what `npm pack` writes: `dist/worker.js` must import nothing, and `dist/index.js` must hold the `new URL("./worker.js", import.meta.url)`. In this repository, `tools/city-pack-check.mjs` checks San Francisco's that way.

### 9.7 The viewer's city packs

The viewer (`apps/web`) loads the city packs listed in one file, `apps/web/src/plugins.ts`, for the worlds whose style pack names them:

```ts
import { cityPlugin as sanFrancisco } from "@pixelworlds/city-sf";
import { vegasPlugin } from "@my-org/city-vegas";

export const CITY_PACKS: PluginDescriptor[] = [sanFrancisco, vegasPlugin];
```

- **Adding one:** add it to `apps/web/package.json` (`"workspace:*"` for a package in `packages/`, else its npm version or tarball), run `pnpm install`, and list its descriptor in `CITY_PACKS`. A style pack that names a plugin missing from the list gets a console warning that says where to add it.
- **A pack in `packages/`** follows `packages/city-sf`: its workspace `exports` name `src/`, and its descriptor imports `./worker?worker&url`, so the viewer runs it unbuilt and reloads it as you edit (§9.5).
- **`?style=<id>`** draws a world with another style pack from `worlds/_styles/<id>/style.json` in place of the one its manifest names, without rebuilding the world. A variant pack is a copy with a new `id`; if it names a plugin, the viewer loads that plugin from `CITY_PACKS`. For example, `http://localhost:5173/?world=/southwest-walk/&style=desert-adobe&fx=14&fy=70&cache=0`.
- **`?cache=0`** skips the tile cache. A generator's edits show on the next reload without it, since the cache key includes a hash of each plugin's code (D-072).
