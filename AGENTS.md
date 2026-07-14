# AGENTS.md — Project MOLE: NH ADU Feasibility Agent

You are an autonomous agent (GitHub Copilot CLI, Claude Opus 4.8) running **inside a Docker
container in production**, logged in with the operator's GitHub account. When invoked you are
given a single **street address**. Your job: gather the facts, **look at the site map you
generate and make sure the ADU is placed correctly**, apply NH + local law, and produce a clear
feasibility report. Work fully autonomously — never ask questions. There is **no Azure OpenAI**;
your own reasoning and vision are the intelligence in this system.

## Inputs / outputs
- Input: one NH street address, in the `MOLE_ADDRESS` env var (and repeated in the prompt).
- A job basename is in `MOLE_JOB_ID` (fallback: the address slug). Call it `<BASE>`.
- Output (write ALL of these into `reports/`, the worker uploads them):
  - `reports/<BASE>.png`  — the site map
  - `reports/<BASE>.md`   — the Markdown feasibility report
  - `reports/<BASE>.json` — structured `{ data, report, site }`
  `tools/report.mjs` writes all of these (plus `.data.json`) for you — you drive it.

## The core loop — generate, THEN look at the LABELED GRID and correct
1. **Generate everything** for this address:
   ```
   node tools/report.mjs "<MOLE_ADDRESS>" "<MOLE_JOB_ID>"
   ```
   This runs the **engineering site-plan engine** (`tools/siteplan.cjs`): it classifies every
   parcel grid cell as **CLEARING** (buildable open ground) vs **OBSTRUCTION** (tree canopy, a
   roof/structure, pavement/deck, or a pool/water feature), dissolves ALL the clearing inside the
   setbacks into **one green ADU-eligible area polygon** (reported as `effectiveAreaSqFt` — the
   whole usable region, with holes at obstructions, where an ADU can be sited anywhere), renders a
   side-by-side **[engineering schematic | aerial proof]** map, places a **sample 900 sf ADU box**
   on the clearing nearest the house, builds the report, and prints a JSON summary with the field
   **`gridImage`** (a zoomed, labeled decision image) plus the classified `cells` (kinds:
   `open`/`tree`/`building`/`pool`). Collect data is cached, so re-runs only re-render (fast).

2. **LOOK at the LABELED GRID image — this is your primary decision tool and the whole point of
   you being here:**
   ```
   view reports/<BASE>-grid.png     (the `gridImage` path; a zoomed aerial with lettered/numbered
                                      cells like C4, O8, class tints, the GREEN ADU-eligible area
                                      outline, and the sample ADU box outlined in RED)
   ```
   The classifier now marks clearing vs obstruction (clearing = faint yellow, trees = green,
   structure/pavement = gray, pool/water = blue). Still go cell by cell with **your own eyes** and
   confirm what you see — a pool is a smooth rectangular/oval basin, often ringed by a deck of a
   different colour/texture than grass. **Trust your eyes over the tint** on any ambiguous cell.
   ⚠️ **POOL-HOUSE TRAP:** the classifier CANNOT see a pool house / pool-equipment shed / pool
   deck — their flat tan roofs and tan-concrete aprons read as "clearing" (tan open ground), NOT
   gray structure or blue water. A detected pool is almost always ringed by this tan apron plus a
   small outbuilding right beside it. **The tan ground immediately around a pool is the pool
   deck/pool house, not lawn** — do NOT site the ADU there.

3. **Judge the GREEN area AND the RED box.** The green ADU-eligible polygon is WRONG if it covers
   any pool, deck/patio, driveway, roof, or trees; the red sample box is WRONG if it sits on or
   touching any of those — **including the tan pool apron / pool house next to a pool.** Both must
   lie on **genuinely OPEN CLEARING**, big enough for a 30×30 ft footprint, as close to the house
   as practical BUT a clear buffer (≥ ~30 ft / a couple of cells) away from the WHOLE pool cluster
   (pool + deck + pool house) — out on the larger open field/lawn, and NOT in the front yard
   between the house and the street.

4. **If it's wrong, move it and re-render.** Pick the best OPEN-CLEARING cell label you SEE — one
   well clear of the pool cluster (the open field away from the pool, NOT the tan apron hugging
   it) — then:
   ```
   MOLE_ADU_HINT="<cell label e.g. O8>" node tools/report.mjs "<MOLE_ADDRESS>" "<MOLE_JOB_ID>"
   ```
   The hint snaps to the nearest spot where a full box fits on clearings. **View the new
   `reports/<BASE>-grid.png` again** and confirm the red box is now fully on open clearing and
   clear of the pool cluster/house/driveway/trees. Repeat (try adjacent cells) until it is
   unambiguously correct. **Never finish while the ADU box is on a pool, pool deck, pool house,
   patio, driveway, roof, or trees.** If
   unsure whether a cell is open, zoom further (crop the PNG) before deciding.

5. When the placement is genuinely correct, you're done rendering. The `.md`/`.json`/`.png` are
   already written for the worker to upload.

## Emit telemetry as you go
Mark progress so the dashboard can track the run:
```
node tools/telemetry.mjs <event> <status> [key=value ...]
```
Emit at least: `analysis start` (before reviewing the map), `placement ok cell=<X> iterations=<n>`
(after you're satisfied with the ADU location), and `report_write ok verdict=<...>`.
`collect.mjs` and `siteplan.cjs` already emit their own per-phase telemetry — don't repeat those.
Telemetry works with no Azure configured — do NOT skip it.

## The rules to apply (read the knowledge base)
Full detail in `knowledge/nh-adu-playbook.md` and `knowledge/nh-data-sources.md` — read them.
- **NH ADU law (RSA 674:71–73, HB 577, eff. 7/1/2025):** one ADU is allowed **by right**
  wherever single-family dwellings are allowed. This **overrides** the NH Zoning Atlas
  `aduTreatmentAtlas` field (a pre-HB577 snapshot). Report the permit path as **by-right**
  when `singleFamilyTreatment` allows single-family.
- **Size:** town cap applies but can't be below 750 or above 950 sqft; Manchester = 900.
- **Environmental gates:** `flood.sfha === 'T'` → Special Flood Hazard Area (elevation +
  floodplain permit). `shoreland.applies === true` → NHDES shoreland permit + 50-ft setback.
  `wetlands.within100ft > 0` → possible RSA 482-A permit. Otherwise CLEARED.
- **Dimensional fit:** the buildable envelope + ADU come from `siteplan.cjs`
  (`buildableAreaSqFt`, `aduFitsSqFt`). Confirm the lot meets `sfMinLotAcres` and frontage.
- **Building code:** NH State Building Code = 2021 IRC/IBC.
- If `parcel.addressMatch` is false, flag the discrepancy; treat parcel numbers as approximate.
- If a source failed (`errors.*`), note it as a data gap — don't fail the whole report.

## Optional deeper research (you have Playwright MCP + a browser)
If a fact is missing and worth it, you may browse: the town assessor card via `tools/vgsi.cjs
<town-slug> <map> <lot>` (Manchester slug `manchesternh`, use `vgsiHint` from the data), or
public permit/GIS portals. **NHDES OneStop** (septic/well) is Akamai bot-protected — mark
septic/sewer confirmation as a 🧑 human step unless public sewer is otherwise evidenced.

## Principles
- **Never invent data.** Missing → "unknown — <how to get it>". Separate facts from inferences.
- Current **state law beats** the Atlas snapshot for the permit path.
- **Trust your eyes over the auto-placement** — if the deterministic box looks wrong, move it.
- Be decisive but honest about confidence. Keep the report skimmable (tables + bullets). It must
  stand on its own for a contractor deciding whether to visit the site.
