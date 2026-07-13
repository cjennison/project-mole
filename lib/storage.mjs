// Shared Azure storage helpers (Table = job state/NoSQL, Blob = maps/reports, Queue = jobs).
// All gated on AZURE_STORAGE_CONNECTION_STRING; throws clearly if missing.
import { TableClient } from '@azure/data-tables';
import { BlobServiceClient } from '@azure/storage-blob';
import { QueueClient } from '@azure/storage-queue';

const CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
if (!CONN) console.warn('[storage] AZURE_STORAGE_CONNECTION_STRING not set');

const TABLE = 'reports';
const CONTAINER = 'reports';
const QUEUE = 'jobs';

let _table, _blob, _queue;
export const table = () => (_table ??= TableClient.fromConnectionString(CONN, TABLE, { allowInsecureConnection: false }));
export const container = () => (_blob ??= BlobServiceClient.fromConnectionString(CONN).getContainerClient(CONTAINER));
export const queue = () => (_queue ??= new QueueClient(CONN, QUEUE));

const PK = 'job';

export async function ensure() {
  await table().createTable().catch(() => {});
  await container().createIfNotExists({ access: 'blob' }).catch(() => {});
  await queue().createIfNotExists().catch(() => {});
}

export async function createJob(id, address) {
  const now = new Date().toISOString();
  await table().upsertEntity({
    partitionKey: PK, rowKey: id, address, status: 'queued',
    phases: '[]', report: '', mapUrl: '', error: '', createdAt: now, updatedAt: now,
  }, 'Replace');
  await queue().sendMessage(Buffer.from(JSON.stringify({ id, address })).toString('base64'));
  return id;
}

export async function getJob(id) {
  try {
    const e = await table().getEntity(PK, id);
    return {
      id: e.rowKey, address: e.address, status: e.status,
      phases: JSON.parse(e.phases || '[]'),
      report: e.report ? JSON.parse(e.report) : null,
      mapUrl: e.mapUrl || '', error: e.error || '',
      createdAt: e.createdAt, updatedAt: e.updatedAt,
    };
  } catch { return null; }
}

export async function patchJob(id, fields) {
  const patch = { partitionKey: PK, rowKey: id, updatedAt: new Date().toISOString(), ...fields };
  if (fields.phases && typeof fields.phases !== 'string') patch.phases = JSON.stringify(fields.phases);
  if (fields.report && typeof fields.report !== 'string') patch.report = JSON.stringify(fields.report);
  await table().updateEntity(patch, 'Merge');
}

export async function appendPhase(id, phase) {
  const job = await getJob(id);
  const phases = job?.phases || [];
  phases.push({ ...phase, at: new Date().toISOString() });
  await patchJob(id, { phases: JSON.stringify(phases), status: 'processing' });
  return phases;
}

export async function uploadBlob(name, content, contentType) {
  const b = container().getBlockBlobClient(name);
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  await b.uploadData(body, { blobHTTPHeaders: { blobContentType: contentType } });
  return b.url;
}

// Queue receive/delete for the worker.
export async function receiveOne() {
  const r = await queue().receiveMessages({ numberOfMessages: 1, visibilityTimeout: 300 });
  const m = r.receivedMessageItems[0];
  if (!m) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(m.messageText, 'base64').toString('utf8')); }
  catch { payload = JSON.parse(m.messageText); }
  return { msg: m, payload };
}
export async function deleteMessage(m) { await queue().deleteMessage(m.messageId, m.popReceipt); }
export async function queueDepth() {
  const p = await queue().getProperties();
  return p.approximateMessagesCount ?? 0;
}
