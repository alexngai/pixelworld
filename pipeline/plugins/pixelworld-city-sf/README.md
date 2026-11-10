# pixelworld-city-sf

San Francisco's city pack for the [pixelworld](https://github.com/alexngai/pixelworld) pipeline (`pixelworld-pipeline`). It is the first city pack, and the template for others: see `docs/plugins.md` in the repository.

## What it provides

| Entry point group | Name | What |
|---|---|---|
| `pixelworld.facts` | `datasf` | DataSF's assessor roll joined to parcel polygons: year built, storeys, units, use, property class and neighbourhood per map lot (`pixelworld_city_sf.datasf:DataSFFacts`) |

A region spec names it in its typology section (D-055):

```yaml
objects:
  typology:
    facts: datasf
    # or, with options:
    facts: { plugin: datasf, rollYear: "2025", classCodes: true }
```

**Options:**
- `rollYear`: the closed roll year. Default: the latest, asked of DataSF.
- `classCodes`: give each building's `class` as the assessor's property class code (`D`, `F`, `A5`, `OC`, …) rather than its definition (`Dwelling`, `Flats & Duplex`, …), so `classes:` rules can match codes and prefixes (`classes: [D, "F*"]`). It costs one more download, which is cached. The definition stays available as `classDefinition`.

**Facts per building:** `year`, `stories`, `units`, `use` (the assessor's use definition, which the pipeline maps to residential, mixed, commercial, industrial or civic), `class`, `construction` and `hood` (the analysis neighbourhood). Condominium units on one map lot are aggregated: the earliest year, the most storeys, the sum of units, the most common use and class.

**Data and licence:** [DataSF](https://data.sf.gov/), the Assessor Historical Secured Property Tax Rolls (`wv5m-vpq2`) and Parcels (`acdm-wktn`), under the ODC PDDL 1.0. The pack adds this attribution to every world that uses it. Downloads go to the pipeline's shared cache, in `datasf/`.

## Layout

```
pixelworld-city-sf/
├── pyproject.toml              the package, and its entry points
├── README.md
├── src/pixelworld_city_sf/
│   ├── __init__.py
│   └── datasf.py               Socrata paging and caching, lot aggregation, DataSFFacts
└── tests/
    └── test_city_sf.py         offline: aggregation, lookups, the entry point
```

## Development

In the repository, the pack is a member of the pipeline's uv workspace, and `uv sync` in `pipeline/` installs it (the `plugins` dependency group). Its tests run with the pipeline's:

```sh
cd pipeline
uv run pytest -q plugins/pixelworld-city-sf/tests
uv run pixelworld plugins ../worlds/sf/region.yaml   # is everything the spec names installed?
uv build --package pixelworld-city-sf
```

**Still to come:** San Francisco's TypeScript generators (facades, towers, Chinatown) are meant to join the pack as its browser side (decision D4 in `docs/library.md`).
