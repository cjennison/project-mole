#!/usr/bin/env node
// Project MOLE — one-shot report orchestrator for the Copilot CLI agent.
//
// Usage: node tools/report.mjs "<address>" [base]
//   base = output basename (defaults to the address slug). Writes into reports/:
//     reports/<base>.png    — the site map (aerial + parcel + buildable + ADU box)
//     reports/<base>.md     — the Markdown feasibility report
//     reports/<base>.json   — { data, report, site } (structured; consumed by the worker)
//     reports/<base>.data.json — cached collect() output (reused across placement iterations)
//
// The agent's self-correction loop:
//   1. node tools/report.mjs "<addr>" <base>          # first pass (auto placement)
//   2. LOOK at reports/<base>.png                      # judge the ADU box with your own eyes
//   3. if the ADU box is on the pool / in the woods / on the house, pick a better spot from
//      site.cells (an open cell beside the house) and re-run with a correction:
//        MOLE_ADU_HINT="<lon,lat or cell label>" node tools/report.mjs "<addr>" <base>
//      (collect data is cached, so this only re-renders — fast and free)
//   4. repeat until the box sits on genuinely open ground next to the existing house.
//
// Deterministic tools do the heavy lifting; the agent contributes visual judgment. NO Azure OpenAI.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport } from '../lib/report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADDRESS = process.argv[2];
if (!ADDRESS) { console.error('Usage: node tools/report.mjs "<address>" [base]'); process.exit(1); }
const slug = ADDRESS.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const BASE = (process.argv[3] || slug).replace(/[^a-z0-9._-]+/gi, '-');
const REPORTS = path.join(ROOT, 'reports');
fs.mkdirSync(REPORTS, { recursive: true });

function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, env: process.env });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; }); // telemetry lines go to stderr; let them pass through
    child.on('close', (code) => {
      let json = null; try { json = JSON.parse(out); } catch {}
      resolve({ code, json, out, err });
    });
    child.on('error', (e) => resolve({ code: -1, json: null, out: '', err: String(e.message || e) }));
  });
}

(async () => {
  const dataPath = path.join(REPORTS, `${BASE}.data.json`);
  // 1) Collect deterministic data (cached across iterations unless MOLE_FRESH is set).
  let data = null;
  if (!process.env.MOLE_FRESH && fs.existsSync(dataPath)) {
    try { data = JSON.parse(fs.readFileSync(dataPath, 'utf8')); } catch {}
  }
  if (!data) {
    const r = await run('tools/collect.mjs', [ADDRESS]);
    data = r.json;
    if (!data || !data.parcel) {
      console.log(JSON.stringify({ ok: false, base: BASE, error: 'data collection failed', detail: data ? data.errors : r.err.slice(-400) }, null, 2));
      process.exit(2);
    }
    fs.writeFileSync(dataPath, JSON.stringify(data));
  }

  // 2) Render the engineering site plan + place the ADU (honours MOLE_ADU_HINT for agent corrections).
  const mapPath = path.join(REPORTS, `${BASE}.png`);
  const s = await run('tools/siteplan.cjs', [ADDRESS, mapPath]);
  const site = s.json || {};

  // 3) Build the deterministic report. mapUrl is the local filename; the worker rewrites it to the
  //    Blob URL after upload.
  const report = buildReport(data, {
    buildableAreaSqFt: site.buildableAreaSqFt,
    effectiveAreaSqFt: site.effectiveAreaSqFt,
    aduFitsSqFt: site.aduFitsSqFt,
    mapUrl: `${BASE}.png`,
    vision: site.vision,
    aduSource: site.aduSource,
  });

  fs.writeFileSync(path.join(REPORTS, `${BASE}.md`), report.markdown);
  fs.writeFileSync(path.join(REPORTS, `${BASE}.json`), JSON.stringify({ data, report, site }, null, 2));

  // 4) Concise summary for the agent — enough to judge placement WITHOUT re-parsing everything.
  const openCells = (site.cells || []).filter(c => c.kind === 'open').map(c => c.label);
  const houseCells = (site.cells || []).filter(c => c.kind === 'building').map(c => c.label);
  const poolCells = (site.cells || []).filter(c => c.kind === 'pool').map(c => c.label);
  console.log(JSON.stringify({
    ok: !!site.ok,
    base: BASE,
    map: path.relative(ROOT, mapPath).replace(/\\/g, '/'),
    gridImage: site.gridImage ? `reports/${site.gridImage}` : null,
    verdict: report.verdict,
    aduSource: site.aduSource,
    aduHint: site.aduHint || null,
    aduHintError: site.aduHintError || null,
    aduPlacedNorm: site.aduPlacedNorm || null,
    buildableAreaSqFt: site.buildableAreaSqFt,
    aduFitsSqFt: site.aduFitsSqFt,
    classZoom: site.classZoom,
    cells: { open: openCells, house: houseCells, pool: poolCells },
    hintUsage: 'View the gridImage, find an OPEN-LAWN cell with your eyes, then re-run with MOLE_ADU_HINT="<cell label>" to move the ADU there.',
  }, null, 2));
})();
