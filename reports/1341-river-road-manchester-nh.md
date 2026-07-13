# ADU Feasibility Report — 1341 River Road, Manchester, NH 03104

**Parcel PID:** 222-85 (NH_GIS_ID 064134-222-85; VGSI PID 6248) &nbsp;|&nbsp; **Date:** 2026-07-13

## Verdict: ✅ Feasible by-right

A **detached (or attached) ADU up to 900 sq ft, ≤2 bedrooms** is allowed on this lot with only
a building permit — no variance or special exception — under **RSA 674:71–73 (HB 577, eff.
7/1/2025)**, which makes one ADU by-right wherever single-family dwellings are permitted. The
lot clears all 7 feasibility gates; the largest open item is confirming public sewer/water at
the tap (see §7).

---

## 1. Data-quality note (resolve before relying on this report)

`tools/collect.mjs`'s automated parcel search (small-envelope query around the geocoded point)
initially matched the **wrong, adjacent parcel** — PID 222-84 / 1325 River Rd — because the
correct parcel (222-85) fell outside its search envelope. This was caught by the tool's own
`addressMatch: false` flag. I re-queried NH GRANIT directly by `PID='222-85'` and cross-verified
against VGSI's address search (which unambiguously returned 1341 River Rd → PID 222-85, VGSI
pid 6248, land 26,000 sq ft — consistent with GRANIT's 25,975 sq ft for the same parcel). **All
figures below use the corrected, verified parcel 222-85.** Treat this as a known limitation of
the current envelope-search radius in `collect.mjs`, not a fact about this property.

---

## 2. Property snapshot

| Field | Value | Source |
|---|---|---|
| Owner | RANDOLPH, GREGORY M | VGSI assessor card |
| Assessed value (2025) | $457,400 | VGSI |
| Last sale | $294,000, 07/01/2013, Bk/Pg 8580/1472 | VGSI |
| Use code | 1010 — SINGLE FAM | VGSI |
| Lot size | 26,000 sq ft (0.60 ac) VGSI / 25,975 sq ft (0.596 ac) GRANIT | VGSI + NH GRANIT |
| Parcel bbox | ≈159 ft × 219 ft | NH GRANIT geometry |
| Zoning district | **R-1A/Sewer** — Residential One-Family, Medium Density | NH Zoning Atlas |
| Building | Colonial, 2 stories, built 2002, 2,256 sq ft living area, 4 bed / 4 bath | VGSI |
| Building footprint (at grade) | 1st floor 884 + enclosed porch 81 + garage 569 = **1,534 sq ft**, + basement 884 (below grade) | VGSI sub-areas |
| Outbuildings | Patio 110 sq ft, frame shed 168 sq ft | VGSI |

---

## 3. The 7 feasibility gates

| # | Gate | Status | Evidence / Source |
|---|---|---|---|
| 1 | **Legal / Zoning** | ✅ | District R-1A/Sewer; single-family treatment = "Allowed/Conditional" (NH Zoning Atlas). Atlas lists ADU treatment as "Public Hearing," but this is a **pre-HB 577 snapshot** — current **RSA 674:72** makes 1 ADU **by-right** wherever SF is allowed. Verify the "Conditional" nuance with Manchester PCD, but it does not block the ADU-by-right path. |
| 2 | **Dimensional fit** | ✅ | Lot 0.60 ac ≫ 0.27 ac min; frontage ~159–219 ft ≫ 100 ft min. See buildable-envelope calc §4. |
| 3 | **Environmental overlays — Flood** | ✅ Cleared | FEMA NFHL: **Zone X, SFHA=F** (not in Special Flood Hazard Area) at the parcel point. |
| 3b | **Environmental overlays — Shoreland** | ✅ Cleared | NH GRANIT + NHDES official Shoreland Protection Act layer: **not in jurisdiction**; nearest 4th-order+ water ≥3,000 ft away. RSA 483-B does not apply despite "River Rd" name. |
| 3c | **Environmental overlays — Wetlands** | ✅ Cleared | 0 wetland features within 100 ft (NH GRANIT/NHDES). |
| 3d | **Environmental due-diligence** | ✅ Cleared | 0 hazard sites (USTs, remediation, salvage, hazwaste, asbestos, solid waste) within 1,000 ft (NHDES DES_Data_Public). Groundwater classification **GA2** (standard, not the more restrictive GA1). |
| 4 | **Wastewater** | ⚠️ Needs confirmation | District name "**R-1A/Sewer**" strongly implies public sewer serves this parcel (vs. the R-1A/Water or R-1A/Water-and-Sewer variants), consistent with an urban Manchester location. **Not independently confirmed** — NHDES OneStop (septic/well records) is Akamai bot-protected and could not be queried. |
| 5 | **Water** | ⚠️ Needs confirmation | Same district-name inference as above suggests public water likely, but unconfirmed. |
| 6 | **Utilities & site** | 🤖 Routine | Electric/gas/telecom assumed available (urban, developed street). **NH811 locate required** before any excavation — not yet filed. |
| 7 | **Process / cost** | 🤖 Routine | NH State Building Code = 2021 IRC/IBC. Manchester impact fees: building permit ≈ cost × 0.006; Planning Board $250 + $100/unit; ADU subject to Article 13 impact fee (exact $ — confirm with PCD). Owner-occupancy deed restriction required. |

---

## 4. Buildable-envelope calculation

- **Lot area:** 26,000 sq ft (VGSI, official).
- **Max lot coverage (buildings + impervious):** 40% → **10,400 sq ft** allowed.
- **Existing footprint:** house at-grade (1st floor 884 + enclosed porch 81 + garage 569) =
  1,534 sq ft, + patio 110 + shed 168 = **1,812 sq ft ≈ 7.0% coverage**. (Driveway not itemized
  by VGSI — assume a few hundred sq ft more; still well under cap.)
- **Adding a 900 sq ft ADU** + pad/walkway (~1,200–1,300 sq ft) → **total ≈ 3,100–3,300 sq ft ≈
  12–13% coverage**, comfortably under the 40% cap. ✅
- **FAR check:** max floor area = 26,000 × 0.3 = **7,800 sq ft**. Existing living area 2,256 +
  ADU 900 = 3,156 sq ft ✅ far under cap.
- **Setbacks:** F25 / S20 / R30 ft. Lot bbox ≈159 ft × 219 ft leaves a large interior
  building envelope (roughly 120–165 ft on a side after setbacks) — ample room for a detached
  ADU that is ≥5 ft from the primary structure, outside the front yard, and ≤ primary building
  height (35 ft max), without needing exact building placement/site-survey data (which was not
  available from VGSI).
- **Conclusion: a 900 sq ft / 2-bedroom ADU fits by-right**, pending confirmed sewer/water
  service.

---

## 5. Task matrix

| Task | Type | Notes |
|---|---|---|
| Statute/ordinance & zoning lookup | 🤖 Done | RSA 674:72, NH Zoning Atlas |
| Parcel, flood, shoreland, wetlands, environmental, groundwater | 🤖 Done | NH GRANIT, FEMA NFHL, NHDES |
| Assessor card (owner, value, footprint, sale history) | 🤖 Done | VGSI |
| Buildable-envelope math | 🤖 Done | This report §4 |
| Confirm public sewer & water at the tap | 🧑 Human | Manchester EPD / Water Works — OneStop is bot-blocked |
| Confirm "Allowed/Conditional" SF treatment nuance for R-1A/Sewer | 🧑/📨 | Manchester PCD zoning desk |
| Manchester impact-fee exact ADU dollar amount | 📨 Request | Manchester PCD fee schedule |
| Building permit + plans (2021 IRC/IBC) | 📨 Request | Town Building/PCD portal |
| Owner-occupancy deed restriction recording | 📨 Request | Hillsborough County Registry of Deeds |
| NH811 / Dig Safe locate ticket | 📨 Request → 🧑 | File ≥72 hrs before excavation; utilities physically mark |
| On-site inspections (footing, framing, electrical, plumbing, insulation, final) | 🧑 Human | Town Building Dept. |

---

## 6. Open questions for the owner

- Attached vs. detached ADU preference (affects placement/setback math).
- Is owner-occupancy (required by NH law) acceptable for this property?
- Budget ceiling — drives finish level and whether to tie into existing utilities vs. new service.
- Intended bedroom count for the ADU (max 2 allowed here).

## 7. Data gaps

- **Septic/well records** — NHDES OneStop is Akamai bot-protected; could not confirm sewer vs.
  septic or well presence from state records. Inferred "likely public sewer/water" from the
  R-1A/**Sewer** zoning-district variant name and urban context only — **not a confirmed fact**.
- **Exact ADU impact-fee dollar amount** — formula known, exact figure needs PCD confirmation.
- **Precise building placement/site survey** — VGSI provides no parcel sketch/site plan;
  setback compliance for a *specific* ADU footprint should be verified with a site plan before
  permitting.
- **"Allowed/Conditional" single-family treatment** in the NH Zoning Atlas for this district
  variant is not fully explained by the available field set — recommend a quick confirmation
  call to Manchester PCD to make sure no unusual conditional-use trigger applies here.
