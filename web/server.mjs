// Project MOLE web app: serves the SPA, enqueues feasibility jobs, exposes job state,
// and (optionally) pulls run telemetry from Application Insights.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.post('/api/jobs', async (req, res) => {
  try {
    const address = (req.body?.address || '').toString().trim();
    if (address.length < 6) return res.status(400).json({ error: 'Please enter a full street address.' });
    const id = `${slugify(address)}-${Date.now().toString(36)}`;
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

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`[web] listening on ${port}`));
