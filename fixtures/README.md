# Committed world packages

World packages the dev app serves and the tests use. They are served as static files by the web app (`apps/web/vite.config.ts` sets this directory as Vite's `publicDir`).

**Your own worlds:** build them into `fixtures/_try/<id>` (git-ignored) and open `http://localhost:5173/?world=/_try/<id>/`, or build them anywhere and serve them with `uv run pixelworld view <dir>`. A build without `--out` writes `fixtures/<id>`, which overwrites the committed package of that id. See [docs/worlds.md](../docs/worlds.md).

## grand-canyon-m0

128×128 cells at a uniform 160 m per cell (no warp), with 2.5× vertical exaggeration (26.1 m per height step) and slope tiles up to 2 steps per cell. Covers the South Rim at Grand Canyon Village, the Colorado River near Phantom Ranch, and the North Rim near Bright Angel Point.

Regenerate:

```sh
cd pipeline && uv run python -m pixelworld_pipeline.fixtures.grand_canyon_m0
# try other exaggerations (1.0 = real slopes) into a scratch directory, then open
# http://localhost:5173/?world=/_try/
uv run python -m pixelworld_pipeline.fixtures.grand_canyon_m0 --exaggeration 3.5 --max-slope 3 --out ../fixtures/_try
```

`fixtures/_try/` is git-ignored. Downloads are cached under `grand-canyon-m0/` in the shared download cache (`$PIXELWORLD_CACHE`, else `pipeline/.cache/`).

Sources and licenses:
- Elevation: USGS 3D Elevation Program (3DEP) 1/3 arc-second DEM. Public domain.
- Colorado River centerline: © OpenStreetMap contributors, ODbL 1.0. Because of this, the package is a derivative database under the ODbL; see `docs/data-sources.md` §6.

Surface classes (woodland, forest, scrub, rock, sand) are generated from elevation and steepness for M0. Real land cover arrives in M1.

## southwest

The US Southwest on the M2 elastic map, built from [`worlds/southwest/region.yaml`](../worlds/southwest/region.yaml) and its warp, [`warp.yaml`](../worlds/southwest/warp.yaml).

- **Size:** 1155×709 cells in 228 gzipped chunks. The chunks are 5.61 MB, `objects.json.gz` is 0.22 MB and the hero bakes and paints are 37 KB.
- **Scale:** cells are about 500 m in the open desert. Focus areas are finer: 100 m on the Las Vegas Strip and at Hoover Dam, 250 m on Lake Mead, 150 m at Grand Canyon Village and Desert View. The manifest records each focus area's achieved scale and every chunk's metres per cell.
- **Relief:** 2.5× vertical exaggeration (65.3 m per height step), with local relief exaggerated where cells are magnified (D-041), at most 1.6× round Hoover Dam (`reliefMax`). The `VREF`/`VFAC` layers keep strata at real elevations. Lake Mead stands just under the dam's crest (`reservoir`, D-066).
- **Micro-terrain:** 4×4 micro-cells per cell (`MHGT`, D-038).
- **Objects:** 5,830 buildings around the Strip and in Grand Canyon Village, with heights and tower parts from 3DEP lidar where Overture's are missing or too low (D-052). Seven registry landmarks (D-051): the Strat, the Welcome to Fabulous Las Vegas sign, the Paris Eiffel Tower replica, the High Roller, Hoover Dam with its intake towers, the bypass bridge and the Desert View Watchtower, all as generic depictions. The client adds shrubs and rocks by surface (D-054).
- **Hero landmarks:** the Strat, Hoover Dam and the Desert View Watchtower are baked offline and painted over in all four rotations (`heroes/`, D-053). The paints are the tool's demo touch-ups.

```sh
cd pipeline && uv run pixelworld build ../worlds/southwest/region.yaml
# hero landmarks: re-bake (keeps and re-registers the paint-overs), then re-package without a rebuild
(cd .. && node tools/hero-bake.mjs --world southwest)
uv run pixelworld heroes ../worlds/southwest/region.yaml
# or edit the warp interactively: http://localhost:5180 (pnpm --filter @pixelworlds/editor dev)
uv run pixelworld serve ../worlds/southwest/region.yaml
```

`build-report.json` records the package hash, the warp's statistics (folds, anisotropy, focus results, solve time), the road validation, the object counts and the surface counts.

Before M2 this package was uniform: 1028×700 cells at 400 m (M1, 0.63 MB), then with micro-terrain (M1.6, 3.97 MB).

All three levels snap streets and buildings to the 8 grid directions (`snap:` in `region.yaml`, D-049).

This is the driving level of the region's three scale levels (D-046). Its manifest lists them, and `geo.i32.gz` holds the lon/lat of every 4th cell corner, so the client (L key) can move to the same place in another level.

## southwest-fly, southwest-walk

The Southwest's other scale levels, built from [`fly.yaml`](../worlds/southwest/fly.yaml) and [`walk.yaml`](../worlds/southwest/walk.yaml). Both extend `region.yaml`.

- **southwest-fly:** the whole region at 1.5 km per cell in open desert, with every focus area 4× coarser than driving: the Strip and Hoover Dam at 400 m, the canyon rim at 600 m.
  - **Size:** 339×219 cells, 0.63 MB with the hero bakes.
  - **Generalization:** motorways and trunks only.
  - **Objects:** towers of 80 m or more drawn 3× their size, where they don't overlap a taller one; landmarks drawn 5× (not the dam); both stretched 1.5× in height. Every other built-up cell is a block of low buildings (2,889 `city.blocks`, D-067). The three hero landmarks are painted over as on the driving level.
- **southwest-walk:** the Las Vegas Strip at a uniform 20 m per cell, with 4×4 micro-cells from the 10 m DEM.
  - **Size:** 182×412 cells, 0.68 MB with the hero bakes.
  - **Ways:** every street class (no parking aisles or driveways) plus the pedestrian network (sidewalks, crosswalks, footways and more), drawn at real width (D-050).
  - **Objects:** at true proportions (`heightStretch` 1):
    - 5,090 building footprints, with lidar heights and tower parts (D-052)
    - 5,109 trees where the WRI/Meta canopy height map shows 3 m or more, plus palms on Las Vegas Boulevard
    - 2,257 street lights and traffic signals
    - four landmarks: the Strat (painted over, D-053), the Welcome sign, the Eiffel Tower replica and the High Roller
  - **Roads:** snapping (D-049) gives a clean road report: one network, no split segments, no disconnected junctions. The M1.5 Strip experiment it's built from has one split segment and two disconnected junctions at 20 m cells.

```sh
cd pipeline
for f in fly region walk; do uv run pixelworld build ../worlds/southwest/$f.yaml; done
```

Sources and licenses: as for `southwest`. The walking level also uses the USGS 3DEP 1/3 arc-second DEM (public domain) and the High Resolution Canopy Height Maps by WRI and Meta (CC BY 4.0).

Sources and licenses:
- Elevation: USGS 3DEP 1 arc-second DEM. Public domain.
- Land cover: ESA WorldCover 2021. CC BY 4.0.
- Roads and rivers: © OpenStreetMap contributors via Overture Maps (release 2026-10-21.0). ODbL 1.0, so this package is a derivative database under the ODbL.
- Buildings: Overture Maps buildings (OpenStreetMap, Esri Community Maps, Microsoft and Google Open Buildings footprints). ODbL 1.0.
- Building heights: USGS 3DEP lidar point clouds (Las Vegas 2016 survey). Public domain.
- Importance (`worlds/southwest/importance.json`, used to build the warp, not shipped in the package): Wikidata. CC0.

## sf, sf-walk, sf-fly

San Francisco at three scale levels, built from [`worlds/sf/`](../worlds/sf/) on the `bay-area` style pack. The point of this region is the ordinary fabric, not only the landmarks: every building is typed from its shape, its street and the city's records (D-055), and drawn by street-facing generators.

- **sf (driving):** the whole city at a uniform 25 m per cell, from Ocean Beach to the Embarcadero and from the Golden Gate to the county line, with 1.5× vertical exaggeration and 4×4 micro-cells.
  - **Buildings:** 168,878. They come from Overture footprints and heights; DataSF's assessor roll supplies year built, storeys, use and neighbourhood (160,794 matched to a lot).
  - **Types:** stucco row houses (82,002), Edwardian rows (26,961), houses (20,100), Victorian rows (17,632), apartment blocks with bays (3,245) and without (5,297), historic commercial blocks (5,150), warehouses (2,884), Chinatown (924), pier sheds (123), and towers by era: deco (107), slabs (129), postmodern (66) and glass (107), with 73 left to a kind by seed.
  - **Trees:** 81,627: 62,295 where the WRI/Meta canopy height map shows 3 m or more (cypress and eucalyptus on tree-covered land), and 19,332 sidewalk trees along the avenues.
  - **Ground (D-062):** 25,121 lawn cells (parks, golf courses, pitches, gardens and cemeteries from Overture land use) and 43,558 yard cells beside houses.
  - **Rails in the street (D-061):** 3,709 cells: cable-car tracks over Nob Hill and Russian Hill, the streetcar and light-rail lines, Caltrain.
  - **Landmarks (generic depictions):** the Golden Gate Bridge, the Bay Bridge's west span (both in pieces, D-056), the Transamerica Pyramid, Salesforce Tower, Coit Tower, the Ferry Building, City Hall, the Palace of Fine Arts, Sutro Tower, the Dutch and Murphy windmills, and Alcatraz's cellhouse and lighthouse.
  - **Traffic routes (D-060):** 16,428.
  - **Size:** 8.6 MB, of which `objects.json.gz` (version 2, D-057) is 7.3 MB and `routes.json.gz` 0.3 MB.
- **sf-walk:** the northeast of the city at 10 m per cell, from the Haight and Alamo Square to the Embarcadero and from Dolores Park to North Beach, with hills at 2× and Lombard Street's hairpins kept from snapping.
  - **Contents:** 43,650 buildings at 1.4× height, 20,225 canopy trees and 9,181 sidewalk trees, 22,175 lawn and 92,652 yard cells, 8,008 street lights and 458 signals, 114 lantern strings over Grant Avenue and Stockton Street, 3,816 rail cells, and the landmarks within it, including the Dragon Gate (not the Palace of Fine Arts: its colonnade would reach past a tile's margin at 10 m cells).
  - **Size:** 3.4 MB.
- **sf-fly:** the Bay from the Marin Headlands to the Oakland shore at 100 m per cell, with 920 traffic routes and vehicles enlarged at most 4× (`vehicleScale`). Only towers of 60 m or more (2×) and the landmarks (3×) are drawn; there's no typology pass and no street trees.
- **Road reports:** clean on all three levels.

```sh
cd pipeline
for f in region walk fly; do uv run pixelworld build ../worlds/sf/$f.yaml; done
```

Sources and licenses:
- Elevation: USGS 3DEP 1/3 arc-second DEM (driving, walking) and 1 arc-second (flying). Public domain.
- Land cover: ESA WorldCover 2021. CC BY 4.0.
- Roads, paths and buildings: Overture Maps (OpenStreetMap and others). ODbL 1.0.
- Building records: DataSF, Assessor Historical Secured Property Tax Rolls and Parcels. ODC PDDL 1.0.
- Tree canopy (driving and walking levels): High Resolution Canopy Height Maps by WRI and Meta. CC BY 4.0.
- Rail and ferry lines (rails and traffic routes), parks and natural land (lawns): Overture Maps transportation and base themes. ODbL 1.0.

## nyc, nyc-walk

New York at two scale levels (D-078, D-083), built from [`worlds/nyc/`](../worlds/nyc/) on the `new-york` style pack. The walking level `extends:` the driving level's spec, which holds what both share (style, sources, typology, ground); each lists the other in `levels`, so the viewer and the game switch between them. Buildings are typed from NYC Open Data (the `pluto` facts source, D-080: footprints, PLUTO lots, LPC records, NTAs) and drawn by the `city-nyc` generators (D-081). Heights are true (`heightStretch` 1.0). Setback towers keep the upper tiers Overture stacks on their lower ones (`objects.buildings.tiers`). Roads and paths are drawn along their own centre lines, snapped to 16 directions where they run near one (D-082).

- **nyc (driving):** Manhattan at 25 m per cell, from the Battery to Inwood, with what the box takes in across the rivers: Brooklyn from the Heights to Greenpoint and Bushwick, Long Island City and Astoria, the South Bronx along the Harlem River, and Jersey City, Hoboken and the Palisades to Fort Lee.
  - **Buildings:** 185,581 from Overture footprints and heights; 129,188 have facts (New Jersey has none and keeps the generic groups).
  - **Types:** tenements (26,185), brownstones (16,981), houses (16,526), historic commercial blocks (14,378), prewar apartment blocks (5,497), warehouses (4,145), cast-iron lofts (301), pier sheds (65), and towers by era: deco (2,871), slabs (2,442), postmodern (901) and glass (1,640), with 354 left to a kind by seed.
  - **Also:** 64,837 canopy trees and 31,534 sidewalk trees (one every 16 m), 23,971 lawn and 26,771 yard cells, 8,287 rail cells (the elevated lines, Metro-North's viaduct), 120,442 road cells with centre-line pieces, 25,808 traffic routes.
  - **Landmarks (generic depictions):** One World Trade Center, the Woolworth Building, the Empire State Building, the Chrysler Building, the Flatiron Building and Grand Central Terminal (the last two on their own footprints), and the Brooklyn, Manhattan, Williamsburg, Queensboro and George Washington Bridges (in pieces, D-056).
  - **Size:** 10 MB, of which `objects.json.gz` is 8.3 MB. Built in 477 s with the download cache (431 s the first time, downloads included, by the pipeline's clock).
- **nyc-walk:** Manhattan at 10 m per cell from the Battery to 86th Street (Lower Manhattan, Midtown, and the Upper West and East Sides' south halves across Central Park), with Brooklyn Heights, DUMBO, Williamsburg, Greenpoint, Long Island City and Astoria's south end across the East River.
  - **Buildings:** 67,370; 60,549 have facts.
  - **Types:** tenements (13,623), brownstones (8,250), historic commercial blocks (7,219), prewar apartment blocks (3,364), warehouses (1,032), houses (805), cast-iron lofts (297), pier sheds (30), and towers by era: deco (3,261), slabs (2,403), postmodern (988) and glass (1,678), with 288 left to a kind by seed.
  - **Centre lines:** 124,169 road cells and 218,684 path cells carry pieces; 33 and 641 have more than six, and drop their narrowest.
  - **Also:** 62,094 canopy trees and 14,764 sidewalk trees, 45,606 lawn and 49,393 yard cells, 12,366 street lights and 438 signals, 2,880 rail cells, 13,073 traffic routes.
  - **Landmarks:** the driving level's, but for the George Washington Bridge.
  - **Size:** 7.4 MB, of which `objects.json.gz` is 4.1 MB and the chunks 3.0 MB. Built in 511 s, the first fetch of its NYC Open Data included.
- **Road reports:** clean on both levels (no discontinuous or steep edges, no disconnected junctions).

```sh
cd pipeline
for f in region walk; do uv run pixelworld build ../worlds/nyc/$f.yaml; done
```

Sources and licenses:
- Elevation: USGS 3DEP 1/3 arc-second DEM. Public domain.
- Land cover: ESA WorldCover 2021. CC BY 4.0.
- Roads, paths, rails, parks and buildings: Overture Maps (OpenStreetMap and others). ODbL 1.0.
- Building records: NYC Open Data (BUILDING footprints, PLUTO, the LPC building database, 2020 NTAs). No restrictions on use (NYC Admin Code §23-502(d)); source, version and modifications named in the manifest.
- Tree canopy: High Resolution Canopy Height Maps by WRI and Meta. CC BY 4.0.

## paris-walk

Paris's walking level (D-078, D-086), built from [`worlds/paris/walk.yaml`](../worlds/paris/walk.yaml) on the `paris` style pack: from the Eiffel Tower and the Trocadéro east to the Île de la Cité and the Marais at 10 m per cell (610 × 324 cells), with the Seine, the Champs-Élysées and the Étoile, the Louvre, the Opéra and the grands boulevards. Heights are true (`heightStretch` 1.0). Its roads and paths are drawn along their own centre lines, snapped to 16 directions only within 6° of one (D-082): Paris's avenues run at every angle.

- **Terrain:** IGN's RGE ALTI 1 m DTM read at 4 m (the `ign-rgealti` terrain source, D-084): 9 to 25 drawn steps, from the Seine's quays to the Chaillot hill.
- **Buildings:** 24,136 from Overture footprints; 19,125 have facts from APUR and IGN (the `apur` facts source, D-084: APUR's footprints, periods and fabric classes, BD TOPO's storeys and use, APUR's quartiers), and 5,144 of those that Overture gives no height take APUR's.
- **Types:** Haussmann blocks (5,783), faubourg houses (2,475), post-war blocks (1,412), civic stone buildings (452), HBM blocks (388), palaces by name (33 pieces: the Louvre and the Hôtel des Invalides, D-088) and warehouses (12); the rest keep the stone default (`haussmann`: 9,820 residential, 3,711 commercial), and 28 towers.
- **Courtyards:** kept open (`courtyards: true`, D-088): 2,791 buildings carry theirs.
- **Centre lines:** 45,185 road cells and 82,732 path cells carry pieces; 14 and 990 have more than six, and drop their narrowest.
- **Also:** 16,347 canopy trees and 7,776 street trees, 13,096 lawn cells, 3,554 street lights and 296 signals, 327 rail cells, 5,856 traffic routes.
- **Landmarks (generic depictions, drawn on their own proportions, D-087, D-088):** the Eiffel Tower (unlit), Notre-Dame, the Arc de Triomphe, the Palais Garnier, the Pont Alexandre III, the Dôme des Invalides, the Grand Palais and the Pont Neuf's two arms.
- **Road report:** clean (no discontinuous or steep edges, no disconnected junctions).
- **Size:** 2.9 MB. Built in about 70 s with the download cache.

```sh
cd pipeline
uv run pixelworld build ../worlds/paris/walk.yaml
```

Sources and licenses:
- Elevation: IGN RGE ALTI®. Licence Ouverte / Open Licence 2.0 (Etalab).
- Land cover: ESA WorldCover 2021. CC BY 4.0.
- Roads, paths, rails, parks and buildings: Overture Maps (OpenStreetMap and others). ODbL 1.0.
- Building records: Apur, Emprise bâtie Paris and Quartier de Paris (ODbL 1.0); IGN, BD TOPO® (Licence Ouverte 2.0).
- Tree canopy: High Resolution Canopy Height Maps by WRI and Meta. CC BY 4.0.

## kyoto-walk

Kyoto's walking level (D-091, D-100), built from [`worlds/kyoto/walk.yaml`](../worlds/kyoto/walk.yaml) on the `kyoto` style pack (D-090): from Nakagyō's machiya streets east across the Kamo river to Gion, Higashiyama and Kiyomizu-dera, and south to Kyoto Tower, at 10 m per cell (338 × 300 cells). Heights are true (`heightStretch` 1.0) and the relief 1.5×. Its roads and paths are drawn along their own centre lines, snapped to 16 directions within 6° of one (D-082): the Heian grid snaps, the lanes up the Higashiyama slopes keep their angles. Its neighbours are the driving level (`kyoto`) and the flying level (`kyoto-fly`).

- **Terrain:** GSI's elevation tiles read at 4 m (the `gsi-dem` terrain source, D-089): 8 to 89 drawn steps, from the Kamo river up the Higashiyama hills.
- **Buildings:** 33,691 from Overture footprints; 31,420 have facts from PLATEAU's 2025 building models (the `plateau` facts source, D-089: structure, year, storeys, usage code, LoD2 roof shape), 29,493 that Overture gives no height take PLATEAU's, and 29,976 take PLATEAU's roof shape as their generator's hint (`roofHints`, D-100).
- **Types:** mid-rises (10,923), wooden houses under gabled (7,924) and hipped (332) roofs, machiya (6,451), temple halls and pavilions (513, 180 buildings stand in temple and shrine grounds), kura (91) and shrine halls (57); the rest keep the defaults (6,888 houses, 427 low blocks, 17 car parks, 68 taller blocks).
- **Centre lines:** 20,250 road cells and 17,581 path cells carry pieces; 8 and 34 have more than six, and drop their narrowest.
- **Also:** 20,861 canopy trees and 559 street trees, 3,416 lawn cells, 199 cells of ponds from Overture's water areas (D-103), 1,265 utility poles strung with wires (one side of each lane, D-102; 39 on diagonal streets, D-103, and 172 on 2:1 streets, D-104), 1,142 street lights and 54 signals, 1,174 rail cells (the JR lines into Kyoto Station), 3,266 traffic routes.
- **Landmarks (generic depictions):** Kiyomizu-dera's main hall on its stage, its three-storey pagoda, the Yasaka Pagoda, Yasaka Shrine's west gate, Chion-in's Sanmon, Kyoto Tower, and three torii (Jishu Shrine's and two in Gion).
- **Road report:** clean (no discontinuous or steep edges, no disconnected junctions).
- **Size:** 2.1 MB. Built in about 55 s with the download cache (about 250 s fetching PLATEAU, GSI and Overture the first time).

```sh
cd pipeline
uv run pixelworld build ../worlds/kyoto/walk.yaml
```

Sources and licenses:
- Elevation: 出典：国土地理院ウェブサイト (地理院タイル 標高タイル), processed. Public Data License 1.0 (PDL 1.0), compatible with CC BY 4.0.
- Land cover: ESA WorldCover 2021. CC BY 4.0.
- Roads, paths, rails, parks, land use and buildings: Overture Maps (OpenStreetMap and others). ODbL 1.0.
- Building records: 出典：国土交通省 PLATEAUウェブサイト (3D city models of Kyoto, 2025), processed. PDL 1.0.
- Tree canopy: High Resolution Canopy Height Maps by WRI and Meta. CC BY 4.0.

## kyoto

Kyoto's driving level (D-101), built from [`worlds/kyoto/region.yaml`](../worlds/kyoto/region.yaml): the city centre at 25 m per cell (294 × 378 cells), from Kinkaku-ji's hills in the north-west to Tō-ji and Fushimi Inari's gate in the south and Ginkaku-ji in the east, with Nijō Castle, the Imperial Palace, the Kamo river and Heian Shrine's great torii. Heights 1.5×, relief 1.5×; the walking level's typology (D-091, D-100).

- **Buildings:** 182,019 from Overture footprints; 170,903 have PLATEAU facts (96 meshes), 163,971 heights and 78,043 roof shapes come from them.
- **Types:** wooden houses under gabled (72,608) and hipped (1,538) roofs, mid-rises (38,479), machiya (28,162), temple halls and pavilions (1,138; 522 buildings stand in 46 temple and shrine grounds), kura (411), shrine halls (145), Nijō Castle's palace halls and gates (33) and the Imperial Palace's halls, gates and corridors (64 pieces), by name and shape (D-102, D-103, D-104); the defaults 36,535 houses, 2,765 low blocks, 76 taller blocks, 65 car parks.
- **Walls:** 1,944 stretches of stone wall along OSM's retaining walls (814 pieces of line), Nijō Castle's ishigaki round its moats among them (D-104).
- **Also:** 42,128 canopy trees and 3,224 street trees, 4,268 lawn cells (the Imperial Palace's courts left paved), 291 cells of ponds and moats from Overture's water areas (Kinkaku-ji's pond, Nijō Castle's moats; D-103), 1,937 rail cells, 13,329 traffic routes.
- **Landmarks:** the walking level's six, Tō-ji's five-storey pagoda (55 m), Heian Shrine's great torii (24.4 m) and Kinkaku-ji's Golden Pavilion (D-102).
- **Road report:** clean (29 components).
- **Size:** 7.5 MB. Built in about 170 s with the download cache (about 380 s the first time).

```sh
cd pipeline
uv run pixelworld build ../worlds/kyoto/region.yaml
```

Sources and licenses: as `kyoto-walk`.

## kyoto-fly

Kyoto's flying level (D-101), built from [`worlds/kyoto/fly.yaml`](../worlds/kyoto/fly.yaml) (it extends `region.yaml`): the whole basin at 100 m per cell (184 × 222 cells), from Arashiyama to the slopes of Hiei and from the Kitayama hills south past Fushimi. Relief 2×. Only its landmarks are drawn, three times their size: Kyoto Tower, Tō-ji's and the Yasaka pagodas, Kiyomizu-dera's hall, Chion-in's Sanmon, Heian Shrine's great torii and Kinkaku-ji. GSI's tiles are read at 16 m. Rivers only, no canals: Overture's canals are mostly field and street-side channels, a whole cell wide here. 0 to 42 drawn steps. 392 KB, built in about 15 s with the cache.

```sh
cd pipeline
uv run pixelworld build ../worlds/kyoto/fly.yaml
```

Sources and licenses: as `kyoto-walk`, without the building records and tree canopy.

## exp-* (M1.5 pixel detail experiment)

Two small areas at three resolutions each, built from [`worlds/experiment/`](../worlds/experiment/). Every variant shares the same 160 m/cell layout on screen: finer cells are drawn smaller (`render.scale` in the manifest), so the variants line up for comparison.

| World | Cells | Drawn at | Cell on screen | Height step |
|---|---|---|---|---|
| `exp-desert-view-k1`, `exp-strip-k1` | 160 m | 1 | 32×16 px | 8 px |
| `exp-desert-view-k4`, `exp-strip-k4` | 40 m | 1/4 | 8×4 px | 2 px |
| `exp-desert-view-k8`, `exp-strip-k8` | 20 m | 1/8 | 4×2 px | 1 px |

Each package also has `objects.json.gz`: vegetation, buildings and landmarks as semantic-group instances (`docs/world-format.md`). Open one with `?world=/exp-strip-k8/`; add `&objects=0` for terrain only, `&palette=night` (or press T) for the night palette.

```sh
cd pipeline
for f in ../worlds/experiment/*.yaml; do uv run pixelworld build "$f"; done
```

**Rebuilds:**
- **`exp-desert-view-*`** were rebuilt with D-076 and match a rebuild byte for byte. Against their M1.5 build they gained a geo grid and traffic routes, and their objects file moved to version 2 (D-057) with the same instances; they draw identically.
- **`exp-strip-*`** are kept as built in M1.5 (e2360db), because `exp-strip-k4` is the e2e golden `exp-strip-k4-r0.png`. A rebuild has the same chunks, except a few road cells in one chunk of `exp-strip-k8`. Its objects file is version 2, and 157 of its buildings carry Overture's roof and facade hints (`rs`, `rc`, `fc`, `fm`), which change the golden scene by a few pixels. It also gains a geo grid and traffic routes. Rebuild them when the golden is re-made.
- **Roads:** the committed `exp-strip-k8` reports one split road segment and two disconnected junctions at 20 m cells. A rebuild reports none (the road stage has changed since; the few road cells above are the difference), so `pixelworld build` exits 0.

Sources and licenses: as for `southwest`, plus the USGS 3DEP 1/3 arc-second DEM (public domain) and Overture Maps buildings (OpenStreetMap, Esri Community Maps, Microsoft and Google Open Buildings footprints; ODbL 1.0).
