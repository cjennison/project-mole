# Telemetry — how Project MOLE reports run progress

**You do NOT need Azure to use this.** Every run emits structured events to two always-on
sinks, and a third that stays dormant until you decide to wire up Azure:

1. **JSONL file** — `reports/telemetry/<runId>.jsonl` (one file per run; durable; in
   production point `MOLE_TELEMETRY_DIR` at a mounted volume or sync to Blob Storage).
2. **stderr** — lines prefixed `@@MOLE_TELEMETRY {json}` (so any log scraper / container-log
   pipeline can pick them up). Goes to **stderr** so it never corrupts a tool's stdout JSON.
3. **Azure Application Insights** — **only active if `APPLICATIONINSIGHTS_CONNECTION_STRING`
   is set.** No resource, no SDK, no code change needed now. When you create an App Insights
   resource later, set that one env var and the same events start flowing as custom Events.

## Event schema
```jsonc
{
  "runId": "e162c4ae-…",        // correlation id, shared by every process in one run
  "address": "1341 River Road, Manchester, NH",
  "role": "mole-runner",        // MOLE_ROLE (cloud role name in App Insights)
  "event": "zoning",            // phase/milestone name
  "status": "start|ok|warn|error|skipped",
  "ts": "2026-07-13T16:18:27Z",
  "seq": 6,                     // monotonic within a process
  "durationMs": 1148,           // present on ok/error of a timed phase
  "error": "…",                 // present on error
  "attributes": { … }           // arbitrary context (pid, district, verdict, …)
}
```
In App Insights this maps to a **customEvent**: `name` = event, `customDimensions` =
status/address/attributes, `customMeasurements.durationMs` = duration, `operation_Id` = runId.

## Standard events (a run's lifecycle)
| event | emitted by | meaning |
|---|---|---|
| `run_start` | entrypoint + collect | container invoked / collector started |
| `geocode`, `parcel`, `zoning`, `flood`, `shoreland`, `wetlands`, `environmental` | collect.mjs | each data phase (start → ok/error, with durationMs) |
| `collect_done` | collect.mjs | data gathering finished; attributes: pid, district, floodZone, shorelandApplies, addressMatch, dataGaps |
| `analysis` | agent | reasoning over the data |
| `assessor` | agent | VGSI scrape result (attributes: pid) |
| `report_write` | agent | report started/written (attributes: slug, verdict) |
| `run_end` | entrypoint | container finished (attributes: exitCode) |

## Config (env vars)
| var | default | purpose |
|---|---|---|
| `MOLE_RUN_ID` | random uuid | correlation id; entrypoint sets one and exports it to all child procs |
| `MOLE_ADDRESS` | — | address under analysis (added to every event) |
| `MOLE_ROLE` | `mole-runner` | App Insights cloud role name (distinguish many runners) |
| `MOLE_TELEMETRY_DIR` | `./reports/telemetry` | JSONL output dir |
| `MOLE_TELEMETRY_FILE` | `<dir>/<runId>.jsonl` | override full file path |
| `MOLE_TELEMETRY_STDERR` | on | set `0` to silence the stderr sink |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | unset | set later to ship to Azure — the ONLY thing needed |

## Emit from anywhere
- Automatically: `tools/collect.mjs` instruments all data phases.
- Manually (agent milestones / scripts):
  ```
  node tools/telemetry.mjs report_write ok slug=1341-river-road verdict=by-right
  ```
- From JS: `import { emit, step, flush } from './telemetry.mjs'`.

## Building a dashboard later (no work now)
When you create an App Insights resource, set `APPLICATIONINSIGHTS_CONNECTION_STRING` on the
container (e.g., from Key Vault in Azure Container Apps). Then query in Log Analytics:
```kusto
customEvents
| where timestamp > ago(24h)
| extend runId = tostring(customDimensions.runId), status = tostring(customDimensions.status)
| project timestamp, name, status, runId, address = tostring(customDimensions.address),
          durationMs = todouble(customMeasurements.durationMs)
| order by timestamp asc
```
Until then, the same data is in `reports/telemetry/*.jsonl` — tail it or load it into anything.
