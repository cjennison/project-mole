// Project MOLE worker — the single "mole agent".
// Polls the jobs queue and, for each address, runs GitHub Copilot CLI (Claude Opus 4.8) INSIDE
// this container as the actual agent: it drives the deterministic tools (collect + sitemap via
// tools/report.mjs), LOOKS at the site map it rendered, and self-corrects the ADU placement — then
// writes reports/<id>.{png,md,json}. The worker uploads those to Blob, stores state in Table, and
// streams live phase telemetry (tailed from the run's JSONL) into the Table for the web UI.
// There is NO Azure OpenAI — Copilot CLI on the operator's account is the intelligence.
// Runs as an Azure Container Apps app with a KEDA queue scaler (max 1 replica, scale-to-zero).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../lib/storage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS = path.join(ROOT, 'reports');
const TELE_DIR = path.join(REPORTS, 'telemetry');
const MODEL = process.env.MOLE_AGENT_MODEL || 'claude-opus-4.8';
const AGENT_TIMEOUT_MS = Number(process.env.MOLE_AGENT_TIMEOUT_MS || 12 * 60 * 1000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function agentPrompt(address, base) {
  return `Produce an NH ADU feasibility report, following AGENTS.md exactly. The target address is ${address} and the job basename is ${base}. First run: node tools/report.mjs "${address}" "${base}". This runs the engineering site-plan engine (tools/siteplan.cjs), which classifies every parcel grid cell as CLEARING (buildable open ground) vs OBSTRUCTION (tree canopy, roof/structure, pavement/deck, or pool/water), dissolves ALL the clearing inside the setbacks into ONE green ADU-eligible area polygon (with its total square footage — the whole usable region where an ADU could be sited), and places a sample 900 sf ADU box on the clearing nearest the house. Then VIEW the labeled grid image reports/${base}-grid.png with your image ability — a zoomed aerial with lettered/numbered cells, class tints (clearing=faint yellow, trees=green, structure/pavement=gray, pool/water=blue), the GREEN ADU-eligible area outline, and the current sample ADU box outlined in red. Going cell by cell with your OWN EYES, confirm (a) the green ADU-eligible polygon covers the genuinely open ground and excludes every pool, deck/patio, driveway, roof and tree, and (b) the red sample box sits fully on open CLEARING and is NOT on or touching a pool, pool deck/patio, driveway/pavement, house/roof, or trees. Trust your eyes over the tints. If the box or the green area is wrong, pick the best OPEN-CLEARING cell nearest the house (e.g. the open ground beside the pool) and re-run with MOLE_ADU_HINT="<that cell label>" node tools/report.mjs "${address}" "${base}", then view reports/${base}-grid.png again to confirm. Repeat until both the green area and the red box are unambiguously on open clearing clear of the pool, structures and trees. Ensure reports/${base}.png, reports/${base}.md and reports/${base}.json all exist. Work autonomously; do not ask questions. End by printing DONE and the final cell.`;
}

// Tail a run's telemetry JSONL and forward each event as a phase update. Returns a stop() fn.
function tailTelemetry(runId, onPhase) {
  const file = path.join(TELE_DIR, `${runId}.jsonl`);
  let offset = 0, stopped = false, buf = '';
  const tick = () => {
    if (stopped) return;
    try {
      if (fs.existsSync(file)) {
        const size = fs.statSync(file).size;
        if (size > offset) {
          const fd = fs.openSync(file, 'r');
          const b = Buffer.alloc(size - offset);
          fs.readSync(fd, b, 0, b.length, offset);
          fs.closeSync(fd);
          offset = size; buf += b.toString('utf8');
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            try { onPhase(JSON.parse(line)); } catch {}
          }
        }
      }
    } catch {}
    if (!stopped) setTimeout(tick, 1200);
  };
  tick();
  return () => { stopped = true; };
}

function runAgent(address, base, env) {
  return new Promise((resolve) => {
    const prompt = agentPrompt(address, base);
    const child = spawn('copilot', ['-p', prompt, '--model', MODEL, '--allow-all', '--log-level', 'none'],
      { cwd: ROOT, env });
    let tail = '';
    const cap = (d) => { tail = (tail + d).slice(-4000); };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, AGENT_TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, tail }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, tail: String(e.message || e) }); });
  });
}

// Deterministic fallback: run tools/report.mjs directly (no agent) so a report is still produced
// if the CLI agent is unavailable or fails to write outputs.
function runDeterministic(address, base, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools/report.mjs'), address, base], { cwd: ROOT, env });
    let tail = '';
    child.stdout.on('data', d => { tail = (tail + d).slice(-4000); });
    child.stderr.on('data', d => { tail = (tail + d).slice(-4000); });
    child.on('close', (code) => resolve({ code, tail }));
    child.on('error', (e) => resolve({ code: -1, tail: String(e.message || e) }));
  });
}

async function processJob(job) {
  const { id, address } = job;
  console.log(`[worker] processing ${id} :: ${address}`);
  const phases = [{ event: 'run_start', status: 'start', at: new Date().toISOString() }];
  await store.patchJob(id, { status: 'processing', phases });

  // De-dupe live phases by event name (keep latest status) to avoid churn across agent iterations.
  const seen = new Map();
  const onPhase = (evt) => {
    const key = evt.event;
    const entry = { event: evt.event, status: evt.status, durationMs: evt.durationMs, attributes: evt.attributes, at: new Date().toISOString() };
    if (seen.has(key)) phases[seen.get(key)] = entry; else { seen.set(key, phases.length); phases.push(entry); }
    store.patchJob(id, { phases, status: 'processing' }).catch(() => {});
  };

  const env = {
    ...process.env,
    MOLE_ADDRESS: address, MOLE_JOB_ID: id, MOLE_RUN_ID: id, MOLE_ROLE: 'mole-agent',
    MOLE_TELEMETRY_DIR: TELE_DIR,
  };
  fs.mkdirSync(TELE_DIR, { recursive: true });
  try { fs.rmSync(path.join(TELE_DIR, `${id}.jsonl`), { force: true }); } catch {}
  const stopTail = tailTelemetry(id, onPhase);

  const jsonPath = path.join(REPORTS, `${id}.json`);
  try { fs.rmSync(jsonPath, { force: true }); } catch {}

  // 1) Try the Copilot CLI agent (Opus 4.8). 2) Fall back to the deterministic pipeline.
  let mode = 'agent';
  const a = await runAgent(address, id, env);
  if (!fs.existsSync(jsonPath)) {
    console.warn(`[worker] agent produced no output (code=${a.code}); falling back to deterministic. tail: ${a.tail.slice(-300)}`);
    mode = 'deterministic';
    await runDeterministic(address, id, env);
  }
  stopTail();

  if (!fs.existsSync(jsonPath)) {
    await store.patchJob(id, { status: 'error', error: `report generation failed (agent code ${a.code})`, phases });
    return;
  }

  const bundle = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const report = bundle.report;

  // Upload the map, then rewrite the markdown image link to the Blob URL.
  let mapUrl = '';
  const pngPath = path.join(REPORTS, `${id}.png`);
  if (fs.existsSync(pngPath)) {
    try { mapUrl = await store.uploadBlob(`${id}.png`, fs.readFileSync(pngPath), 'image/png'); }
    catch (e) { console.warn('map upload failed', e.message); }
  }
  let md = fs.existsSync(path.join(REPORTS, `${id}.md`)) ? fs.readFileSync(path.join(REPORTS, `${id}.md`), 'utf8') : (report.markdown || '');
  if (mapUrl) md = md.split(`](${id}.png)`).join(`](${mapUrl})`);
  await store.uploadBlob(`${id}.md`, md, 'text/markdown; charset=utf-8').catch(() => {});
  await store.uploadBlob(`${id}.json`, JSON.stringify(bundle, null, 2), 'application/json').catch(() => {});

  phases.push({ event: 'run_end', status: 'ok', attributes: { mode }, at: new Date().toISOString() });
  await store.patchJob(id, { status: 'done', report, mapUrl, phases });
  console.log(`[worker] done ${id} (${mode}) :: ${report.verdict}`);
}

async function main() {
  await store.ensure();
  console.log(`[worker] started; model=${MODEL}; polling queue…`);
  for (;;) {
    let item = null;
    try { item = await store.receiveOne(); } catch (e) { console.warn('receive failed', e.message); await sleep(3000); continue; }
    if (!item) { await sleep(2000); continue; }
    try { await processJob(item.payload); }
    catch (e) { console.error('job failed', e); try { await store.patchJob(item.payload.id, { status: 'error', error: String(e.message || e) }); } catch {} }
    try { await store.deleteMessage(item.msg); } catch (e) { console.warn('delete failed', e.message); }
  }
}
main().catch(e => { console.error('worker fatal', e); process.exit(1); });
