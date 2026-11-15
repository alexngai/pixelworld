# Make your own world

This guide takes you from nothing to a rendered world of a place you choose. The worked example is Jerome, Arizona, an old copper-mining town on a steep hillside. Its spec is [`worlds/jerome/region.yaml`](../worlds/jerome/region.yaml). The reference at the end lists every key a region spec can hold.

Contents:
1. What you need
2. Pick a place and a scale
3. Write the spec
4. Check it
5. Build it
6. View it
7. Make it richer
8. Bigger worlds: levels, the warp and the editor
9. When something goes wrong
10. Spec reference

## 1. What you need

- **Tools:** Node 22.12 or later with pnpm, and [uv](https://docs.astral.sh/uv/) (it installs Python 3.12 or later for the pipeline).
- **A checkout of this repository**, set up once:

  ```sh
  pnpm install
  cd pipeline && uv sync
  ```

- **Network:** a build downloads only what its area needs, over HTTP range requests:
  - `prd-tnm.s3.amazonaws.com`: USGS 3DEP elevation
  - `esa-worldcover.s3.eu-central-1.amazonaws.com`: ESA WorldCover land cover
  - `overturemaps-us-west-2.s3.amazonaws.com`: Overture Maps roads, rivers, buildings and land use
  - `dataforgood-fb-data.s3.amazonaws.com` (canopy trees) and `usgs-lidar-public.s3.amazonaws.com` (lidar heights), only for specs that ask for them
- **The download cache:** downloads are cached in `pipeline/.cache/`, so a rebuild reads nothing again. Set `PIXELWORLD_CACHE=/some/dir` to keep the cache elsewhere, or to share one between checkouts and worktrees. A town needs a few megabytes; the whole Southwest about a gigabyte.
- **Coverage:** the built-in elevation sources are the USGS's, so they cover the United States. ESA WorldCover and Overture Maps are worldwide. Elsewhere the built-in `copernicus-glo30` (worldwide), `ign-rgealti` (France) and `gsi-dem` (Japan) cover terrain, or a terrain source from an installed package ([plugins.md](plugins.md) §4).

## 2. Pick a place and a scale

- **Bounds:** a lon/lat box, `[west, south, east, north]`. Read the corners off any map: on openstreetmap.org, right-click and choose "Show address", or use "Export" to draw a box. Jerome is `[-112.130, 34.738, -112.098, 34.762]`, about 2.9 × 2.7 km around Cleopatra Hill.
- **Metres per cell** sets what the world is. A cell is drawn as one isometric tile, so the area divided by the cell size is the world's size in tiles:

  | Scale | Metres per cell | Reads as | Example |
  |---|---|---|---|
  | Walking | 10–20 | streets, single houses, street trees | `sf-walk` (10 m), Jerome (20 m) |
  | Driving | 25–100 | blocks, hills, a city's road network | `sf` (25 m), `sf-fly` (100 m) |
  | Flying, regions | 100–1,500 | valleys, ranges, highways; use a warp (§8) | `southwest` (400 m base) |

  Keep a single-scale world under about 2,000 cells a side. Jerome is 148 × 134 cells; San Francisco at 25 m is 584 × 645. `pixelworld check` warns when a world gets very large.
- **Elevation source:** `usgs-3dep-13arcsec` (10 m) for cells of 40 m or less, `usgs-3dep-1arcsec` (30 m) for coarser ones. Set its `overview` close to the cell size: `1` reads full resolution, `2` reads half, and so on.
- **Start:** where the viewer opens, a `{ lon, lat }` inside the bounds. Jerome starts on Main Street.

## 3. Write the spec

A spec is a YAML file. Keep it in `worlds/<id>/region.yaml` in this repository, so the style packs (`worlds/_styles/`) and the landmark registry (`worlds/_landmarks/`) are found beside it. It can live anywhere else too: the pipeline then looks for `_styles/` and `_landmarks/` in the directories above it, and falls back to this checkout's.

The smallest spec that builds:

```yaml
id: jerome                 # the package's name: fixtures/jerome, ?world=/jerome/
name: Jerome, Arizona      # shown in the viewer
bounds: [-112.130, 34.738, -112.098, 34.762]   # west, south, east, north
metersPerCell: 20
style: desert-southwest    # a style pack in worlds/_styles/
start: { lon: -112.1138, lat: 34.7489 }
sources:
  dem: { kind: usgs-3dep-13arcsec, overview: 1 }
  landcover: { kind: esa-worldcover-2021, overview: 1 }
  features: { kind: overture, release: 2026-10-21.0 }
  roads: { classes: [primary, secondary, tertiary, residential] }
```

That gives terrain, land cover, water and roads. [`worlds/jerome/region.yaml`](../worlds/jerome/region.yaml) adds what makes it Jerome: steeper slopes (`maxSlope: 3`), more road classes and streams, grid-snapped streets at 1.5× their width, micro-terrain, buildings and pinyon-juniper woodland. §7 explains each.

- **Style packs:** `desert-southwest` (the Southwest's: red rock, desert, adobe) and `bay-area` (San Francisco's). A style pack decides what every surface and object looks like; the spec only names semantic groups.
- **The Overture release** (`sources.features`) is pinned so builds repeat. Releases are named like `2026-10-21.0`, the one this repository's worlds use.
- **Scale levels** (`level:`, `levels:`) are optional. A world with one level needs neither.

## 4. Check it

`pixelworld check` reads the spec and reports every problem with its file, line and key, in under a second and without downloading anything:

```
$ cd pipeline
$ uv run pixelworld check ../worlds/jerome/region.yaml
../worlds/jerome/region.yaml: ok (jerome: 148×134 cells at 20 m, style desert-southwest)
```

The same spec with four mistakes, kept outside the repository:

```
$ uv run pixelworld check ~/jerome-typos.yaml
jerome-typos.yaml:16: verticalExageration: unknown key; did you mean 'verticalExaggeration'?
jerome-typos.yaml:17: maxSlope: must be a whole number, not 2.7
jerome-typos.yaml:19: style: no style pack 'desert' in …/worlds/_styles; did you mean 'desert-southwest'? (there: bay-area, desert-southwest); a pack of your own goes in a _styles/ directory beside the spec
jerome-typos.yaml:26: sources.roads.classes[5]: unknown value 'residental'; did you mean 'residential'? (use one of: motorway, trunk, primary, secondary, tertiary, residential, living_street, unclassified, service)
jerome-typos.yaml: 4 problems
```

It also checks types and ranges, required keys, a start outside the bounds, landmark ids, and that the sources the spec names exist. `pixelworld build` runs the same checks first, so a bad spec never starts a build, and exits with 2.

## 5. Build it

```sh
cd pipeline
uv run pixelworld build ../worlds/jerome/region.yaml --out ../fixtures/_try/jerome
```

- **Where it goes:** `--out` is the package directory. Without it a world builds into `fixtures/<id>`, which for this repository's own worlds overwrites the committed package. `fixtures/_try/` is git-ignored, and the viewer serves it (§6).
- **Progress** goes to stderr, a line per stage with the time since the start, and the summary to stdout. A rebuild from the cache:

  ```
  pixelworld: building ../worlds/jerome/region.yaml into ../fixtures/_try/jerome
  [   0.0 s] spec: ../worlds/jerome/region.yaml
  [   0.0 s] layout: a uniform grid
             region jerome: 148×134 cells at 20 m
  [   0.0 s] terrain: elevation and land cover (downloads are cached)
  [   0.0 s] ways: roads, paths and rivers from Overture
  [   0.0 s] grid: water, roads and cells
             snap: 502/730 road edges made octilinear, nodes moved p99 1.78 cells
             roads: {'cells': 996, 'edges': 1023, 'discontinuous_edges': 0, 'steep_edges': 0, 'components': 2, 'split_segments': 0, 'disconnected_junctions': 0}
  [   0.7 s] micro-terrain
             micro: K=4, 592×536 micro-cells
  [   0.8 s] objects: buildings, vegetation, landmarks
             objects: {'building.commercial': 37, 'building.residential': 335, 'shrub': 730, 'tree.pinyon-juniper': 1432}
  [   1.4 s] package: chunks, objects and the geo grid
  [   1.8 s] routes: ambient traffic
  [   1.9 s] write: ../fixtures/_try/jerome
  wrote ../fixtures/_try/jerome in 2 s (148×134 cells, 9 chunks, 2,534 objects, 119 routes)
    packageHash c107bdf6274d48554968fc2cfde7d216342f87ed48ad751e470a106ca955f5c6
    stages: grid 0.7 s, objects 0.6 s, package 0.5 s, routes 0.1 s, micro-terrain 0.1 s
    report: ../fixtures/_try/jerome/build-report.json
  ```

- **Time:** from an empty cache, Jerome's first build took about 2.5 minutes on a shared 4-core machine and left 12 MB in the cache. Its elevation and land cover took 3 s; most of the rest was a one-time index of Overture's files (roads, water and buildings), read once per Overture release. A second town in the same release downloads a few megabytes in seconds. A rebuild from the cache takes about 2 s. The whole Southwest takes about 3 minutes (§8).
- **The report:** `build-report.json` in the package holds the package hash, the cell count, object counts, the road report and the routes. `--json` prints it to stdout as well.
- **Deterministic:** the same spec and cached inputs give the same package, byte for byte, and the same `packageHash`.
- **Safe:** a build writes into a scratch directory beside `--out` and moves the package into place only when every stage has succeeded. A failed build leaves `--out` as it was.
- **Exit codes:**

  | Code | Meaning |
  |---|---|
  | 0 | done |
  | 1 | the package was written, but its road report found problems: split segments, disconnected junctions or steep edges (see `build-report.json`) |
  | 2 | the spec or the command line is invalid; nothing was built |
  | 3 | the build failed (a download, or a bug); `--out` was left as it was |

## 6. View it

The viewer is the web app in `apps/web`. Start it once and leave it running:

```sh
pnpm dev        # in the repository root: http://localhost:5173
```

If port 5173 is taken, `pnpm dev --port 5200` serves it on another; pass that URL to `pixelworld view --viewer`.

- **A package under `fixtures/`:** open `http://localhost:5173/?world=/_try/jerome/`. The viewer serves `fixtures/` as is, so a rebuild shows on the next reload.
- **A package anywhere else:** `pixelworld view` serves it and prints the URL to open:

  ```
  $ uv run pixelworld view /tmp/worlds/jerome
  serving /tmp/worlds/jerome (Jerome, Arizona) at http://127.0.0.1:8766/
  open http://localhost:5173/?world=http://127.0.0.1:8766/
  ```

  It warns if the viewer isn't running, or if the package's style pack isn't one this viewer has. Ctrl+C stops it.
- **In the viewer:** `WASD` or a drag pans, the arrow keys drive the rover, `Q`/`E` rotate, `1`–`6` zoom, `T` switches to night, `V` toggles traffic and `I` lists the data sources and their licences. The panel at the bottom left lists every key; `H` hides the panels.
- **The edit loop:** change the spec, rebuild (about 2 s for Jerome from the cache), reload the page. The viewer then bakes the tiles in view; without a GPU (software rendering) that can take a minute.

## 7. Make it richer

Each of these is a section of the spec; the reference (§10) lists their keys.

- **Relief:** `verticalExaggeration` (default 2.5) multiplies every height. `maxSlope` (1–3, default 2) is the steepest slope drawn as a slope, in height steps per cell: steeper ground becomes terraces and cliffs. Jerome uses 3, so its streets climb rather than step.
- **Micro-terrain** (`micro: { k: 4 }`): K × K finer heights inside each cell, so hillsides and road cuts read smoothly. Read them from a finer overview with `micro.dem`.
- **Snapping** (`snap:`): roads straighten toward the 8 grid directions, which draw as clean pixel lines, and buildings turn and move with their streets. Most worlds want the values Jerome uses.
- **Widths** (`widths:`): roads and paths at their real width, times `scale`. Without it they're drawn at the style pack's fixed width.
- **Rivers** (`sources.rivers`): Overture water lines; `[river]` unless you list more (Jerome adds `stream`).
- **Buildings** (`objects.buildings`): Overture's footprints and heights, everywhere in the bounds or in `bounds` boxes. `houseMaxArea` draws small residential footprints as houses.
- **Vegetation** (`objects.vegetation`): trees and shrubs scattered by ESA WorldCover class (`tree`, `shrub`, `grass`, `bare`, …) at a spacing and density, or from the canopy height map (`canopy: 3`, trees 3 m and taller) where it has data.
- **Street furniture** (`objects.streetTrees`, `objects.streetProps`): rows along roads of given classes, or at junctions.
- **Landmarks** (`objects.landmarks`): ids from the registry, [`worlds/_landmarks/`](../worlds/_landmarks/README.md), or inline `{ group, lon, lat, hm }`.
- **Building types** (`objects.typology`): rules that retype buildings by shape, street and public records, as San Francisco's rowhouses are. Records come from a facts source (`sources.facts`; [plugins.md](plugins.md) §3).
- **Ground** (`ground:`): park lawns and yards from land use.
- **Traffic** (`routes:`): every build writes ambient traffic routes along its roads, and along Overture's rail and ferry lines. `--no-routes` skips them; `pixelworld routes` adds them later without a rebuild.
- **Objects by chunk** (D-123): `pixelworld object-chunks <package>` adds a built package's placed objects by chunk beside the whole file, for a game server that loads part of the world at a time (`openWorld`). `pixelworld coarse-heights <package>` adds heights by block of 8 × 8 cells, which such a server reads where it hasn't loaded the ground. The `southwest` and `southwest-fly` fixtures have both.

## 8. Bigger worlds: levels, the warp and the editor

- **Scale levels:** a region can be built at several scales, each its own package: flying, driving, walking. A level spec `extends:` the region's spec and overrides what differs (`worlds/sf/walk.yaml`). List every level in the region spec's `levels:` and name each spec's own in `level:`; the viewer's L key then moves between them at the same place. See [architecture.md](architecture.md) §3.5.
- **The warp:** an elastic map that draws focus areas finer than the open country around them, for regions too big for one scale. It lives in its own file (`warp: warp.yaml`, `worlds/southwest/warp.yaml`). See [architecture.md](architecture.md) §6.
- **The editor** edits a warp's focus areas and pins on the real map and re-solves it in about a second:

  ```sh
  cd pipeline && uv run pixelworld serve ../worlds/southwest/region.yaml --out ../fixtures/_try/southwest
  pnpm --filter @pixelworlds/editor dev     # http://localhost:5180
  ```

  - **Save** writes the spec's warp file; it saves only a warp file the spec names itself.
  - **Build world** runs the same build as `pixelworld build`, routes included, into `--out`. "Open viewer" opens a package under `fixtures/`; for one elsewhere, use `pixelworld view <out>`.
  - **Scale:** the source map, the focus areas' sizes and the solver's mesh scale with the region, from a 3 km town to the 400 km Southwest. A warp is still a tool for regions: in a town, a focus area of a few hundred metres has few cells to work with.
  - `PIXELWORLD_API` points the editor at a pipeline server on another port: `PIXELWORLD_API=http://127.0.0.1:8770 pnpm --filter @pixelworlds/editor dev`, with `pixelworld serve … --port 8770`.
- **Time:** the Southwest (1155 × 709 cells, 228 chunks, 5,841 objects, 5,619 traffic routes) rebuilt from the cache in 171 s on a shared 4-core machine: routes 49 s, terrain 33 s, gridding 30 s, objects, micro-terrain and writing the package about 20 s each. Its warp solve adds about 20 s when it isn't cached. `pixelworld build` prints the time each stage took.

## 9. When something goes wrong

| What you see | What to do |
|---|---|
| `…: unknown key; did you mean …?` (exit 2) | A typo: fix the spelling. An unknown key is an error, never silently ignored. |
| `no style pack 'x'` (exit 2) | Use one of the packs listed. A pack of your own goes in a `_styles/<name>/style.json` beside (or above) the spec. |
| `no terrain source named 'x'` (exit 2) | Use `usgs-3dep-13arcsec` or `usgs-3dep-1arcsec`, or install a package that provides it (`pixelworld plugins` lists the sources by role). |
| `sources.features.release: Overture has no release 'x'` (exit 2) | Use a release that exists, such as `2026-10-21.0`. |
| `a download failed` (exit 3) | Check the network or proxy (the hosts in §1) and build again; what was already downloaded is cached. |
| `the build failed in the … stage` with a traceback (exit 3) | A bug: report it with the traceback. If the stage was `routes`, `--no-routes` builds the world without traffic. |
| `the road report found problems` (exit 1) | The package is written. Roads that don't join up are usually fixed by `snap:` (as in Jerome), or by finer cells. |
| The viewer says `no style pack x` | The package names a style pack this viewer doesn't have (`pixelworld view` warns about this). |
| A blank map in the viewer | The tiles are still baking; under software rendering they take a while. Reload if a rebuild changed the package. |
| Elevation is flat or missing | The built-in elevation sources cover the United States only. |

## 10. Spec reference

Every key a region spec can hold, generated from the pipeline's schema ([`schema.py`](../pipeline/src/pixelworld_pipeline/schema.py)), which also checks specs. `pixelworld reference` prints the same tables.

- **Units:** a box is `[west, south, east, north]` in degrees. Distances are metres unless the key's name or meaning says otherwise (`radiusKm`, `minCells`, snapping's cells).
- **Null:** any optional key can be set to `null`, which unsets it. In a level spec, null removes a section the spec it extends has (`warp: null`).
- **Defaults:** "—" means none: the feature is off, or the key isn't needed, when it's absent.

<!-- spec-reference: generated by `pixelworld reference --write docs/worlds.md` (pipeline/src/pixelworld_pipeline/schema.py); don't edit it here -->

<a id="spec-top"></a>
#### Top level

| Key | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | **required** | The package id: the directory it's built into (`fixtures/<id>`) and the viewer's `?world=/<id>/`. |
| `name` | string | **required** | The world's name, shown in the viewer. |
| `extends` | string | — | Another spec file (relative to this one) this one builds on: mappings merge key by key, anything else replaces, null removes a section. |
| `bounds` | [west, south, east, north] (lon/lat) | **required** | The area in degrees: `[west, south, east, north]`. |
| `metersPerCell` | number, > 0 (m) | **required** | Real metres per cell (uniform; a `warp` varies it). |
| `verticalExaggeration` | number, > 0 | 2.5 | Heights are drawn this many times true (1: real slopes). |
| `maxSlope` | integer, 1–3 | 2 | The steepest slope tile, in height steps per cell; steeper ground becomes terraces and cliffs. |
| `chunkSize` | integer, 8–1024 | 64 | Cells per package chunk side. |
| `style` | string | **required** | The style pack that draws it: a directory of `worlds/_styles/` (`desert-southwest`, `bay-area`). |
| `start` | [mapping](#spec-start) | **required** | Where the viewer starts: `{ lon, lat }` inside bounds. |
| `sources` | [mapping](#spec-sources) | **required** | Where the data comes from. |
| `smoothing` | [mapping](#spec-smoothing) | — | Smooth elevation before it's cut into steps (coarse worlds). |
| `geology` | [mapping](#spec-geology) | — | Geology provinces: which strata set cliffs show (the style pack's `provinces`). |
| `terrain` | [mapping](#spec-terrain) | — | Rules for water and cliffs. |
| `micro` | [mapping](#spec-micro) | — | Micro-terrain: finer heights inside each cell. |
| `render` | [mapping](#spec-render) | — | Draw a fine world smaller on screen. |
| `warp` | [a file, or a mapping](#spec-warp) | — | An elastic map: magnify focus areas over a background scale. Usually a file of its own (`warp: warp.yaml`), which the editor writes. |
| `level` | string | — | This spec's level, one of `levels`. |
| `levels` | [list of mappings](#spec-levels) | — | Every scale level of the region (each its own package). |
| `snap` | [mapping](#spec-snap) | — | Isometric snapping of roads and buildings to the 8 grid directions. |
| `widths` | [mapping](#spec-widths) | — | Draw ways at their real width (else at the style's fixed width). |
| `ground` | [mapping](#spec-ground) | — | Ground surfaces from land use (lawns, yards). |
| `objects` | [mapping](#spec-objects) | — | Buildings, vegetation, street furniture and landmarks. |
| `routes` | [mapping](#spec-routes) | — | Ambient traffic routes. |

<a id="spec-start"></a>
#### `start`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `lon` | number, in [-180, 180] | **required** | Longitude. |
| `lat` | number, in [-90, 90] | **required** | Latitude. |

<a id="spec-sources"></a>
#### `sources`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `dem` | [mapping](#spec-sources-dem) | **required** | Elevation: the terrain source. |
| `landcover` | [mapping](#spec-sources-landcover) | **required** | Land cover: surfaces, water and vegetation. |
| `features` | [mapping](#spec-sources-features) | **required** | The vector map (D-110). |
| `facts` | [mapping](#spec-sources-facts) | — | Building facts (D-055). |
| `canopy` | [mapping](#spec-sources-canopy) | — | Tree canopy heights. |
| `heights` | [mapping](#spec-sources-heights) | — | Measured building heights (D-052). |
| `importance` | [mapping](#spec-sources-importance) | — | Place fame, for warped layouts. |
| `roads` | [mapping](#spec-sources-roads) | **required** | The road network. |
| `rivers` | [mapping](#spec-sources-rivers) | `{ subtypes: [river] }` | River lines. |
| `lakes` | [mapping](#spec-sources-lakes) | — | Overture's water areas drawn as still water beside land cover's (D-103): a garden's pond, a castle's moat. Each is levelled as a lake. |
| `paths` | [mapping](#spec-sources-paths) | — | Footways and cycleways (walking levels). |
| `rails` | [list of mappings](#spec-sources-rails) | — | Rails drawn in the street, each segment by the first rule it matches. |

<a id="spec-sources-dem"></a>
#### `sources.dem`

Other keys here are the source's options.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `kind` | string | **required** | The terrain source: `usgs-3dep-13arcsec` (10 m, United States), `usgs-3dep-1arcsec` (30 m, United States), `copernicus-glo30` (30 m, worldwide), `gsi-dem` (Japan), `ign-rgealti` (France), or an installed one (`pixelworld plugins` lists them). |
| `overview` | 1, 2, 4, 8, … | 4 | Read the source's overview this many times coarser than its full resolution (1: full). Match it to the cell size: 1 for 10–20 m cells from a 10 m source. |
| `resampling` | one of `average`, `bilinear`, `cubic`, `nearest`, `mode`, `min`, `max`, `med` | `average` | How source pixels become cell corners: `average` when cells are coarser than the source, `bilinear` when they're finer. |

<a id="spec-sources-landcover"></a>
#### `sources.landcover`

Other keys here are the source's options.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `kind` | string | **required** | The land-cover source: `esa-worldcover-2021` (10 m, worldwide), or an installed one giving ESA WorldCover's class codes. |
| `overview` | 1, 2, 4, 8, … | 16 | Read the source's overview this many times coarser than its full resolution (1: full). Match it to the cell size: 1 for 10–20 m cells from a 10 m source. |

<a id="spec-sources-features"></a>
#### `sources.features`

Other keys here are the source's options.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `kind` | string | **required** | The map's roads, paths, rivers, rail, water, land use and buildings: `overture` (with `release:`, an Overture Maps release like `2026-10-21.0`, pinned so builds repeat), or an installed source. |

<a id="spec-sources-facts"></a>
#### `sources.facts`

Other keys here are the source's options.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `kind` | string | **required** | Per-building facts (year built, storeys, use) for `objects.typology`: `datasf`, `pluto`, `apur`, `plateau`, `areas`, or an installed source. |

<a id="spec-sources-canopy"></a>
#### `sources.canopy`

Other keys here are the source's options.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `kind` | string | `meta-chm` | Tree heights for `canopy:` rules: `meta-chm` (WRI and Meta, 1 m, worldwide). |

<a id="spec-sources-heights"></a>
#### `sources.heights`

Other keys here are the source's options.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `kind` | string | `usgs-3dep-lidar` | Building heights for `objects.buildings.lidar`: `usgs-3dep-lidar` (with `project:`, a USGS 3DEP EPT project). |

<a id="spec-sources-importance"></a>
#### `sources.importance`

Other keys here are the source's options.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `kind` | string | `wikidata` | Famous places for `warp.importance`: `wikidata`. |

<a id="spec-sources-roads"></a>
#### `sources.roads`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `classes` | list of `motorway`, `trunk`, `primary`, `secondary`, `tertiary`, `residential`, `living_street`, `unclassified`, `service` | **required** | The Overture road classes drawn. |
| `excludeSubclasses` | list of strings | — | Overture road subclasses left out (e.g. `parking_aisle`, `driveway`); ramps (`link`) always are. |
| `joinIslands` | list of strings | — | Subclasses kept only where a road needs them to join the network. |

<a id="spec-sources-rivers"></a>
#### `sources.rivers`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `subtypes` | list of strings | `[river]` | Overture water lines burned in as rivers (`river`, `stream`, `canal`, …). Lakes and the sea come from land cover. |

<a id="spec-sources-lakes"></a>
#### `sources.lakes`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `classes` | list of strings | **required** | Overture water area classes (`pond`, `moat`, `lake`, `reservoir` …). |

<a id="spec-sources-paths"></a>
#### `sources.paths`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `classes` | list of `path`, `cycleway`, `steps`, `footway`, `sidewalk`, `crosswalk`, `pedestrian` | **required** | The path classes drawn (sidewalks and crosswalks are Overture footways of those subclasses). |

<a id="spec-sources-rails"></a>
#### `sources.rails[]`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `draw` | one of `street`, `cable`, `train` | **required** | How the track is drawn: `street` (in the road), `cable` (with the cable's slot), `train` (its own way). |
| `rail` | list of strings | **required** | Overture rail classes the rule takes. |
| `names` | list of strings | — | Only lines whose name contains one of these. |
| `unnamed` | true/false | — | Only lines without a name. |
| `bounds` | [west, south, east, north] (lon/lat) | — | Only lines wholly inside this box. |
| `bundle` | number, > 0 (m) | — | Parallel tracks within this distance are drawn as one corridor along its centre line, with its track count (D-097; micro-terrain worlds). |

<a id="spec-smoothing"></a>
#### `smoothing`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `bilateralCells` | number, ≥ 0 | 0 | Edge-preserving smoothing radius (cells). |
| `bilateralMeters` | number, ≥ 0 (m) | 0 | …across height differences up to this. |

<a id="spec-geology"></a>
#### `geology`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `default` | string | `default` | The province everywhere else. |
| `provinces` | [list of mappings](#spec-geology-provinces) | — | Areas with their own strata. |

<a id="spec-geology-provinces"></a>
#### `geology.provinces[]`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | **required** | The province's name (the style pack's strata set). |
| `polygon` | list of [lon, lat] | **required** | Its outline. |

<a id="spec-terrain"></a>
#### `terrain`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `minLakeArea` | number, ≥ 0 (m²) | 0 | Smaller water bodies are dropped. |
| `maxLakeRelief` | number, ≥ 0 (m) | — | Water whose ground spans more than this isn't a lake. |
| `riverWidthMeters` | number, > 0 (m) | — | Rivers drawn this wide. |
| `cliffSlope` | number, > 0 | — | Cells steeper than this (rise over run) are rock. |

<a id="spec-micro"></a>
#### `micro`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `k` | integer, 2–8 | **required** | Micro-cells per cell side: 2, 4 or 8. |
| `dem` | [mapping](#spec-micro-dem) | — | Overrides `sources.dem` for the micro-terrain (usually a finer overview). |
| `smooth` | mapping of surface → metres | — | Smooth these surfaces' micro-terrain over this many metres. |
| `maxSlope` | integer, ≥ 3 | `3` | The steepest micro-cell drawn as a slope, in micro-steps; steeper ones are flat terraces with walls between. Raise it to draw sheer walls as faces. |

<a id="spec-micro-dem"></a>
#### `micro.dem`

Other keys here are the source's options.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `kind` | string | `sources.dem.kind` | Another terrain source. |
| `overview` | 1, 2, 4, 8, … | `sources.dem.overview` | Read the source's overview this many times coarser than its full resolution (1: full). Match it to the cell size: 1 for 10–20 m cells from a 10 m source. |
| `resampling` | one of `average`, `bilinear`, `cubic`, `nearest`, `mode`, `min`, `max`, `med` | `average` | How source pixels become cell corners: `average` when cells are coarser than the source, `bilinear` when they're finer. |

<a id="spec-render"></a>
#### `render`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `scale` | number, in (0, 1] | **required** | A cell's size on screen relative to a normal one. |
| `tileSize` | integer, ≥ 1 | 32 | Cells per baked tile side. |

<a id="spec-warp"></a>
#### `warp`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `background` | number, > 0 (m) | **required** | Metres per cell where nothing is magnified. |
| `focus` | [list of mappings](#spec-warp-focus) | — | Areas drawn finer than the background. |
| `pins` | [list of mappings](#spec-warp-pins) | — | Places held at given cells. |
| `method` | one of `v1`, `v2` | `v2` | The solver. |
| `meshKm` | number, > 0 | 2 | The solver's mesh spacing; keep it well under the smallest focus radius. |
| `focusScale` | number, > 0 | 1 | Multiplies every focus area's metresPerCell (levels). |
| `vertical` | [mapping](#spec-warp-vertical) | — | Exaggerate relief where the map is magnified, so it keeps its proportions. |
| `importance` | [mapping](#spec-warp-importance) | — | Magnify famous places automatically (`importance.json`, `pixelworld importance`). |

<a id="spec-warp-focus"></a>
#### `warp.focus[]`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | **required** | Its name, in the build report. |
| `lon` | number, in [-180, 180] | **required** | Centre longitude. |
| `lat` | number, in [-90, 90] | **required** | Centre latitude. |
| `radiusKm` | number, > 0 | **required** | Inside this radius the target holds. |
| `falloffKm` | number, ≥ 0 | `radiusKm` | It blends back to the background over this distance. |
| `metersPerCell` | number, > 0 | **required** | The target scale inside the area. |
| `reliefMax` | number, > 0 | — | A lower cap on relief exaggeration here. |

<a id="spec-warp-pins"></a>
#### `warp.pins[]`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | **required** | Its name. |
| `lon` | number, in [-180, 180] | **required** | The place's longitude. |
| `lat` | number, in [-90, 90] | **required** | The place's latitude. |
| `x` | number | **required** | The world cell it's held at (x). |
| `y` | number | **required** | The world cell it's held at (y). |

<a id="spec-warp-vertical"></a>
#### `warp.vertical`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `gamma` | number, ≥ 0 | 1 | Relief grows as (base / local m per cell)^gamma. |
| `referenceSigmaKm` | number, > 0 | 6 | Relief is measured from elevation smoothed over this. |
| `min` | number, > 0 | 0.5 | Smallest relief factor. |
| `max` | number, > 0 | 4 | Largest relief factor. |

<a id="spec-warp-importance"></a>
#### `warp.importance`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `minSitelinks` | number, ≥ 0 | 20 | Places with fewer Wikidata sitelinks are ignored. |
| `sigmaKm` | number, > 0 | 4 | How far a place's pull reaches. |
| `maxMagnification` | number, ≥ 1 | 2 | The most a place magnifies. |
| `reference` | number, > 0 | 100 | Sitelinks that give full magnification. |

<a id="spec-levels"></a>
#### `levels[]`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | **required** | The level's name (`fly`, `drive`, `walk`). |
| `world` | string | **required** | The id of the package built for it. |
| `label` | string | — | Shown in the viewer. |

<a id="spec-snap"></a>
#### `snap`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `roads` | [mapping](#spec-snap-roads) | — | Straighten roads toward the 8 grid directions, which draw as clean pixel lines. |
| `buildings` | [mapping](#spec-snap-buildings) | — | Turn buildings to the grid and move them with their streets. |

<a id="spec-snap-roads"></a>
#### `snap.roads`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `angle` | number, in [0, 45] | 16 | Edges within this many degrees of a grid direction run along it. |
| `simplify` | number, ≥ 0 | 0.75 | Cells of wiggle removed first. |
| `deviation` | number, ≥ 0 | 1 | How far (cells) an in-between road may stray to keep long runs. |
| `maxShift` | number, ≥ 0 | 2 | No junction moves further than this (cells). |
| `directions` | 8 or 16 | 8 | Snap to the 8 grid directions, or 16 with the 2:1 ones (D-082). |
| `keep` | [list of mappings](#spec-snap-roads-keep) | — | Streets left as mapped (a crooked street). |

<a id="spec-snap-roads-keep"></a>
#### `snap.roads.keep[]`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `bounds` | [west, south, east, north] (lon/lat) | **required** | Ways wholly inside this box keep their real geometry. |
| `class` | one of `motorway`, `trunk`, `primary`, `secondary`, `tertiary`, `residential`, `living_street`, `unclassified`, `service`, `brick` | — | Draw the kept roads as this class (e.g. `brick`). |
| `width` | number, > 0 (m) | — | Their width. |
| `widen` | number, > 0 | — | Swing their bends this many times wider. |
| `within` | number, > 0 (m) | 15 | …but never past this far from the axis. |
| `surface` | string | — | The surface between the swung bends. |

<a id="spec-snap-buildings"></a>
#### `snap.buildings`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `angle` | number, in [0, 45] | 12 | Footprints within this many degrees turn to the grid. |
| `follow` | number, ≥ 0 | 3 | Objects within this many cells of a road move with it. |
| `clearRoads` | [mapping](#spec-snap-buildings-clearroads) | — | Move buildings off the drawn roads. |

<a id="spec-snap-buildings-clearroads"></a>
#### `snap.buildings.clearRoads`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `nudgeMeters` | number, ≥ 0 | 5 | Nudge buildings off the drawn asphalt by up to this. |

<a id="spec-widths"></a>
#### `widths`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `scale` | number, > 0 | 1 | Ways are drawn this many times their real width. |
| `minCells` | number, ≥ 0 | 0.1 | …never narrower than this (cells). |
| `centrelines` | true/false | false | Draw ways along their own centre lines rather than their cells' connections (any angle, curves; D-082). |
| `roads` | mapping of road class → metres | — | Real width per road class (defaults: motorway 16, trunk and primary 14, secondary 12, tertiary 10, residential 8, unclassified 7, living_street 6, service 5). |
| `paths` | mapping of path class → metres | — | Real width per path class (defaults: pedestrian 8, crosswalk 4, sidewalk, footway and steps 3, cycleway 2.5, path 2). |
| `lanes` | [mapping](#spec-widths-lanes) | — | Lanes and medians. |
| `ways` | [list of mappings](#spec-widths-ways) | — | Widths and lanes for particular roads; the first match wins. |

<a id="spec-widths-lanes"></a>
#### `widths.lanes`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `meters` | number, > 0 (m) | 3.5 | A lane's width. |
| `lines` | true/false | true | Store lane counts (lane lines are drawn). |
| `medianMeters` | number, ≥ 0 | 60 | How far apart a divided road's carriageways may run. |

<a id="spec-widths-ways"></a>
#### `widths.ways[]`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `names` | list of strings | — | Roads whose name contains one of these. |
| `bounds` | [west, south, east, north] (lon/lat) | — | Roads whose middle lies in this box. |
| `oneway` | true/false | — | Only one-way carriageways (true) or two-way roads (false). |
| `meters` | number, > 0 (m) | — | Their width. |
| `lanes` | integer, 1–15 | — | Their lane count. |

<a id="spec-ground"></a>
#### `ground`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `lawn` | [mapping](#spec-ground-lawn) | — | Parks, golf courses, pitches and gardens. |
| `yard` | [mapping](#spec-ground-yard) | — | Open ground beside houses. |

<a id="spec-ground-lawn"></a>
#### `ground.lawn`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `landUse` | list of strings | **required** | Overture land-use classes that are lawns (`park`, `golf_course`, …). |
| `over` | list of strings | `[grass]` | Surfaces a lawn replaces. |
| `keep` | list of strings | — | Natural land (Overture base `land` classes) left as it is. |
| `paved` | list of strings | — | Land-use classes inside a park left as they are (`pedestrian`: courts and plazas). |
| `maxSlope` | number, ≥ 0 | 0.2 | A park steeper than this (rise over run) stays wild. |
| `slopeMeters` | number, ≥ 0 | 50 | Slopes are measured over about this distance. |
| `wooded` | [mapping](#spec-ground-lawn-wooded) | — | Lawn under open tree cover. |
| `spread` | [mapping](#spec-ground-lawn-spread) | — | Spread lawns into the open ground around them. |

<a id="spec-ground-lawn-wooded"></a>
#### `ground.lawn.wooded`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `over` | list of strings | `[woodland]` | Tree-covered surfaces that can be lawn. |
| `maxCover` | number, in [0, 1] | 0.5 | …where the canopy covers at most this share. |
| `canopy` | number, ≥ 0 (m) | 3 | Trees at least this tall count as cover. |

<a id="spec-ground-lawn-spread"></a>
#### `ground.lawn.spread`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `over` | list of strings | `[grass]` | Surfaces it spreads into. |
| `meters` | number, ≥ 0 | 0 | How far. |

<a id="spec-ground-yard"></a>
#### `ground.yard`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `near` | list of strings | `[building.residential]` | Building groups (prefixes) that have yards. |
| `over` | list of strings | `[urban]` | Surfaces a yard replaces. |
| `reachMeters` | number, ≥ 0 | 15 | Cells this close to a house are yard. |
| `paved` | number, in [0, 1] | 0 | Share of yard cells left paved. |

<a id="spec-objects"></a>
#### `objects`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `buildings` | [mapping](#spec-objects-buildings) | — | Buildings from Overture footprints (`{}` for the defaults). |
| `typology` | [mapping](#spec-objects-typology) | — | What each building is (rowhouse, tower, …), by rules. |
| `vegetation` | [list of mappings](#spec-objects-vegetation) | — | Trees and shrubs scattered by land cover. |
| `streetTrees` | [list of mappings](#spec-objects-streettrees) | — | Rows of trees along roads. |
| `streetProps` | [list of mappings](#spec-objects-streetprops) | — | Street lights and signals: rows, or at junctions. |
| `walls` | [list of mappings](#spec-objects-walls) | — | Walls along Overture's barrier lines, in segments turned with them (D-104). |
| `landmarks` | list of ids or mappings | — | Landmarks: registry ids (`worlds/_landmarks/`), `{ id, …overrides }`, or inline mappings. |
| `landmarkDepiction` | string | `generic` | Which registry depiction to draw. |
| `depiction` | [mapping](#spec-objects-depiction) | — | How big things are drawn at this scale level. |
| `lowrise` | [mapping](#spec-objects-lowrise) | — | Built-up land as blocks of low buildings (coarse levels). |

<a id="spec-objects-buildings"></a>
#### `objects.buildings`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `bounds` | a box or a list of boxes | the whole region | Only buildings in this box (or these boxes). |
| `minArea` | number, ≥ 0 (m²) | 30 | Smaller footprints are left out. |
| `towerMeters` | number, ≥ 0 (m) | 45 | Buildings this tall are towers. |
| `podiumMeters` | number, ≥ 0 (m) | 15 | A tower's podium height. |
| `tiers` | true/false | off | Parts standing on others (setback tiers) are drawn from the ground where they stand over their building, not dropped. |
| `houseMaxArea` | number, ≥ 0 (m²) | 0 | Residential footprints up to this size are houses (0: none). |
| `simplifyMeters` | number, ≥ 0 (m) | 2 | Footprint simplification. |
| `courtyards` | true/false | false | Keep footprints' courtyards (their holes, as `fh`) instead of filling them. |
| `implausible` | [mapping](#spec-objects-buildings-implausible) | on | Footprints in parks that are really trees are dropped (null keeps every one). |
| `lidar` | [mapping](#spec-objects-buildings-lidar) | — | Heights and tower parts from measured heights (`sources.heights`: USGS 3DEP lidar). |

<a id="spec-objects-buildings-implausible"></a>
#### `objects.buildings.implausible`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `maxArea` | number, ≥ 0 (m²) | 200 | At most this big… |
| `minHeight` | number, ≥ 0 (m) | 8 | …at least this tall… |
| `minAspect` | number, ≥ 0 | 2.5 | …and this many times taller than wide. |
| `landUse` | list of strings | `ground.lawn.landUse` | The park land uses it applies in. |

<a id="spec-objects-buildings-lidar"></a>
#### `objects.buildings.lidar`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `res` | number, > 0 (m) | 4 | Height grid resolution. |
| `depth` | integer, ≥ 0 | 6 | Point-cloud octree depth read. |
| `towerGap` | number, ≥ 0 (m) | 25 | Roofs this far above the median are tower parts. |
| `minTowerArea` | number, ≥ 0 (m²) | 600 | Smallest tower part. |

<a id="spec-objects-typology"></a>
#### `objects.typology`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `rules` | [list of mappings](#spec-objects-typology-rules) | — | Matched in order; the first match picks the group. |
| `roofHints` | true/false | false | The facts' roof shape (`gabled`, `hipped`, `flat` …) becomes the generator's roof hint where Overture gives none. |

<a id="spec-objects-typology-rules"></a>
#### `objects.typology.rules[]`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `group` | string | **required** | The group a matching building gets. |
| `from` | list of strings | the generic building groups | Groups the rule may replace. |
| `year` | [from, to) | — | Year built. |
| `uses` | list of strings | — | Uses (`residential`, `mixed`, `commercial`, `industrial`, `civic`). |
| `hoods` | list of strings | — | Neighbourhood names (from the facts source). |
| `classes` | list of strings | — | Class codes: exact, or a prefix ending in `*`. |
| `roofs` | list of strings | — | Roof shapes. |
| `materials` | list of strings | — | Facade materials (from the facts source; any case). |
| `names` | list of strings | — | Overture names (a building's primary name; its parts share it), exactly. |
| `grounds` | list of strings | — | Overture land-use classes (OSM's `landuse=religious`: `religious`, `cemetery` …) the building's centroid stands in. |
| `kinds` | list of strings | — | Overture classes (OSM's `building=*`: `temple`, `shrine`, `house` …; its parts share it), exactly. |
| `minWidth` | number, ≥ 0 (m) | — | Narrowest. |
| `maxWidth` | number, ≥ 0 (m) | — | Widest. |
| `minDepth` | number, ≥ 0 (m) | — | Shallowest. |
| `maxDepth` | number, ≥ 0 (m) | — | Deepest (the footprint's long side). |
| `maxFill` | number, in [0, 1] | — | Most share of its smallest enclosing rectangle the footprint fills (a ring, a C). |
| `minParty` | number, in [0, 1] | — | Least share of outline shared with neighbours. |
| `maxParty` | number, in [0, 1] | — | Most share of outline shared with neighbours. |
| `floors` | [min, max] | — | Storeys. |
| `minHeight` | number, ≥ 0 (m) | — | Lowest. |
| `maxHeight` | number, ≥ 0 (m) | — | Tallest. |
| `onWater` | true/false | — | Stands over water. |
| `corner` | true/false | — | On a corner lot. |
| `bounds` | a box or a list of boxes | — | Only buildings whose centroid is in this box (or these boxes): a neighbourhood. |

<a id="spec-objects-vegetation"></a>
#### `objects.vegetation[]`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `group` | string | **required** | The semantic group placed (the style pack draws it). |
| `spacing` | number, > 0 (m) | **required** | Grid spacing of candidate spots. |
| `density` | number, in [0, 1] | 1 | Share of spots kept. |
| `landcover` | list of `tree`, `shrub`, `grass`, `crop`, `built`, `bare`, `snow`, `water`, `wetland`, `mangrove`, `moss` | — | ESA WorldCover classes it grows on: `tree`, `shrub`, `grass`, `crop`, `built`, `bare`, `snow`, `water`, `wetland`, `mangrove`, `moss`. |
| `canopy` | number, ≥ 0 (m) | — | Instead: where the canopy height map is at least this tall. |
| `byLandcover` | mapping of class → groups | — | Pick the group by the land cover it stands on. |

<a id="spec-objects-streettrees"></a>
#### `objects.streetTrees[]`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `group` | string | **required** | The semantic group placed. |
| `roads` | list of `motorway`, `trunk`, `primary`, `secondary`, `tertiary`, `residential`, `living_street`, `unclassified`, `service`, `brick` | **required** | Road classes it lines. |
| `spacing` | number, > 0 (m) | 12 with `canopy` | Distance between them. |
| `offset` | number, ≥ 0 (m) | 12 (0 with `canopy`) | Distance from the road's centre line. |
| `name` | string | — | Only roads whose name contains this. |
| `notName` | string | — | Not on roads whose name contains this (D-109). |
| `bounds` | [west, south, east, north] (lon/lat) | — | Only within this box. |
| `landcover` | list of `tree`, `shrub`, `grass`, `crop`, `built`, `bare`, `snow`, `water`, `wetland`, `mangrove`, `moss` | — | Only on these land-cover classes. |
| `across` | true/false | — | Over the road, turned across it (strung lanterns). |
| `along` | true/false | — | On one side only, turned to run with the road (utility poles and their wires). |
| `diagonal` | string | — | With `along`: the group placed where the road runs diagonally, for a model drawn along x = y. |
| `slants` | list of strings | — | With `along`: two groups for the 2:1 directions (26.6° and 63.4° from east), for models drawn along (2, −1) and (1, −2). |
| `canopy` | number, ≥ 0 (m) | — | On the verge past the drawn asphalt, where the canopy map has trees this tall. |
| `kerb` | number, ≥ 0 (m) | 2 | With `canopy`: distance past the drawn asphalt. |
| `search` | number, ≥ 0 (m) | 3 | With `canopy`: how far to look for a mapped tree. |
| `density` | number, in [0, 1] | 1 | With `canopy`: share of spots kept. |

<a id="spec-objects-streetprops"></a>
#### `objects.streetProps[]`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `group` | string | **required** | The semantic group placed. |
| `roads` | list of `motorway`, `trunk`, `primary`, `secondary`, `tertiary`, `residential`, `living_street`, `unclassified`, `service`, `brick` | **required** | Road classes it lines. |
| `spacing` | number, > 0 (m) | 12 with `canopy` | Distance between them. |
| `offset` | number, ≥ 0 (m) | 12 (0 with `canopy`) | Distance from the road's centre line. |
| `name` | string | — | Only roads whose name contains this. |
| `notName` | string | — | Not on roads whose name contains this (D-109). |
| `bounds` | [west, south, east, north] (lon/lat) | — | Only within this box. |
| `landcover` | list of `tree`, `shrub`, `grass`, `crop`, `built`, `bare`, `snow`, `water`, `wetland`, `mangrove`, `moss` | — | Only on these land-cover classes. |
| `across` | true/false | — | Over the road, turned across it (strung lanterns). |
| `along` | true/false | — | On one side only, turned to run with the road (utility poles and their wires). |
| `diagonal` | string | — | With `along`: the group placed where the road runs diagonally, for a model drawn along x = y. |
| `slants` | list of strings | — | With `along`: two groups for the 2:1 directions (26.6° and 63.4° from east), for models drawn along (2, −1) and (1, −2). |
| `canopy` | number, ≥ 0 (m) | — | On the verge past the drawn asphalt, where the canopy map has trees this tall. |
| `kerb` | number, ≥ 0 (m) | 2 | With `canopy`: distance past the drawn asphalt. |
| `search` | number, ≥ 0 (m) | 3 | With `canopy`: how far to look for a mapped tree. |
| `density` | number, in [0, 1] | 1 | With `canopy`: share of spots kept. |
| `at` | one of `junctions` | — | Two per junction of 3+ roads, on opposite corners. |
| `wires` | string | — | Strung props (D-098): one row on each street's left at `offset` (default 3 m), joined through junctions where the street runs on straight, and a span of this group from each prop to the next. |

<a id="spec-objects-walls"></a>
#### `objects.walls[]`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `group` | string | **required** | The group of a wall's segment. |
| `classes` | list of strings | **required** | Overture barrier classes (`retaining_wall`, `wall` …). |
| `spacing` | number, ≥ 0 (m) | **required** | Segment length. |
| `diagonal` | string | — | The group on diagonal lines. |
| `slants` | list of strings | — | The groups on the 2:1 lines. |

<a id="spec-objects-landmarks"></a>
#### `objects.landmarks[]`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | — | A landmark in the registry (`worlds/_landmarks/<id>.yaml`). |
| `group` | string | — | Inline: its semantic group. |
| `lon` | number, in [-180, 180] | — | Inline: anchor longitude. |
| `lat` | number, in [-90, 90] | — | Inline: anchor latitude. |
| `line` | [[lon, lat], [lon, lat]] | — | Inline: a line landmark's ends (dams, bridges). |
| `hm` | number, ≥ 0 (m) | — | Height. |
| `crestMeters` | number (m) | — | A line landmark's crest or deck, above sea level. |
| `baseMeters` | number (m) | — | A line landmark's foot. |
| `reservoir` | number, ≥ 0 (m) | — | A dam's lake stands this far below its crest. |
| `thicknessM` | number, ≥ 0 (m) | 60 | Across a line landmark. |
| `bulge` | number | 0.15 | How far a line landmark bows to its left. |
| `segmentCells` | number, > 0 | — | A line landmark's pieces are at most this long. |
| `snap` | true/false | — | A bridge turns to its road's grid direction. |
| `clear` | number, ≥ 0 (m) | 0 | Other buildings are kept this far away. |
| `cut` | number, ≥ 0 (m) | — | An anchored landmark with `baseMeters`: the ground this close is lowered to its foot (an arch's fin or a balanced rock's spike, which the elevation holds; D-139). |
| `orient` | integer | 0 | Quarter turns. |
| `scale` | number, > 0 | `depiction.landmarks.scale` | Drawn this many times its size. |
| `replaces` | list of strings | — | Overture building names or ids it stands in for. |
| `footprint` | true/false | off | Drawn on the footprint of the building it replaces, not on a box. |
| `parts` | [list of mappings](#spec-objects-landmarks-parts) | — | Sub-objects along a line landmark. |
| `hero` | true/false | — | Baked offline and painted over. |

<a id="spec-objects-landmarks-parts"></a>
#### `objects.landmarks[].parts[]`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `group` | string | **required** | The part's group. |
| `along` | number, in [0, 1] | 0.5 | Where along the line. |
| `offset` | number (m) | 0 | How far to the line's left. |
| `aboveCrest` | number (m) | 0 | Its top above the crest. |
| `height` | number, ≥ 0 (m) | — | Its height. |

<a id="spec-objects-depiction"></a>
#### `objects.depiction`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `heightStretch` | number, > 0 | — | Objects drawn this many times taller (overrides the style pack's). |
| `scatter` | number, ≥ 0 | — | Density of the client's scatter (shrubs, rocks) by surface. |
| `vehicleScale` | number, > 0 | — | Traffic drawn at most this many times its size. |
| `buildings` | [mapping](#spec-objects-depiction-buildings) | — | Oversize buildings on coarse levels. |
| `landmarks` | [mapping](#spec-objects-depiction-landmarks) | — | Oversize landmarks. |

<a id="spec-objects-depiction-buildings"></a>
#### `objects.depiction.buildings`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `scale` | number, > 0 | 1 | Drawn this many times their size. |
| `minHeightMeters` | number, ≥ 0 (m) | 0 | Lower buildings are left out. |

<a id="spec-objects-depiction-landmarks"></a>
#### `objects.depiction.landmarks`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `scale` | number, > 0 | 1 | Drawn this many times their size. |

<a id="spec-objects-lowrise"></a>
#### `objects.lowrise`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `group` | string | `city.blocks` | The group. |
| `heightMeters` | number, ≥ 0 (m) | 8 | Their real height. |

<a id="spec-routes"></a>
#### `routes`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `rail` | [false, or a mapping](#spec-routes-rail) | — | Rail routes (false: none). |
| `ferries` | true/false | true | Ferry routes. |

<a id="spec-routes-rail"></a>
#### `routes.rail`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `unnamedTram` | one of `cablecar`, `lightrail`, `streetcar`, `train` | — | Tram lines with no name anywhere run this vehicle. |
| `classes` | mapping of class → vehicle | — | Vehicle per Overture rail class (adds to the defaults). |

<!-- spec-reference: end -->
