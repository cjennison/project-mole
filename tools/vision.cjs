// Aerial vision analysis via Azure OpenAI (GPT-5 vision).
// analyzeAerial(pngBuffer, ctx) -> { features[], adu{x,y,rationale,obstaclesAvoided}, concerns[], summary }
// Coordinates are normalized image space: x 0..1 left→right, y 0..1 top→bottom.
// No-op (returns null) if AZURE_OPENAI_* env is not set.

const ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const KEY = process.env.AZURE_OPENAI_KEY;
const DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5.4';
const API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2025-04-01-preview';

const SYSTEM = `You are a site-planning assistant analyzing an aerial photo of a residential property to decide where a new ~30 ft x 30 ft (900 sq ft) Accessory Dwelling Unit (ADU) can PRACTICALLY be built.
The subject parcel is outlined in YELLOW and a labeled GRID of white cells (like A1, B2, C3) is drawn ONLY over the buildable interior of that parcel. Everything OUTSIDE the parcel is darkened — ignore it entirely.
Look carefully at what is UNDER each grid cell in the photo. Classify the ground in each cell as one of: open/cleared lawn or dirt, tree/forest canopy, building/house roof, swimming pool, driveway/pavement, or water.
Choose the SINGLE best grid cell for the ADU: it must be OPEN CLEARED GROUND (NOT under tree canopy), avoid the house/pool/driveway, not be in the front yard between the house and the street, and require the least tree removal. If NO cell is genuinely open, pick the least-treed cell and say so in concerns.
Respond with STRICT JSON only:
{
  "adu": { "cell": "C2", "rationale": "why this cell", "isOpenGround": true },
  "cells": { "A1": "forest", "B2": "open_lawn", "C2": "open_lawn", "...": "pool|house|driveway|forest|open_lawn|water" },
  "features": [ { "label": "house|pool|driveway|forest|open_lawn|water", "cell": "B2" } ],
  "concerns": ["short caveats a human must verify"],
  "summary": "2-3 sentences: describe the lot and why the chosen cell is the best practical ADU spot"
}
Pick adu.cell from the labels actually drawn on the image. Base it on what you SEE under that cell, not assumptions.`;

async function analyzeAerial(pngBuffer, ctx = {}) {
  if (!ENDPOINT || !KEY) return null;
  const dataUrl = 'data:image/png;base64,' + Buffer.from(pngBuffer).toString('base64');
  const userText = `Analyze this aerial with the labeled grid. Parcel is ~${ctx.lotSqFt ? Math.round(ctx.lotSqFt).toLocaleString() : '?'} sq ft (${ctx.acres ?? '?'} ac).`
    + ` Look at what is under each grid cell and pick the best OPEN, cleared cell for the ADU (avoid trees, pool, house, driveway, front yard).`;
  const body = {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: [ { type: 'text', text: userText }, { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } } ] },
    ],
    response_format: { type: 'json_object' },
    max_completion_tokens: 4000,
  };
  const url = `${ENDPOINT.replace(/\/$/, '')}/openai/deployments/${DEPLOYMENT}/chat/completions?api-version=${API_VERSION}`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'api-key': KEY }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Azure OpenAI HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  const content = d.choices?.[0]?.message?.content;
  if (!content) throw new Error('no content from model');
  return JSON.parse(content);
}

module.exports = { analyzeAerial };

// CLI: node tools/vision.cjs <pngPath> [lotSqFt]
if (require.main === module) {
  (async () => {
    const fs = require('node:fs');
    const png = process.argv[2] || 'reports/_aerial1325.png';
    const buf = fs.readFileSync(png);
    try { const out = await analyzeAerial(buf, { lotSqFt: Number(process.argv[3]) || undefined }); console.log(JSON.stringify(out, null, 2)); }
    catch (e) { console.error('vision error:', e.message); process.exit(1); }
  })();
}
