# Second region: which cities have open data for a San Francisco-grade world (research, for discussion)

Research date: 2026-11-09. Scope: the M5 "second region from coverage tier 1" decision (roadmap §M5, data-sources.md §4). No code was changed.

**Decided (D-078):** all three top candidates, in the order New York, Paris, Amsterdam. New York's sources were then checked directly from an open network (§7), which corrects §3 and §4 where they disagree.

**How this was verified.** This session's network only allows the hosts in the pixelworld environment (DataSF, Wikidata, USGS and others). Every official portal tried was blocked: nyc.gov, opendata.cityofnewyork.us, data.cityofchicago.org, opendata.dc.gov, 3dbag.nl, mlit.go.jp, data.gv.at, hri.fi and data.gouv.fr. Facts below were checked in three ways:
- **Search:** web-search results that quote the official dataset, metadata and licence pages. The URLs given are the official pages those results came from.
- **Code search:** GitHub code search, to confirm field names and value codes in code that queries the live APIs. NYC Planning's own ZoLa app gave PLUTO's class codes.
- **GitHub pages:** pages hosted on GitHub that WebFetch could read. The City of Philadelphia's licence was read verbatim this way, and so were the geospatial.jp licence record and the PLATEAU site policy, quoted in a third-party repo.

Anything that rests on one secondary source is marked *(unverified)* or *(third-party)*. Section 6 lists every gap. Before integrating any of these sources, re-read its licence page directly, as data-sources.md already requires.

---

## 1. Bottom line

| Rank | City | Score | Why |
|---|---|---|---|
| 1 | **Amsterdam** (and the rest of NL) | A | The exact tier-1 case the roadmap names. 3D BAG gives every building LoD2.2 roofs, heights and floors in CityJSON (CC BY 4.0). BAG gives the original build year and use (CC0), and AHN a 0.5 m DTM (CC0). Canal houses are data-drivable from year, width, roof and canal frontage. One adapter covers the whole country. |
| 2 | **New York City** | A | The closest analogue to DataSF. It runs on the same Socrata API, so `datasf.py` is nearly a template. PLUTO's per-lot class codes name the iconic fabric outright (C4 "Walk-up Apartments – Old Law Tenements", A4 "City Residence", L loft buildings, O4 towers). Footprints carry roof height and year, and USGS lidar EPT already works with `lidar.py`. ⚠ There is no named licence, only the Open Data Law's "without any restrictions". |
| 3 | **Paris** | A | The most recognizable ordinary fabric of all candidates, driven by just two open fields: APUR's construction period (11 classes) and height (ODbL), plus BD TOPO floors and use (Licence Ouverte 2.0). Street trees come from the city (ODbL). There's no open LoD2 roof model, so the Haussmann mansard comes from rules. |

**Close alternatives:**
- **Montréal (A):** CC BY 4.0 throughout. Its assessment roll has year, floors above ground, dwellings and use per unit, and LoD2 CityGML exists for some boroughs. The plex-with-outdoor-staircase fabric is a near-perfect counterpart to SF's Victorian rows. Pick it over Paris if you want a CityGML path and a North American style pack that reuses the row-house generators.
- **Kyoto (B):** the best PLATEAU city for typing. Year, structure and use come with the CityGML. Tokyo's 23 wards appear to carry no build year.
- **Boston and Washington DC (B):** the cleanest US licences, PDDL and CC BY 4.0. Boston's assessor even has a `DK - Decker` building type, the triple-decker.

**Licence red flags (details in §5):**
- **Philadelphia:** the city keeps all rights and grants no explicit right to modify or redistribute (verified verbatim).
- **Chicago and Cook County:** the city's terms grant no IP rights and let it demand that you stop distributing; the Cook County Assessor's data has no licence.
- **Los Angeles:** the 2023 building outlines with heights are "LARIAC Members only".
- **King County / Seattle:** a limited, revocable licence.
- **London:** OS building age, floors and heights are paid products.
- **Barcelona:** some city data is CC BY-ND; the Catastro uses its own licence.
- **US transit feeds:** MTA, WMATA and others have custom developer terms. We don't need them, because rail lines already come from Overture.

---

## 2. What the pipeline needs from a city (the contract to match)

From `sources/datasf.py`, `typology.py`, `objects.py` and `rasters.py`:
- **Facts per building:** `typology.features()` reads `year`, `stories`, `use` (mapped by `use_group()` to residential, mixed, commercial, industrial or civic) and `hood`. DataSF also supplies `units`, `class` and `construction`, but no rule reads them yet. Facts are looked up by point-in-lot (`ParcelFacts.at`).
- **Elevation:** `rasters.py` knows only USGS 3DEP (`usgs-3dep-1arcsec`, `usgs-3dep-13arcsec`) and WorldCover. Any non-US region needs a new DEM kind: Copernicus GLO-30 at least, or a national DEM.
- **Lidar:** `lidar.py` reads USGS Entwine Point Tiles only. That covers NYC, Boston and DC directly.
- **Transit:** `transit.py` uses Overture rail and ferry segments with their `routes`, so a GTFS reader is optional everywhere: route names, colours and frequencies for ambient traffic (D-060).
- **Two refactors every candidate needs:**
  1. Turn `if spec.get("facts") == "datasf"` into a registry of facts sources, all returning one normalized dict: `year, stories, units, use, class, hood`, plus optional `roof` and `material`.
  2. Add rule fields `classes:` (a source's native building class: PLUTO `bldgclass`, Boston `BLDG_TYPE`, DC `STRUCT`, Philadelphia `building_code_description`, Helsinki `rakennusaine_s`) and `roofs:`. In most candidates the iconic type is in the class code, not in year plus use.
- **Status (after this research):** both refactors are done, and DEMs are plugins too ([plugins.md](plugins.md)):
  - facts sources are plugins (`pixelworld.facts`), and DataSF is the city pack `pixelworld-city-sf`;
  - `classes:` and `roofs:` are rule fields;
  - a "DEM kind" below is now a terrain source plugin (`pixelworld.sources`), and 3DEP is the first.

---

## 3. Comparison table

Key: ✔ open and fit for us · ⚠ usable with a caveat · ✖ blocks the use. Scores: **A** = every core layer open, verified and fetchable over HTTPS, with recognizable fabric the data can drive. **B** = one significant gap (coverage, access, a licence ambiguity in a core layer, or weaker fabric). **C** = a core layer blocked by licence or availability.

| City | 1 Footprints + heights / 3D | 2 Building attributes | 3 Elevation | 4 Trees, parks | 5 Transit | 6 Access | 7 Licence | 8 Iconic fabric (data-drivable?) | Score |
|---|---|---|---|---|---|---|---|---|---|
| **New York City** | Official footprints (~1.08M) with `height_roof`, `construction_year`, BBL, updated weekly. 3D model (2014, CityGML; TUM LoD2 version). Overture/OSM from the 2013–14 full import, with heights | PLUTO per lot: `yearbuilt`, `numfloors`, `bldgclass` (A/B/C/D/K/L/O… codes), `landuse`, units | 3DEP 10 m; USGS lidar EPT `NY_NewYorkCity` | Forestry Tree Points (`hn5i-inap`, current); 2015 Street Tree Census (`uvpi-gqnh`); Overture parks | MTA GTFS ⚠ custom terms; rail via Overture | Socrata SoQL (same as DataSF) | ⚠ Open Data Law: "without any restrictions on their use"; no named licence | Brownstones, walk-up tenements with fire escapes, cast-iron lofts, prewar elevator blocks, Deco towers. ✔ `bldgclass` and year | **A** |
| Chicago | Footprints with `year_built`, `stories` (year stops ~2015 *(third-party)*) | Cook County Assessor residential characteristics (wall, roof…) | 3DEP + EPT | not checked | not checked | Socrata | ✖ City terms grant no IP rights, can demand termination; Cook County: no licence | Two- and three-flats, greystones, bungalow belt. ✔ data drives it | **C** |
| Boston | Overture (some heights USGS-lidar-derived); BPDA 3D model; roof-break outlines (PDDL) | Property assessment: `YR_BUILT`, floors, land use ("THREE-FAM DWELLING"), `BLDG_TYPE` ("DK - Decker", "RE - Row End", "RM - Row Middle"), roof structure and cover | 3DEP; EPT `MA_CentralEastern_1_2021` | not verified | not verified | CKAN (Analyze Boston) | ✔ PDDL (default for all Analyze Boston datasets) | Triple-deckers, bowfront brick rows. ✔ `BLDG_TYPE` names it | **B** |
| Philadelphia | L&I footprints (546k) with `approx_hgt`/`max_hgt` | OPA: `year_built`, `number_stories`, `building_code_description` ("ROW 2 STY MASONRY", "ROW B/GAR 2 STY MASONRY") | 3DEP + EPT | not checked | not checked | ArcGIS FeatureServer, Carto SQL | ✖ City of Philadelphia License: City keeps all rights; no explicit modify or redistribute grant; indemnity | Rowhouses. ✔ the building code spells them out | **C** |
| Washington DC | Footprints (CC BY 4.0); 3D Buildings 2024 max height from lidar ⚠ returns redacted inside the Secret Service boundary | CAMA residential: `AYB`, `STORIES`, `STRUCT` (Row Inside, Row End, Semi-Detached, Single, Multi), `STYLE`, `EXTWALL`, `ROOF` | 3DEP + DC lidar | Urban Forestry street trees (~175k), CC BY 4.0 | WMATA ⚠ own terms | ArcGIS REST, CSV/GeoJSON | ✔ CC BY 4.0 | Victorian rowhouses with bays and turrets, flat Height Act skyline. ⚠ streets may read as Philadelphia or Baltimore | **B** |
| Seattle | Outlines without height | King County Assessor (year, stories) | 3DEP | – | – | portal | ✖ King County: limited, revocable licence | Craftsman houses; weak | **C** |
| Los Angeles | ✖ LARIAC Building Outline 2023 (with height) is "LARIAC Members only" | County assessor (year, use) ⚠ licence unclear | 3DEP | – | – | ArcGIS | ✖ / ⚠ | Spanish Revival bungalows, dingbats, palms | **C** |
| Portland | Metro buildings with height and stories (ODbL per an old OSM import page) | DOGAMI statewide `YEAR_BUILT` | 3DEP | – | – | ArcGIS | ⚠ unclear | Weak | **C** |
| **Amsterdam** (all NL) | 3D BAG: every NL building, LoD 0/1.2/1.3/2.2 with roof shapes (CityJSON); `b3_h_dak_max`, `b3_h_maaiveld`, `b3_dak_type`, `b3_bouwlagen` | BAG: `oorspronkelijkbouwjaar` (100%; 1005 and 1905 placeholders), `gebruiksdoel` per dwelling unit | AHN 0.5 m DTM/DSM | City trees (~270k) ⚠ municipal licence; Overture parks | OVapi GTFS (CC0 per 2014 posts); trams via Overture | 3D BAG tiles plus OGC API Features; PDOK ATOM/WFS | ✔ BAG and AHN CC0, 3D BAG CC BY 4.0 | Canal houses: narrow, gabled, brick. Amsterdam School blocks, houseboats. ✔ year, width, LoD2.2 roof, canal adjacency; ⚠ gable type not in data | **A** |
| Rotterdam | Same national data (3D BAG, BAG, AHN) | same | same | city data not checked | same | same | ✔ | Post-war rebuild and modernism; less distinctive streets | **B** |
| Tokyo (23 wards) | PLATEAU CityGML 2.0 + i-UR: LoD1 everywhere, LoD2 in parts | `usage`, `storeysAboveGround`; ⚠ `yearOfConstruction` 0% in all 23 tilesets *(third-party)*; structure type unverified | GSI 5 m DEM (CC BY 4.0-compatible terms) | not verified | ODPT ⚠ mixed licences | geospatial.jp CKAN (multi-GB zips), 3D Tiles | ✔ PDL 1.0 / CC BY | Dense low-rise wooden houses, pencil buildings, utility poles. ⚠ no age to drive it | **B** |
| Kyoto | PLATEAU LoD1/2 (some LoD3) | `yearOfConstruction` (82.6% of a 6.4k sample *(third-party)*), usage, storeys, structure type | GSI 5 m | – | City Bus GTFS via ODPT ⚠ licence unclear | same | ✔ PDL 1.0 / CC BY | Machiya rows, temples, tiled roofs. ✔ year, wooden structure, two storeys | **B** |
| Berlin | Statewide LoD2 CityGML (dl-de/zero-2.0) | Gebäudegeschosse WFS (floors, dl-de/zero); ALKIS function; ⚠ age only per city block (2011 census decades) | DGM1 1 m (dl-de/zero) | Baumbestand WFS street trees (dl-de/zero; park trees dl-de/by) | VBB, not verified | Atom + WFS | ✔ | Gründerzeit perimeter blocks, Plattenbau. ⚠ block-level age | **B** |
| Hamburg | LoD2-DE CityGML (dl-de/by-2.0) | Function; build year not found | not checked | not checked | not checked | Atom/WFS | ✔ | Red-brick Kontorhaus and Klinker housing. ⚠ no age | **B** |
| Vienna | LoD2 CityGML tiles + Baukörpermodell LoD1.4, ~200k buildings (CC BY 4.0) | `GEBAEUDEINFOOGD`: `BAUJAHR`, `GESCH_ANZ`, `ARCHITEKT`; `BAUPERIODEDETAILOGD`: period per building part (439k parts, "Vor 1683" … "Nach 1976") | DGM (CC BY 4.0) | Baumkataster CC BY 4.0 | Wiener Linien GTFS, licence unverified | OGD WFS 1.1 | ✔ CC BY 4.0 | Gründerzeit blocks, Gemeindebau. ⚠ could read as Budapest or Prague | **B** |
| Helsinki | 3D model CityGML LoD1/LoD2 (plus textured LoD2 and mesh), CC BY 4.0 | Register WFS `Rakennukset_alue_rekisteritiedot`: `c_valmpvm` (completion date), `i_kerrlkm` (floors), `c_kayttark` (use), `rakennusaine_s` (material) | City surface model; NLS lidar | Urban tree database, CC BY 4.0 | HSL GTFS, CC BY 4.0 | GeoServer WFS + CityGML sheets | ✔ CC BY 4.0 | Jugend stone blocks, Empire centre. ⚠ low international recognition | **B** |
| Zurich | LoD2 roof model CityGML (opendata.swiss terms: commercial allowed, no reference required) | Federal GWR: year (100%), floors, category ⚠ licence ambiguous | swissALTI3D | Baumkataster (city data mostly CC0) | opentransportdata.swiss ⚠ own terms | CKAN | ⚠ | Moderate | **B** |
| **Paris** | APUR built footprints (ODbL) + BD TOPO 2.5D heights (Licence Ouverte); LiDAR HD 50 cm DSM; no open LoD2 | APUR `C_PERCONST_APUR` (11 periods), heights (`H_MEDIANE`); BD TOPO floors and use; BDNB open | LiDAR HD 50 cm DTM (Etalab 2.0 ⚠ metadata conflict); RGE ALTI | "Les arbres" (ODbL; species, height, circumference) | IDFM GTFS: Licence Mobilité (ODbL plus user identification) | ArcGIS Hub download API; IGN Géoplateforme | ✔ ODbL, Licence Ouverte 2.0 | Haussmann blocks: cream stone, zinc mansards, iron balconies. ✔ period 1851–1914 + 5–7 floors | **A** |
| London | OS Open Map Local footprints, no heights; EA 1 m lidar DSM/DTM; ✖ OS NGD heights, age and floors are paid | Colouring London (ODbL, crowdsourced, patchy) | EA 1 m | not checked | TfL: OGL v2 plus amendments, revocable | EA WCS, downloads | ✖ key attributes paid | Georgian and Victorian terraces. ✖ age not reliably available | **C** |
| **Montréal** | LoD2 CityGML with textures, per borough and vintage (2009–2020; ⚠ partial coverage), CC BY 4.0; HRDEM 1 m DSM/DTM COGs for heights | Unités d'évaluation foncière (polygons, ~514k units): `ANNEE_CONSTRUCTION`, `ETAGE_HORS_SOL`, `NOMBRE_LOGEMENT`, `CODE_UTILISATION`/`LIBELLE_UTILISATION` | HRDEM 1 m (STAC/COG; OGL-Canada per a mirror) | Public trees + canopy, CC BY 4.0 | STM GTFS, CC BY 4.0 | CKAN (Données Québec) | ✔ CC BY 4.0 | Plexes with outdoor staircases and balconies, greystones. ✔ year, floors, dwellings | **A** |
| Barcelona | Catastro INSPIRE Building + BuildingPart (floors above ground) | Construction date, current use, units | PNOA lidar (CC BY 4.0) | City trees, CC BY 4.0 | TMB: API key, licence unverified | Catastro ATOM per province | ⚠ Catastro's own licence; some BCN data CC BY-ND ✖ | Eixample chamfered blocks. ✔ street geometry drives it | **B** |
| Copenhagen | GeoDanmark buildings; DHM 0.4 m | BBR: construction year, floors | DHM 0.4 m | not checked | not checked | ⚠ Datafordeler needs an account and token | ⚠ "frie data" terms (commercial use OK, attribution) | 5-storey brick perimeter blocks | **B** |

---

## 4. Per-city notes (key datasets, URLs, licences)

URLs are the official pages surfaced by search. Socrata IDs and field names were confirmed in code that calls the live APIs.

### New York City: A
- **Building Footprints:** Socrata `5zhs-2jue` (`https://data.cityofnewyork.us/resource/5zhs-2jue.json`); metadata at `https://github.com/CityOfNewYork/nyc-geo-metadata/blob/master/Metadata/Metadata_BuildingFootprints.md`.
  - **Fields:** `HEIGHT_ROOF` (feet above ground), `CONSTRUCTION_YEAR`, `GROUND_ELEVATION`, `BASE_BBL`, `MAPPLUTO_BBL`, `FEATURE_CODE`.
  - **Updates:** weekly. Citywide review every four years.
  - **Coverage:** about 1.08M buildings; 99.1% have a year, but 1900 is a common default *(third-party measurement)*.
- **PLUTO / MapPLUTO:** Socrata `64uk-42ks`, with fields including `yearbuilt`, `numfloors`, `bldgclass`, `landuse` and `unitsres`. Data dictionary: `https://s-media.nyc.gov/agencies/dcp/assets/files/pdf/data-tools/bytes/PLUTODD.pdf`. MapPLUTO lot polygons come from DCP's "Bytes of the Big Apple".
  - **Year:** DCP replaced `YearBuilt` with Landmarks Preservation Commission dates for about 27k buildings.
  - **Class codes** (from NYC Planning's own ZoLa lookup):
    - A4 "One Family – City Residence", A5 "Attached or Semi-Detached", B1 "Two Family – Brick".
    - C4 "Walk-up Apartments – Old Law Tenements", C7 "Over Six Families With Stores".
    - D-series elevator apartments; L1–L9 loft buildings; O1–O9 offices by storey band.
    - Land use 01–11.
- **NYC 3D Building Model:** every building in the 2014 aerial survey, as CityGML, multipatch and 3dm. "LOD 1.5 buildings" have no pitched roofs or domes. `https://data.cityofnewyork.us/d/tnru-abg2`. A TUM-derived LoD2 CityGML version: `https://www.asg.ed.tum.de/gis/projekte/new-york-city-3d/`. Optional for us, since the footprints already carry heights.
- **Lidar:** `https://s3-us-west-2.amazonaws.com/usgs-lidar-public/NY_NewYorkCity/ept.json`. USGS, public domain, and `lidar.py` reads it as is. (There is no `NY_NewYorkCity_2021` in the bucket; see §7.)
- **Trees:** Forestry Tree Points `hn5i-inap` (current, updated daily); the 2015 Street Tree Census `uvpi-gqnh` is frozen. See §7.
- **Transit:** MTA GTFS at `https://www.mta.info/developers`. The data is free, but the terms are MTA's own (`https://www.mta.info/developers/terms-and-conditions`). Use Overture rail instead.
- **Licence:** NYC Admin Code Title 23, Ch. 5 (Open Data Law) says public data sets "shall be made available without any restrictions on their use". The FAQ (`https://opendata.cityofnewyork.us/faq/`) says there are "no restrictions on the use of Open Data", but the Terms of Use add agency terms. OpenStreetMap imported the NYC footprints in 2013–14, a useful precedent.
- **Overture:** good. OSM's NYC buildings come from the city import, including roof heights, but those date from 2014.

### Chicago: C
- **Footprints:** Chicago Data Portal (`syp8-uezg`; `hz9b-7nh8` in older references), with `year_built` and `stories`. The year data seems to stop around 2015 *(third-party)*.
- **Assessor:** Cook County "Assessor – Single and Multi-Family Improvement Characteristics" on `datacatalog.cookcountyil.gov` (via `https://catalog.data.gov/dataset/assessor-single-and-multi-family-improvement-characteristics`). It covers properties with fewer than 7 units, 1999 to present.
- **Licence:**
  - Chicago datasets say "See Terms of Use". The City's Data Terms of Use (`https://www.chicago.gov/city/en/narr/foia/data_disclaimer.html`) say the City "may require a user … to terminate any and all display, distribution or other use … for any reason" and grant no IP rights.
  - Cook County Assessor datasets list "License not specified".
  - A 2013 city report mentions an MIT-style licence, and a third-party directory says public domain. Neither is current city text.
  - Not usable for shipped packages without written clarification.

### Boston: B
- **Property Assessment:** `https://data.boston.gov/dataset/property-assessment`, released yearly, PDDL.
  - **Fields:** `YR_BUILT`, `YR_REMODEL`, floors (`RES_FLOOR`/`NUM_FLOORS`), `ROOF_STRUCTURE`, `ROOF_COVER`, land use, and `BLDG_TYPE` with values such as "DK - Decker", "RE - Row End", "RM - Row Middle", "CL - Colonial" and "CV - Conventional" (confirmed in code that uses the data).
  - **Join:** parcel-level, so it needs a join to parcels (`https://data.boston.gov/dataset/parcels-2020`), just as DataSF does.
- **Licence:** Boston made PDDL the default for all Analyze Boston datasets (city announcement).
- **3D and heights:** "Boston 3D Buildings (Existing)" scene layer and the BPDA tiled 3D model; "Boston Buildings with Roof Breaks" (PDDL, `https://data.boston.gov/dataset/boston-buildings-with-roof-breaks`). The OMF/USGS lidar-height work covered Boston, so Overture heights should be decent *(not measured)*. USGS EPT `MA_CentralEastern_1_2021`.
- **Gaps:** trees and MBTA GTFS licences weren't verified.

### Philadelphia: C (licence)
- **OPA properties:** `https://opendataphilly.org/datasets/philadelphia-properties-and-assessment-history`, updated nightly; CSV, GeoJSON and Carto API (`opa_properties_public`).
  - **Fields:** `year_built`, `number_stories`, `building_code_description` ("ROW 2 STY MASONRY", "ROW B/GAR 2 STY MASONRY", "S/D OFF/STR 3 STY MASONRY"), `category_code_description`, `exterior_condition`.
- **Footprints:** `https://opendataphilly.org/datasets/building-footprints` (546k, `approx_hgt` in feet, updated weekly).
- **Licence:** "City of Philadelphia License" (`https://github.com/CityOfPhiladelphia/terms-of-use/blob/master/LICENSE.md`, read directly). The City "retains all … copyright … and other proprietary rights". "IF YOU DO NOT AGREE, YOU MAY NOT DOWNLOAD, SHARE OR DISTRIBUTE". It requires indemnification and a Pennsylvania forum, and has no explicit grant to modify or redistribute. **Not on our accepted list.**

### Washington DC: B
- **CAMA Residential:** `https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Property_and_Land/MapServer/25`, CC BY 4.0, updated daily.
  - **Fields:** `AYB`, `STORIES`, `STRUCT` (Row Inside, Row End, Semi-Detached, Single, Multi), `STYLE`, `EXTWALL`, `ROOF`.
  - **Others:** Commercial and Condominium CAMA tables exist separately.
- **Footprints and heights:** footprints 2015–2023 (CC BY 4.0, `https://catalog.data.gov/dataset/building-footprints-d97ff`); "3D Buildings 2024 Maximum Height" from the 2024 lidar.
  - ⚠ All returns except ground and water were removed inside the US Secret Service redaction boundary, so the core around the White House has no lidar heights.
- **Trees:** DDOT Urban Forestry Street Trees (~175k), CC BY 4.0.
- **Transit:** WMATA, own terms (`https://developer.wmata.com/license`).

### Seattle, Los Angeles, Portland: C
- **Seattle:** footprints have no height. King County's Open Data Terms are a "limited, revocable license" (`https://www.kingcounty.gov/About/dataTermsOfUse.aspx`).
- **Los Angeles:** the County's Building Outline (2023) with height is "LARIAC Members only" (`https://rpgis.isd.lacounty.gov/arcgis/rest/services/GISNET_Public/MapServer/434`). The older 2008 set was public domain. The assessor licence isn't stated.
- **Portland:** Metro buildings have `num_story` and `max_height` (ODbL per an old OSM import page). The licence is unconfirmed.

### Amsterdam / Netherlands: A
- **3D BAG** (TU Delft 3D geoinformation group and 3DGI), CC BY 4.0. Docs: `https://docs.3dbag.nl/en/`; download: `https://3dbag.nl/en/download`; OGC API Features: `https://api.3dbag.nl/`.
  - **Coverage:** every building in NL, at LoD 0, 1.2, 1.3 and 2.2.
  - **Formats:** CityJSON, GeoPackage, OBJ and WMS/WFS.
  - **Attributes:** `b3_h_dak_max` (roof maximum, metres above NAP), `b3_h_maaiveld` (ground), `b3_dak_type` (e.g. horizontal), `b3_bouwlagen` (estimated floors), `b3_pw_bron` (ahn3/4/5), `b3_kwaliteitsindicator`, `oorspronkelijkbouwjaar`, BAG id.
  - **Updates:** a 2025-09-03 release was in use in 2026.
- **BAG** (Kadaster via PDOK), CC0 or "Publiek domein". ATOM: `https://service.pdok.nl/lv/bag/atom/bag.xml`, giving a GeoPackage without history and XML with history; updated monthly. Original build year per building; use (`gebruiksdoel`) per dwelling unit. Build year is 100% filled, but 1005 means "unknown or very old" and 1905 is a default *(third-party)*.
- **AHN:** DTM 0.5 m, CC0. ATOM `https://service.pdok.nl/rws/ahn/atom/dtm_05m.xml`; WCS `https://service.pdok.nl/rws/ahn/wcs/v1_0`.
- **Trees:** Amsterdam BOMEN (`https://api.data.amsterdam.nl/v1/docs/datasets/bomen.html`), about 270k trees with species and height class. Licence: the municipality's own terms (`https://maps.amsterdam.nl/open_geodata/terms.php`) allow use "for any lawful purpose", commercial included, but it isn't a named open licence. ⚠ The Meta canopy works as a fallback.
- **GTFS:** OVapi / OpenOV (`gtfs.ovapi.nl`, now `gtfs.openov.nl`), CC0 per the maintainer's 2014 posts *(no current terms page found)*. Trams are already in Overture.
- **Overture:** OSM's NL buildings carry BAG ids (`ref:bag`). A TomTom import of 3D BAG heights into OSM was only a pilot (May 2026), so read heights from 3D BAG directly.

### Tokyo (B) and Kyoto (B): PLATEAU
- **Data:**
  - Tokyo 23 wards: `https://www.geospatial.jp/ckan/dataset/plateau-tokyo23ku` (CityGML, 3D Tiles, FBX).
  - Kyoto: `26100_kyoto-shi_city_<year>_citygml_…` on geospatial.jp; 3D Tiles on `assets.cms.plateau.reearth.io`.
  - Spec: `https://www.mlit.go.jp/plateaudocument/`.
  - **Fields:** `bldg:usage`, `bldg:storeysAboveGround`, `bldg:yearOfConstruction`, `uro:buildingStructureType`. The spec warns that not every building has every attribute.
- **Licence:** the geospatial.jp record says `license_title: "PLATEAU Site Policy「３．著作権について」に拠る"`. The site policy (`https://www.mlit.go.jp/plateau/site-policy/`) applies Public Data License 1.0 and permits use under CC BY, credited "出典：国土交通省 PLATEAUウェブサイト". It also requires noting your edits and not presenting edited data as MLIT's. The FAQ says commercial use is free. ⚠ "データによって、ライセンスの種類…が異なります" (licences can differ per dataset).
- **Coverage:**
  - Tokyo 23 wards: 0 of 23 tilesets have a build year *(third-party)*.
  - Kyoto: 82.6% of a sample has one; buildings before 1869 have none *(third-party)*.
- **Elevation:** GSI elevation tiles. GSI's content terms were made CC BY 4.0-compatible in 2016, with an edit notice required.
- **Transit:** Kyoto City Bus GTFS has been published via ODPT since 2024-01-19. An OSM wiki page says CC0 ⚠ *(unverified)*. Tokyo ODPT licences vary.

### Berlin: B
- **LoD2:** statewide LoD2, dl-de/zero-2.0. Atom `https://gdi.berlin.de/data/a_lod2/atom/` (record `3c7c49af-…`). The BKG lists no 2025 update.
- **Floors:** Gebäudegeschosse WFS `https://gdi.berlin.de/services/wfs/gebaeude_geschosse`, dl-de/zero, annual.
- **Age:** Umweltatlas "Gebäudealter der Wohnbebauung" (2015 status, from the 2011 census, decade classes **per block**, not per building), `https://www.berlin.de/umweltatlas/nutzung/gebaeudealter/2016/einleitung/`. Its own licence wasn't confirmed; the related "Stadtstruktur" dataset is dl-de/zero.
- **Trees:** Baumbestand WFS `https://gdi.berlin.de/services/wfs/baumbestand`. Street trees are dl-de/zero; park-tree attribute data is dl-de/by.
- **Elevation:** DGM1 1 m, dl-de/zero (`https://gdi.berlin.de/data/dgm1/docs/dgm1.pdf`).
- **Licence caveat:** ALKIS building records vary between dl-de/zero and dl-de/by.

### Hamburg: B
- **LoD2:** LoD2-DE CityGML from LGV, dl-de/by-2.0 (INSPIRE record `1F6E48EB-…`).
- **Gap:** no per-building build year found, and trees and transit weren't checked.

### Vienna: B
- **3D city model:** Baukörpermodell (LoD1.4, ~200k buildings, >650k parts), CC BY 4.0, `https://www.wien.gv.at/stadtentwicklung/stadtvermessung/geodaten/bkm/`. LoD2 CityGML tiles are in the OGD catalogue.
- **Building facts:** OGD WFS (`data.wien.gv.at/katalog/wfs.html`).
  - `ogdwien:GEBAEUDEINFOOGD`: `BAUJAHR`, `ARCHITEKT`, `GESCH_ANZ`. Only ~19% have an exact year *(third-party)*.
  - `BAUPERIODEDETAILOGD`: period classes for 439k building parts *(third-party count)*.
- **Elevation:** DGM, CC BY 4.0 (`https://www.wien.gv.at/stadtentwicklung/stadtvermessung/geodaten/dgm/`).
- **Trees:** Baumkataster, CC BY 4.0, on data.gv.at.
- **Gap:** the Wiener Linien GTFS licence wasn't verified.

### Helsinki: B
- **3D model:** `https://www.hel.fi/en/decision-making/information-on-helsinki/maps-and-geospatial-data/helsinki-3d` (CityGML 2.0, LoD1 and LoD2 in 2 × 2 km sheets, plus WFS 2.0), CC BY 4.0. The direct CityGML files carry building attributes; the WFS download doesn't.
- **Building register:** WFS `https://kartta.hel.fi/ws/geoserver/avoindata/wfs`, layer `avoindata:Rakennukset_alue_rekisteritiedot`, CC BY 4.0. Fields: `c_valmpvm`, `i_kerrlkm`, `c_kayttark`, `rakennusaine_s`. About 59% have a year citywide, 76% in the core *(third-party)*.
- **Trees:** `avoindata:Puurekisteri_piste` (Urban tree database), CC BY 4.0.
- **Transit:** HSL GTFS (`https://infopalvelut.storage.hsldev.com/gtfs/hsl.zip`), CC BY 4.0 per HSL's open data page.

### Zurich: B
- **LoD2:** Stadt Zürich 3D roof model, CityGML (`https://ckan.opendata.swiss/de/dataset/bauten-dachmodell-3d`), "Commercial Allowed / Reference Not Required".
- **GWR:** the federal building register (MADD download via housing-stat.ch). Licence ⚠ conflicting: opendata.swiss shows attribution terms, while the OSM wiki says the bundled `licence.txt` "has no clear legal meaning".
- **Transit:** opentransportdata.swiss, own terms.

### Paris: A
- **APUR "Emprise bâtie" / "Volume bâti":** ODbL (catalogue record `urn:apur:emprise_batie_od`, `https://geocatalogue.apur.org/catalogue/srv/api/records/urn:apur:emprise_batie_od`).
  - **Fields:** `C_PERCONST_APUR` (11 classes, pre-1800 to post-2008, plus undated), `C_PERCONST_INSEE` (7 classes), median height `H_MEDIANE`.
  - **Download:** zipped shapefile or GeoJSON via `https://opendata.apur.org/data.json` → `…/api/download/v1/items/<id>/{shapefile,geojson}` (an ArcGIS Hub-style API).
  - **Coverage:** an exact year for ~63% of 128k footprints, heavily rounded *(third-party)*. The period classes are what matter.
- **BD TOPO (IGN):** Licence Ouverte 2.0, OSMF-compatible with ODbL per the OSM wiki. Building height to the gutter, floor count and use (field names vary by version).
- **BDNB (CSTB):** the open tier is Licence Ouverte 2.0 (`https://www.data.gouv.fr/fr/datasets/base-de-donnees-nationale-des-batiments/`); its fields weren't verified.
- **LiDAR HD:** DTM, DSM and canopy height model (MNH) at 50 cm, 1 km GeoTIFF tiles (`https://www.data.gouv.fr/datasets/mnh-lidar-hd`), Etalab 2.0 per IGN's release. ⚠ The data.gouv listings say "not specified", and no-fly zones are missing.
- **Trees:** "Les arbres" (DEVE), ODbL (`https://www.data.gouv.fr/datasets/les-arbres-paris`): street trees, park trees and trees at municipal facilities, with species, height and circumference. Use `IDBASE` as the key.
- **Transit:** IDFM GTFS (`https://prim.iledefrance-mobilites.fr/en/jeux-de-donnees/offre-horaires-tc-gtfs-idfm`) under the Licence Mobilité, which is the ODbL plus the right to ask for user identification. The API has separate terms.
- **Depiction:** France's narrow freedom of panorama and the Eiffel Tower lighting are already in data-sources.md §7.

### London: C
- **Colouring London:** ODbL, with 50+ attributes including age and typology, but crowdsourced and uneven.
- **OS NGD Buildings:** age, floors and material exist, but royalties apply ("Building Age carry additional royalty obligations").
- **Lidar:** the EA lidar composite DSM and DTM at 1 m (2022) can supply heights. Our doc lists it as OGL; the search snippet showed only "© Environment Agency … All rights reserved", so re-check.
- **Transit:** TfL data is "based on version 2.0 of the Open Government Licence with specific amendments", and TfL can change it at any time.

### Montréal: A
- **Unités d'évaluation foncière:** `https://www.donneesquebec.ca/recherche/dataset/vmtl-unites-evaluation-fonciere`, CC BY 4.0, cited as "VILLE DE MONTRÉAL".
  - **Format:** spatial lot polygons, so it's DataSF's parcels and roll in one.
  - **Fields:** `ANNEE_CONSTRUCTION` (9999 = unknown), `ETAGE_HORS_SOL`, `NOMBRE_LOGEMENT`, `CODE_UTILISATION`, `LIBELLE_UTILISATION`, `CATEGORIE_UEF`, `MATRICULE83`.
  - **Coverage:** ~95% have a year *(third-party)*.
- **3D buildings:** LoD2 CityGML with textures, CC BY 4.0, published per borough and vintage. ⚠ Coverage is partial.
  - 2009: Ville-Marie.
  - 2013: Plateau-Mont-Royal, Sud-Ouest, Ville-Marie, Outremont.
  - 2016 and 2020: Ville-Marie, Côte-des-Neiges–NDG, Outremont, Sud-Ouest.
  - Dataset slugs `vmtl-batiments-3d-2020-maquette-lod2-avec-textures` and `vmtl-maquette-numerique-plateau-mont-royal-batiments-lod2-avec-textures`.
- **Elevation:** NRCan HRDEM 1 m DTM and DSM as COGs via STAC and AWS (`https://registry.opendata.aws/canelevation-dem/`). Open Government Licence – Canada per a mirror. DSM minus DTM gives heights where LoD2 is missing.
- **Trees and canopy:** public trees and canopy, CC BY 4.0.
- **Transit:** STM GTFS ("Horaires planifiés et trajets des bus et du métro"), CC BY 4.0. The record notes the STM's ownership.

### Barcelona: B
- **Catastro:** INSPIRE Buildings and BuildingParts via ATOM per province (Barcelona: `ES.SDGC.bu.atom_08.xml`; `https://www.catastro.hacienda.gob.es/webinspire/index.html`). Construction date and use per building; floors above ground per part.
- **Catastro licence:** its own, `https://www.catastro.hacienda.gob.es/pdf/ovc/licdescargaES.pdf`. Allows own and commercial use and transformation; derived products must not pose as "cartografía catastral". INSPIRE metadata says CC BY 4.0, while a university source says CC BY 4.0 covers only the generated files.
- **Open Data BCN:** mostly CC BY 4.0, but data with third-party participation may be **CC BY-ND 4.0** (`https://opendata-ajuntament.barcelona.cat/en/node/52`).

### Copenhagen: B
- **Data:** BBR (construction year, floors) and the DHM 0.4 m elevation model are rich.
- **Access:** Datafordeler and Dataforsyningen require a user account and token, so a pipeline can't fetch anonymously.
- **Terms:** "Vilkår for brug af frie geografiske data" allows commercial use with attribution. The BBR licence itself wasn't confirmed.

### Noted, not scored
- **Hong Kong:** Lands Department 3D-BIT00 data (Max, 3ds, FBX, VRML) and a 3D Tiles API. The terms allow commercial use but aren't a named licence, and the data isn't CityGML.
- **Singapore** (HDB blocks, Singapore Open Data Licence) and **Melbourne** (CLUE, CC BY, central area only) appear in a third-party survey but weren't researched.

---

## 5. Top 3, recommended

### 1. Amsterdam (the Netherlands)
**Why it fits:**
- It is literally the roadmap's tier-1 example, with the cleanest licence stack of any candidate (CC0 + CC BY 4.0).
- The 3D city model is national and updated, so every Dutch city follows at almost no cost.
- Roofs come from data rather than rules, the thing SF's blind tests struggled with (D-055: "pitched slate roofs" misread SF as Dublin).
- **Fabric rules:**
  - Canal houses: year before 1800, narrow width, 4–5 floors, a slanted LoD2.2 roof whose ridge runs perpendicular to the front, fronting a canal.
  - Amsterdam School blocks: 1910–1935, brick, with expressionist corners.
  - 19th-century ring blocks; houseboats (BAG berth objects *(object type not verified this session)*).
- **Weakness:** the gable type (spout, neck, bell, step) isn't in the data. Assign it by era and seed, as SF's paint variants are.

**New adapters:**
1. `sources/threedbag.py`, a **CityJSON reader**: tiles from 3dbag.nl, or the OGC API Features at `api.3dbag.nl` by bounding box.
   - **Yields:** footprints, height (`b3_h_dak_max − b3_h_maaiveld`), floors, roof type, the LoD2.2 roof surfaces (ridge direction for gables), year and BAG id.
   - **Role:** a buildings source that replaces or conflates Overture (match on `ref:bag`), and a facts source at once.
   - **Reuse:** the same reader later handles PLATEAU, Berlin, Vienna, Helsinki and Montréal CityGML after conversion to CityJSON (e.g. with citygml-tools).
2. `sources/bag.py` (facts): use per dwelling unit, aggregated per building like DataSF's condo aggregation. Source: the PDOK BAG GeoPackage or OGC API. Neighbourhood comes from a city or CBS district layer *(licence not checked)*.
3. **DEM kind `ahn-dtm-05`** in `rasters.py` (PDOK WCS or ATOM GeoTIFF). The region CRS would be EPSG:28992.
4. **Optional:** Amsterdam trees (custom licence; or keep the Meta canopy); an OVapi GTFS reader for tram route names.

### 2. New York City
**Why it fits:**
- Its facts are the richest and the closest to DataSF: a per-lot assessor class whose codes are the typology.
  - Walk-up tenements (C4, C7) get fire escapes.
  - Brownstones: A4 or B1, 1840–1900, 3–5 floors, in historic districts.
  - Prewar elevator blocks: D-series before 1940. Lofts: L. Office towers: O4, typed by era like `decoTower` and `sfTower`.
- Everything US-side is already in the pipeline: 3DEP, the EPT lidar, NAIP colours, the Meta canopy and Overture.
- The 2015 tree census gives real street-tree positions.

**Caveats:**
- **Licence:** statutory, with no named licence; get it reviewed.
- **Scale:** ~1.08M buildings, so start with Manhattan plus Brownstone Brooklyn.
- **Data age:** heights in OSM and Overture date from the 2014 import, so prefer the city footprints, which are updated weekly.

**New adapters:**
1. `sources/nycopendata.py`, cloned from `datasf.py` (Socrata SoQL paging and caching):
   - PLUTO `64uk-42ks`: `bbl, yearbuilt, numfloors, bldgclass, landuse, unitsres`.
   - Building Footprints `5zhs-2jue`: `height_roof, construction_year, mappluto_bbl`.
   - Join by BBL, which is simpler than DataSF's point-in-lot. Neighbourhoods come from NTA or community districts *(dataset IDs not verified)*.
2. **Typology:** a `classes:` rule field matching `bldgclass` prefixes. Optionally `histdist` or landmark fields, if present in PLUTO *(unverified)*.
3. **Optional:** the city footprints as the buildings source instead of Overture; a tree-census point source.

### 3. Paris
**Why it fits:**
- Haussmannian Paris is the most uniform and recognizable ordinary fabric of any candidate. One rule covers most of the city: APUR period 1851–1914, 5–7 floors, residential or mixed use → cream ashlar, zinc mansard, continuous balconies on the 2nd and 5th floors.
- **Other periods:** pre-1800 faubourg houses, 1920s–30s brick HBM housing on the ring, post-1960 slabs and towers (13th arrondissement).
- Neighbourhood comes from the arrondissement or quartier. Street trees (ODbL, with height and circumference) line the boulevards.
- Licences are ODbL and Licence Ouverte, which we already handle.

**Caveats:**
- There is no open LoD2, so roofs come from rules (LiDAR HD's 50 cm DSM could fit them later).
- Many exact years are rounded, but the period field is what we'd use.
- The LiDAR HD and RGE ALTI licence metadata needs one direct check.
- Watch the depiction policy (freedom of panorama).

**New adapters:**
1. `sources/apur.py` (facts, and footprints within Paris): the ArcGIS Hub download of the "Emprise bâtie" layer as GeoJSON, giving the period class and heights. It's footprint-level, so join to Overture by overlap.
2. `sources/bdtopo.py` (facts): IGN BD TOPO buildings (floors, use, height) per département GeoPackage.
3. **DEM kind** for IGN (RGE ALTI or the LiDAR HD DTM). Montmartre and Belleville need better than 30 m.
4. **Optional:** a Paris tree point source; an IDFM GTFS reader (ODbL-based) for RER and tram route names.

**If you'd rather have CityGML in the first non-US region:** take **Montréal** instead of Paris.
- The facts adapter is the UEF polygons via CKAN, nearly identical to `ParcelFacts`.
- An HRDEM COG DEM kind; LoD2 CityGML for the Plateau, Ville-Marie and Sud-Ouest.
- The plex fabric (2–3 floors, 2–5 dwellings, 1880–1940) can reuse much of `rowhouse` and `stuccoRow`, with flat roofs, parapets and outdoor stairs.

The **GTFS reader** is optional for all three, since `transit.py` already gets rail and tram lines with route refs from Overture.

---

## 6. Flags: what couldn't be verified

**Access limits**
- Official portals couldn't be opened directly from this session; see the header.
- To read the pages yourself, allow these hosts in the environment: nyc.gov, opendata.cityofnewyork.us, data.cityofnewyork.us, 3dbag.nl, docs.3dbag.nl, pdok.nl, data.amsterdam.nl, opendata.apur.org, geoservices.ign.fr, data.gouv.fr, donneesquebec.ca, mlit.go.jp, geospatial.jp, chicago.gov, data.boston.gov and opendata.dc.gov.
- Overture building-height coverage per city wasn't measured. It's described qualitatively from import histories, and could be measured with the pipeline's existing Overture reader.

**Third-party numbers.** Coverage figures and placeholder years marked *(third-party)* come from one GitHub research table (`HungQuach301/cine-lab`, `research/timelapse/NGUON-DU-LIEU.md`, checked 2026-10-15). This includes Tokyo's 0% build year, Kyoto's 82.6%, Paris's 63%, Vienna's 19% and Helsinki's 59%. Treat them as indicative.

**By city**
- **NYC:**
  - The full Terms of Use text wasn't read; the Open Data Law wording came via search.
  - The current-trees (ForMS) and neighbourhood dataset IDs weren't checked, nor whether PLUTO still carries historic-district fields. *(All answered in §7.)*
  - MTA GTFS terms are custom.
- **Chicago:** the current Data Portal Terms text was only partly visible, and Cook County has no licence at all. The licence status is "unclear", not "denied".
- **Boston:** street trees, MBTA GTFS and the BPDA 3D model licence weren't checked. Field names come from code, not the official data key.
- **DC:** the `STYLE`, `EXTWALL` and `ROOF` code values weren't listed. The extent of the lidar redaction wasn't measured.
- **Amsterdam / NL:**
  - The 3D BAG licence (CC BY 4.0) came from metadata and catalogues, not the copyright page.
  - The OVapi CC0 claim dates from 2014; the Amsterdam tree licence is municipal, not CC.
  - BAG berth objects and a usable neighbourhood layer weren't checked.
- **PLATEAU:**
  - Per-dataset licence variation is possible.
  - The Tokyo and Kyoto attribute coverage is third-party, and the Kyoto LoD2 extent is unknown.
  - The Kyoto bus GTFS licence is conflicting (CC0 per the OSM wiki).
- **Berlin, Hamburg, Vienna:**
  - Berlin's building-age dataset is per block, and its licence is unconfirmed.
  - Hamburg's building year wasn't found.
  - The VBB and Wiener Linien GTFS licences are unverified.
- **Helsinki:** field meanings come from code comments, not the official data description PDF.
- **Zurich:** the GWR licence is ambiguous.
- **Paris:**
  - The LiDAR HD licence shows "not specified" on data.gouv; Etalab 2.0 is per a secondary source. The RGE ALTI licence wasn't checked.
  - The BDNB open-tier fields and the exact BD TOPO field names weren't checked.
- **London:** the EA lidar licence wording needs a re-check against our doc's "OGL".
- **Montréal:**
  - The LoD2 coverage list is assembled from search hits; there may be more boroughs.
  - The HRDEM licence came from a mirror.
  - A 2023 OSM discussion notes the city's own licence text mentions OpenStreetMap, but the Données Québec copy doesn't. Read the city's version.
- **Barcelona:** the current Catastro licence text wasn't read (the cited PDF may be an older version), and the TMB GTFS licence is unknown.
- **Copenhagen:** the BBR licence is unconfirmed, and access needs a token.

**Not researched:** Seattle, LA and Portland trees and transit; Rotterdam's city-specific data; Hong Kong, Singapore and Melbourne beyond a mention.

---

## 7. New York, checked directly (2026-11-09)

Read from an open network: Socrata dataset metadata and SoQL queries against the live API, DCP's PLUTO page, the portal's dataset pages and the Open Data Law. Counts below are from those queries on that date.

### Licence
- **The law:** Admin Code §23-502(d), read in the nycadmincode.readthedocs.io mirror of the official code. Public data sets "shall be made available without any registration requirement, license requirement or restrictions on their use". The only condition: the city may require a third party to identify the source and version of each data set and describe its modifications.
- **The portal:** every dataset below says "The license for this dataset is unspecified". DCP's PLUTO page adds only a no-warranty disclaimer.
- **For us:** fit for ODbL world packages. Each attribution entry names the dataset, its version (PLUTO `26v2`; the footprints' fetch date) and says it was modified.
- **Access:** SoQL needs no app token at our volume, as with DataSF. Note that the portal's web pages (`opendata.cityofnewyork.us`) refuse plain HTTP clients behind Cloudflare, while the API (`data.cityofnewyork.us/resource/…`, `/api/views/…`) answers.

### Datasets

| Dataset (agency) | ID | Fields we'd read | Measured |
|---|---|---|---|
| **BUILDING**, the footprints (OTI) | `5zhs-2jue` | `the_geom` (spatial: `within_box` works), `bin`, `base_bbl`, `mappluto_bbl`, `height_roof` (feet), `ground_elevation`, `construction_year`, `name`, `geom_source` | 1,082,972 footprints. Height missing on 717 (0.07%), year on 10,058 (0.9%). Year 1900 on 7,520, of them 4,961 in Manhattan (11% of its footprints): a placeholder. 93% photogrammetric. Latest edit 2026-11-06. |
| **PLUTO** (DCP) | `64uk-42ks` | `bbl`, `bldgclass`, `landuse`, `yearbuilt`, `numfloors`, `unitsres`, `histdist`, `landmark`, `bldgfront`, `bldgdepth`, `latitude`/`longitude` | 858,284 lots, version `26v2` (DCP's latest). No year on 40,317 (4.7%). ⚠ In Manhattan 52% of years are multiples of 5, and 1910, 1900 and 1920 are the three most common: the year is a decade estimate, so rules should lean on the class code. ⚠ `geom` is a text column the API returns empty: lot polygons come only from the MapPLUTO download (shapefile or FGDB zip on DCP's page). Join to footprints by BBL instead. |
| **Individual Landmark and Historic District Building Database** (LPC) | `gpmc-yuvp` | `bin`, `bbl`, `date_low`/`date_high`, `style_prim`, `mat_prim`, `build_type`, `use_orig`, `hist_dist`, `arch_build` | 38,105 buildings in designated districts and landmarks: Brooklyn 17,047, Manhattan 14,610, Queens 4,814, Bronx 1,095, Staten Island 539. **Material:** brick 13,816, brownstone 7,341, wood frame 2,262, limestone 1,851, cast iron 411. **Style:** Renaissance Revival 5,156, neo-Grec 2,837, Italianate 2,700, Romanesque Revival 2,130, Queen Anne 1,464, Greek Revival 1,407 ("Not determined" 6,703). **Type:** row house 17,650, store and lofts 760, tenement 497. |
| **Historic Districts** (LPC) | `skyk-mpzq` | district polygons, `area_name`, `desdate` | — |
| **Individual Landmark Sites** (LPC) | `buis-pvji` | `lpc_name`, `landmarkty`, `bbl`, `nta2020` | candidates for the landmark registry |
| **2020 NTAs** (DCP) | `9nt8-h7nd` | `ntaname` ("Brooklyn Heights", "Greenpoint"), `boroname` | gives `hood` |
| **Forestry Tree Points** (Parks) | `hn5i-inap` | `genusspecies`, `dbh`, `tpstructure` | 897,872 live trees (`Full`), updated 2026-11-04. Replaces the 2015 census (`uvpi-gqnh`, frozen in 2017). |

**PLUTO's most common classes in Manhattan:** C7 4,519 (walk-ups over six families, with stores), C1 2,562, C4 2,215 (old-law tenements), RM 1,903, D4 1,896, C5 1,821, C6 1,536, A4 1,475 (city residences), C0 1,396, K4 1,217, D1 1,118, B1 914.

### Elevation and lidar
- **Terrain:** the built-in `usgs-3dep-13arcsec` covers the city. The city's own 1-foot DEM (`dpc8-z3jc`, `7kuu-zah7`) is a download if ever needed; not at 10–25 m cells.
- **Lidar:** the bucket has one New York City EPT, `NY_NewYorkCity` (4.76 billion points; the survey year isn't in its metadata). There is no `NY_NewYorkCity_2021`, contrary to §3 and §4 before this check. The footprints already carry heights, so lidar is optional.

### What the city pack would be
- **`pixelworld-city-nyc`**, with one facts source named after its data, `pluto` (plugins.md §6). It looks up by point in footprint, not point in lot:
  1. footprints in the box (spatial query);
  2. PLUTO by BBL, fetched by its lot `latitude`/`longitude` box;
  3. LPC by BIN.
- **Facts it fills:**
  - `year`: LPC's `date_low`, else the footprint's `construction_year` (not 1900), else PLUTO's `yearbuilt`;
  - `stories` (`numfloors`), `units` (`unitsres`), `use` (from `landuse`), `class` (`bldgclass`, unchanged), `hood` (the NTA);
  - `material`: LPC's `mat_prim`.
- **Generators:** `@pixelworlds/city-nyc` for what SF's `rowhouse` and `block` can't draw: stoops, cornices, fire escapes, cast-iron fronts, setback towers.

### Open questions for the New York spec
1. **Extent.** Manhattan alone is about 4 × 21 km. For example: the drive level as Manhattan and the Brooklyn and Queens waterfront at 25 m; the walk level as Lower Manhattan, or Brownstone Brooklyn (Brooklyn Heights, Cobble Hill, Park Slope), at 10 m; the fly level as the harbour at 100 m.
2. **Heights.** Buildings come from Overture, whose New York heights come from OSM's 2013–14 import of these same footprints. The city's are edited daily. Using them needs either a buildings source (no such plugin kind yet) or a height key read from facts.
3. **Rule fields.** LPC's material and style are the strongest signals for the brownstone and cast-iron fabric, and no rule reads them yet: `materials:` (facts' `material`) and maybe `styles:`. Both are pipeline changes beyond an adapter.
4. **Depiction (data-sources.md §7).** The Statue of Liberty is sculpture, not architecture, so it needs a stylized variant. The Empire State Building's image is used as a trademark by its owners; check before a canonical depiction.
