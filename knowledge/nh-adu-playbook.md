# NH ADU Feasibility Playbook

> **Purpose.** Reusable, property-agnostic checklist of *everything* an administrator
> must figure out before an ADU project can move to design/build in New Hampshire.
> Each item lists **what to determine**, **where to get it** (the "tool"/data source),
> and **who does it**: 🤖 AGENTIC (agent does it now), 📨 REQUEST (agent files a form /
> records request, then waits), 🧑 HUMAN (a person must call/visit/pay/decide).
>
> Run order is roughly top-to-bottom. A worked example (1335 River Rd, Manchester) is
> at the bottom. Statutes/figures verified 2026-07; re-verify each run — laws change
> (NH ADU law was just overhauled by HB 577, eff. 2025).

---

## 0. Inputs required to start
| Need | Source | Who |
|---|---|---|
| Street address | Customer intake | 🧑 |
| Owner name / confirm ownership | Assessor + Registry of Deeds | 🤖 |
| Customer intent (attached vs detached, # bedrooms, budget) | Intake form | 🧑 |

---

## 1. The mental model — the 7 feasibility dimensions
An ADU is feasible when it clears **all seven** gates. The whole job is answering these:

1. **Legal/Zoning** — Does state + town law allow an ADU here, and of what size/type?
2. **Dimensional fit** — Does the lot physically fit an ADU inside setbacks & coverage?
3. **Environmental overlays** — Shoreland, wetlands, floodplain, steep slopes, aquifer.
4. **Wastewater** — Public sewer vs private septic; if septic, does it have capacity/room?
5. **Water** — Public water vs private well; well-radius setbacks.
6. **Other utilities & site** — Power, gas, telecom; buried-utility locates (NH811).
7. **Process/cost** — Permits, inspections, impact fees, deed restriction, valuation/financing.

---

## 2. Dimension-by-dimension: what to determine & where

### 2.1 Legal / Zoning
| Determine | Tool / source | Who |
|---|---|---|
| Statewide ADU rights (RSA 674:71–73; HB 577 eff. 7/1/2025) — 1 ADU **by right** in any district allowing single-family; no special/conditional-use permit; attached OR detached; ≥1 must be owner-occupied; size cannot be capped below 750 or above 950 sq ft by the town; max 1 parking space; can't require occupants be related | NH General Court RSA site; NH Municipal Assoc. guidance PDF | 🤖 |
| Town zoning district of the parcel (e.g., R-1A/R-1B/R-SM) | Town GIS viewer (zoning layer) | 🤖 (interactive map → headless browser) |
| Town ADU ordinance specifics (setbacks, size cap 750–950, height ≤ primary, detached ≥5 ft from primary, no front-yard ADU, design conformity, owner-occupancy deed restriction, impact fees) | Town zoning ordinance + town ADU info sheet | 🤖 |
| Dimensional table for district (min lot, front/side/rear setback, max lot coverage, max height) | Town zoning ordinance | 🤖 |

### 2.2 Dimensional fit (the "buildable envelope")
| Determine | Tool / source | Who |
|---|---|---|
| Lot size & dimensions | Assessor card + GIS parcel geometry | 🤖 |
| Existing structure footprint & location | GIS aerial + assessor sketch | 🤖 |
| Setback lines → remaining buildable envelope | Compute from zoning + parcel geometry | 🤖 (geometry) |
| Lot coverage headroom (existing impervious vs max) | GIS measurement + zoning cap | 🤖 |
| Site constraints: slope, driveway, trees, easements | GIS contours + recorded plans/deeds | 🤖 map / 📨 for recorded easements |

### 2.3 Environmental overlays (the deal-breakers)
| Determine | Tool / source | Who |
|---|---|---|
| **Shoreland** (RSA 483-B): within 250 ft of a "public water" (Merrimack River qualifies)? 50-ft primary-structure setback; accessory structures regulated; **NHDES Shoreland Permit** likely required | NHDES Protected Shoreland map / OneStop; NH GRANIT hydro layer | 🤖 to detect; 📨 to permit |
| **Wetlands** (RSA 482-A): wetlands on/near lot; buffer; dredge-&-fill permit if impacting | NHDES OneStop wetlands; NWI; town conservation | 🤖 detect; 📨 permit |
| **Floodplain** (FEMA SFHA, e.g., Zone AE): building in a flood zone triggers elevation, floodplain-development permit, flood insurance | FEMA Map Service Center; NH Flood Hazards Viewer | 🤖 |
| Aquifer / wellhead protection, steep-slope overlays | Town overlay maps in GIS | 🤖 |

### 2.4 Wastewater (public sewer vs septic)
| Determine | Tool / source | Who |
|---|---|---|
| Public sewer available at the street? | Town sewer/EPD dept.; assessor "utilities" field; listing data | 🤖 (data) / 🧑 (official confirm) |
| If **septic**: existing system location, design flow, # bedrooms it's approved for | NHDES OneStop Subsurface (septic approvals by address/map-lot) | 🤖 lookup; 📨 if only paper file |
| Septic capacity: does ADU add bedrooms beyond approval? → may need **new/upgraded septic design** by a licensed designer + NHDES approval | NHDES Subsurface Bureau | 🧑 (licensed designer) + 📨 (state approval) |
| Septic setbacks: leach field 75 ft to well/water, 10 ft to property line | NH Env-Wq 1000 rules | 🤖 (rules) |
| Note: town ADU rule usually says ADU can't need *greater* septic than primary allows | Town ordinance | 🤖 |

### 2.5 Water (public vs well)
| Determine | Tool / source | Who |
|---|---|---|
| Public water at street? | Town/Water Works service map; assessor field | 🤖 |
| If **well**: location & 75-ft radius vs proposed leach field/structures | NHDES OneStop well inventory (well completion reports) | 🤖 lookup |

### 2.6 Other utilities & site (buried-utility safety)
| Determine | Tool / source | Who |
|---|---|---|
| Electric / gas / telecom providers at address | Assessor + utility service maps | 🤖 |
| **NH811 / Dig Safe** locate before any excavation: file ≥72 business-hrs ahead; markout valid 30 days; homeowner white-lines the dig area | NH811 Exactix online ticket portal | 📨 (file ticket) → 🧑 (utilities physically mark; can't skip) |

### 2.7 Process, cost & financing
| Determine | Tool / source | Who |
|---|---|---|
| NH State Building Code edition: **2021 IRC/IBC** (eff. 7/1/2024), 2020 NEC, 2018 IECC | NH Div. Fire Safety; NHBOA | 🤖 |
| Building permit application + required plans | Town Building/PCD dept. permit portal | 📨 (submit) |
| Required inspections: footing/foundation, framing, electrical, plumbing, insulation/energy, mechanical, final | Town Building dept. | 🧑 (on-site inspector) |
| Impact fees (school/road/rec) for new dwelling unit | Town PCD fee schedule | 🤖 (amount) / 🧑 (pay) |
| Owner-occupancy **deed restriction** recording | Registry of Deeds | 📨 |
| Property valuation / comps (for financing & feasibility) | Assessor assessed value + Zillow/Redfin comps | 🤖 |
| Deeds, recorded plans, easements | County Registry of Deeds (Hillsborough = Manchester) | 🤖 if online index / 📨 for copies |

---

## 3. Data-source ("tool") catalog — what the agent must integrate
Ranked by how automatable each is with a headless browser + APIs.

| # | Tool / portal | Gives | Access method | Auto-rating |
|---|---|---|---|---|
| T1 | **Town GIS viewer** (zoning, parcels, aerials, overlays) | zoning district, geometry, overlays | Interactive JS map → **Playwright headless** | 🤖 med (map scripting) |
| T2 | **Assessor DB** (e.g., Vision/VGSI `gis.vgsi.com/<town>nh`) | lot size, owner, assessed value, sewer/utility flags, sketch | Web form / ASP.NET postback → Playwright | 🤖 med |
| T3 | **NHDES OneStop** (Subsurface/septic, wells, shoreland, wetlands) | septic approvals, well reports, permits by address/map-lot | Web query forms → Playwright; some data mapper | 🤖 med |
| T4 | **FEMA Flood Map Service Center** + NH Flood Hazards Viewer | flood zone (AE/X), BFE | msc.fema.gov (has address search) | 🤖 high |
| T5 | **NH811 Exactix** | file dig-safe locate ticket | Account + online ticket form | 📨 (auth+form) |
| T6 | **County Registry of Deeds** (Hillsborough) | deeds, plans, easements, restrictions | Online index (varies) | 🤖/📨 |
| T7 | **NH General Court RSA** + **NH Municipal Assoc.** | statute text & guidance | Static pages/PDFs → fetch | 🤖 high |
| T8 | **Town zoning ordinance + ADU info sheet** | local rules, dimensional tables | PDFs on town site → fetch/parse | 🤖 high |
| T9 | **Zillow/Redfin/Realtor** | beds/baths, lot, sale history, utility hints, comps | Web pages → fetch/search | 🤖 high |
| T10 | Town **Building/PCD permit portal** | submit permit, fee schedule | Portal (often account) | 📨 |

**Integration note:** T4, T7, T8, T9 are near-fully agentic today. T1, T2, T3 need
Playwright scripting per-portal (they're JS/postback). T5, T6, T10 usually need an
authenticated account and/or produce a request the *town/utility* fulfills.

---

## 4. Task-classification summary (the value story)
Of a typical ~20-step pre-build workload:

- **🤖 AGENTIC now (~55%)**: statute/ordinance lookup, zoning district, lot/dimensional
  data, buildable-envelope math, flood zone, shoreland/wetland *detection*, septic/well
  *record* lookup, valuation/comps, impact-fee amount, building-code edition.
- **📨 REQUEST — agent files, then waits (~25%)**: NHDES shoreland/wetland/septic
  permits, NH811 locate ticket, deed/plan copies, deed-restriction recording, building
  permit submission.
- **🧑 HUMAN — unavoidable (~20%)**: licensed septic designer, on-site inspections,
  physical utility markouts, paying fees, owner decisions, official phone confirmations.

The agent collapses days of portal-hopping into minutes and hands the human a short,
pre-filled action list instead of a blank research project.

---

## 5. Worked example — 1335 River Rd, Manchester, NH 03104
*(All figures to be re-confirmed against official town/state records each run.)*

| Dimension | Finding | Source | Confidence |
|---|---|---|---|
| **Geocode** | lon -71.470117, lat 43.025655 | US Census geocoder | ✅ confirmed |
| **Parcel ID** | **PID 222-83** (NH_GIS_ID 064134-222-83); Manchester (TownID 4134), Hillsborough Co (6) | NH GRANIT ParcelMosaic | ✅ confirmed |
| Lot | **25,778 sq ft = 0.592 ac** (Shape_Area); single-family ranch, built 1979, 3bd/2.5ba, 2,028 sqft | NH GRANIT (area) + Zillow (bldg) | ✅ lot confirmed |
| Land use | **SLU/SLUC = 11** (single-family residential) → single-family IS the use → **ADU allowed by right** | NH GRANIT | ✅ (verify SLU table) |
| Value | Sold $605k (May 2024); Zestimate ~$674k | Zillow | med (get assessor card) |
| Sewer | **Public sewer** (listing) | Redfin | med (confirm w/ Manchester EPD) |
| Water | Assume public (North End) — **CONFIRM** | — | low |
| Zoning | Likely **R-1A/R-1B** single-family; ADU allowed by right | Manchester zoning + RSA 674:72 | med (confirm district in GIS) |
| ADU size cap | Manchester: max 900 sq ft, ≤2 br, ≤ primary height, detached ≥5 ft, no front-yard | Manchester ADU info sheet | med |
| **Floodplain** | **Zone X, SFHA=False — NOT in a flood zone** (at rooftop point) | FEMA NFHL API | ✅ confirmed (check rear yard too) |
| **Shoreland** | **NOT APPLICABLE** — 0 fourth-order+ water within 250 ft; nearest Merrimack River ≈ 0.5 mi (2,600–3,000 ft) east. "River Rd" is a misnomer → **no NHDES shoreland permit needed** | NH GRANIT IWR/WaterResources | ✅ confirmed (big assumption corrected) |
| Building code | 2021 IRC/IBC | NH Fire Safety | high |
| Impact fees | Manchester charges impact fees on new dwelling units — amount TBD | Manchester PCD | needs lookup |

### Biggest gating items for THIS property
1. ~~Shoreland permit~~ **CLEARED** — Merrimack is ~0.5 mi away; RSA 483-B does not apply.
2. ~~Flood zone~~ **CLEARED** at house point — Zone X (not SFHA). *Still verify the specific
   ADU location if it moves toward any low area.*
3. **Zoning district + dimensional fit** — confirm district (R-1A/R-1B) and that the 0.59-ac
   lot has a buildable envelope inside setbacks for a ≤900 sqft ADU. *Now the primary gate.*
4. **Confirm public water/sewer** — if truly public (likely), septic/well analysis is moot;
   if not, re-open capacity + 75-ft setbacks.
5. **Wetlands** — check for wetlands on-parcel (Milestone Brook is nearby); minor, verify.

### Immediate agent-doable next steps (still open)
- [ ] Pull official assessor card (VGSI) → exact lot size, map/lot, assessed value, utility flags.
- [ ] Open Manchester GIS → confirm **zoning district** + overlay layers (shoreland/flood).
- [ ] FEMA MSC → exact flood zone for the parcel.
- [ ] NHDES OneStop → septic/well records (should be none if public).
- [ ] Measure distance from Merrimack River reference line to buildable rear yard.

---

## 6. Open questions for the human (project owner)
- Attached or detached ADU preferred? (changes setback/shoreland math)
- Is owner-occupancy acceptable? (NH requires owner in one unit)
- Budget ceiling? (drives septic-upgrade vs public-tie-in decisions)
