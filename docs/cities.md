# Places to build: an index of candidates and their data

Status: living document. Every place we've built, are building, or might build, with what open data exists for it: the index holds the places built, in progress or next and the cities from the first research ([second-region.md](second-region.md)); the newer candidates are in their region's table below. Add a place when someone proposes it; update its row when its data is checked or its build starts. The detailed research behind the city rows is in [second-region.md](second-region.md); licence rules are in [data-sources.md](data-sources.md) §1, depiction rules in §7.

**What we look for:** places recognisable as pixel art at a glance, by a skyline, a landform or a fabric seen nowhere else: Venice's canals, Santorini's white cubes on the caldera, Chongqing's stacked mountain streets, Rio's hills between the sea and the favelas. Distinctiveness comes first, data second. An iconic place with thin local data can still be built on the **global-data path**:
- Overture footprints and heights;
- Copernicus GLO-30 elevation;
- typology by neighbourhood boxes instead of records;
- landmarks from the registry.

Its rows say what that path would and wouldn't capture.

## How to read it

**Status:** **built** (a package in `fixtures/`) · **building** (a track in progress) · **next** (decided, D-078) · **candidate** (data looks good enough) · **weak** (a core layer is closed or missing) · **no** (blocked: licence or access).

**Score** (as in [second-region.md](second-region.md) §3): **A**: every core layer open, checked and fetchable, with fabric the data can drive · **B**: one significant gap (coverage, access, a licence ambiguity in a core layer, or weaker fabric) · **C**: a core layer blocked.

**Checked:** **direct** (we read the licence page and sampled the data ourselves, from a machine that reaches the portal) · **docs** (official pages, read through search) · **third-party** (one secondary source). Re-read a source's licence directly before integrating it, whatever this says.

**The layers a place needs** (the pipeline's contract, [second-region.md](second-region.md) §2):
1. **Buildings:** footprints with heights, or a 3D city model (LoD1/LoD2). Overture covers footprints almost everywhere; what varies is heights and roofs.
2. **Building facts:** year built or age class, floors, use, class or type, material or roof. These drive the typology rules (D-055) and are what make ordinary streets recognisable.
3. **Elevation:** a DTM fine enough for the scale (1–10 m for walking levels). USGS 3DEP is built in; elsewhere, IGN (France), GSI (Japan) and Copernicus GLO-30 are built in too, or a terrain source from an installed package (`docs/plugins.md` §4).
4. **Trees, water, transit:** optional. Overture, WorldCover and the WRI/Meta canopy map cover them coarsely everywhere.
5. **Access and licence:** anonymous download or API, and a licence that allows derived databases and redistribution (world packages are ODbL).

## Index

| Place | Status | Score | Why it's distinctive | Buildings and facts | Elevation | Licence | Checked | Notes |
|---|---|---|---|---|---|---|---|---|
| US Southwest: Las Vegas, Hoover Dam, Grand Canyon | built (`southwest`, three levels) | A | Canyon strata, the Strip, the dam | Overture; USGS 3DEP lidar heights | USGS 3DEP 1″ and 1/3″ | public domain, ODbL | direct | The first region (M1–M3) |
| San Francisco | built (`sf`, three levels) | A | Victorian and stucco rows on hills, the bridges, fog | Overture; DataSF assessor roll and parcels (year, storeys, use, class, neighbourhood) | USGS 3DEP 1/3″ | ODC PDDL | direct | M3.5; landmarks pass the blind test, 2 of 6 streets do |
| New York: Lower Manhattan | built (`nyc-walk`) | A | Towers over colonial streets, cast-iron lofts, brownstones, the bridges | NYC footprints with heights; PLUTO (class, year, floors, use); LPC (style, material); NTAs | USGS 3DEP 1/3″; USGS lidar EPT | NYC Admin Code §23-502(d): no restrictions | direct (second-region.md §7) | D-078–D-082 |
| New York: Manhattan | built (`nyc` driving, `nyc-walk` to 86th Street) | A | Midtown towers, prewar avenues, Central Park, Harlem | as above | as above | as above | direct | D-083 |
| Paris | built (`paris-walk`, the Eiffel Tower to the Marais) | A | Haussmann blocks with zinc mansards, the Seine | APUR built footprints (`c_perconst` period, `h_med` height, `c_forme_toit` roof, `c_tissu` fabric); BD TOPO (storeys, use) | IGN RGE ALTI | ODbL, Licence Ouverte 2.0 | direct (second-region.md §8) | D-084–D-086 |
| Amsterdam (and the rest of the Netherlands) | next | A | Canal houses with gables, canals, houseboats | 3D BAG LoD2.2 (roofs, heights, floors); BAG (year, use) | AHN 0.5 m DTM | CC0, CC BY 4.0 | docs | CityJSON ingestion comes with it |
| Jerome, Arizona | spec only (`worlds/jerome`) | A | A mining town on a slope | Overture | USGS 3DEP | public domain, ODbL | direct | The worked example in worlds.md |
| Montréal | candidate | A | Plexes with outdoor staircases, greystones | Assessment roll (year, floors, dwellings, use; CC BY 4.0); LoD2 for some boroughs | NRCan HRDEM 1 m | CC BY 4.0 | docs | second-region.md §4 |
| Kyoto | built (`kyoto`, `kyoto-walk`, `kyoto-fly`; D-090, D-091, D-100, D-101, D-102, D-103, D-104) | A | Machiya rows, temples and pagodas, tiled roofs, the Kamo river | PLATEAU 2025 (spec 5.0) LoD2, checked in three 1 km meshes (Nakagyō, Kiyomizu, Gion): build year 68–73% (back to the 1860s), structure 100% (`601` wooden on 39–52%), storeys 67–72%, measured height and use 100%; Overture: OSM footprints, heights 0% | GSI 1 m (`dem1a`) and 5 m DEM tiles, anonymous | PLATEAU PDL 1.0 / CC BY; GSI PDL 1.0 ("出典：国土地理院ウェブサイト", and say it was processed) | direct (2026-11-11) | One PLATEAU adapter serves every PLATEAU city |
| Boston | candidate | B | Triple-deckers, bowfront brick rows | Property assessment (`BLDG_TYPE`, year, floors, roof; PDDL) | USGS 3DEP + lidar EPT | PDDL | docs | |
| Washington DC | candidate | B | Victorian rowhouses, the Height Act skyline | CAMA (`STRUCT`, `STYLE`, `AYB`; CC BY 4.0) | USGS 3DEP + DC lidar | CC BY 4.0 | docs | lidar redacted around the White House |
| Vienna | candidate | B | Gründerzeit blocks, Gemeindebau | Baukörpermodell LoD1.4; period per building part | City DGM | CC BY 4.0 | docs | |
| Helsinki | candidate | B | Jugend stone blocks | 3D model LoD1/2; building register (year, floors, material) | City surface model | CC BY 4.0 | docs | |
| Berlin | candidate | B | Gründerzeit perimeter blocks, Plattenbau | Statewide LoD2; floors; age per block only | DGM1 1 m | dl-de/zero | docs | |
| Zurich | candidate | B | Old town, lake | LoD2 roof model; GWR (year) | swissALTI3D | open, GWR ambiguous | docs | |
| Barcelona | candidate | B | Eixample chamfered blocks | Catastro (year, use, floors per part) | PNOA lidar | Catastro's own licence; some city data CC BY-ND | docs | |
| Copenhagen | candidate | B | Brick perimeter blocks | BBR (year, floors) | DHM 0.4 m | open with attribution, needs a token | docs | |
| Tokyo (23 wards) | built (`tokyo-walk`, Shibuya to Shinjuku) | B | Shibuya's scramble, Shinjuku's towers and neon, dense low-rise wooden quarters, elevated rail, Tokyo Tower and the Skytree | PLATEAU 2025 (spec 5.0) LoD2, checked in six meshes (Shibuya, Shinjuku, Asakusa, Yanaka, Ginza, Akihabara): **build year and structure 0%**, storeys 83–94%, measured height and use 100%; Overture: OSM footprints, heights 57% at Shibuya, 2% in Asakusa | GSI 1 m and 5 m DEM tiles | PDL 1.0 | direct (2026-11-11) | D-089, D-092, D-093: typed by use, storeys, height, footprint size and neighbourhood boxes; the scramble, Harajuku and Omotesandō, the Meiji Shrine, west Shinjuku |
| Hong Kong: Kowloon | built (`hongkong-walk`, Tsim Sha Tsui to Prince Edward) | C local / B global | Tong lau under neon, Nathan Road, the harbour | Overture (OSM) footprints and floors; each neighbourhood's typical height from the spec (`areas`, D-107) | Copernicus GLO-30 with its buildings filtered off (D-107) | ODbL, Copernicus DEM licence | direct (2026-11-11) | D-107–D-109; the first city on open data alone: LandsD's data can't be adapted (Asia-Pacific notes) |
| Hong Kong Island | built (`hongkong-island`, the whole island) | C local / B global | Central's towers, the Mid-Levels and the Peak, the trams, Wan Chai's neon, the country parks, the south side's bays | Overture (OSM) footprints and floors; 20 neighbourhoods' typical heights from the spec (`areas`, D-107) | Copernicus GLO-30 filtered only in town (D-115) | ODbL, Copernicus DEM licence | direct (2026-11-12) | D-115, D-117; the Mid-Levels' slopes are C (Asia-Pacific notes) |
| Chicago | no | C | Two-flats, greystones | footprints and assessor data | USGS 3DEP | city terms grant no rights; county data unlicensed | docs | |
| Philadelphia | no | C | Rowhouses | OPA building codes | USGS 3DEP | city keeps all rights | direct | |
| London | no | C | Georgian and Victorian terraces | OS heights and age are paid | EA 1 m lidar | OS NGD paid | docs | |
| Los Angeles, Seattle, Portland | no | C | | heights members-only or licence revocable/unclear | USGS 3DEP | | docs | |

## Candidates by region

Researched 2026-11-10 by region. The shortlist first, then each region in full.

### Shortlist

**Iconic, with strong open data** (an adapter or two each, as for New York):
- **Prague** (A): IPR's 3D model of every building and bridge (CityGML), ČÚZK's DTM, CC BY throughout. CityGML ingestion would serve Amsterdam too.
- **Lauterbrunnen or Zermatt** (A): swissALTI3D at 0.5 m and LoD2 chalets with roof overhangs, commercial use with attribution.
- **Rio de Janeiro** (A): a height and a favela flag for 2.3 M buildings (CC BY 4.0); its cable car and rack railway are in Overture.
- **Québec City** (A): the province-wide assessment roll (also serves Montréal), HRDEM 1 m.
- **Mont-Saint-Michel** (A, landmark-led), and the terrain showcases **Yosemite** and **Milford Sound** (A).

**Iconic, on the global-data path:**
- **Pilots:** Venice, Santorini, Chongqing.
- **Then:** La Paz, Chefchaouen, Varanasi, Hạ Long Bay with Hội An, Valparaíso, Kathmandu or Bhaktapur, Jaipur, Marrakech, Dubrovnik.
- **One shared set of code serves them all:**
  - a Copernicus GLO-30 terrain plugin;
  - typology by neighbourhood box;
  - an Overture aerialway reader;
  - a ground filter for the surface model in dense cities;
  - optionally, Google Open Buildings 2.5D heights.
- **Order:** Venice first (flat, dense OSM footprints with 23% heights, canals from Overture's water), then Chongqing (the hardest terrain and streets).

**Licences to clear first:**
- **Hong Kong:** a derived-database grant from LandsD; its data is otherwise the richest of all. The terms were re-read on 2026-11-11 and are unchanged; the request and the open fallback are in the Asia-Pacific notes.
- **The French Quarter:** the Vieux Carré Commission's layer on the city's CC0 portal.
- **Singapore:** the sublicensing clause.
- **Monument Valley:** Navajo Nation permissions.
- **Turkey (Istanbul, Cappadocia):** the 2026 geographic-data permit regulation.
- **Depiction (data-sources.md §7):** Christ the Redeemer.

### Europe, the Mediterranean and North Africa

Researched 2026-11-10; licence pages fetched directly where the portal answered. Ranked by how recognisable each would be as pixel art.

| Place | Status | Score | Why it's distinctive | Buildings and facts | Elevation | Licence | Checked |
|---|---|---|---|---|---|---|---|
| **Venice** | candidate | B (strong global path) | Canals instead of streets, palazzi on the water, San Marco | Veneto's "Edifici del Veneto" WFS (height fields not seen); Overture 3,286 in the core, heights 23%, floors 34%; no open facts: typology by sestiere | Flat; Veneto 5 m lidar DTM (docs); lagoon bathymetry 0.5 m (third-party) | IODL 2.0 (direct): "consultazione, estrazione, riproduzione e modifica", credit "Regione del Veneto – L.R. n. 28/76 – Formazione della Carta Tecnica Regionale" | direct |
| **Santorini** (Oia, Fira) | candidate (global path) | C local | White cubes and blue domes on a 300 m caldera cliff | Overture 525 / 737, heights 0–1%, half Microsoft ML footprints; one box typology covers the town | GLO-30 (the caldera wall, not the cliff shelf under Oia); Hellenic Cadastre DEMs listed as open, no licence found | Copernicus, ODbL | direct (Overture, GLO-30) |
| **Cinque Terre** | candidate | B | Pastel tower-houses over coves, vine terraces | Overture heights 8–13%, floors 42% at Manarola; no open facts | Ministry of Environment (MASE) 1 m lidar DTM/DSM, CC BY 4.0 (coverage per tile unconfirmed); Liguria DTM 2023 (WMS) | CC BY 4.0 | docs |
| **Mont-Saint-Michel** | candidate | A (landmark-led) | The abbey on a rock in the tidal flats | BD TOPO floors and use; Overture 114 | LiDAR HD 50 cm; RGE ALTI | Licence Ouverte 2.0, Etalab 2.0 (as for Paris) | docs |
| **Prague** | candidate | A | Red roofs, spires, Charles Bridge, the castle | IPR Praha 3D model of every building and bridge (CityGML, multipatch); RÚIAN buildings with floors (year unverified); Overture floors 84% | ČÚZK DMR 5G; IPR DTM | IPR: CC BY ("use the open data without restriction under CC BY licence", credit "data base © IPR Praha"); ČÚZK: CC BY 4.0 for all Geoportal data since 2023 | direct |
| **Lauterbrunnen / Zermatt** | candidate | A (B if GWR facts are needed) | The waterfall valley; the Matterhorn and chalets | swissBUILDINGS3D 3.0: LoD2 with roof overhangs; EGIDs in canton Bern, not Valais; GWR (year, floors) licence ambiguous | swissALTI3D 0.5 m; swissSURFACE3D | swisstopo free geodata: "may be used, distributed… enriched and processed and also used commercially. A reference to the source is mandatory." | direct (STAC `data.geo.admin.ch/api/stac/v0.9`) |
| **Hallstatt** | candidate | B | Chalets between the lake and the cliff | BEV lidar DSM − DTM for heights; Overture heights 46%, roof shape 23%; no open facts (a uniform village doesn't need them) | BEV lidar DTM and DSM 1 m, COG | CC BY 4.0 ("Für dieses Produkt gilt die Standardlizenz CC-BY-4.0") | direct |
| **Chefchaouen** | candidate (global path) | C local | The blue town on a mountainside | Overture 1,891, 99% OSM, no heights; box typology (blue, 2–3 floors) | GLO-30 | Copernicus, ODbL | direct (Overture) |
| **Dubrovnik** | candidate (global path) | C local | The walled old town, terracotta roofs, the sea | Overture 819, no heights; no open buildings | GLO-30; the national DMR carries a fee | Croatian open licence (ODbL-compatible per OSMF, third-party); DMR paid | docs |
| **Granada (Albaicín), Toledo, Ronda** | candidate | B | White hill quarters under the Alhambra; Toledo on its hill | Catastro buildings and parts (year, use, dwellings, floors per part); Overture floors 91–94% (from Catastro) | IDEE WCS 5 m, CC BY 4.0 | Catastro INSPIRE licence: commercial use of *transformed* data allowed, "no se autoriza la difusión… de la información original": derive typology, don't ship raw years | direct |
| **Bruges** | candidate | B | Canals, stepped gables, the belfry | 3D GRB LoD1 (open data); no open build year | DHMV II 1 m | Flemish open data | docs |
| **Edinburgh** | candidate | B | Castle rock, the Old Town's ridge of tenements | Scottish lidar DSM − DTM; Overture floors 39%; Ordnance Survey age and floors are paid | Scottish lidar 0.5–1 m, COG on AWS | OGL v3 (phase 2 LAZ is non-commercial) | direct |
| **Lisbon (Alfama), Porto (Ribeira)** | candidate | B | Hills, trams, tiles, the riverfront | DGT lidar DSM − DTM; Overture roof shape 77% in Porto | DGT lidar 50 cm DTM/DSM, STAC | CC BY 4.0 | docs |
| **Tallinn** | candidate | B | The medieval walled old town | Estonia's nationwide LoD2 (856,360 objects; CityGML, anonymous zips); Overture heights 50%; the building register is largely closed | national lidar DEM | Land Board open-data licence: "may produce derivatives… commercial or non-commercial purposes and redistribute" | direct |
| **Gdańsk** | candidate | B | Gabled Hanseatic houses, the crane | National LoD1 (2024) with `measuredHeight` (LoD2 probably not in Pomorskie); BDOT10k floors and function; Overture floors 77% | NMT 1 m | statute: "free of charge and free to use" (not a named licence) | direct |
| **Bergen (Bryggen), Geiranger** | candidate | B (Geiranger A, terrain only) | Wooden wharf houses; the fjord | FKB buildings restricted; Matrikkel building points CC BY 4.0; Overture floors 56% | DTM1 1 m, CC BY 4.0 | mixed | docs |
| **San Gimignano, Florence** | candidate | B | The medieval tower skyline; the Duomo | Overture heights 1–6%; census age by section (unverified) | Tuscany lidar 1 m, CC BY (third-party) | CC BY | third-party |
| **Matera** | candidate | B | The Sassi cave town | Overture roof and facade colour 69% (OSM) | MASE lidar | CC BY 4.0 | docs |
| **Reykjavík** | candidate | B | Corrugated-iron houses, Hallgrímskirkja | Overture floors 26% | IslandsDEM 2 m | CC BY 4.0 | docs |
| **Marrakech medina** | candidate (global path) | C local | Flat-roofed riads, souks, ochre and pink | Overture 9,106, 79% OSM; box typology | GLO-30 | Copernicus, ODbL | direct (Overture) |
| **Sidi Bou Said** | candidate (global path) | C local | The blue and white cliff village | Overture 608, floors 43% | GLO-30 | Copernicus, ODbL | direct (Overture) |
| Positano | weak | C | A pastel cascade down a cliff | Overture heights 5% | GLO-30 too coarse; Campania not checked | unverified | direct (Overture) |
| Fez medina | weak | C | The tanneries, the densest medina | 94% Microsoft ML footprints that merge roofs into blobs: unusable for streets | GLO-30 | — | direct (Overture) |
| Istanbul, Cappadocia | no (for now) | C | Domes and minarets; fairy chimneys and cave houses | Overture footprints, no heights; Cappadocia 75% ML | GLO-30 (the valleys, not the chimneys) | ⚠ Turkey's 2026 geographic-data permit regulation (permit and fee for commercial sharing; covers foreigners): get a legal read first | third-party |
| Petra | no (as data) | C | Rock-cut façades, the Siq | Wadi Musa only | GLO-30 can't resolve a 3–12 m wide gorge | — | direct |

**Notes**
- **Dropped as middling** (good data, no distinctive look at our scale): Riga (its Art Nouveau is façade detail), Kraków, Rome's ordinary fabric, Seville, Ghent. Delft and Giethoorn come free with the Netherlands adapter (Amsterdam). Valletta wasn't researched (Overture: 469, no heights).
- **Venice** needs the water mask to flatten GLO-30's surface bias; canals come from Overture's water. The metadata host for the Veneto building layer had an expired certificate, so its height fields are unconfirmed.
- **Zermatt** needs a spatial join to the GWR (no EGIDs in Valais); Lauterbrunnen's buildings carry them.
- **Petra** can only be a hand-authored landmark; Cappadocia's chimneys would have to be placed procedurally on bare land.



### Asia-Pacific

Researched 2026-11-10; Overture coverage measured with the pipeline's reader, PLATEAU attributes counted in real 1 km mesh files, licences quoted from the official pages. Each place has a local score (its own open data) and a global one (the global-data path).

| Place | Status | Score (local / global) | Why it's distinctive | Buildings and facts | Elevation | Licence | Checked |
|---|---|---|---|---|---|---|---|
| **Hong Kong** (Kowloon, Central) | Kowloon and Hong Kong Island built on the global path (`hongkong-walk`, `hongkong-island`, D-107–D-109, D-115, D-117); LandsD's data awaits a grant | C / B | The densest high-rise on earth on steep hills, tong lau tenements, the harbour, the Star Ferry, the trams | LandsD Building layer over anonymous WFS: `BaseHeight` (ground, mPD), `TopHeight`, `Storeys`, `BuildingBlockType` (tower, podium); occupation permits (`OPDate`, `GFA`, `OPBuildingType`) and works history; 3D-BIT00 LoD1 everywhere, LoD2/3 landmarks (3D Tiles with a free key). Overture (OSM 90–98%) in seven districts: floors on 27–63% (52–74% of footprints over 600 m²), heights 0–9%; 3D-GloBFP (CC BY 4.0) has a height for 72% of the rest, but towers come out at 0.4–0.5× | LandsD 5 m DTM; GLO-30 misses the towers (IFC 2 reads 11 m) but lifts dense mid-rise blocks 20–40 m (Mong Kok 24–45 m on ~5 m ground) | ✖ CSDI and DATA.GOV.HK terms (re-read 2026-11-11) allow "browse, download, distribute, reproduce, hyperlink to and print… for both commercial and non-commercial purposes" but grant no right to adapt, require acknowledging government IP in every copy and an open-ended indemnity, and can be revised without notice: ask LandsD in writing for a derived-database grant | direct (2026-11-11) |
| **Chongqing** | candidate (global path) | C / B− | The vertical mountain city: the monorail through a building, stilt houses, river gorges | No open source (the city's digital twin isn't downloadable); Overture in Yuzhong: 1,601 (East Asian buildings dataset, CC BY 4.0, and OSM), heights 1%, floors 7%; **185 road segments with `level_rules` (levels −5…+5), 130 steps, the monorail** | GLO-30 (a surface model: dense towers inflate the ground) | Copernicus, ODbL, CC BY 4.0; China's surveying and mapping law (unverified) | direct (Overture) |
| **Varanasi** (the ghats) | candidate (global path) | C / B | Stepped ghats along the Ganges crescent, stacked temples | Overture 5,347 (86% Google), no heights; **Google Open Buildings 2.5D covers India** | GLO-30 | ODbL; Google CC BY 4.0 or ODbL | direct |
| **Hạ Long Bay** (with Hội An) | candidate (global path) | C / B | Limestone karst towers in the sea; Hội An's yellow merchant houses and lanterns | Hạ Long: terrain and water are the subject; Hội An: Overture 9,052 (96% OSM), floors 1%; Google 2.5D covers Vietnam | GLO-30 (big islands as blunt cones; slender towers and overhangs lost) | Copernicus, ODbL | direct |
| **Shirakawa-go** | candidate | C / B | Gassho thatched A-frames in a snowy valley | Not in PLATEAU; OSM footprints; one roof typology by box | GSI 5 m | GSI (CC BY-compatible), ODbL | docs |
| **Jiufen** | candidate | B / B | Lantern-lit teahouse stairs on a sea-facing slope | Overture 317, no heights; the national LoD1 model may not be open (unverified) | 20 m DTM (coarse for a stair-street town) | Taiwan OGDL v1.0: any purpose, irrevocable, adaptations allowed, "compatible with CC BY 4.0" | direct |
| **Kathmandu, Bhaktapur** | candidate (global path) | C / B | Pagoda temples, Durbar Squares, red-brick lanes | Overture 6,188 / 5,480 (92–95% OSM), floors 4% / 0%; Google 2.5D covers Nepal; temples from OSM `building=temple` and Wikidata | GLO-30 | ODbL, CC BY 4.0 | direct |
| **Jaipur** (the Pink City) | candidate (global path) | C / B | The pink walled-city grid, the Hawa Mahal | Overture 7,684 (81% Google), no heights; Google 2.5D | GLO-30 | ODbL, CC BY 4.0 | direct |
| **Busan Gamcheon** (and Seoul's Bukchon) | candidate | B / B | Pastel houses terraced up a hillside amphitheatre | MOLIT integrated GIS building data (footprints with the register's floors, use, structure, approval date; field names unverified); Overture 1,626, no floors | NGII DEM (unverified); GLO-30 is enough for the ~100 m slope | "이용허락범위 제한 없음" (no restriction on permitted use); the download needs a login; Korea's map-export rules (unverified) | direct |
| **Singapore** | candidate | B / B+ | HDB slab blocks, shophouses, Marina Bay | HDB property information (`year_completed`, `max_floor_lvl`, use flags) joined to HDB footprints; URA conserved shophouses; Overture in Chinatown: heights 58%, floors 69% | No open DEM (GLO-30; the island is flat) | Singapore Open Data Licence v1.0: "use, access, download, copy, distribute, transmit, modify and adapt", terminable only on breach; ⚠ its sublicensing clause needs checking against ODbL redistribution | direct |
| Kyoto, Gion | built (inside `kyoto-walk`, D-091) | B | Machiya, teahouses | PLATEAU 2025 LoD2: build year on 68% (`0001` = unknown), wooden 41% (one mesh, 2,172 buildings) | GSI 5 m | PDL 1.0 / CC BY | direct |
| Osaka, Dotonbori | candidate | B | The neon canal | PLATEAU 2025 LoD2: storeys, structure, use 100%, **year 0%**; Overture heights 40% | GSI 5 m | PDL 1.0 | direct |
| Milford Sound, Queenstown | candidate (terrain) | A | Fjord walls and Mitre Peak | LINZ building outlines (few buildings) | LINZ 1 m lidar DEM/DSM COGs (Southland 2020–23 covers Milford village, not Mitre Peak; Queenstown 2021); national 8 m DEM | CC BY 4.0 | direct |
| Kanazawa, Higashi Chaya | weak (reads as Kyoto) | B+ | Teahouse streets | PLATEAU 2024: year 70%, wooden 72% | GSI 5 m | PDL 1.0 | direct |
| Sydney | weak | C / B | Landmarks carry it; ordinary fabric middling | Geoscape building heights are "distributed exclusively to NSW Government" | ELVIS lidar (unverified) | ⚠ | docs |

**Notes**
- **Dropped as middling:** Melbourne, Wellington, Yokohama (its 2024 Chinatown mesh has no year, storeys or use). Miyajima (Hatsukaichi) and Nara aren't in PLATEAU; Taipei wasn't checked beyond the national licence.
- **Hong Kong:** the Building layer is CSDI dataset `landsd_rcd_1637211194312_35158` (WFS, monthly); `BaseHeight` gives the ground under every building. The Buildings Department's "Building information and age records" CSV is on data.gov.hk. The data is A-grade; the licence is what blocks it.
  - **The terms (re-read directly 2026-11-11):** the CSDI portal and DATA.GOV.HK use the same wording. It lists what we may do (browse, download, distribute, reproduce, hyperlink, print) and adapting isn't on the list. A world package is an adaptation, and our ODbL packages would pass on to downstream users the right to adapt, which we don't have. The indemnity covers "any allegations or claims" arising from use, and the terms can be revised without notice. No permission for Hong Kong government data is listed on OSM's contributors page.
  - **The clean route:** a written grant from LandsD, asked at `3dmap@landsd.gov.hk` (the contact on the CSDI 3D Spatial Data API page). Ask whether we may adapt the Building layer, 3D-BIT00 and the 5 m DTM into a derived database that is redistributed under ODbL with their acknowledgement, and whether the indemnity applies to that. Until there is an answer, nothing from CSDI or DATA.GOV.HK goes into a package, a fixture or a golden, including through a plugin that fetches it at build time.
  - **The open fallback** (measured 2026-11-11, Sheung Wan to Sham Shui Po, 13,950 Overture buildings): OSM footprints with floors on 6,076 of them. 3D-GloBFP fills 5,632 of the other 7,874, but compared with floors × 3.2 m it overstates buildings under 30 m by about 1.7× and gives buildings over 150 m about 0.4× their height (Langham Place, 255 m, reads 75 m). It would need calibrating against the OSM floors before use. Terrain is GLO-30 with a ground filter. Landmarks from the registry carry the skyline's top. Tong lau come from neighbourhood boxes (Mong Kok, Yau Ma Tei, Sham Shui Po, Sheung Wan) using Tokyo's `bounds` and `maxDepth`.
  - **What open data loses, measured against LandsD** (2026-11-11, the same area: 18,091 LandsD buildings with `TopHeight − BaseHeight`, the 5 m DTM and OP dates as the reference; LandsD data was used only for this comparison and kept out of the repo):
    - **Footprints hold up.** Overture covers 80% of LandsD's building area, and 85% of Overture's area lies on LandsD buildings. 4% of towers and podiums over 30 m² are missing (median height 7 m). Only 232 footprints merge four or more buildings.
    - **Heights where OSM has floors** (47% of footprints, 86% of towers over 100 m) are close: floors × 3.5 m against the tallest part under each footprint is within 3 floors on 60%, with a median error of 6.7 m. 3.0 m per floor suits towers better (ratio 0.99) and 3.5 m suits walk-ups better (0.93–0.99).
    - **Heights where OSM has none** (53%) are guesses. A box default or calibrated 3D-GloBFP is within 3 floors on about 60% of them, but makes low buildings 1.3–1.5× too tall and 40–100 m blocks 0.4–0.6× too short. 3D-GloBFP adds little over a box default.
    - **Overall:** the open path is within 3 floors on 59–60% of buildings, with a median error of 7–8 m, about 2 floors. The pipeline as it stands is within 3 floors on 44–47%, with a median error of 12 m, and draws 20–40 m tong lau at 0.38× their height, so the global path's box defaults are essential. In the skyline, the tallest building in each 100 m cell is within 25% in 75% of cells with towers.
    - **Towers on podiums:** 27% of footprints carry a tower over a podium or a row of mixed heights. Open data draws these as one block, except the 527 buildings that have OSM building parts.
    - **Tong lau:** box rules find 92% of them, but only 63% of the buildings they mark are tong lau (many are walk-ups from after 1975). Era can't be told apart without OP dates, which LandsD has for 68% of buildings.
    - **Terrain is the biggest loss.** GLO-30 with a 210 m opening filter has an RMSE of 7.9 m on flat streets and 15.4 m on slopes over 15°, and 22% of street points are off by more than 10 m. Raw GLO-30 has an RMSE of 12.8 m and reads flat streets 3.8 m high.
    - **The verdict:** Kowloon's flat districts (Mong Kok, Yau Ma Tei, Sham Shui Po, Tsim Sha Tsui) come out at B: heights about 2 floors off and one uniform era. Central and the Mid-Levels come out at C: streets and building bases 3–5 floors off on the slopes, which breaks a walking level's stairs and terraces.
  - **Hong Kong Island on open data** (2026-11-12, D-115, D-117; built as `hongkong-island`): the whole island at 10 m is 1650 × 1086 cells and about 21,000 Overture buildings (6.1 MB as built; 11 MB in the trial, with a placed tree wherever the canopy map had one). OSM has floors on 37–79% of buildings along the north shore, 14% in Happy Valley and 0–27% on the Peak and the south side. Against the 183 summits with a surveyed height, D-107's filter planed the hills off (a median 36 m low); with the filter only in town and a canopy's height off the trees elsewhere, a median 14 m low (GLO-30 as it is: 5 m). The Mid-Levels still need a ground that reads the roads.
- **Chongqing:** the global path gets the peninsula, the gorges and ridge relief, the stacking order of roads, bridges, tunnels and stairs, and the monorail line (where it crosses a building footprint, the Liziba set piece can be found automatically). It can't say which street enters which floor (Hongyadong, Kuixing's 22nd-floor entrance), loses cliffs and stilt houses under 30 m, and needs a ground filter on the DSM. Google 2.5D doesn't cover China.
- **Varanasi:** the ghat steps and the bank need an authored riverbank rule.

### The Americas and US national parks

Researched 2026-11-10, checked against the live APIs where the portals answered (ArcGIS REST, Socrata, CKAN, the USGS TNM API and lidar bucket, COG samples). Datos CDMX and IDE Perú didn't answer. Ranked by how recognisable each would be as pixel art.

| Place | Status | Score | Why it's distinctive | Buildings and facts | Elevation | Licence | Checked |
|---|---|---|---|---|---|---|---|
| **Rio de Janeiro** | candidate | A | Sugarloaf and its cable car, Corcovado, favelas on the hills, Copacabana | Data.Rio *Edificações (2013)*: 2.3 M buildings with `BASE`, `TOPO`, `ALTURA` (Rocinha: 16,430 of 16,436 with a height); `Tipo` flags favela buildings (`A102 - EDIFICACAO_FAVELA`) and stepped upper floors (`PROJECAO_1/2/3`); favela boundaries 2009–2019. No year | City 5 m lidar DTM (2019) only as a point-query MapServer; Copernicus GLO-30 for bulk terrain | CC BY 4.0 | direct |
| **Yosemite Valley** (and Zion, Bryce, Yellowstone) | candidate | A | Half Dome, El Capitan; canyon walls; hoodoos; Grand Prismatic | NPS Buildings (`BLDGTYPE`, `FACUSE`), NPS trails | USGS 1 m DEMs and point clouds; EPT for Bryce and Yellowstone (not Yosemite Valley or Zion Canyon) | public domain (federal) | direct |
| **Québec City** | candidate | A | Château Frontenac, the walls, steep tin roofs, Petit-Champlain | City footprints (CC BY 4.0, no heights; take heights from the HRDEM DSM − DTM); the province-wide MAMH assessment roll (`RL0307A` year, `RL0306A` floors, `RL0311A` dwellings, `RL0105A` use) | NRCan HRDEM 1 m DSM and DTM (`QC-Quebec_Levis_2017-1m`) | CC BY 4.0; OGL-Canada | direct |
| **Monument Valley** | candidate | B | The Mittens and Merrick Butte | none needed | 3DEP 1/3″ (10 m, read today by the built-in source); no 1 m on the Arizona buttes, no lidar | public domain | direct; a Navajo Nation Tribal Park: clear permissions first |
| **French Quarter, New Orleans** | candidate | B | Iron-lace galleries, Creole townhouses and cottages, shotguns | City footprints (public domain, no heights); the Vieux Carré Commission's *Structures* layer: `BuildingType` (Creole Townhouse, Creole Cottage, Shotgun…), `CurrentStyle`, `ColorRating`, galleries and balconies as their own polygons | 1 m DEM; lidar EPT `LA_2021GNO_1_C22` for heights | footprints public domain; the VCC layer has a disclaimer and no grant | direct; ask the city to publish the VCC layer on its CC0 portal |
| **Charleston** | candidate | B | Rainbow Row, single houses with piazzas | OSM through Overture is unusually rich: heights 77%, floors 89%, roof shape 61%, facade colour 65% | 1 m DEM; EPT `USGS_LPC_SC_Charleston_2016_LAS_2019` | ODbL (city layer: disclaimer only) | direct |
| **Waikīkī and Diamond Head** | candidate | B | The hotel wall, the crater | City footprints with `maxht_m`; Overture heights 67% | 1 m DEM; EPT `HI_NOAAMauiOahu_2_B20` | ODbL (city layer: disclaimer only) | direct |
| **Old San Juan** | candidate | B | El Morro, blue cobbles, pastel blocks | Overture floors 58% | 1 m DEM; EPT `USGS_LPC_PR_PRVI_E_2018` | ODbL, public domain | direct |
| **La Paz** | candidate (global path) | C local | A city in a canyon bowl crossed by the Mi Teleférico gondolas, Illimani | No local data found; Overture 8,286 buildings in the centre (floors 3%); **its 13 gondola lines, 27 stations and 187 pylons are in Overture** | GLO-30 (the bowl and El Alto's rim are far above 30 m) | ODbL, Copernicus | direct (Overture) |
| **Valparaíso** | candidate (global path) | C local | Colourful hillside houses, the ascensores | Overture 1,513 in the cerros (floors 4%); 9 ascensores in Overture as funiculars | GLO-30 | ODbL, Copernicus (the 2024 municipal geoportal's licence unverified) | direct (Overture) |
| **Machu Picchu** (and Cusco) | candidate (hero asset) | C local | Ruins on a ridge, terraces, Huayna Picchu | Overture 121 (113 OSM ruins); no open Peruvian data found; CAST scans are CC BY-NC (reference only) | GLO-30 | ODbL, Copernicus | direct |
| **Guanajuato** | weak | C local | Coloured houses stacked in a ravine, tunnels | Overture 5,727 (floors 5%, colour 4%); INEGI census by block only | INEGI 15 m; 5 m lidar DTM in parts of Mexico (coverage here unverified) | INEGI free-use terms (commercial use and derived products allowed; terms may change) | direct |
| **Havana** | weak | C local | The Malecón, pastel colonial blocks, the Capitolio | Overture 2,854 (floors 6%); no portal | GLO-30 | ODbL, Copernicus | direct (Overture) |
| Antelope Canyon | no (as a region) | — | The slot canyon's interior | a slot a few metres wide is invisible from above | 1 m DEM at nearby Horseshoe Bend | public domain | direct; better as a hero asset or interior in a Page, Arizona region |

**Notes**
- **Rio:** the `Tipo` codes drive a favela typology per building; `PROJECAO` polygons are stepped upper floors (building parts). The city's 15 cm orthophotos exist (licence unverified). Christ the Redeemer is a sculpture (data-sources.md §7) and is reported to be licensed commercially by the Archdiocese (unverified): plan a stylised variant and legal review. Dataset: `https://services5.arcgis.com/mgrvZxGU0bSJbVld/arcgis/rest/services/Quadras_Lotes_Edificacoes/FeatureServer/0`.
- **Québec City:** the MAMH roll covers the whole province, so one facts plugin also serves Montréal.
- **French Quarter:** Vieux Carré Structures at `https://gis.nola.gov/arcgis/rest/services/apps/vcvl/MapServer/0`; the item text grants nothing ("provided for general informational purposes only"), though city policy memo 135 defines open data as free of encumbrances.
- **Parks:** NPS Buildings at `https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Buildings_Geographic/FeatureServer/0`. Overhangs (Arches, Mesa Verde's cliff dwellings) need hero assets.
- Skipped as well-documented but not distinctive enough: Vancouver, Savannah, Buenos Aires, Mexico City. Noted: Medellín (Metrocable in Overture), Cartagena (IGAC cadastre licence unclear), Santa Fe (1 m DEM).

### The global-data path: what it captures

Measured in Overture 2026-10-21.0 over boxes of 1–2 km, the share of buildings with a height / floors / roof shape / facade colour:

| Place | Buildings | Height | Floors | Roof | Colour | Main source |
|---|---|---|---|---|---|---|
| Rio, Copacabana | 3,440 | 0% | 2% | 0% | 0% | OSM 65%, Google 28% |
| Rio, Rocinha | 5,888 | 5% | 0% | 0% | 0% | (Data.Rio has 16,436 here) |
| La Paz | 8,286 | 0% | 3% | 0% | 0% | Google 81% |
| Guanajuato | 5,727 | 1% | 5% | 0% | 4% | Microsoft 66% |
| Havana | 2,854 | 0% | 6% | 0% | 1% | |
| Cusco | 4,602 | 1% | 0% | 0% | 0% | |
| Machu Picchu | 121 | 0% | 0% | 0% | 0% | OSM ruins |
| Charleston (for contrast) | | 77% | 89% | 61% | 65% | OSM |
| Venice | 3,286 | 23% | 34% | 2% | | OSM 99% |
| Santorini, Oia / Fira | 525 / 737 | 1% / 0% | 0% / 2% | 0% | | Microsoft ML 58% / 44% |
| Chefchaouen | 1,891 | 0% | 0% | 0% | | OSM 99% |
| Marrakech / Fez | 9,106 / 3,495 | 0% | 0% | 0% | | OSM 79% / Microsoft ML 94% |
| Dubrovnik | 819 | 0% | 1% | 0% | | OSM 93% |
| Hallstatt | 222 | 46% | 27% | 23% | | OSM |
| Prague | 906 | 3% | 84% | 11% | | OSM |
| Hong Kong, Mong Kok (six more districts: 902–1,787 each, floors 27–58%, heights 0–9%) | 1,547 | 2% | 63% | | | OSM 96% |
| Chongqing, Yuzhong | 1,601 | 1% | 7% | | | East Asian buildings (CC BY 4.0) 56%, OSM 44% |
| Varanasi / Jaipur | 5,347 / 7,684 | 0% | 0% | | | Google 86% / 81% |
| Kathmandu / Bhaktapur | 6,188 / 5,480 | | 4% / 0% | 3% / | | OSM 95% / 92% |
| Hội An | 9,052 | | 1% | | | OSM 96% |

**Captured:** every footprint (OSM, Google, Microsoft), roads, beaches and water, funiculars and cable cars, landforms of about 60–90 m and up (Sugarloaf, Corcovado, Valparaíso's cerros, La Paz's bowl, Huayna Picchu), coarse height classes, Wikidata fame.

**Machine-learned footprints** (Microsoft, Google) merge contiguous roofs into blobs in medinas and cave towns, so Fez's are unusable for streets; OSM-dense places (Venice, Chefchaouen, Marrakech, Dubrovnik) are fine.

**Not captured:** per-building age or style (typology comes from neighbourhood boxes in the spec), real heights and roof forms, facade colours (palettes come from the style pack), true ground under dense city or forest (GLO-30 is a surface model), and anything under about 30 m: Machu Picchu's terraces, Guanajuato's lanes, Valparaíso's stair streets, Sugarloaf's sheer faces (they become ramps).

**What it would take**, built once for all these places:
- **A Copernicus GLO-30 terrain source:** built in since D-107 (`copernicus-glo30`, `copernicus-glo30-ground`). The DEM is on AWS as `copernicus-dem-30m`, anonymous (tiles checked for Santorini, Petra, Cappadocia and Marrakech).
  - **Licence** (read directly): Article 4 grants "reproduction; distribution; adaptation, modification and combination with other data", worldwide and free of charge.
  - **Attribution:** derived products must say "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved", and pass on its no-liability sentence.
  - **Water mask:** it's a surface model, so Venice and dense old towns need flattening with the water mask.
- **An Overture aerialway reader:** `base/infrastructure` with subtype `aerialway` holds La Paz's gondolas, Sugarloaf's cable car and Medellín's Metrocable. `transportation/segment` with rail class `funicular` holds Corcovado's rack railway and Valparaíso's ascensores. The index is cached; nothing reads it yet.
- **Typology by neighbourhood box,** with no facts source.
- **A ground filter for the surface model** in dense cities (Chongqing, Hong Kong): the lowest GLO-30 value around each road, say. The bare-earth FABDEM is CC BY-NC-SA, and GlobalBuildingAtlas heights are CC BY-NC: neither is usable.
- **Multi-level streets:** Overture's `level_rules` and `steps` give the stacking order of roads, bridges and stairs (Chongqing), not their heights.
- **Heights from 3D-GloBFP** (Zenodo 15487006, CC BY 4.0): a height for each footprint, estimated for 2020 and covering China, Hong Kong and Macau (tile 2269 for Hong Kong; Chongqing has its own tiles). In Hong Kong it pulls heights toward the middle (low buildings 1.7×, towers 0.4×), so use it only after calibrating against OSM floors where both exist, as a fallback to them.
- **Optionally, heights from Google Open Buildings 2.5D Temporal:** a building-height raster for 2016–2023 at 4 m effective resolution, covering Latin America, India, Nepal, Vietnam and Indonesia (not China or Taiwan), capped at 100 m. It is under CC BY 4.0 or ODbL, the user's choice, in a public bucket that lists anonymously (`gs://open-buildings-temporal-data/v1/geotiffs/`).


