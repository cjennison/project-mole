# AGENTS.md — Project MOLE: NH ADU Feasibility Agent

You are an autonomous agent that produces **ADU (Accessory Dwelling Unit) feasibility
reports** for New Hampshire properties. You run inside a Docker container. When invoked
you are given a single **street address**. Your job: gather the facts, apply NH + local
law, and write a clear feasibility report. Work fully autonomously — do not ask questions.

## Your task, on invocation
Input: one NH street address (from the `ADDRESS` env var or the prompt).
Output: a Markdown feasibility report written to `reports/<slug>.md` (slug = address,
lowercased, non-alphanumerics → `-`). Also print a short summary to stdout.

## Emit telemetry as you go
Mark your progress so a dashboard can track the run. After each major milestone, run:
```
node tools/telemetry.mjs <event> <status> [key=value ...]
```
Emit at least: `analysis start` (before you reason over the data), `assessor ok|error`
(after the VGSI step, with `pid=<pid>`), `report_write start` then `report_write ok`
(with `slug=<slug>` and `verdict=<by-right|conditional|not-feasible|needs-verification>`).
`tools/collect.mjs` already emits its own per-phase telemetry, so you don't need to repeat
those. Telemetry works with no Azure configured — do NOT skip it.

## How to do it (follow in order)

1. **Collect the deterministic data.** Run:
   ```
   node tools/collect.mjs "<ADDRESS>"
   ```
   This returns JSON with: geocode, parcel (PID, town, lot area, bbox), zoning (district +
   ADU treatment + full dimensional standards), flood zone, shoreland, wetlands,
   environmental due-diligence, groundwater, and a `vgsiHint` {map, lot}.
   - If `parcel.addressMatch` is false, **flag the address discrepancy prominently** and
     treat parcel-specific numbers as approximate.
   - If any `errors.*` are present, note them as data gaps (don't fail the whole report).

2. **Get the official assessor card** (owner, assessed value, use code, footprint). Run:
   ```
   node tools/vgsi.cjs <town-slug> <map> <lot>
   ```
   Use `vgsiHint.map`/`vgsiHint.lot` from step 1. The town-slug for Manchester is
   `manchesternh` (pattern: `<town>nh`). If VGSI fails, continue without it.

3. **Apply the rules** (full detail in `knowledge/nh-adu-playbook.md` and
   `knowledge/nh-data-sources.md` — read them):
   - **NH ADU law (RSA 674:71–73, HB 577, eff. 7/1/2025):** one ADU is allowed **by right**
     wherever single-family dwellings are allowed. **This overrides the NH Zoning Atlas
     `aduTreatmentAtlas` field** (which is a pre-HB577 snapshot, often "Public Hearing").
     Report the permit path as **by-right** when `singleFamilyTreatment` allows single-family.
   - **Size:** town cap applies but can't be below 750 or above 950 sqft; Manchester = 900.
   - **Environmental gates:** `flood.sfha === 'T'` → in a Special Flood Hazard Area (elevation
     + floodplain permit). `shoreland.applies === true` → NHDES shoreland permit + 50-ft
     setback. `wetlands.within100ft > 0` → possible RSA 482-A permit. Otherwise these are
     CLEARED.
   - **Dimensional fit:** compute the buildable envelope. Max coverage = `maxCoveragePct`% of
     `parcel.areaSqFt`. Compare against existing footprint (from VGSI sub-areas if available)
     + a planned ADU (≤ `aduMaxSqFt`). Confirm the lot meets `sfMinLotAcres` and frontage.
   - **Building code:** NH State Building Code = 2021 IRC/IBC.

4. **Classify remaining tasks** as 🤖 AGENTIC (done), 📨 REQUEST (agent files a form/records
   request), or 🧑 HUMAN (call/visit/inspect/pay). Known boundary: **NHDES OneStop**
   (septic/well records) is **Akamai bot-protected** and cannot be scraped — mark
   septic/sewer confirmation as a 🧑 human step unless public sewer is otherwise evidenced.

5. **Write the report** to `reports/<slug>.md` using this structure:
   - Header: address, parcel PID, date, one-line verdict (Feasible by-right / Conditional /
     Not feasible / Needs verification).
   - Property snapshot (owner, lot size, assessed value, use, zoning district).
   - The 7 feasibility gates with ✅/⚠️/❌ and the evidence + source for each.
   - Buildable-envelope calculation.
   - Task matrix (🤖/📨/🧑).
   - Open questions for the owner + data gaps.
   Cite the data source for every material fact.

## Principles
- **Never invent data.** If a source failed or a field is missing, say "unknown — <how to
  get it>". Distinguish confirmed facts from inferences.
- Current **state law beats** the Atlas snapshot for permit path.
- Be decisive but honest about confidence. Keep the report skimmable (tables + bullets).
- The report must stand on its own for a contractor deciding whether to visit the site.
