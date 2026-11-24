# Map survey: finding good boards across a city

Hold the Block fights on 8 × 8 boards cut from a real city. Until now each city
had a few hand-picked sites, and the game nudged a board round each one to find
the clearest (D-169). The map survey finds boards algorithmically: it scans a
whole city, scores every board position for how well it plays, how well it
reads and how much it looks like *that* city, splits the city into character
zones, and elects the best boards of each zone into a large pool of sites.

Status: phase 1, the survey tool, is built (D-174): `node tools/survey-sites.mjs`
writes a pool per city (see [Running it](#running-it) and
[First results](#first-results)). Simulation, rooftop maps and the game drawing
from the pool come after (see [Build order](#build-order)).

## What a good board is

- **Interesting:** cells with things to interact with: water to push invaders
  into, lawns and woods that burn, tall buildings that topple onto others, roofs
  close enough to leap between, high ground, chokepoints.
- **Readable:** little of the board hidden behind its own buildings from the
  side the fight starts on, and terraced: low in front, tall at the back. Little
  of the city in front of it has to be cut away to see it.
- **Iconic:** visually rich (many kinds of building and prop, varied roofs and
  colours), with the city's own character (its signature building types and
  props), and a landmark in view where there is one.

## What the data gives us

Per walking-level city (all at 10 m a world cell):

| City | Objects | Landmarks | Signature types and props |
|---|---|---|---|
| New York | 157k | 10 (One WTC, Woolworth, Brooklyn and Manhattan bridges, Empire State, Chrysler, Flatiron, Grand Central…) | brownstone, tenement, tower; 33k buildings before 1930 |
| Hong Kong | 24k | 4 (ICC, the Clock Tower, the Cultural Centre, the Peninsula) | tong lau, composite; neon signs, market stalls |
| Kyoto | 63k | 9 (Kiyomizu-dera, Yasaka Pagoda, Chion-in Sanmon, Kyoto Tower…) | machiya, temple, midrise; poles and wires; gabled roofs |
| Paris | 52k | 9 (Eiffel Tower, Notre-Dame, Arc de Triomphe, Palais Garnier…) | Haussmann, faubourg, HBM |
| San Francisco | 82k | 7 (Bay Bridge, Transamerica, Salesforce Tower, Coit Tower, Ferry Building…) | rowhouse; cypress and eucalyptus |
| Tokyo | 46k | 4 (Metropolitan Government Building, Docomo Yoyogi, Shibuya 109, Meiji Jingu torii) | kodate, zakkyo, mansion; poles and wires |

Each object has its group (typology), footprint, real height, year built, roof
shape and facade colour where the data has them. The ground has water, surface
(lawn, forest, scrub, sand…), road classes and elevation. The tactics package
already builds the fight's arena from a board (structures with hit points and
people, roofs, water, burnable cells) and measures what its own buildings hide
from each side (`hiddenFrom`, D-169).

## Pipeline

An offline Node tool (`tools/survey-sites.mjs`, loading the TypeScript through
Vite) runs per city and writes a reviewed JSON pool of sites. The game still
nudges each board within half its width at runtime (D-169).

1. **Raster.** The city read once at world-cell resolution: ground height, the
   building standing on each cell and its top, water, surface, trees. Objects
   are bucketed by where they stand, with their typology, height, year, roof
   and colour.
2. **Candidates.** The 8 × 8 board slid over the whole city on a 4-cell step,
   at both cell sizes (one and two world cells a board cell): about 90,000
   positions for New York.
3. **Coarse pass** on every position, from the raster: an approximate arena
   (each board cell's majority building, roof, water, burnable ground), the hard
   gates, then every score below except front clearance.
4. **Fine pass** on each zone's best few: the real board and arena (as the game
   builds them), the exact hidden share and front clearance, rescored.
5. **Proof pass** (phase 2): a puzzle generated on each finalist; boards where
   none comes are dropped.
6. **Election** per character zone, then naming (below).

### Gates

A position is dropped if it fails any of:

- at least 16 world cells from the world's edge (the view looks on past the
  board, and the world stops there);
- 5 to 14 buildings on the board;
- 30 to 70 % of its cells open ground (not a building, not water);
- at most 25 % water;
- its open ground one connected region (at least 85 % of it);
- at most 30 % of its cells hidden from its clearest side.

### Scores

Each term is 0 to 1; the score is their weighted sum. The weights are a first
guess, to be fitted to ratings (see [Validation](#validation)).

**Readability (35 %)**

| Term | Weight | Measure |
|---|---|---|
| Hidden | 0.45 | The share of cells the board's own buildings hide from its clearest side (`hiddenFrom`): 15 % or less is 1, 30 % is 0. The clearest side is the side the fight starts on. |
| Terraced | 0.30 | On that side, how far roof height rises from front to back: the rank correlation of each cell's stand height with its depth along the view, from −1 (tall in front) to 1. |
| Front clearance | 0.25 | How much of the city in front has to be cut away to see the board (D-168): the world cells, outside the board, whose buildings stand above the view rays from its cells, as a share of the board's area. None is 1; a board's worth is 0. A board opening onto a park, water or an avenue scores well, and its cut looks natural. Coarse pass: estimated from the raster; fine pass: exact. |

**Hidden penalty.** Taken off the weighted sum, not one of the terms: a share
of the cells hidden from the clearest side costs `0.25 × (share / 30 %)²`. It
starts at the first hidden cell, where the Hidden term is still 1 up to 15 %,
and grows with the square, so each cell hidden costs more than the one before:
3 cells cost 0.006, 6 cells 0.024, 10 cells 0.068, 19 cells (the gate) 0.25.
Its size is `penalty.hidden` in `weights.json`; the fit leaves it as it is and
takes it off the same way (D-177).

**Interactables (35 %)**

| Term | Weight | Measure |
|---|---|---|
| Water | 0.15 | Some water to push into (2 to 12 cells is 1), none or a lake 0. |
| Fire | 0.15 | Burnable cells (lawn, grass, scrub, woods, trees): 3 to 16 is 1. |
| Topples | 0.20 | Buildings tall enough to topple (two board cells or more) with another building or open ground in their fall: 2 or more is 1. |
| Leaps | 0.15 | Roof pairs a street apart within 6 m of each other: 3 or more is 1. |
| Height bands | 0.20 | How many of the four bands (to 6 m, to 15 m, to 40 m, taller) the buildings span: 1 band 0, 4 bands 1. |
| Chokepoints | 0.15 | Open cells whose loss would split the open ground, or with two open neighbours in a line: 3 or more is 1. |

**Character (30 %)**

| Term | Weight | Measure |
|---|---|---|
| Landmark | 0.30 | A registry landmark in the backdrop (behind the board as the clearest side sees it, within about 600 m and 25°) is 1; next to the board 0.8; on it 0.6 (it can be damaged); beyond 1 km, 0. |
| Signature | 0.30 | How much of the board is the city's own: each building and prop group weighted by how few of the six cities have it (inverse document frequency), averaged over the board's objects. Brownstones score in New York, machiya in Kyoto, neon in Hong Kong. |
| Richness | 0.25 | The variety of what stands there: the entropy of the object groups round the board, with roof shapes and facade colours, normalized per city. |
| Age and contrast | 0.15 | The share of buildings from before 1930, and a tall building among low ones (the tallest roof against the median). |

## Character zones

The pool should cover the whole city, one or more boards per recognisable kind
of place, not ten boards in its densest district. The city is tiled at 16 world
cells (160 m); each tile gets a vector: its share of each building group, its
water and park share, and whether it is nearly empty. A tile's few buildings
are noisy, so each is seen with its neighbours (its own vector counted twice,
its eight neighbours' once). Tiles grow into zones by similarity: from the tile
with the most buildings, neighbours join while their vector is close to the
zone's (cosine similarity 0.75), up to 16 tiles (about 640 m square). Zones of
a tile or two then join the neighbouring zone most like them, up to 20 tiles.
Without the smoothing, New York grew 1,011 zones, 694 of them single tiles;
with it, 192 zones of about 15 tiles.

**Fallback to a grid:** where the data can't tell places apart (fewer than
three building groups with a real share of the city, or a clustering that
comes out as one zone or as mostly single tiles), zones are a plain grid of
4 × 4 tiles.

## Election and naming

- In each zone, its best positions go to the fine pass; the best that still
  passes the gates is elected, and one more for every eight tiles of zone.
- No two elected boards closer than one and a half board widths.
- The pool is every zone's elected boards that score above a floor: hundreds of
  sites for New York, not ten.
- Each site keeps the side it scores best from, its score and each term, so the
  game and the gallery can show why it was picked.
- **Names:** the nearest landmark within about 300 m ("by the Flatiron
  Building"), else a hand-kept list of neighbourhood centres per city (the old
  hand-picked sites seed it), else the zone's typology ("brownstone blocks").

## Rooftop maps and chasms

Where a board's heights split in two (towers far above the street), the survey
also tries it as a rooftop map: a floor height is chosen, the roofs above it are
the playable cells, and every cell below is a **chasm**. Walkers can't enter a
chasm, and anything that isn't flying pushed or knocked into one falls in and
is lost, as drowning is. Flyers cross chasms freely, and rigs leap the narrow
gaps between roofs. Both versions are scored and the better one kept.

This needs a chasm cell in the rules (`A_CHASM` beside `A_WATER`), the arena
built with a floor height, and the cutaway and glass to treat the street below
as a void. It comes after the loadouts work in the combat rules lands.

## Simulation

Phase 2 plays each finalist with several bots, so the measures aren't one
strategy's habits:

- **optimal**: the solver (`solveTurn`, `solveFight`);
- **greedy**: the most damage now (`greedyTurn`);
- **environmental**: prefers drowning, toppling, burning and dropping invaders;
- **random**: a baseline.

Measures per board:

- **variety:** how many kinds of event come up (drown, topple, fire spread,
  fall, bump, leap, crush);
- **depth:** how far greedy falls short of optimal (if greedy also holds the
  block, the map is too easy);
- **room:** how many distinct perfect turns there are (one is a pure puzzle,
  dozens trivial);
- **environment share:** the share of damage the city does rather than the
  weapons.

These feed a fourth score family and rerank the finalists. The solver is run
offline on a few hundred finalists, in worker threads.

## Validation

- **References:** the old hand-picked sites are known to be good; they should
  score in the top tenth of their zones.
- **Gallery:** a dev page shows each city's pool and calibration samples from
  above and from their starting side, with each term. Rating them (good, fine,
  bad) gives labels to fit the weights to, and checks that the ranking agrees.
  See [The gallery](#the-gallery).

## Output

`apps/tactics/survey/<world>.json`, one per city:

```json
{
  "world": "nyc-walk",
  "zoning": "character",
  "zones": 212,
  "sites": [
    {
      "x0": 39, "y0": 945, "cell": 2,
      "toward": [-1, -1],
      "zone": 17,
      "name": "by the Woolworth Building",
      "score": 0.71,
      "terms": { "hidden": 0.9, "terraced": 0.62, "clearance": 0.8, "water": 0, "fire": 1, "...": 0 }
    }
  ]
}
```

## Running it

```
node tools/survey-sites.mjs                # every walking-level city
node tools/survey-sites.mjs nyc-walk       # one
node tools/survey-sites.mjs --step 8       # a coarser scan
```

The worlds are read from `fixtures/`; the survey (`apps/tactics/src/survey.ts`)
and the packages it uses are loaded through Vite. It prints each city's top
sites, with their parts, and where the old hand-picked sites rank among every
position that passes the gates.

## First results

All six cities in about 11 s:

| City | Positions | Pass the gates | Zones | Sites | Old sites' rank |
|---|---|---|---|---|---|
| New York | 80,810 | 11,069 | 192 | 195 | SoHo top 1 %, the Financial District 18 %, Midtown 35 % |
| San Francisco | 39,458 | 8,125 | 101 | 113 | North Beach 4 %, Russian Hill 3 % |
| Paris | 20,166 | 2,360 | 55 | 65 | Le Marais 10 % |
| Tokyo | 10,248 | 1,464 | 29 | 20 | Harajuku 4 % |
| Kyoto | 9,622 | 1,129 | 28 | 24 | Pontochō top, Shijō-Kawaramachi 8 %, Gion 41 % |
| Hong Kong | 9,496 | 1,128 | 29 | 22 | Tsim Sha Tsui 1 %, Yau Ma Tei 12 %, Mong Kok 55 % |

The old sites mostly land in their city's top tenth; the exceptions (Midtown,
Mong Kok, Gion) are dense and tall, where much is hidden. Looked at in the city
view, New York's top site is a waterfront park with buildings rising behind it
(low in front, tall at the back); a brownstone square with towers behind
scores well on character. Generic towers and commercial blocks still win
overall where they read and play well: the character weights are the first
thing the gallery's ratings should tune.

## The gallery

```
pnpm --filter @pixelworlds/tactics-game exec vite --config gallery.config.ts
```

then <http://localhost:5301/survey.html> (the launch config `tactics-survey`
does the same). The game's own server keeps port 5300.

- **Cards:** the city's pool (best first), its calibration samples (about 40
  positions that pass the gates, spread evenly over the range of scores, not
  elected), or everything unrated. Each card is the board from above with a
  margin round it: the board outlined, and a marker at the corner the starting
  side's camera looks from.
- **The chosen one** in the city view from its starting side, the buildings in
  front cut away as the game cuts them (each site lists them: `cutObjects`), the
  board's grid on it; its score, each part and term with its weight, and the
  facts behind them. Click the view to pan (WASD) and turn it (Q, E).
- **Rating:** `1` good, `2` fine, `3` bad (then on to the next); tags for why
  (great view, landmark, character, interesting terrain, good puzzle space,
  boring, too dense, too open, occluded, ugly cut, edge of data) and a note.
  `J`/`K` or the arrows step through, `N` jumps to the next unrated.
- **Kept** in `apps/tactics/survey/ratings.json`, by world and position, with
  the score and terms at the time of rating, so the weights can be fitted to
  them even after the survey changes.

## Fitting the weights

```
node tools/survey-fit.mjs            # how well the weights now and the fitted agree with the ratings
node tools/survey-fit.mjs --write    # and write the fitted ones
node tools/survey-sites.mjs          # then score the cities again
```

The weights live in `apps/tactics/survey/weights.json` (each set summing to
one), read by the survey. The fit looks for the weights that order every pair of
sites rated differently as rated (good above fine above bad): a pairwise
logistic loss over the terms, the weights kept non-negative and summing to one,
and pulled toward the weights now (`--pull`, default 0.3), so a few ratings
move them a little and many move them more. It reports the share of pairs the
weights now and the fitted ones order as rated, on all of them and held out
(fitted on four fifths of the sites, judged on the fifth left out), the weights
side by side, and for each tag given three times or more the terms that set its
sites apart (what "boring" sites lack, say: a hint for a missing term).

Checked on 277 synthetic ratings from a rater who cares most for character
(60 %), then readability (30 %) and topples (10 %): character rose from 0.30 to
0.47, interactables fell from 0.35 to 0.21 with topples taking most of theirs,
and the pairs held out ordered as rated went from 92 % to 98 %.

## Build order

1. **Survey tool:** raster, candidates, gates, scores, character zones,
   election, the JSON pool; a summary to read. *(done, D-174)*
2. **Gallery:** the dev page to review and rate the pool. *(done, D-175)*
3. **Fit the weights** to the ratings. *(the tool is done, D-176; it waits on
   more ratings: 64 of New York's, none bad, fit no better held out)*. The
   hidden penalty added by hand. *(D-177)*
4. **Simulation:** the bots and interaction measures, reranking finalists.
5. **Rooftop maps:** chasm cells in the rules, the rooftop variant in the survey.
6. **The game draws from the pool**, with the runs and loadouts.
