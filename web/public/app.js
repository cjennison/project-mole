const STEP_DEFS = [
  ['geocode', 'Geocoding address'],
  ['parcel', 'Locating parcel'],
  ['zoning', 'Zoning & ADU rules'],
  ['flood', 'Flood zone (FEMA)'],
  ['shoreland', 'Shoreland (RSA 483-B)'],
  ['wetlands', 'Wetlands screen'],
  ['environmental', 'Environmental & groundwater'],
  ['vision', 'AI aerial site analysis'],
  ['sitemap', 'Rendering buildable-area map'],
];
const $ = (s) => document.querySelector(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };

let poll = null;

function renderSteps(phases) {
  const byEvent = {};
  for (const p of phases) byEvent[p.event] = p; // last state wins
  const anyActive = phases.length && phases[phases.length - 1];
  const ol = $('#steps'); ol.innerHTML = '';
  let firstPending = true;
  for (const [ev, label] of STEP_DEFS) {
    const st = byEvent[ev];
    let cls = 'pending', dot = '';
    if (st && st.status === 'ok') { cls = 'ok'; dot = '✓'; }
    else if (st && st.status === 'error') { cls = 'err'; dot = '!'; }
    else if (st && st.status === 'start') { cls = 'active'; }
    else if (firstPending && !st) { /* pending */ }
    const li = el('li', cls);
    li.appendChild(el('span', 'dot', dot));
    li.appendChild(el('span', 'label', label));
    if (st && st.durationMs) li.appendChild(el('span', 'ms', `${st.durationMs} ms`));
    ol.appendChild(li);
    if (cls !== 'ok' && cls !== 'err') firstPending = false;
  }
}

function statusPill(status) {
  const p = $('#p-status'); p.textContent = status; p.className = 'pill ' + status;
}

function icon(st) { return ({ pass: '✅', warn: '⚠️', human: '🧑', unknown: '❓' })[st] || '•'; }

function renderResult(job) {
  const r = job.report; const res = $('#result'); res.innerHTML = '';
  if (!r) return;
  const s = r.snapshot;
  const card = el('section', 'card');

  const v = el('div', 'verdict');
  v.appendChild(el('div', 'badge ' + r.verdictClass, r.verdict));
  v.appendChild(el('div', 'sub', `${s.address}<br><b>${s.pid || '—'}</b> · ${s.district || '—'} · ${s.lotAcres ?? '?'} ac`));
  card.appendChild(v);

  const snap = el('div', 'snapshot');
  const add = (k, val) => { const c = el('div', 'snap'); c.appendChild(el('div', 'k', k)); c.appendChild(el('div', 'v', val)); snap.appendChild(c); };
  add('Lot size', s.lotSqFt ? `${s.lotSqFt.toLocaleString()} sf` : '—');
  add('Zoning', s.district || '—');
  add('Max ADU', s.aduMaxSqFt ? `${s.aduMaxSqFt} sf / ${s.aduMaxBedrooms ?? '?'} br` : '—');
  add('Owner-occ', s.ownerOccupancyRequired || '—');
  card.appendChild(snap);

  if (job.mapUrl) { const img = el('img', 'mapimg'); img.src = job.mapUrl; img.alt = 'Buildable area map'; card.appendChild(img); }

  if (r.siteAnalysis) {
    card.appendChild(el('h3', 'sec', 'Site analysis — AI aerial review'));
    if (r.siteAnalysis.summary) card.appendChild(el('p', 'analysis', r.siteAnalysis.summary));
    if (r.siteAnalysis.rationale) { const p = el('p', 'analysis'); p.innerHTML = `<b>Recommended ADU location:</b> ${r.siteAnalysis.rationale}`; card.appendChild(p); }
    if (r.siteAnalysis.features && r.siteAnalysis.features.length) {
      const chips = el('div', 'featchips');
      for (const f of r.siteAnalysis.features) chips.appendChild(el('span', 'featchip', f.label));
      card.appendChild(el('div', 'k', 'Detected on the lot')); card.appendChild(chips);
    }
    if (r.siteAnalysis.concerns && r.siteAnalysis.concerns.length) {
      card.appendChild(el('div', 'k', 'Verify before siting'));
      const ul = el('ul', 'gaps'); for (const c of r.siteAnalysis.concerns) ul.appendChild(el('li', null, c)); card.appendChild(ul);
    }
  }

  card.appendChild(el('h3', 'sec', 'Feasibility gates'));
  const tbl = el('table', 'gates');
  for (const g of r.gates) {
    const tr = el('tr');
    tr.appendChild(el('td', 'g', g.name));
    tr.appendChild(el('td', null, `<span class="st ${g.status}">${icon(g.status)} ${g.status}</span>`));
    tr.appendChild(el('td', null, g.detail));
    tbl.appendChild(tr);
  }
  card.appendChild(tbl);

  card.appendChild(el('h3', 'sec', 'Task breakdown'));
  const ul = el('ul', 'tasks');
  for (const t of r.tasks) ul.appendChild(el('li', null, `${t.type === 'agentic' ? '🤖 Automated' : t.type === 'request' ? '📨 Filed request' : '🧑 Human step'} — ${t.task}`));
  card.appendChild(ul);

  card.appendChild(el('h3', 'sec', 'Data gaps & caveats'));
  const gaps = el('ul', 'gaps');
  for (const d of r.dataGaps) gaps.appendChild(el('li', null, d));
  card.appendChild(gaps);

  const act = el('div', 'actions');
  if (job.mapUrl) act.appendChild(Object.assign(el('a'), { href: job.mapUrl, target: '_blank', textContent: 'Open site map' }));
  const md = job.mapUrl ? job.mapUrl.replace(/\.png$/, '.md') : '';
  if (md) act.appendChild(Object.assign(el('a'), { href: md, target: '_blank', textContent: 'Report (markdown)' }));
  card.appendChild(act);

  res.appendChild(card);

  // Telemetry pulled from Application Insights (proves the AI integration end-to-end).
  const ai = el('section', 'card');
  ai.appendChild(el('h3', 'sec', 'Telemetry — pulled live from Application Insights'));
  ai.appendChild(el('p', 'hint', 'These events were emitted by the MOLE agent and queried back from Azure Application Insights. Ingestion can lag ~1–2 min, so click refresh if the list looks short.'));
  const aiBox = el('div', 'ai-events', 'Loading from Application Insights…');
  ai.appendChild(aiBox);
  const refresh = el('button', 'chip', '↻ Refresh from App Insights');
  refresh.style.marginTop = '10px';
  refresh.addEventListener('click', () => loadInsights(job.id, aiBox));
  ai.appendChild(refresh);
  res.appendChild(ai);
  loadInsights(job.id, aiBox);

  res.classList.remove('hidden');
}

async function loadInsights(id, box) {
  box.textContent = 'Loading from Application Insights…';
  try {
    const d = await fetch('/api/insights/' + id).then(r => r.json());
    if (!d.enabled) { box.textContent = 'Application Insights query not configured.'; return; }
    if (!d.rows || !d.rows.length) { box.textContent = 'No events indexed yet (ingestion lag) — click refresh in a moment.'; return; }
    box.innerHTML = '';
    const tbl = el('table', 'gates');
    for (const r of d.rows) {
      const tr = el('tr');
      tr.appendChild(el('td', 'g', r.name || ''));
      tr.appendChild(el('td', null, `<span class="st ${r.status === 'ok' ? 'pass' : r.status === 'error' ? 'warn' : 'unknown'}">${r.status || ''}</span>`));
      tr.appendChild(el('td', null, (r.durationMs ? Math.round(r.durationMs) + ' ms' : '') + (r.timestamp ? ` · ${new Date(r.timestamp).toLocaleTimeString()}` : '')));
      tbl.appendChild(tr);
    }
    box.appendChild(tbl);
  } catch (e) { box.textContent = 'Could not query Application Insights: ' + (e.message || e); }
}

async function tick(id) {
  const job = await fetch('/api/jobs/' + id).then(r => r.json()).catch(() => null);
  if (!job || job.error) return;
  statusPill(job.status);
  renderSteps(job.phases || []);
  if (job.status === 'done') { clearInterval(poll); poll = null; renderResult(job); }
  else if (job.status === 'error') {
    clearInterval(poll); poll = null;
    const res = $('#result'); res.innerHTML = ''; res.appendChild(el('div', 'card err-box', 'Analysis failed: ' + (job.error || 'unknown error')));
    res.classList.remove('hidden');
  }
}

async function run(address) {
  $('#result').classList.add('hidden'); $('#result').innerHTML = '';
  $('#progress').classList.remove('hidden');
  $('#p-addr').textContent = address; statusPill('queued');
  renderSteps([]);
  const j = await fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }) }).then(r => r.json());
  if (j.error) { alert(j.error); return; }
  if (poll) clearInterval(poll);
  poll = setInterval(() => tick(j.id), 1500);
  tick(j.id);
}

$('#go').addEventListener('click', () => { const a = $('#addr').value.trim(); if (a) run(a); });
$('#addr').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#go').click(); });
document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { $('#addr').value = c.dataset.a; run(c.dataset.a); }));
