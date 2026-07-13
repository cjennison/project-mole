#!/usr/bin/env node
// Project MOLE telemetry emitter.
//
// Emits structured progress events for a feasibility run. Sinks:
//   1. JSONL file  -> reports/telemetry/<runId>.jsonl   (always; durable, mount/Blob-friendly)
//   2. stderr line -> "@@MOLE_TELEMETRY {json}"          (always unless MOLE_TELEMETRY_STDERR=0)
//   3. Azure App Insights -> ONLY if APPLICATIONINSIGHTS_CONNECTION_STRING is set (else no-op)
//
// NOTHING about Azure is required to run. The App Insights sink is dormant until a
// connection string exists, so a dashboard can be wired up later with zero code changes.
//
// Module use:   import { emit, step, flush } from './telemetry.mjs'
// CLI use:      node tools/telemetry.mjs <event> [status] [key=value ...]
//   e.g.        node tools/telemetry.mjs report_write ok slug=1341-river-road

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN_ID  = process.env.MOLE_RUN_ID  || randomUUID();
const ADDRESS = process.env.MOLE_ADDRESS || '';
const ROLE    = process.env.MOLE_ROLE    || 'mole-runner';
const STDERR_ON = process.env.MOLE_TELEMETRY_STDERR !== '0';
const DIR  = process.env.MOLE_TELEMETRY_DIR  || join(process.cwd(), 'reports', 'telemetry');
const FILE = process.env.MOLE_TELEMETRY_FILE || join(DIR, `${RUN_ID}.jsonl`);
const AI_CONN = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || '';

let seq = 0;
const pending = [];

function parseConn(cs) {
  const o = {};
  cs.split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return o;
}
function strProps(obj) {
  const o = {};
  for (const [k, v] of Object.entries(obj || {})) o[k] = typeof v === 'string' ? v : JSON.stringify(v);
  return o;
}

// App Insights EventData envelope (correct schema; dormant until a connection string exists).
function toAppInsights(evt) {
  if (!AI_CONN) return;
  const c = parseConn(AI_CONN);
  const iKey = c.InstrumentationKey;
  const endpoint = (c.IngestionEndpoint || 'https://dc.services.visualstudio.com').replace(/\/+$/, '');
  if (!iKey) return;
  const envelope = {
    name: 'Microsoft.ApplicationInsights.Event',
    time: evt.ts,
    iKey,
    tags: { 'ai.operation.id': evt.runId, 'ai.cloud.role': ROLE, 'ai.operation.name': 'feasibility' },
    data: { baseType: 'EventData', baseData: {
      ver: 2, name: evt.event,
      properties: strProps({ status: evt.status, address: evt.address, ...(evt.error ? { error: evt.error } : {}), ...(evt.attributes || {}) }),
      measurements: evt.durationMs != null ? { durationMs: evt.durationMs } : {},
    } },
  };
  const pr = fetch(`${endpoint}/v2/track`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([envelope]),
  }).catch(() => {}); // best-effort, never breaks a run
  pending.push(pr);
}

export function emit(event, { status = 'ok', attributes = {}, durationMs, error } = {}) {
  const evt = {
    runId: RUN_ID, address: process.env.MOLE_ADDRESS || ADDRESS, role: ROLE, event, status,
    ts: new Date().toISOString(), seq: seq++,
    ...(durationMs != null ? { durationMs } : {}),
    ...(error ? { error: String(error && error.message ? error.message : error) } : {}),
    attributes,
  };
  try { mkdirSync(dirname(FILE), { recursive: true }); appendFileSync(FILE, JSON.stringify(evt) + '\n'); } catch {}
  if (STDERR_ON) { try { process.stderr.write('@@MOLE_TELEMETRY ' + JSON.stringify(evt) + '\n'); } catch {} }
  toAppInsights(evt);
  return evt;
}

// Time an async phase and emit start/ok|error around it. Never throws.
export async function step(event, fn, attributes = {}) {
  const t0 = Date.now();
  emit(event, { status: 'start', attributes });
  try {
    const r = await fn();
    emit(event, { status: 'ok', durationMs: Date.now() - t0, attributes });
    return r;
  } catch (e) {
    emit(event, { status: 'error', durationMs: Date.now() - t0, error: e, attributes });
    return undefined;
  }
}

export async function flush() { await Promise.allSettled(pending); }
export const runId = RUN_ID;

// ---- CLI mode ----
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , event, status = 'ok', ...rest] = process.argv;
  if (!event) { console.error('Usage: node telemetry.mjs <event> [status] [key=value ...]'); process.exit(1); }
  const attributes = {};
  for (const kv of rest) { const i = kv.indexOf('='); if (i > 0) attributes[kv.slice(0, i)] = kv.slice(i + 1); }
  emit(event, { status, attributes });
  flush().then(() => process.exit(0));
}
