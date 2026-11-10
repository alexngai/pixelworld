# The viewer: keys, URL parameters and debug API

The reference viewer is `apps/web` (`pnpm dev`, http://localhost:5173), a client of the engine ([library.md §7](library.md#7-as-built-the-engine-m4-step-1)). This page is its reference: the keys, every URL parameter (they are read in `apps/web/src/main.ts`), the `window.__pixelworld` debug API that the e2e tests, the bench page and the hero tool drive, and the model preview page beside it.

## 1. Keys and mouse

| Input | Action |
|---|---|
| WASD / drag | pan (the camera stops following the rover) |
| arrow keys | drive the rover (it can't climb cliffs or steep slopes, or enter water) |
| Q / E | rotate the view 90° |
| 1–6 | zoom (integer upscale of the baked pixels) |
| F | toggle camera follow |
| N | toggle no-clip (drive through water and up cliffs) |
| T | day / night palette (styles with a night palette; no re-bake) |
| L | next scale level in the package's list (flying → driving → walking → flying), at the same place |
| V | traffic on or off (worlds with routes) |
| G | fog on or off (styles with fog over this world and level) |
| I | data sources and licences; Esc closes them |
| H | hide or show the HUD, help and layer panel |
| Alt+click | log what is under the pointer to the console (`inspect`, §3) |

The layer panel (top right, with the HUD) switches layers and their sublayers: traffic's road vehicles, rail and transit, and ferries.

## 2. URL parameters

Every parameter is optional. The e2e tests open views with `hud=0&cache=0&w=640&h=360&traffic=0&fog=0` plus a place, so a scene is fixed and fresh.

**The world and the place**

| Parameter | Default | What it does |
|---|---|---|
| `world` | `/southwest/` | World package URL (a directory with `manifest.json`); the committed ones in `fixtures/` are served at `/<name>/`, e.g. `/grand-canyon-m0/`, `/sf/`, `/sf-walk/`, `/southwest-fly/` |
| `style` | the world's | A style pack id from `worlds/_styles/` to draw the world with instead of the one its manifest names: try a variant pack without rebuilding the world |
| `rover` | the world's start | `x,y`: the rover's start cell |
| `at` | | `lon,lat`: start at a place (worlds with a geo grid); outside this level the rover starts at the world's start and the HUD says so. Level switching (L) uses it |
| `fx`, `fy` | | Focus cell: the camera looks there and doesn't follow the rover |
| `rot` | `0` | View rotation, 0–3 quarter turns |
| `zoom` | auto | Integer upscale; auto is about one baked pixel per 640 canvas pixels |
| `w`, `h` | the window | A fixed canvas size in pixels, one canvas pixel per CSS pixel (tests, the bench) |

**What is drawn**

| Parameter | Default | What it does |
|---|---|---|
| `objects=0` | on | No placed objects: terrain, roads and paths only |
| `scatter=0` | on | No decorative scatter (vegetation and rocks the client adds where a level asks) |
| `paint=0` | on | No painted-over hero landmarks (the plain bake, D-053) |
| `palette=night` | day | Start at night, where the style has a night palette |
| `marker=0` | shown | Don't draw the rover (clean screenshots) |
| `hud=0` | shown | Hide the HUD, help line, attribution and layer panel |
| `cache=0` | on | Skip the IndexedDB tile cache: every tile is baked fresh by the code as it is now. Use it when you change code that bakes tiles (generators, the baker, a city pack) ([CONTRIBUTING.md §6](../CONTRIBUTING.md#6-the-tile-cache)) |

**Traffic** (D-060; worlds whose package has routes)

| Parameter | Default | What it does |
|---|---|---|
| `traffic=0` | on | No ambient traffic |
| `trafficLayers` | all | The sublayers drawn, comma-separated: `road`, `rail`, `ferry` |
| `trafficSeed` | `1` | Seed of the simulation |
| `trafficDensity` | `1` | Vehicles per route length, as a multiple |
| `trafficTime` | `0` | Start the simulation at this many seconds of play |
| `trafficPause=1` | running | Start paused (a fixed scene) |

**Fog** (an atmosphere layer, D-063; styles with fog over the world)

| Parameter | Default | What it does |
|---|---|---|
| `fog=0` | on | Start with fog off |
| `fogTime` | `0` | The fog's clock in seconds of play (its drift is a function of time) |
| `fogPause=1` | drifting | Don't let it drift |

**Tools**

| Parameter | Default | What it does |
|---|---|---|
| `bench=1` | off | Keep every tile bake's timings for `tileBakes()` (the bench page, `apps/web/bench.html`) |

## 3. The debug API: `window.__pixelworld`

Set once the world view is created; call `ready()` before reading pixels or stats. Typed in `apps/web/src/main.ts` (`PixelworldDebug`).

| Function | What it does |
|---|---|
| `ready()` | Resolves once a frame is drawn with every visible tile and sprite, and nothing is left to bake |
| `stats()` | Renderer, bake mode, tiles baked and from the cache, chunks, GPU memory, timings, rotation, the rover's cell and height, level, palette, traffic and fog |
| `inspect(x, y)` | What is under a canvas point (CSS pixels from its top-left); see below |
| `pan(dx, dy)` | Pan by internal pixels (stops following) |
| `lookAt(x, y, h?)` | Centre on a cell at a height (steps; default the surface there) |
| `setZoom(z)` | Set the zoom, as the 1–6 keys do |
| `setRover(x, y)` | Put the rover on a cell |
| `lonLat()` | Lon/lat under the rover (worlds with a geo grid), else null |
| `switchLevel(name?)` | Reload at the same place in another scale level (the next one without a name) |
| `palette()` | The day palette, RGBA per index (256 entries) |
| `traffic()` | Traffic's state: enabled, paused, ticks, time, counts by kind, sublayers, vehicles drawn; null without routes |
| `trafficStep(s)` | Run the traffic simulation forward by whole ticks (seconds of play) |
| `setTraffic({ enabled, paused, layers })` | Switch traffic, pause it or choose its sublayers |
| `fog()` | Fog's state (enabled, paused, time, whether any is drawn); null where the world has none |
| `setFog({ enabled, paused, time })` | Switch fog, pause its drift or set its clock |
| `timeFrames(n)` | Redraw the current frame n times, waiting for the GPU: mean milliseconds per frame |
| `tileBakes()` | Every tile baked so far with its timings (only with `bench=1`) |
| `bakeHero(id)` | Bake a landmark alone in all four rotations (the offline hero tool, D-053; `tools/hero-bake.mjs`) |

**`inspect(x, y)`** answers "which ramp, surface or generator drew this pixel?" (`apps/web/src/inspect.ts`):

```js
__pixelworld.inspect(320, 180)
// {
//   color: "#4f535c", index: 173, ramp: "roof-slate", shade: 4,
//   usedBy: ["asset:building.house/gable", "asset:building.tower/deco:cap.slate", …],
//   cell: { x: 195.9, y: 350.3, h: 32.5 },
//   ground: { x: 194.6, y: 349.0, h: 30, surface: "urban", surfaceRamp: "urban", road: "residential" },
//   lonLat: [-122.43284, 37.77652],
//   object: { group: "building.rowhouse.victorian", generator: "rowhouse", source: "@pixelworlds/city-sf",
//             roles: ["gable"], anchor: [196.7, 350.3], bounds: […], base: 28.9, top: 32.5 },
//   landmark: null,
// }
```

- **Colour:** the pixel's palette entry in the palette shown now (day or night): its index, ramp and shade (0 darkest … 5 lightest), and `usedBy`, every place the style pack uses that ramp (`surface:`, `strata:<set>/<band>`, `roads.`, `paths.`, `asset:<group>/<role>`, `atmosphere.fog`). `ramp` is `background` or `silhouette` for those entries.
- **Ground:** where the view ray through the pixel meets the drawn ground (as `query.pick` finds it), its surface and the surface's ramp in the style, and its road class. `cell` is where the ray meets what is drawn: the object's side or top when there is one, else the ground.
- **Object:** the placed object drawn at the pixel, with its asset group, the generator the style names for it and who registered that generator (`@pixelworlds/generators` for the built-ins, a plugin's name), the asset roles in the pixel's ramp, and its landmark registry id. Bakes keep no per-pixel object id, so the object is the nearest one the view ray passes through (by footprint and estimated height, `query.objectsAt`) whose asset draws in the pixel's ramp. Decorative scatter, traffic and the rover aren't placed objects; a part drawn above an object's estimated top (a spire) is missed.
- **Fog and traffic** change pixels over the bake: open the view with `fog=0&traffic=0` to inspect the bake itself.
- **Alt+click** on the canvas logs the same to the console.

## 4. The model preview: `pnpm models`

`apps/web/model.html` shows one asset group's models alone, without loading a world: each model is generated with the style pack's roles and parameters (`generateModel`), meshed at the object voxel scale as a world tile meshes it and baked by the real baker, in each rotation, by day and night. Saving a generator, a city pack or a style pack reloads the page onto the same models (about half a second). `pnpm models` starts the dev server and opens it; with `pnpm dev` running, open http://localhost:5173/model.html.

| Parameter | Default | What it does |
|---|---|---|
| `style` | `desert-southwest` | Style pack id |
| `group` | `building.residential` | Asset group in that pack: its generator, roles and parameters |
| `generator` | the group's | Draw the group's roles and parameters with another registered generator (one not wired into a pack yet) |
| `seeds` | `1` | Seeds, as a list and ranges: `1-4,9` |
| `fp` | `8x6` | Footprints in voxels (x by y), comma-separated: buildings, landmarks, city blocks |
| `h` | `24` | Heights in voxels, comma-separated; every seed × footprint × height is a row (48 at most) |
| `size` | the kind's | Vehicles (`vehicle.*`): length × width × height in voxels; default as traffic draws the kind on a 25 m driving level |
| `part`, `variant` | | Vehicles: the car of a consist, and the paint variant |
| `hints` | | The data's hints to buildings (D-055): `front:2,floors:3,year:1900,corner:1,roof:gabled,facade:glass` |
| `rot` | `0,1,2,3` | Rotations shown |
| `palette` | both | `day` or `night` only |
| `zoom` | `3` | Integer upscale, 1–8 |
| `ground` | the urban surface's ramp | The ramp of the plate under the model (it shows the cast shadow); `0` for none |

- **Units:** a voxel is a 2×1 px top and 1 px tall at 1× (D-033). Vegetation, rocks and props get only a seed, as in a world (they are drawn instanced); vehicles get a size.
- **City packs:** every workspace package with a `src/plugin.ts` exporting `plugin` (the layout of `packages/city-sf`, D-071) is registered, so its generators appear in the generator list. The page notes when the chosen style pack doesn't name the plugin in `plugins`: a world view wouldn't load it.
- **Debug API:** `window.__models.ready()` resolves once the current parameters are drawn; `state()` lists the rows, their errors and the cells drawn (`e2e/model.spec.ts`).
