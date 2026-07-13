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

## Step 6 — Zoning district → town GIS (per-town; not statewide)
- Manchester GIS viewer: `https://www.manchesternh.gov/Departments/Planning-and-Comm-Dev/GIS/GIS-Viewer` (DNN page, VIEWSTATE postback → the map app URL/service is embedded).
- No public statewide zoning layer; must locate each town's zoning MapServer/FeatureServer
  or read the zoning map PDF. TODO: find Manchester's hosted zoning service.
- Cross-check district against the zoning ordinance dimensional table (setbacks, min lot,
  coverage, height) — those are in the ordinance PDF (fetchable).

---

## Step 7 — Septic / wells → NHDES OneStop
- Subsurface (septic approvals) + Well Completion Reports, searchable by address/map-lot.
- `https://www4.des.state.nh.us/OneStop/...` — ASP.NET forms → **Playwright**.
- If public sewer/water confirmed (Step 5 / listing), expect no records; if records exist →
  private system → capacity + 75-ft setback analysis.

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
| SLU/SLUC 11 | Single-family residential (NH State Land Use) | ⚠️ verify vs SLU table |
| FEMA FLD_ZONE X | Minimal flood hazard (not SFHA) | ✅ |
| FEMA SFHA_TF F | Not in Special Flood Hazard Area | ✅ |

## Open API TODOs
- [ ] NH GRANIT hydrography service path (for shoreland distance math).
- [ ] Manchester hosted zoning service (or parse zoning map PDF).
- [ ] Confirm NH SLU code table (map SLUC → land-use description).
- [ ] VGSI Manchester internal pid for 222-83 (owner + assessed value).
