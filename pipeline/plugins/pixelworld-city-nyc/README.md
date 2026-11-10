# pixelworld-city-nyc

New York City's city pack for the [pixelworld](https://github.com/alexngai/pixelworld) pipeline (`pixelworld-pipeline`). Its layout follows `pixelworld-city-sf`; see `docs/plugins.md` in the repository.

## What it provides

| Entry point group | Name | What |
|---|---|---|
| `pixelworld.facts` | `pluto` | NYC Open Data's building footprints joined to PLUTO tax lots and the Landmarks Preservation Commission's building database: year built, storeys, units, use, building class, facade material and neighbourhood per building (`pixelworld_city_nyc.pluto:PlutoFacts`) |

A region spec names it in its typology section (D-055):

```yaml
objects:
  typology:
    facts: pluto
    # or pinned to the PLUTO release its downloads were cached under:
    facts: { plugin: pluto, version: "26v2" }
```

**Options:**
- `version`: the PLUTO release. Default: the current one, asked of the portal. The portal serves only the current release, so pinning keeps a build on the downloads it cached before.

**Facts per building** (looked up by point in footprint):
- `year`: the LPC record's earliest date, else the footprint's construction year (except 1900, a placeholder), else PLUTO's year built. PLUTO's years are mostly rounded to 5 or 10, so rules should lean on `class`.
- `stories`, `units`: PLUTO's floors and residential units (per lot).
- `use`: PLUTO's land use code, mapped to residential (01–03), mixed (04), commercial (05), industrial (06) or civic (07–08).
- `class`: PLUTO's building class, unchanged (`A4`, `C7`, `D1`, `L1`, `O4`, …), for `classes:` rules.
- `material`: the LPC record's primary material (`Brownstone`, `Cast Iron`, `Brick`, …), for `materials:` rules. Only buildings in designated landmarks and historic districts have one.
- `hood`: the 2020 Neighborhood Tabulation Area's name, for `hoods:` rules.

**Data and licence:** NYC Open Data:
- BUILDING footprints (OTI, `5zhs-2jue`);
- PLUTO (DCP, `64uk-42ks`);
- the Individual Landmark and Historic District Building Database (LPC, `gpmc-yuvp`);
- the 2020 NTAs (DCP, `9nt8-h7nd`).

NYC Admin Code §23-502(d) makes them available without restrictions on their use. The city may ask users to name each data set's source and version and describe their modifications; the pack's attribution, added to every world that uses it, does. Downloads go to the pipeline's shared cache, in `nyc/`, limited to the region's box and named by the PLUTO release.

## Layout

```
pixelworld-city-nyc/
├── pyproject.toml              the package, and its entry points
├── README.md
├── src/pixelworld_city_nyc/
│   ├── __init__.py
│   └── pluto.py                Socrata paging and caching, the joins, PlutoFacts
└── tests/
    └── test_city_nyc.py        offline: the joins, year fallbacks, lookups, the entry point
```
