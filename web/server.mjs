// Project MOLE web app: serves the SPA, enqueues feasibility jobs, exposes job state,
// and (optionally) pulls run telemetry from Application Insights.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { TableClient } from '@azure/data-tables';
import { QueueClient } from '@azure/storage-queue';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const PK = 'job';
let _t, _q;
const table = () => (_t ??= TableClient.fromConnectionString(CONN, 'reports'));
const queue = () => (_q ??= new QueueClient(CONN, 'jobs'));

// --- Owner gate: creating runs is restricted to the owner(s) in MOLE_OWNER (comma-separated,
//     case-insensitive). Identity comes from App Service Easy Auth headers. Viewing reports is public.
//     If MOLE_OWNER is unset, the gate is OPEN (dev/local convenience). ---
const OWNERS = (process.env.MOLE_OWNER || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
function principal(req) {
  // Easy Auth injects these once the user has signed in via /.auth/login/<provider>.
  const name = req.get('x-ms-client-principal-name') || '';
  let claims = [];
  const b64 = req.get('x-ms-client-principal');
  if (b64) {
    try { const p = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); claims = p.claims || []; } catch {}
  }
  return { name, claims };
}
function identityValues(req) {
  const { name, claims } = principal(req);
  const vals = new Set();
  if (name) vals.add(name.toLowerCase());
  for (const c of claims) {
    const t = (c.typ || c.type || '').toLowerCase();
    if (/(email|preferred_username|upn|name|nameidentifier|login)/.test(t) && c.val) vals.add(String(c.val).toLowerCase());
  }
  return vals;
}
function isOwner(req) {
  if (!OWNERS.length) return true; // gate open when no owner configured (local/dev)
  const vals = identityValues(req);
  return OWNERS.some(o => vals.has(o));
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Who am I / may I create runs? Drives the SPA's sign-in gating.
app.get('/api/me', (req, res) => {
  const { name } = principal(req);
  res.json({ authenticated: !!name, name: name || null, isOwner: isOwner(req), gated: OWNERS.length > 0 });
});

app.post('/api/jobs', async (req, res) => {
  try {
    if (!isOwner(req)) {
      const { name } = principal(req);
      return res.status(name ? 403 : 401).json({ error: name ? 'Not authorized to create runs on Project MOLE.' : 'Sign in as the owner to create a run.', authenticated: !!name });
    }
    const address = (req.body?.address || '').toString().trim();
    if (address.length < 6) return res.status(400).json({ error: 'Please enter a full street address.' });
    const id = randomUUID();
    const now = new Date().toISOString();
    await table().upsertEntity({ partitionKey: PK, rowKey: id, address, status: 'queued', phases: '[]', report: '', mapUrl: '', error: '', createdAt: now, updatedAt: now }, 'Replace');
    await queue().sendMessage(Buffer.from(JSON.stringify({ id, address })).toString('base64'));
    res.json({ id, address, status: 'queued' });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/jobs/:id', async (req, res) => {
  try {
    const e = await table().getEntity(PK, req.params.id);
    res.json({
      id: e.rowKey, address: e.address, status: e.status,
      phases: JSON.parse(e.phases || '[]'),
      report: e.report ? JSON.parse(e.report) : null,
      mapUrl: e.mapUrl || '', error: e.error || '',
      createdAt: e.createdAt, updatedAt: e.updatedAt,
    });
  } catch { res.status(404).json({ error: 'not found' }); }
});

// Optional: pull this run's telemetry from Application Insights (proves the AI integration).
app.get('/api/insights/:id', async (req, res) => {
  const appId = process.env.APPINSIGHTS_APP_ID, apiKey = process.env.APPINSIGHTS_API_KEY;
  if (!appId || !apiKey) return res.json({ enabled: false, rows: [] });
  const kql = `customEvents | where operation_Id == '${req.params.id}' | project timestamp, name, status=tostring(customDimensions.status), durationMs=todouble(customMeasurements.durationMs) | order by timestamp asc`;
  try {
    const r = await fetch(`https://api.applicationinsights.io/v1/apps/${appId}/query?query=${encodeURIComponent(kql)}`, { headers: { 'x-api-key': apiKey } });
    const d = await r.json();
    const t = d.tables?.[0];
    const rows = (t?.rows || []).map(row => Object.fromEntries(t.columns.map((c, i) => [c.name, row[i]])));
    res.json({ enabled: true, rows });
  } catch (e) { res.json({ enabled: true, rows: [], error: String(e.message || e) }); }
});

// Deep-link: serve the SPA for /r/<id> so a report URL opens directly (and survives refresh).
app.get('/r/:id', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`[web] listening on ${port}`));
