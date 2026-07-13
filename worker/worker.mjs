// Project MOLE worker — the single "mole agent".
// Polls the jobs queue, runs the deterministic feasibility pipeline (collect + sitemap),
// builds a report, stores map+report in Blob and state in Table, and streams live phase
// progress (parsed from the tools' telemetry) into the Table for the web UI.
// Runs as an Azure Container Apps app with a KEDA queue scaler (max 1 replica, scale-to-zero).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../lib/storage.mjs';
import { buildReport } from '../lib/report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function runTool(script, address, jobId, onPhase) {
  return new Promise((resolve) => {
    const env = { ...process.env, MOLE_RUN_ID: jobId, MOLE_ADDRESS: address, MOLE_TELEMETRY_STDERR: '1' };
    const child = spawn(process.execPath, [path.join(ROOT, script), address], { cwd: ROOT, env });
    let out = '', errBuf = '', errAll = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => {
      errBuf += d; errAll += d;
      let nl;
      while ((nl = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, nl); errBuf = errBuf.slice(nl + 1);
        const m = line.match(/@@MOLE_TELEMETRY (\{.*\})/);
        if (m) { try { onPhase(JSON.parse(m[1])); } catch {} }
      }
    });
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch {}
      if (!parsed) {
        const nonTel = errAll.split('\n').filter(l => l && !l.includes('@@MOLE_TELEMETRY')).slice(-8).join(' | ');
        console.error(`[worker] ${script} exit=${code} no-json. stdout(${out.length}b): ${out.slice(0, 300)} :: stderr: ${nonTel}`);
      }
      resolve(parsed);
    });
    child.on('error', (e) => { console.error(`[worker] spawn error for ${script}: ${e.message}`); resolve(null); });
  });
}

async function processJob(job) {
  const { id, address } = job;
  console.log(`[worker] processing ${id} :: ${address}`);
  const phases = [{ event: 'run_start', status: 'start', at: new Date().toISOString() }];
  await store.patchJob(id, { status: 'processing', phases });

  // Keep phases in local memory (avoids table read-modify-write races on fast events).
  const onPhase = (evt) => {
    phases.push({ event: evt.event, status: evt.status, durationMs: evt.durationMs, attributes: evt.attributes, at: new Date().toISOString() });
    store.patchJob(id, { phases, status: 'processing' }).catch(() => {});
  };

  const data = await runTool('tools/collect.mjs', address, id, onPhase);
  if (!data || !data.parcel) {
    const detail = data ? ('errors=' + JSON.stringify(data.errors || {}) + (data.fatal ? ' fatal=' + data.fatal : '')) : 'no output from collect.mjs';
    await store.patchJob(id, { status: 'error', error: 'data collection failed — ' + detail, phases }); return;
  }

  const site = await runTool('tools/sitemap.cjs', address, id, onPhase);

  let mapUrl = '';
  if (site && site.ok && site.png) {
    try { const fs = await import('node:fs'); mapUrl = await store.uploadBlob(`${id}.png`, fs.readFileSync(site.png), 'image/png'); }
    catch (e) { console.warn('map upload failed', e.message); }
  }

  const report = buildReport(data, { buildableAreaSqFt: site?.buildableAreaSqFt, aduFitsSqFt: site?.aduFitsSqFt, mapUrl, vision: site?.vision, aduSource: site?.aduSource });
  await store.uploadBlob(`${id}.md`, report.markdown, 'text/markdown; charset=utf-8').catch(() => {});
  await store.uploadBlob(`${id}.json`, JSON.stringify({ data, report }, null, 2), 'application/json').catch(() => {});
  phases.push({ event: 'run_end', status: 'ok', at: new Date().toISOString() });
  await store.patchJob(id, { status: 'done', report, mapUrl, phases });
  console.log(`[worker] done ${id} :: ${report.verdict}`);
}

async function main() {
  await store.ensure();
  console.log('[worker] started; polling queue…');
  let idle = 0;
  for (;;) {
    let item = null;
    try { item = await store.receiveOne(); } catch (e) { console.warn('receive failed', e.message); await sleep(3000); continue; }
    if (!item) { idle++; await sleep(2000); continue; }
    idle = 0;
    try { await processJob(item.payload); }
    catch (e) { console.error('job failed', e); try { await store.patchJob(item.payload.id, { status: 'error', error: String(e.message || e) }); } catch {} }
    try { await store.deleteMessage(item.msg); } catch (e) { console.warn('delete failed', e.message); }
  }
}
main().catch(e => { console.error('worker fatal', e); process.exit(1); });
