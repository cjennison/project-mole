const STEP_DEFS = [
  ['geocode', 'Geocoding address'],
  ['parcel', 'Locating parcel'],
  ['zoning', 'Zoning & ADU rules'],
  ['flood', 'Flood zone (FEMA)'],
  ['shoreland', 'Shoreland (RSA 483-B)'],
  ['wetlands', 'Wetlands screen'],
  ['environmental', 'Environmental & groundwater'],
  ['vision', 'Aerial site analysis'],
  ['sitemap', 'Rendering buildable-area map'],
];
const $ = (s) => document.querySelector(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };

let poll = null;
let errStreak = 0;
let me = { authenticated: false, isOwner: true, gated: false, name: null };

function deepLinkId() {
  const m = location.pathname.match(/^\/r\/([\w.-]+)$/);
  if (m) return m[1];
  return new URLSearchParams(location.search).get('id');
}
function setUrl(id) { try { history.pushState({ id }, '', '/r/' + id); } catch {} }

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

  // Shareable link — anyone with this URL can view the report.
  const shareUrl = `${location.origin}/r/${job.id}`;
  const share = el('div', 'sharebar');
  share.appendChild(el('span', 'k', 'Shareable link'));
  const inp = el('input', 'shareurl'); inp.type = 'text'; inp.readOnly = true; inp.value = shareUrl;
  inp.addEventListener('focus', () => inp.select());
  const copy = el('button', 'chip', 'Copy');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(shareUrl); } catch { inp.select(); document.execCommand('copy'); }
    copy.textContent = 'Copied!'; setTimeout(() => (copy.textContent = 'Copy'), 1500);
  });
  share.appendChild(inp); share.appendChild(copy);
  card.appendChild(share);

  const snap = el('div', 'snapshot');
  const add = (k, val) => { const c = el('div', 'snap'); c.appendChild(el('div', 'k', k)); c.appendChild(el('div', 'v', val)); snap.appendChild(c); };
  add('Lot size', s.lotSqFt ? `${s.lotSqFt.toLocaleString()} sf` : '—');
  add('Zoning', s.district || '—');
  add('Max ADU', s.aduMaxSqFt ? `${s.aduMaxSqFt} sf / ${s.aduMaxBedrooms ?? '?'} br` : '—');
  add('Owner-occ', s.ownerOccupancyRequired || '—');
  card.appendChild(snap);

  if (job.mapUrl) { const img = el('img', 'mapimg'); img.src = job.mapUrl; img.alt = 'Buildable area map'; card.appendChild(img); }

  if (r.siteAnalysis) {
    card.appendChild(el('h3', 'sec', 'Site analysis — aerial review'));
    if (r.siteAnalysis.summary) card.appendChild(el('p', 'analysis', r.siteAnalysis.summary));
    if (r.siteAnalysis.rationale) { const p = el('p', 'analysis'); p.innerHTML = `<b>Recommended ADU location:</b> ${r.siteAnalysis.rationale}`; card.appendChild(p); }
    if (r.siteAnalysis.features && r.siteAnalysis.features.length) {
      const seen = new Set(); const labels = [];
      for (const f of r.siteAnalysis.features) { const k = (f.label || '').toLowerCase(); if (!k || k === 'other' || seen.has(k)) continue; seen.add(k); labels.push(k.replace('_', ' ')); }
      if (labels.length) {
        const chips = el('div', 'featchips');
        for (const l of labels) chips.appendChild(el('span', 'featchip', l));
        card.appendChild(el('div', 'k', 'Detected on the lot')); card.appendChild(chips);
      }
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
  let resp;
  try { resp = await fetch('/api/jobs/' + id); } catch { return; }
  if (resp.status === 404) {
    if (++errStreak >= 3) {
      clearInterval(poll); poll = null;
      const res = $('#result'); res.innerHTML = ''; res.appendChild(el('div', 'card err-box', 'Report not found. Check the link or run a new analysis.'));
      res.classList.remove('hidden'); $('#progress').classList.add('hidden');
    }
    return;
  }
  errStreak = 0;
  const job = await resp.json().catch(() => null);
  if (!job || job.error) return;
  if (job.address) $('#p-addr').textContent = job.address;
  statusPill(job.status);
  renderSteps(job.phases || []);
  if (job.status === 'done') { clearInterval(poll); poll = null; renderResult(job); }
  else if (job.status === 'error') {
    clearInterval(poll); poll = null;
    const res = $('#result'); res.innerHTML = ''; res.appendChild(el('div', 'card err-box', 'Analysis failed: ' + (job.error || 'unknown error')));
    res.classList.remove('hidden');
  }
}

// Open an existing report by id (deep link). Public — no auth required to view.
function openReport(id) {
  errStreak = 0;
  $('#result').classList.add('hidden'); $('#result').innerHTML = '';
  $('#progress').classList.remove('hidden');
  $('#p-addr').textContent = '…'; statusPill('loading'); renderSteps([]);
  if (poll) clearInterval(poll);
  poll = setInterval(() => tick(id), 1500);
  tick(id);
}

async function run(address) {
  $('#result').classList.add('hidden'); $('#result').innerHTML = '';
  $('#progress').classList.remove('hidden');
  $('#p-addr').textContent = address; statusPill('queued');
  renderSteps([]); errStreak = 0;
  const resp = await fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }) });
  const j = await resp.json().catch(() => ({ error: 'request failed' }));
  if (!resp.ok || j.error) {
    $('#progress').classList.add('hidden');
    if (resp.status === 401 || resp.status === 403) { renderGate(true); }
    else alert(j.error || 'Could not start the run.');
    return;
  }
  setUrl(j.id);
  if (poll) clearInterval(poll);
  poll = setInterval(() => tick(j.id), 1500);
  tick(j.id);
}

// --- Owner gating: only the owner can create runs; anyone can view reports by link. ---
function renderGate(force) {
  const search = $('.search'); if (!search) return;
  let gate = $('#gate');
  if (me.isOwner && !force) { if (gate) gate.remove(); search.classList.remove('locked'); return; }
  search.classList.add('locked');
  if (!gate) {
    gate = el('div', 'gate'); gate.id = 'gate';
    search.appendChild(gate);
  }
  gate.innerHTML = '';
  const msg = me.authenticated
    ? `Signed in as <b>${me.name}</b>, but this account can’t create runs. Reports remain viewable by link.`
    : 'Running a feasibility analysis is restricted to the owner. Anyone can view a report from its link.';
  gate.appendChild(el('p', 'gate-msg', msg));
  const a = el('a', 'signin');
  a.href = '/.auth/login/github?post_login_redirect_uri=' + encodeURIComponent(location.pathname + location.search);
  a.textContent = me.authenticated ? 'Switch account' : 'Sign in with GitHub to run';
  gate.appendChild(a);
}

async function loadMe() {
  try { me = await fetch('/api/me').then(r => r.json()); } catch { me = { authenticated: false, isOwner: true, gated: false }; }
  const go = $('#go');
  if (go) go.disabled = me.gated && !me.isOwner;
  renderGate(false);
}

$('#go').addEventListener('click', () => { const a = $('#addr').value.trim(); if (a) run(a); });
$('#addr').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#go').click(); });
document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { $('#addr').value = c.dataset.a; run(c.dataset.a); }));
window.addEventListener('popstate', () => { const id = deepLinkId(); if (id) openReport(id); });

// Boot: learn who we are (gate the run UI), then open a deep-linked report if the URL has one.
loadMe();
{ const id = deepLinkId(); if (id) openReport(id); }
