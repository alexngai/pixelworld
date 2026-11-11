# pixelworld-city-jp

Japan's city pack for the [pixelworld](https://github.com/alexngai/pixelworld) pipeline (`pixelworld-pipeline`), shared by every Japanese city (Kyoto and Tokyo first). Its layout follows `pixelworld-city-nyc`; see `docs/plugins.md` in the repository, and D-089 in `docs/decisions.md`.

## What it provides

| Entry point group | Name | What |
|---|---|---|
| `pixelworld.facts` | `plateau` | MLIT's PLATEAU 3D city models: per building a footprint, measured height, storeys, year built, use, structure and a roof shape read from its LoD2 roof surfaces (`pixelworld_city_jp.plateau:PlateauFacts`) |
| `pixelworld.sources` | `gsi-dem` | GSI's elevation tiles: DEM1A (1 m) where flown, else DEM5A (5 m), else DEM10B (10 m) (`pixelworld_city_jp.gsi:GSI_DEM`) |

```yaml
sources:
  dem: { kind: gsi-dem, overview: 4 }   # tiles at the zoom just finer than 4 m (15 at 35°N)
objects:
  typology:
    facts: plateau
    # or pinned to the release its extracts were cached from:
    facts: { plugin: plateau, year: 2025 }
```

**Options of `plateau`:**
- `year`: the PLATEAU release (the year the city's models were published). The data catalog serves only each city's current release; a pinned year reads the extracts cached from it, and fails if one is missing and the catalog has moved on.
- `keepGml: true`: keep each mesh's CityGML, gzipped (1–45 MB), beside its extract. By default only the extract is kept.

**Facts per building** (looked up by point in footprint; the footprint is the LoD0 footprint or roof edge, else the base of the LoD1 solid):
- `height`: `bldg:measuredHeight` (metres; `-9999` is none). It fills buildings Overture gives no height or floors (D-084).
- `stories`: `bldg:storeysAboveGround`; 0 and 9999 are unknown.
- `year`: `bldg:yearOfConstruction`; `0001` is unknown. Kyoto's temples carry recent years (Nishi Hongan-ji's halls 1989), likely a rebuilding or survey, not the founding.
- `use`: `bldg:usage` in use groups: 401–404 (offices, shops, hotels, commercial complexes) commercial; 411–412 (houses, flats) residential; 413–415 (a house or flats with a shop or workshop) mixed; 421, 422, 453 (government, schools, hospitals and temples, defence) civic; 431, 441, 451, 452 (warehouses, factories, farms, utilities) industrial; 454 (other) and 461 (unknown) none.
- `class`: the usage code as it is (`"411"`, `"413"`), for `classes:` rules.
- `material`: `uro:buildingStructureType`: 601 wood (timber and earthen storehouses), 602 steel reinforced concrete, 603 reinforced concrete, 604 steel, 605 light steel, 606 masonry (brick, block, stone), 610 non-wood; 611 unknown. Kyoto has it; Tokyo's models don't.
- `roof`: from the LoD2 `RoofSurface`s, in Overture's words: `flat` (half the plan area under 5°), `skillion` (a shed roof: 80% of the slope facing one way), `hipped` or `gabled` (more hip than gable verge, in plan length; a hip-and-gable 入母屋 roof is hipped). None where the building has no LoD2 model.

The code meanings are PLATEAU's code lists (`codelists/` in each city's package, spec 5.0), recorded in `plateau.py`. The extract also keeps `uro:fireproofStructureType` and `uro:detailedUsage`, which Tokyo's models have; they aren't facts yet (Tokyo's detailed-use codes are the city's own, not the national list).

**How it reads:** the region's box gives the 3rd-level (1 km) mesh codes of the Japanese standard grid (JIS X 0410). PLATEAU's data catalog (`api.plateau.reearth.io/datacatalog/citygml/m:<mesh>`) lists each mesh's building file for every city whose models cover it; Tokyo's ward packages repeat their neighbours' border meshes, and those copies (the same feature and LoD counts) are read once, buildings deduplicated by `gml:id`. Each file is 10–330 MB of XML, served gzip-encoded at 4–14% of that; it is streamed through ElementTree's `iterparse` (about 2 s a mesh), and only a compact extract is cached.

**Data and licences** (checked 2026-11-11; `docs/second-region.md` §9):
- PLATEAU (MLIT; the models' copyright is each municipality's): Public Data License 1.0, compatible with CC BY 4.0. Credit "出典：国土交通省 PLATEAUウェブサイト", say the data was processed, and don't present processed data as MLIT's.
- GSI's elevation tiles: GSI's content terms (revised 2025-11-20), PDL 1.0, CC BY 4.0-compatible. Credit "出典：国土地理院ウェブサイト", and say the tiles were processed ("地理院タイル（標高タイル）を加工して作成").

Downloads go to the pipeline's shared cache: `plateau/` (one extract per mesh, named by city code, release year, spec, mesh and extract version; and per release and mesh, the catalog's entries) and `gsi/<DEM>/<z>/<x>/<y>.png` (an empty file marks a tile the server doesn't have).

## Layout

```
pixelworld-city-jp/
├── pyproject.toml              the package, and its entry points
├── README.md
├── src/pixelworld_city_jp/
│   ├── __init__.py
│   ├── plateau.py              mesh codes, the catalog, streaming CityGML into extracts, roof shapes, PlateauFacts
│   └── gsi.py                  GSIElevation: PNG elevation tiles, decoded, mosaicked in Web Mercator, reprojected
└── tests/
    └── test_city_jp.py         offline: a tiny CityGML file, roofs, mesh codes, the catalog and cache, tiles, entry points
```
