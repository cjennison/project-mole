// Aerial vision analysis via Azure OpenAI (GPT-5 vision).
// analyzeAerial(pngBuffer, ctx) -> { features[], adu{x,y,rationale,obstaclesAvoided}, concerns[], summary }
// Coordinates are normalized image space: x 0..1 left→right, y 0..1 top→bottom.
// No-op (returns null) if AZURE_OPENAI_* env is not set.

const ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const KEY = process.env.AZURE_OPENAI_KEY;
const DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5.4';
const API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2025-04-01-preview';

const SYSTEM = `You are a site-planning assistant analyzing an aerial photo of a residential property to decide where a new ~30 ft x 30 ft (900 sq ft) Accessory Dwelling Unit (ADU) can PRACTICALLY be built.
The subject parcel is outlined in YELLOW. Only consider space INSIDE the yellow outline.
Identify what already occupies the lot and would constrain an ADU: the existing house, swimming pool, driveway/paved areas, sheds/outbuildings, dense tree/forest cover, water or wetland, and open cleared lawn.
Then choose the single best location for the ADU: an open, relatively clear area inside the parcel that AVOIDS the pool, the house (keep a few feet away), the driveway, and minimizes tree removal, and is not in the front yard between the house and the street.
Respond with STRICT JSON only, no prose, matching this schema:
{
  "features": [ { "label": "house|pool|driveway|shed|forest|open_lawn|water|other", "description": "short", "x": 0.0, "y": 0.0 } ],
  "adu": { "x": 0.0, "y": 0.0, "rationale": "why here", "obstaclesAvoided": ["pool", "..."] },
  "concerns": ["short caveats a human should verify"],
  "summary": "2-3 sentence plain-English description of the lot and the recommendation"
}
Coordinates x,y are fractions of the image: x=0 left edge, x=1 right edge, y=0 top edge, y=1 bottom edge. Put the ADU center at adu.x/adu.y, inside the yellow parcel and inside any open area you found.`;

async function analyzeAerial(pngBuffer, ctx = {}) {
  if (!ENDPOINT || !KEY) return null;
  const dataUrl = 'data:image/png;base64,' + Buffer.from(pngBuffer).toString('base64');
  const userText = `Analyze this aerial. Parcel is ~${ctx.lotSqFt ? Math.round(ctx.lotSqFt).toLocaleString() : '?'} sq ft (${ctx.acres ?? '?'} ac).`
    + (ctx.frontNote ? ` ${ctx.frontNote}` : '')
    + ` Find obstacles and recommend the ADU location as normalized image coordinates.`;
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
