# Data sources and licensing

Status: living document. Licenses below are as we understand them at the time of writing. **Confirm each source's license when it is first integrated into the pipeline**, and record it in the world manifest's attribution list.

## 1. Rules

**Allowed:** openly licensed sources whose terms permit derived databases and redistribution (with attribution and/or share-alike).

**Not allowed in the pipeline, the editor, or as tracing references:**

| Source | Why |
|---|---|
| **Google Maps Platform, Google Maps, Google Earth** (imagery, Photorealistic 3D Tiles, Elevation API, Places, Street View) | The Google Maps Platform Terms §3.2.3 (last modified 2026-08-26) prohibit: exporting or scraping content for use outside the services, including bulk downloading tiles and elevation values; creating content based on Google Maps content, with tracing building outlines and roads, creating 3D models from 45° imagery, building terrain models from Elevation API values, and ML/AI training given as examples; and using the services with or near a non-Google map. |
| **Mapbox** tiles and imagery | Our understanding is that the terms prohibit extraction outside their SDKs/APIs, and that the satellite tracing permission covers OpenStreetMap contributions only. (Not yet re-verified against the current text.) Mapbox offers nothing unique for us anyway: Streets is OSM and Terrain is built from public DEMs, so we use those sources directly. |
| **Esri World Imagery, Bing Maps imagery** | Tracing permissions exist only for contributing to OpenStreetMap. |

**Openly licensed datasets published by these companies are a different matter.** Google Open Buildings and Microsoft building footprints are released under open licenses and are allowed.

**Reference photos:** artists may look at public or openly licensed photos for reference. We never trace restricted imagery, and we never build tooling around it. Reference layers in the editor use open imagery only.

## 2. Is open data enough for semantic content?

For our level of abstraction, yes. Cells range from about 10 to about 400 m, and objects are generated from style packs. So what we need from data is **classification, footprints, heights and colors**, not sub-meter visual detail.

- **What limits quality:** OSM completeness (good in the US, Europe and Japan; patchy elsewhere) and height/roof-shape coverage (excellent where lidar or 3D city models exist, procedural elsewhere).
- **The role of imagery:** sampling colors (roofs, soil, field patterns) and filling gaps with segmentation (canopy, pools, parking lots). NAIP's 60 cm is enough for both. A 10 m roof covers about 16 NAIP pixels, plenty for a mean color.

## 3. Semantic layer fusion

**In use as of M1** (US Southwest; the full matrix below is the target):

| Layer | Source | How it's read |
|---|---|---|
| Elevation | USGS 3DEP 1 arc-second (30 m) | the 120 m overview of each COG tile, over HTTP range requests, averaged per cell corner |
| Elevation (micro-terrain, M1.6) | USGS 3DEP 1 arc-second (30 m) | the 60 m overview, averaged per micro-corner (100 m apart in the Southwest) |
| Elevation (fine cells, M1.5) | USGS 3DEP 1/3 arc-second (10 m) | full resolution or an overview, averaged per cell corner |
| Importance (M2) | Wikidata items with coordinates, scored by sitelinks | SPARQL query over the region's bounds, saved as a committed snapshot (`worlds/<id>/importance.json`); CC0 |
| Buildings (M1.5) | Overture buildings and building parts | footprints, class and height (or floors × 3.5 m), over HTTP range reads; parts become towers on a podium |
| Land cover | ESA WorldCover 2021 (10 m) | the 160 m overview, mode-resampled per cell |
| Roads | Overture `transportation/segment` (from OSM), release pinned in the region spec | GeoParquet row groups pruned by bounding box from a cached footer index |
| Rivers | Overture `base/water` lines | same |
| Rail and ferry lines (M3.5) | Overture `transportation/segment`, subtypes rail and water | rails drawn in the street (D-061) and traffic routes (D-060) |
| Parks and natural land (M3.5) | Overture `base/land_use` (park, golf, pitch, garden, cemetery, …) and `base/land` (grassland, scrub, heath, beach) | polygons moved with the straightened roads; lawn surfaces where the spec's `ground` section asks (D-062) |
| Lakes | WorldCover water class, flattened per water body | — |
| Building facts (San Francisco, D-055) | DataSF assessor roll and parcels | the `datasf` facts source, in the city pack `pixelworld-city-sf` (`pipeline/plugins/pixelworld-city-sf/`): Socrata API, paged, cached in `pipeline/.cache/datasf/` |
| APUR Emprise bâtie Paris | built footprints with construction period and year, median height, roof form and urban fabric class. Read by the `apur` facts source in the city pack `pixelworld-city-paris` | Paris | ODbL 1.0 |
| IGN BD TOPO® | buildings with storeys, dwellings, use and height | France | Licence Ouverte 2.0 |
| Building facts (New York, D-080) | NYC Open Data: BUILDING footprints (OTI, `5zhs-2jue`), PLUTO (DCP, `64uk-42ks`), the LPC Individual Landmark and Historic District Building Database (`gpmc-yuvp`), 2020 NTAs (DCP, `9nt8-h7nd`). Licence: NYC Admin Code §23-502(d), "without any registration requirement, license requirement or restrictions on their use"; the city may ask for each data set's source, version and a description of modifications, which the attribution gives (checked 2026-11-09, second-region.md §7) | the `pluto` facts source, in the city pack `pixelworld-city-nyc`: Socrata API, limited to the region's box, paged, cached in `pipeline/.cache/nyc/` under the PLUTO release |
| Elevation (France, D-084) | IGN RGE ALTI® 1 m and LiDAR HD 50 cm DTMs, from the Géoplateforme's WMS-Raster. Licence: Licence Ouverte / Open Licence 2.0 (Etalab), per IGN's catalogue records (checked 2026-11-10, second-region.md §8) | the terrain sources `ign-rgealti` and `ign-lidar-hd-mnt`, in the city pack `pixelworld-city-paris`: 2,000-pixel float32 GeoTIFF tiles in Lambert-93 at the resolution the overview asks for (the server resamples), cached in `pipeline/.cache/ign/`, then reprojected and averaged per cell corner |
| Building facts (Paris, D-084) | APUR's "Emprise bâtie Paris" (period, year, median height, roof form, urban fabric) and "Quartier de Paris": ODbL 1.0. IGN's BD TOPO® buildings (storeys, dwellings, use): Licence Ouverte 2.0, which asks for the source and the date of its last update (checked 2026-11-10, second-region.md §8) | the `apur` facts source, in the city pack `pixelworld-city-paris`: APUR's ArcGIS REST service and the Géoplateforme's WFS, limited to the region's box, paged, cached in `pipeline/.cache/paris/` under a version tag. Its `height` fills buildings Overture gives no height or floors |

- **Plugins:** elevation and land cover are read through source adapters, and building facts through facts sources, all found by name ([plugins.md](plugins.md)). A new region's national DEM or city records come in as a plugin. 3DEP and WorldCover are built in.
- **Why Overture rather than OSM extracts:** releases are versioned, so builds are reproducible from the spec alone, and GeoParquet supports bounding-box range reads. (Geofabrik and Overpass were also unreachable from the build environment at the time.)
- **NLCD isn't used yet:** WorldCover is global, so the same code serves non-US regions in M5.

The pipeline's `semantics` stage fills each layer from the first available source in this order, falling back to procedural defaults.

| Layer | Primary | Gap fill | Fallback |
|---|---|---|---|
| Terrain (bare earth) | USGS 3DEP DEM (US); national lidar DTMs (EU) | Copernicus GLO-30 | — |
| Water (rivers, lakes, coast) | OSM water polygons + waterways; USGS NHD (US) | WorldCover water class; water index from imagery | — |
| Land cover / surface | NLCD (US); OSM landuse/natural polygons; ESA WorldCover | segmentation of NAIP / national orthophotos | biome default (style pack) |
| Roads and rail | OSM | Overture transportation | — |
| Building footprints | OSM + Overture (includes Microsoft and Google Open Buildings) | 3D city models | — |
| Building heights | 3D city models; lidar (surface minus terrain) | OSM `height` / `building:levels`; Overture height | estimate from use, area and region style |
| Roof shape | 3D city models (LoD2) | OSM `roof:shape`; roof fitting from lidar (later) | style-pack default by use |
| Building use | OSM building/amenity/shop tags; POIs inside the footprint | surrounding land use | generic, by zone |
| Building age and type | city assessor and parcel records (e.g. DataSF); footprint geometry and street frontage (D-055) | OSM `start_date`, `building:architecture` | type by shape and neighbourhood |
| Trees / canopy | lidar (3DEP, AHN, …); Meta/WRI 1 m canopy height | OSM woods and individual trees; city tree inventories | density from land cover |
| Colors (roofs, ground tint) | sampled from NAIP / national orthophotos | Sentinel-2 | style-pack palette |
| Small features (pools, parking, sports fields) | OSM | imagery segmentation (later) | omitted |
| POIs and fame | Wikidata, Wikipedia pageviews, OSM tourism/historic/natural tags | Overture places | — |
| Landmark shape | hand-made hero assets (3D city models as a blockout reference) | Mapillary / Wikimedia Commons photos (reference only) | generic variant |

## 4. Coverage tiers

| Tier | What's available | Examples |
|---|---|---|
| 1 | Open 3D city models + lidar + high-res orthophotos + OSM | Netherlands, Switzerland, many German states, Japan (PLATEAU cities), New York City |
| 2 | Lidar + NAIP + OSM | most of the US (including the Southwest pilot region) |
| 3 | National orthophotos + OSM (lidar varies) | France, Spain, Austria, Nordic countries, England (lidar open; orthophotos not) |
| 4 | Global datasets only | everywhere else: Copernicus DEM, WorldCover, Sentinel-2, Overture, OSM; heights and roofs procedural |

## 5. Catalog

### Elevation and lidar

| Source | Provides | Resolution / coverage | License |
|---|---|---|---|
| Copernicus DEM GLO-30 | surface elevation | 30 m, global | Copernicus DEM license (free, with attribution) |
| USGS 3DEP DEMs | bare-earth elevation | 1/3″ (~10 m) seamless; 1 m where lidar exists; US | public domain |
| USGS 3DEP lidar | classified point clouds (ground, buildings, vegetation) | most of the US | public domain |
| AHN | lidar / DSM / DTM | Netherlands | CC0 |
| Environment Agency lidar | DSM / DTM | England | Open Government Licence |
| IGN LiDAR HD | classified point clouds; DTM, DSM and canopy height at 50 cm | France (where flown; Paris is) | Licence Ouverte 2.0 (IGN's catalogue record, checked 2026-11-10) |
| IGN RGE ALTI® | bare-earth DTM | 1 m, France | Licence Ouverte 2.0 (IGN's catalogue record, checked 2026-11-10) |
| PNOA-LiDAR | point clouds | Spain | CC BY 4.0 |
| swissSURFACE3D | point clouds / DSM | Switzerland | swisstopo open data (attribution) |

### 3D city models and buildings

| Source | Provides | Coverage | License |
|---|---|---|---|
| 3D BAG | every building, LoD 1.2–2.2 with roof shapes (CityJSON) | Netherlands | CC BY 4.0 |
| PLATEAU | CityGML 3D city models (LoD1–2, some LoD3) | many Japanese cities | open (CC BY 4.0-compatible terms) |
| State LoD2 CityGML | LoD2 buildings with roofs | several German states | varies by state (dl-de/zero, CC BY, …) |
| swissBUILDINGS3D | 3D buildings with roofs | Switzerland | swisstopo open data (attribution) |
| NYC 3D Building Model | 3D buildings | New York City | NYC Open Data |
| Overture buildings | footprints merged from OSM, Microsoft, Google Open Buildings and others; heights where known | global | ODbL |
| Microsoft building footprints | ML footprints, some heights | global | ODbL |
| Google Open Buildings (incl. 2.5D) | ML footprints; heights in some areas | Global South focus | CC BY 4.0 / ODbL |
| DataSF assessor roll and parcels | year built, storeys, units, use, property class and neighbourhood per lot; lot polygons. Read by the `datasf` facts source in the city pack `pixelworld-city-sf` | San Francisco | ODC PDDL 1.0 |

### Vector features and POIs

| Source | Provides | License |
|---|---|---|
| OpenStreetMap | roads, rail, water, land use, buildings, POIs | ODbL |
| Overture Maps | transportation, places, base (land/water), buildings | per theme: ODbL (buildings, transportation, base); CDLA-Permissive-2.0 (places) |
| USGS NHD | rivers, lakes, streams (US) | public domain |
| Natural Earth | coarse world features for far-zoom LODs | public domain |
| Wikidata | landmark metadata, coordinates, sitelinks | CC0 |
| Wikipedia pageviews | fame signal | open (verify at ingest) |

### Land cover and vegetation

| Source | Provides | Resolution / coverage | License |
|---|---|---|---|
| ESA WorldCover | 11 land-cover classes | 10 m, global | CC BY 4.0 |
| NLCD (Annual) | land cover, including how built-up an area is | 30 m, US | public domain |
| Meta/WRI canopy height | tree canopy height | 1 m, global | CC BY 4.0 |
| City of Paris, "Les arbres" | 220,339 trees with species, height and girth (not read yet) | Paris | ODbL 1.0 |

### Imagery (color sampling, gap fill, editor reference)

| Source | Resolution / coverage | License |
|---|---|---|
| NAIP | 60 cm (finer in some states), RGB + near-infrared, contiguous US, every 2–3 years | public domain |
| PDOK aerial photos | ~8–25 cm, Netherlands | CC BY 4.0 |
| IGN BD ORTHO | 20 cm, France | Licence Ouverte 2.0 |
| PNOA orthophotos | 25 cm (some 15 cm), Spain | CC BY 4.0 |
| SWISSIMAGE | 10 cm, Switzerland | swisstopo open data (attribution) |
| basemap.at orthophotos | Austria | CC BY 4.0 |
| State orthophotos (DOP) | 20 cm, several German states | varies by state |
| City / county orthophotos | 7.5–30 cm, many US cities and counties (e.g. NYC) | varies |
| Sentinel-2 | 10 m, global, every few days | Copernicus open data (attribution) |
| OpenAerialMap | drone/aerial, patchy | CC BY 4.0 |

### Reference only (not ingested)

| Source | Use | License |
|---|---|---|
| Mapillary | street-level facade reference for hero assets | CC BY-SA 4.0. Reference only, so share-alike doesn't attach to our assets. |
| Wikimedia Commons | landmark photo reference | per file |

### Commercial (only if open data runs out)

Nearmap (~5–7 cm aerials and 3D), Planet SkySat (50 cm), Airbus Pléiades Neo (30 cm), Maxar. Any license must explicitly allow **derived datasets** and their redistribution in our world package.

## 6. Licensing consequences

- **ODbL share-alike:** the world package (chunks and manifest) is a *derivative database* of OSM and Overture's ODbL themes. If we distribute it publicly, we must offer it under the ODbL.
  - Not affected: game code, independently authored art (hero assets, style packs) and rendered images ("produced works").
  - All of them still need attribution: "© OpenStreetMap contributors".
- **Attribution:** the manifest lists every source used in a region, and the app has an attribution screen built from it.
- **Share-alike imagery** (e.g. Mapillary) is used for reference only, never ingested.

## 7. Depiction and compliance policy

- **Default:** buildings and landmarks visible from public places are depicted in their canonical form. In the US, 17 U.S.C. §120 allows pictorial representations of constructed architectural works visible from public places.
- **Protected elements get a stylized or generic variant**, chosen per release target in the landmark registry (`depiction` field). These include:
  - trademarks (e.g. the Hollywood Sign; the Empire State Building's image, which its owners use as a trademark: its generic depiction is a setback tower of its height, with no mast or lighting of its own)
  - copyrighted displays (e.g. the Eiffel Tower's night lighting)
  - public sculpture and artworks (§120 covers architecture, not sculpture)
- **Brands and signage:** no real brand names or logos on buildings by default (relevant to the Las Vegas Strip). Signs use generic or invented names unless licensed.
- **Freedom of panorama varies by country** (France's is narrow, for example). The landmark registry records the jurisdiction so release targets can pick the right variants.
- **Legal review** is required before any commercial launch. This document is not legal advice.
