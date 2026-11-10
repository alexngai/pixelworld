# pixelworld-city-paris

Paris's city pack for the [pixelworld](https://github.com/alexngai/pixelworld) pipeline (`pixelworld-pipeline`). Its layout follows `pixelworld-city-nyc`; see `docs/plugins.md` in the repository.

## What it provides

| Entry point group | Name | What |
|---|---|---|
| `pixelworld.facts` | `apur` | APUR's built footprints of Paris (construction period, median height, roof form, urban fabric) joined to IGN's BD TOPO buildings (storeys, dwellings, use) and APUR's quartiers (`pixelworld_city_paris.apur:ApurFacts`) |
| `pixelworld.sources` | `ign-rgealti` | IGN's RGE ALTI 1 m DTM of France, from the Géoplateforme's WMS-Raster (`pixelworld_city_paris.ign:RGE_ALTI`) |
| `pixelworld.sources` | `ign-lidar-hd-mnt` | IGN's LiDAR HD 50 cm DTM, where it has been flown (`pixelworld_city_paris.ign:LIDAR_HD_MNT`) |

```yaml
sources:
  dem: { kind: ign-rgealti, overview: 4 }   # 4 m: the server resamples
objects:
  typology:
    facts: apur
    # or pinned to the tag its downloads were cached under:
    facts: { plugin: apur, version: "2026-07-30" }
```

**Options of `apur`:**
- `version`: the tag its downloads are cached under. Default: the date APUR last updated its footprints, asked of ArcGIS Online. Both services serve only their current data, so pinning keeps a build on the downloads it cached before.

**Facts per building** (looked up by point in APUR footprint):
- `year`: APUR's year of construction where it falls inside its construction period (`c_perconst`), else the year the period stands for: before 1800 → 1750, 1801–1850 → 1830, 1851–1914 → 1880, 1915–1939 → 1930, 1940–1967 → 1958, 1968–1975 → 1971, then 1978, 1985, 1995, 2003 and 2012. Undated footprints have none. APUR's own years are often rounded to ten, so rules should use the periods' bounds.
- `stories`, `units`: BD TOPO's `nombre_d_etages` (the ground floor included) and `nombre_de_logements`, from the BD TOPO building under the footprint's representative point.
- `use`: BD TOPO's `usage_1`: residential, commercial (`Commercial et services`), industrial, civic (religious, sports); residential with commerce as its other use is mixed. `Indifférencié` and `Annexe` are none.
- `class`: APUR's urban fabric (`c_tissu`), for `classes:` rules: `TR` regular (the Haussmann street wall), `TC` composite, `TPE` small-scale, `TD` discontinuous, `TI` industrial, `HBM` regular with open courts (the 1920s–30s social housing), `ER` remarkable buildings, `IGH` high-rise (over 37 m).
- `roof`: APUR's roof form (`c_forme_toit`) in Overture's words: `flat`, `gabled` (two slopes, in tile or small-scale fabric) or `mansard` (brisis and terrasson).
- `height`: APUR's median height of the footprint (`h_med`, metres), which fills buildings Overture gives no height or floors.
- `hood`: the quartier's name (`Gros-Caillou`, `Saint-Germain-des-Prés`, …), for `hoods:` rules.

**Data and licences** (checked 2026-11-10; `docs/second-region.md` §8):
- APUR, "Emprise bâtie Paris" and "Quartier de Paris": ODbL 1.0. APUR's catalogue credits Apur, DGFiP, Ville de Paris (STDF) and Aerodata's orthophotos.
- IGN, BD TOPO®, RGE ALTI® and LiDAR HD: Licence Ouverte / Open Licence 2.0 (Etalab), per IGN's catalogue records; it asks for the source and the date of the data's last update.

Downloads go to the pipeline's shared cache: `paris/` (limited to the region's box and named by the version) and `ign/` (2,000-pixel tiles on a Lambert-93 grid, named by layer, resolution and tile).

## Layout

```
pixelworld-city-paris/
├── pyproject.toml              the package, and its entry points
├── README.md
├── src/pixelworld_city_paris/
│   ├── __init__.py
│   ├── apur.py                 APUR's ArcGIS REST and BD TOPO's WFS, paging and caching, the joins, ApurFacts
│   └── ign.py                  IGNElevation: WMS-Raster tiles in Lambert-93, cached, reprojected
└── tests/
    └── test_city_paris.py      offline: the joins, years, uses, lookups, tiles, the entry points
```
