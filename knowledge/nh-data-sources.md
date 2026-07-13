# NH ADU Data-Source Cookbook (working API recipes)

> **Purpose.** The *exact*, tested endpoints and queries the agent uses to pull ADU
> feasibility data for **any NH property**. These are verified-working as of 2026-07.
> Prefer these REST/JSON APIs over scraping JS portals — they're faster and stable.
> When an item says "Playwright", the source has no clean API and needs the headless
> browser.

---

## Step 1 — Geocode the address → lon/lat (no API key)
**US Census Geocoder** (free, no key):
```
https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=<URLENC ADDRESS>&benchmark=Public_AR_Current&format=json
```
- Returns `result.addressMatches[].coordinates` = `{x: lon, y: lat}` in WGS84.
- ✅ Tested: `1335 River Rd, Manchester, NH 03104` → **lon -71.470117, lat 43.025655**.
- Fallback geocoders if Census misses: ArcGIS World Geocoder, Nominatim (OSM).

---

## Step 2 — Parcel (statewide, reusable) → NH GRANIT ParcelMosaic
**Base:** `https://nhgeodata.unh.edu/nhgeodata/rest/services/CAD/ParcelMosaic/MapServer`
- Layer **0** = Parcel Points, Layer **1** = **Parcels (polygons)** ← use this, Layer 2 = Additional Lines.
- Fields: `PID, Town, TownID, CountyId, StreetAddress, SLU, SLUC, SLUM, NBC, LocalNBC, NH_GIS_ID, U_ID, Shape_Area, Shape_Length`.
- **`Shape_Area` is in SQUARE FEET** (NH State Plane). ✅ Verified: 25,778 sq ft ÷ 43,560 = 0.59 ac, matches Zillow.

**Query by address:**
```
.../MapServer/1/query?where=StreetAddress='1335 RIVER RD' AND Town='MANCHESTER'&outFields=*&returnGeometry=true&outSR=4326&f=json
```
**Query by point** (use a small envelope, point-in-polygon can miss on rooftop coords):
```
.../MapServer/1/query?geometry={xmin,ymin,xmax,ymax}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&f=json
```
- `TownID 4134 = MANCHESTER`, `CountyId 6 = Hillsborough`.
- **SLU / SLUC** = NH State Land Use Code. `11` observed on this + neighboring parcels =
  **single-family residential** (VERIFY against NH SLU code table; drives "is single-family
  allowed here" → ADU-by-right test).
- ⚠️ Not every town contributes CAMA attributes; some parcels only have geometry+PID. For
  owner name / assessed value, fall back to the town assessor DB (Step 5).

---

## Step 3 — Flood zone → FEMA National Flood Hazard Layer (NFHL)
**Endpoint** (note `/arcgis/`, host `hazards.fema.gov`):
```
https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?geometry=<lon>,<lat>&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE&returnGeometry=false&f=json
```
- Layer **28** = Flood Hazard Zones. Key fields: `FLD_ZONE` (e.g. X, AE), `SFHA_TF`
  (T=in Special Flood Hazard Area, F=not), `STATIC_BFE` (base flood elev; -9999 = n/a).
- ✅ Tested `1335 River Rd`: **FLD_ZONE=X, ZONE_SUBTY="AREA OF MINIMAL FLOOD HAZARD",
  SFHA_TF=F** → NOT in a flood zone. (Note: check the whole *buildable envelope*, not just
  the rooftop point — near a river the rear yard may fall in AE while the house is in X.)

---

## Step 4 — Shoreland / wetlands / hydro → NH GRANIT IWR/WaterResources ✅ (recipe works)
**Base:** `https://nhgeodata.unh.edu/nhgeodata/rest/services/IWR/WaterResources/MapServer`
Pre-computed **shoreland buffer zones** and hydro layers — no geometry math needed:
- Water-body buffers: L13=50ft, L14=100, L15=150, L16=200, **L17=250**, L18=300.
- Stream buffers: L20=50 … **L24=250** … L25=300.
- L6=Stream Centerlines, L8=**Fourth Order and Greater** (the RSA 483-B jurisdictional
  waters), L9=Water Bodies, L26/L28/L32=Wetlands (NWIPlus / NHDES base map),
  L30=Designated Rivers, L31=Designated Rivers ¼-mile buffer.
- There's also a dedicated layer: `IWR/NHDStreamOrderLegacyVersionForChapter483_B/MapServer/9`.

**Shoreland trigger test** (does RSA 483-B apply?): is any **4th-order-or-greater** water,
great pond, or designated river within **250 ft**? Use a distance-buffered point query:
```
.../MapServer/8/query?geometry=<lon>,<lat>&geometryType=esriGeometryPoint&inSR=4326&distance=250&units=esriSRUnit_Foot&spatialRel=esriSpatialRelIntersects&returnCountOnly=true&f=json
```
- count>0 → shoreland applies (NHDES permit, 50-ft primary setback). count=0 → does NOT apply.
- To find nearest named water, step `distance` up (500,1000,…) or add `where=gnis_name='Merrimack River'`.
- ✅ Tested `1335 River Rd`: **0 fourth-order+ water within 250 ft**; nearest Merrimack River
  centerline ≈ **2,600–3,000 ft (~0.5 mi) east**. **Shoreland does NOT apply** despite the
  street name "River Rd". (Field in L8 is lowercase `gnis_name`; L6/L29 use `GNIS_Name`.)

**Wetlands test** (RSA 482-A): point/parcel intersect L26/L28/L32 (and buffer ~100 ft).
- Small brooks (< 4th order, e.g. "Milestone Brook" here) are NOT protected shoreland, but
  wetlands within/near the parcel can still trigger a dredge-&-fill permit — check separately.

---

## Step 5 — Town assessor DB (owner, assessed value, sewer flag) → VGSI
- Manchester: `https://gis.vgsi.com/manchesternh/` (Vision Government Solutions).
- ASP.NET; parcel pages at `Parcel.aspx?pid=<internalId>`. Search form is postback →
  **Playwright** (or find the internal pid). Gives: owner, assessed value, land/bldg, sewer,
  building sketch, year built.
- Reusable pattern: `gis.vgsi.com/<town>nh/` for many NH towns.

---

## Step 6 — Zoning district + ALL dimensional/ADU rules → NH Zoning Atlas ✅ (statewide!)
**This is the highest-value tool in the project — statewide, per-district, machine-readable.**
**Endpoint:**
```
https://services1.arcgis.com/aguSsLS841Hp3EC4/ArcGIS/rest/services/NH_Atlas_Zoning_Districts_Buildable/FeatureServer/0
```
- Polygon layer; query by point or envelope (same pattern as parcels). The "Buildable"
  version clips out non-buildable slivers, so a rooftop point can miss → **fall back to a
  small envelope** and pick the polygon(s) whose `Jurisdiction` = the town.
- ~170 fields. The ones that matter for ADUs:
  - `Jurisdiction`, `AbbreviatedDistrict`, `Full_District_Name`, `Type_of_Zoning_District`
  - `F1_Family_Treatment` (is single-family allowed → ADU-by-right test)
  - **`Accessory_Dwelling_Unit__ADU__Treatment`** (Allowed / Conditional / Public Hearing / Prohibited)
  - `Detached_ADU_Treatment__if_allowed_`, `ADU_Max___Per_Lot`, `ADU_Owner_Occupancy_Required`,
    `ADU_Min___Parking_Spaces__Additional_to_Main_Unit_`, `ADU_Max_Size__SF_`,
    `ADU_Max___Bedrooms_Per_Unit`, `ADU_Min_Lot__acres___additional_to_main_unit_`
  - Single-family dimensional: `F1_Family_Min_Lot__ACRES_`, `F1_Family_Front/Side/Rear_Setback____of_feet_`,
    `F1_Family_Min_Road_Frontage`, `F1_Family_Max_Lot_Coverage___Buildings___Impervious_Surface____`,
    `F1_Family_Max_Height____of_feet_`, `F1_Family_Floor_to_Area_Ratio`
- ✅ Tested near `1335 River Rd`: district **R-1A** (variants R-1A/Sewer, R-1A/Water,
  R-1A/Water and Sewer — dimensions identical). Values:
  - SF min lot **0.27 ac**, front **25 ft**, side **20 ft**, rear **30 ft**, frontage **100 ft**,
    max coverage (bldg+impervious) **40%**, max height **35 ft / 2.5 stories**, FAR **0.3**.
  - ADU: max **900 sqft**, **≤2 bedrooms**, **1 per lot**, **owner-occupancy required**,
    +1 parking, no extra min lot.
- ⚠️ **CRITICAL RECONCILIATION:** the Atlas records ADU Treatment = **"Public Hearing"** for
  R-1A, but that's a *pre-HB 577 snapshot*. Under current **RSA 674:72 (eff. 7/1/2025)** one
  ADU is now **by right** wherever single-family is allowed — the statute overrides the
  Atlas's "Public Hearing". **Always let current state law win over the Atlas for the
  permit-path question; use the Atlas for the dimensional numbers.**
- Sibling layers exist (e.g. `NH_Atlas_Zoning_Districts` non-buildable, statewide zoning
  FeatureServers under other org ids) — the Buildable one above is the richest.

### (old Step 6 town-GIS notes — fallback only)
- Manchester GIS viewer: `https://www.manchesternh.gov/Departments/Planning-and-Comm-Dev/GIS/GIS-Viewer` (DNN/VIEWSTATE postback → Playwright). Use only to confirm the exact
  district boundary if the Atlas polygon is ambiguous at a lot line.

---

## Step 7 — Septic / wells / official environmental → NHDES GIS + OneStop
**NHDES ArcGIS server (public):** `https://gis.des.nh.gov/server/rest/services`
- ✅ **Official shoreland check:** `Projects_LRM/Shoreland_Protection_Act/MapServer`
  - L0 Urban Exemptions, **L1 "4th Order and Above Streams and Rivers"**, L2 Lakes/Ponds
    jurisdiction. Point-in-layer test = authoritative shoreland determination.
  - ✅ Verified `1335 River Rd`: point in **none** of these → shoreland officially N/A
    (independent confirmation of the NH GRANIT result).
- Wetlands/terrain: `Projects_LRM/National_Wetlands_Inventory_Plus_NWIPlus_New_Hampshire`,
  `New_Hampshire_Prime_Wetlands`, `NHDES_Wetland_Permits_by_Year`, `NHDES_Alteration_of_Terrain_Projects`.
- **Environmental due-diligence** (`Core_GIS_Datasets/DES_Data_Public/MapServer`, 14 layers):
  Remediation Sites, Underground/Aboveground Storage Tanks, Hazardous Waste Generators,
  Auto Salvage Yards, Groundwater Classification GA1/GA2, NPDES Outfalls, etc. Point/buffer
  query these to flag nearby contamination — a value-add screen, not core ADU feasibility.
- ⚠️ **Septic (subsurface) approvals & Well Completion Reports are NOT in the public GIS.**
  They live in **NHDES OneStop** (`https://www4.des.state.nh.us/DESOnestop/BasicSearch.aspx`).
  - ❌ **OneStop is Akamai bot-protected** — returns **"Access Denied"** to `Invoke-WebRequest`
    AND to the container's real headless Chromium (tested this session). Standard Playwright
    is blocked. Options: (a) anti-bot/stealth browser (playwright-extra + stealth, residential
    IP), (b) treat as a **🧑 human / 📨 records-request** step, or (c) wait for NHDES's new
    **NHEnviro** platform (launching Aug 2026) which may expose APIs.
  - The only well data in NHDES ArcGIS is `Hosted/NH_NGWMN_Wells` = groundwater *monitoring*
    wells (not private drinking wells) — not useful for parcel water/sewer determination.
  - **Practical fallback:** infer public sewer/water from the listing + assessor card + the
    fact that the lot sits in a fully-sewered urban district; flag "confirm at tap" for a human.

## Step 5b — Assessor card (owner, value, use, lot, sales) → VGSI via Playwright ✅ WORKS
- Base: `https://gis.vgsi.com/manchesternh/` (path assets `/ManchesterNH/`). ASP.NET postback.
- **Working recipe (tested in the container):**
  1. `goto Search.aspx` (`waitUntil: 'domcontentloaded'` — NOT networkidle; keep-alive pings
     abort networkidle).
  2. `selectOption('#MainContent_ddlSearchSource','3')` → MBLU mode (0=Address,1=Owner,3=Mblu).
  3. Fill `#MainContent_txtM` (Map), `#MainContent_txtB` (Block), `#MainContent_txtL` (Lot).
     For Manchester, PID `222-83` = **Map 222, Lot 83** (Block empty).
  4. Submit is hidden — trigger via `document.getElementById('MainContent_btnSubmit').click()`.
  5. Lands on `Parcel.aspx?pid=<internalId>`; scrape `span[id*="lbl"]`.
- Key span ids: `lblGenOwner`, `lblGenAssessment` (Total Market Value), `lblUseCode` +
  `lblUseCodeDescription`, `lblLndSize` (sqft), `lblMblu`, `lblPrice`/`lblSaleDate`/`lblBp`
  (book&page), building attrs under `ctl02_lbl*`.
- ✅ `1335 River Rd` → pid **6246**, Owner **JENNISON, JESSICA L**, MBLU 0222/0083,
  **assessed $397,400 (2025)**, Use **1010 SINGLE FAM**, land **25,740 sqft**, sold $605k
  05/16/2024 Bk/Pg 9775/1322. Building: Ranch 1979, 1,416 sqft 1st flr + 780 garage + 332
  enclosed + 110 open porch. (No utilities/sewer field in the summary; try the Field Card PDF.)
- Run: `docker run --rm --entrypoint node -e NODE_PATH=/usr/local/lib/node_modules
  -v <scripts>:/work --cap-add SYS_ADMIN --security-opt seccomp:unconfined
  project-mole-copilot:latest /work/vgsi.cjs`. Script committed at `scripts/vgsi.cjs`.
- **NH assessing Use Code 1010 = single-family** (confirms SLU 11 / single-family use).

## Impact fees & permit fees (Manchester) — verified
- Building permit, new 1&2-family: **est. construction cost × 0.006**.
- Planning Board application: **$250 base + $100/dwelling unit**.
- ADUs ARE subject to impact fees (Article 13 of the zoning ordinance); internal conversions
  may be treated more leniently. Exact ADU impact-fee dollar amount → confirm with PCD.
- Source: `manchesternh.gov/pcd/forms/PermitFeeSchedule.pdf`, PCD "Fees" page.

---

## Step 8 — Dig Safe → NH811 Exactix (action, not lookup)
- `https://exactix.nh811.com/` — account + online locate ticket. File ≥72 business hrs
  before digging; markout valid 30 days. **Playwright + stored creds**; produces a
  📨 request the utilities fulfill physically.

---

## Reference codes captured
| Code | Meaning | Confidence |
|---|---|---|
| TownID 4134 | Manchester | ✅ |
| CountyId 6 | Hillsborough County | ✅ |
| SLU/SLUC 11 | Single-family residential (NH State Land Use) | ✅ (VGSI Use 1010 confirms) |
| FEMA FLD_ZONE X | Minimal flood hazard (not SFHA) | ✅ |
| FEMA SFHA_TF F | Not in Special Flood Hazard Area | ✅ |
| Zoning district R-1A | Residential One-Family Medium Density (Manchester) | ✅ |
| Assessing Use Code 1010 | Single-family (VGSI) | ✅ |

## Open API TODOs
- [x] NH GRANIT hydrography → IWR/WaterResources (shoreland buffers L13-25, 4th-order L8).
- [x] Statewide zoning + dimensional + ADU rules → NH Zoning Atlas FeatureServer.
- [x] SLU/Use code confirmed (VGSI Use 1010 = single-family = SLU 11).
- [x] VGSI assessor card (pid 6246): owner, $397,400 assessment, 25,740 sqft, deed Bk/Pg 9775/1322.
- [x] Environmental due-diligence + groundwater (NHDES DES_Data_Public) — site clean, GA2.
- [ ] NHDES OneStop septic/well — **BLOCKED by Akamai** (needs stealth browser or records request).
- [~] Deeds: have Book/Page **9775/1322** (05/16/2024) from VGSI; full deed doc = Hillsborough
      Registry of Deeds (separate portal; may also be bot-protected).
- [ ] Manchester impact-fee exact ADU dollar amount (formulae captured; confirm $ with PCD).
