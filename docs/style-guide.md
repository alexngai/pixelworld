# Style guide (reference sheet)

Status: v0, set in M0. It describes the rules every baked pixel follows. The style pack data lives in `worlds/_styles/<pack>/style.json`; the rules are implemented in `packages/bake/src/shaders.ts`. Change both together, and update the golden images (`pnpm test:e2e --update-snapshots`) only after a visual review.

![Rotation 1, 2× zoom: the South Rim's strata](images/m0-south-rim-r1.png)

## 1. Geometry and projection

- **Cell:** a 32×16 px diamond. **Height step:** 8 px. All geometry sits on the grid, so edges are exact 2:1 staircases or straight vertical/horizontal screen lines. See [architecture.md](architecture.md) §3.
- **Rotations:** 4 fixed views, each baked separately. Nothing is rendered at an angle in between.
- **Zoom:** whole-number zoom levels only, with nearest-neighbour upscaling. 1× is the native art scale. Normal play is 2–4×.

## 2. Palette

The palette is indexed: 256 entries, and every baked pixel stores an index.

![Desert Southwest ramps](images/palette-desert-southwest.png)

Rows from top to bottom: `kaibab`, `toroweap`, `coconino`, `hermit`, `supai`, `redwall`, `muav`, `tonto`, `tapeats`, `vishnu` (rock strata), `pine`, `conifer`, `scrub`, `water`, `sand`, `marker` (the placeholder rover).

- **Ramps have 6 shades.** Shade 0 is reserved for outlines. Lighting uses shades 1–5.
- **Ramps shift hue as well as brightness.** Shadows lean cool and purple, highlights warm, so shading never turns into flat grey-black.
- **Layout:** index 0 is the background and empty pixels. Index `1 + ramp·6 + shade` is a ramp colour. Index 253 is the silhouette highlight.
- **Applying the palette:** it happens at runtime through a lookup texture, so later palette variants (day/night, seasons, compliance styles) won't need a re-bake.

## 3. Light and shading

- **Light is relative to the view:** the sun always comes from the upper-left of the screen (`SUN_DIR` in `packages/grid`).
- **Standard faces:** a lit top face lands on shade 4, a left-facing wall on 3 and a right-facing wall on 2. Slopes facing the sun reach 5; slopes facing away drop to 3.
- **Cast shadows** subtract 1.6 levels, then round. Shadows come from a per-tile shadow map that includes neighbouring terrain, so they cross tile seams correctly.
- **Shading is quantized, not smooth.** A face has one shade. Gradients exist only through dithering (§5).

## 4. Materials

- **Strata.** Rock surfaces and every cliff face take their ramp from the elevation of the pixel, using the style pack's `strata` table (Kaibab at the top down to Vishnu schist at the river). Cliffs therefore show horizontal bands. A one-pixel darker bedding line marks the bottom of each band on cliff faces.
- **Surfaces.** Top faces use the ramp of their surface class (`woodland` uses `pine`, `forest` uses `conifer`, and so on). Patterns:

| Pattern | Effect | Used by |
|---|---|---|
| `trees` | 2-px-wide clumps: highlight row, body row, shadow row | woodland, forest |
| `speckle` | sparse 2-px darker flecks | rock, scrub, sand, cliffs |
| `sparkle` | sparse 2-px lighter flecks | water |

- **Anchoring and density.** Patterns are anchored to absolute screen pixels for each rotation, so they're stable across tiles and re-bakes. Densities live in the style pack. Keep them low: texture should read as material, not noise.

### Strata sets and geology provinces (M1)

- **Strata sets:** a style pack defines several (`strataSets`). Each cell's geology province (`GEOL`, from the region spec's province polygons) picks one through `provinces`, and worlds without geology use `defaultStrata`.
- **Desert Southwest pack:**
  - `colorado-plateau` uses the Grand Canyon bands.
  - `basin-and-range` uses `desert-ranges`: basalt below 800 m, ochre volcanics, red sandstone from 1300 m, grey limestone from 1700 m, dolomite above 2600 m.

  Without this split, Vegas's ranges would wear Grand Canyon colours.

### Surfaces added in M1

| Surface | Ramp | Pattern |
|---|---|---|
| desert | `desert` (pale tan) | sparse speckle |
| grass | `grass` (dry olive) | speckle |
| farmland | `farmland` | `fields`: world-anchored patchwork, a third of a cell per field |
| urban | `urban` (blue-grey concrete) | `blocks`: world-anchored streets every third of a cell, with sparse lit roofs |
| snow | `snow` | sparkle |

World-anchored patterns follow the terrain through rotations and slopes. Screen-anchored ones (speckle, trees) are stable for each rotation.

### Roads (M1)

- **Drawn as decals** in the bake: a top-face pixel is road when it's within the class's half-width of the cell's road centre lines. These run from the cell centre to the edge midpoint or corner of each connected neighbour, plus diagonal roads crossing the cell's corners.
- **Pixel-clean:** roads follow the same 8 directions as the grid, so their edges are 2:1, horizontal or vertical lines.
- **Widths** (half-widths in cells): motorway 0.2, trunk 0.17, primary 0.1, secondary 0.07. Narrowing primary and secondary was needed to stop Las Vegas's arterial grid from overpowering the city.
- **Colours:** `asphalt` ramp; motorways and trunks get a one-pixel `marking` centre line. Roads are lit like the terrain under them.

## 5. Ambient occlusion and dithering

- **How AO is calculated:** per vertex, from the horizon angle of nearby terrain in 8 directions. It darkens cliff feet and canyon floors.
- **Dead zone:** occlusion below a threshold is ignored, so open ground stays a clean flat colour.
- **How occlusion becomes shades:** it's mapped to whole shade steps with a 4×4 ordered (Bayer) dither anchored to screen pixels. Dithering appears only where there's real occlusion.

## 6. Outlines

- **Silhouettes:** a pixel gets shade 0 of its own ramp when a neighbour is more than **2.0 depth units** farther away. That outlines cliffs of 2 steps or more where they stand in front of farther terrain.
  - 1-step terraces aren't outlined.
  - A slope triangle seen edge-on (a 1-step drop over half a cell) also produces a 1.33-unit jump, which is why the threshold sits above it. Steeper slope tiles that face away from the camera can exceed 2.0. They then get a silhouette line along their ridge, which is correct: they really do hide terrain behind them.
- **World edge:** pixels next to empty background are outlined, which frames the diorama.
- **No black:** outlines use the darkest shade of the pixel's own ramp, never pure black.

## 7. Cleanup

- **Lone pixels:** a pixel whose four neighbours all agree with each other but not with it takes their ramp and shade.
- **Not affected:** patterns, bedding lines and dithers survive, because they're at least 2 px wide or have matching neighbours along one axis.
- **Not needed yet:** majority-vote downsampling and line-run straightening are only needed for geometry that isn't on the grid (landmarks, M3). Terrain doesn't use them.

## 8. Terrain quantization (pipeline)

These choices live in the gridify stage and the fixture script, but they're style decisions:

- **Bilateral smoothing** (1.5 cells, 1.2 steps) runs before quantizing. It flattens noisy benches into coherent terraces and leaves cliffs sharp.
- **Steep cells become flat terraces** at their mean height (`steep="flat"`), which gives the stepped "temple" look of canyon buttes. The alternative `"slope"` mode was rejected in the M0 review: it made walls into sawtooth triangle facets.
- **Vertical exaggeration:** 2.5× true proportions (26.1 m per step at 160 m per cell). In the comparison, 1.63× (M0's original 40 m/step) looked flat, 2.5× made cliffs and strata bands bold while walls stayed coherent, and 3.5× and 5× broke walls into one-cell pillars, because noise in the elevation data becomes several steps. Going above about 3× needs more smoothing to match.
- **Slope tiles rise at most 2 steps per cell** (`--max-slope`, 1–3). In the comparison:
  - 1 (the original one-step model) made gentle benches stepped.
  - 2 made benches, the Tonto Platform and lower butte flanks continuous while the walls kept crisp stepped cliffs.
  - 3 smoothed further but gave a faceted low-poly look, with contrasting triangles and spiky folds.

  Walls steeper than the limit still become terraces and cliffs. Going up, rises of 1–3 steps per cell keep edges horizontal, 2:1 or 1:1. Going down, a 2-step rise gives slightly uneven 2:3 lines, which is acceptable at play zoom.
- **Smoothing and surface classes use real metres** (bilateral range σ = 48 m; cliff threshold 80 m), so changing the exaggeration doesn't change which cells are woodland or rock.

## 9. Player sprites

- **Baking:** sprites are baked from 3D boxes through the same passes, without shadows.
- **When hidden:** where terrain covers a player sprite, its hidden pixels are drawn as a checkerboard of index 253 (the silhouette colour).

![Rotation 2, 2× zoom](images/m0-south-rim-r2.png)

![4× close-up: tree pattern, strata, AO dither, outline](images/m0-closeup-4x.png)

## 10. Pixel-scale terrain (M1.5 experiment, M1.6 micro-terrain)

Micro-terrain (M1.6) uses K=4: 8×4 px micro-cells with 2 px height steps. The M1.5 experiment worlds draw fine cells smaller instead (`render.scale`). These rules apply to both (D-032, D-036, D-039):

- **Steep cells are bare rock.** Every fine cell or micro-cell steeper than 0.6 rise over run takes the strata ramp, whatever its land cover. Canyon walls then read as bands of ledges rather than a green-and-tan herringbone. For micro-terrain the shader applies it per micro-cell (style `terrain.steepRockSlope`); water and snow keep their surface.
- **Ragged land-cover borders.** Land cover is still per 400 m cell. Each micro-cell takes its surface from a point jittered by up to ±0.4 cell, hashed in world coordinates, so borders are ragged at micro-cell scale rather than following the cell grid. Water keeps its exact cells, because its geometry is flat only there.
- **Patterns keep their pixel size.** Field and city-block patterns, and road widths, are measured in render units. Road widths are capped at one cell.
- **K=4 (chosen, D-037):** its ledges form 2 px clusters; K=8 gave 1 px hatching. See [roadmap](roadmap.md) M1.5 and M1.6.

![A Supai wall at 3×: K=4, K=8 with objects, K=8 terrain only](images/m1.5-desert-view-k4-k8.png)

## 11. Objects (M1.5 experiment)

Objects are voxel models generated per semantic group (D-030) and baked with the terrain through the same passes: lighting, shadows, AO, outlines and palette.

- **Scale (D-033):**
  - A voxel is a 2×1 px top and 1 px tall at native zoom, whatever the map scale.
  - Heights are `metres × heightStretch ÷ voxel metres`, with `heightStretch` 2.5.
  - Trees and palms are deliberately oversized (a conifer is 5 voxels across) so they read as trees.
- **Catalog:** the style pack's `assets` maps a group to a generator, role ramps and parameters. The longest dotted prefix wins (`tree.conifer.ponderosa` falls back to `tree.conifer`, then `tree`).

  | Generator | Groups (desert-southwest) | Notes |
  |---|---|---|
  | `conifer` | `tree.conifer` | layered skirts |
  | `blob` | `tree`, `tree.pinyon-juniper`, `shrub` | ellipsoid crown with holes, optional trunk |
  | `palm` | `tree.palm` | `reach` sets frond length |
  | `boulder` | `rock.boulder` | |
  | `building` | `building.residential`, `building.commercial`, `building.parking`, `building.tower`, `building.tower.hotel` | `style` 0 hip roof, 1 low-rise with parapet and a window band, 2 tower with a window grid and crown |
  | `lookoutTower` | `landmark.tower.lookout` | round stone tower, slits, crenellation, optional round room |
  | `observationTower` | `landmark.tower.observation` | generic shaft, legs and pod; no replica |
  | `sign` | `landmark.sign` | generic diamond roadside sign with a neon rim |

- **Role variants:** a role can name several ramps (`wall`, `wall.gold`, `wall.concrete`), and each building picks one by its seed.
- **Repeated objects** use 6 variants per group and 4 quarter-turns, drawn instanced.
- **Ramps added:** `bark`, `palm`, `stucco`, `roof-tile`, `roof-flat`, `glass`, `lit`, `lit-cool`, `tower-white`, `tower-gold`, `concrete`, `neon-pink`, `neon-cyan`.
- **Ground under objects:** when a world has objects, the style's `objects.surfaces` replaces surface styles; the urban block pattern becomes a light speckle, because real buildings stand there.

![The Strip at 2× with objects: coarse, K=4, K=8](images/m1.5-strip-variants.png)

## 12. Night palette (M1.5 experiment)

- **One bake, two palettes (D-035):** night is a palette variant, so switching (T in the app, `?palette=night`) needs no re-bake.
- **Ordinary ramps** are desaturated to 55%, multiplied by (0.30, 0.34, 0.52) and lifted by (4, 6, 16). The result is a moonlit blue that keeps the day shading.
- **Emissive ramps** get their own night colours, bright across all shades:
  - `lit` (warm windows)
  - `lit-cool` (cool windows, the observation tower's pod)
  - `neon-pink` and `neon-cyan` (trim and signs)
  - `marker` (the rover)
- **Lit windows:** by day, `lit` and `lit-cool` equal `glass`. The generator assigns about 35–60% of window voxels to them, so each building has a fixed pattern of lit windows.

![The Strip at 3×, K=8: day, and night on the same bake](images/m1.5-strip-day-night.png)

## 13. Buildings and landmarks (M3)

Buildings come from data, Overture footprints with lidar heights and massing (D-052), and are drawn by the `building` generator (v2). Landmarks come from the registry (D-051) and have generators of their own.

**Massing**
- **Heights:** real metres × `heightStretch` (2.5 when driving and flying, 1.0 when walking).
- **Lidar towers:** large complexes get tower parts where lidar sees roofs well above the podium, so Caesars, the Venetian, Excalibur and New York-New York keep their skylines.
- **Setbacks:** towers 30 voxels or taller step back once or twice in their top third (about 60% of towers, by seed).
- **No overhangs:** every voxel rests on another. Buildings stay inside their footprint, and nothing floats.

**Roofs**

| Roof | Where | Drawn as |
|---|---|---|
| flat | low-rises and towers by default | parapet (neon trim on hotel towers); rooftop equipment on large low-rise roofs; a penthouse, spire or beacon on towers |
| hipped | houses by default, or from Overture | inset one voxel per layer |
| gabled | from Overture | a ridge along the longer side |
| pyramidal | from Overture | a cap on a tower; a large, broad footprint becomes a pyramid from the ground up, with a dark glass skin |
| dome | from Overture | a hemispherical cap |

**Facades**
- **Glass on the skin only:** windows are glass, or `lit`/`lit-cool` at night, and only on outer walls.
- **Towers** use one pattern by seed:
  - punched windows (every other column on odd floors)
  - ribbon windows (whole odd floors)
  - vertical fins (two columns of glass, one of wall)
  - a curtain wall (glass except every sixth floor), always for gold-walled or glass-faced towers
- **Low-rises** have storefront glass at street level and windows every third floor. Large ones carry a band of neon at the top: a sign with no lettering.
- **Houses** have windows on every third floor and tiled hip roofs.

**Landmarks** (generic depictions: shapes, no names or logos)

| Group | Generator | Landmark |
|---|---|---|
| `landmark.tower.observation` | `observationTower` | the STRAT tower |
| `landmark.tower.lattice` | `latticeTower` | the Eiffel Tower replica at Paris Las Vegas: four legs, base arches, two lit platforms, a spire |
| `landmark.wheel` | `wheel` | the High Roller: rim, spokes, 28 lit cabins, A-frame legs |
| `landmark.sign` | `sign` | the Welcome sign: a diamond with a neon rim, no lettering |
| `landmark.dam` | `dam` | Hoover Dam, bowed upstream |
| `landmark.dam.intake` | `intakeTower` | its four intake towers in the lake |
| `landmark.bridge.arch` | `archBridge` | the Hoover Dam bypass bridge: arch rib, columns, deck |
| `landmark.tower.lookout` | `lookoutTower` | the Desert View Watchtower |

**Checked in tests** (`packages/generators/test/buildings.test.ts`, 192 generated buildings):
- no voxel outside the footprint
- no overhangs
- glass only on the skin
- only style ramps
- pyramids where the data says so
- setbacks inside the footprint
