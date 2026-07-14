#!/usr/bin/env node
// Project MOLE — "engineering site plan" ADU placement (v3, redesigned).
//
// The old approach painted a pixel-classifier tint straight onto the Esri aerial and let color
// thresholds pick the ADU spot — which put the ADU on a pool house / pool deck because it could
// not tell a smooth tan deck from open ground.
//
// New approach (what the user asked for): treat the aerial ONLY as evidence. For every grid cell
// on the PARCEL, decide one thing — is this cell a genuine CLEARING (buildable open ground) or is
// it an OBSTRUCTION (something is in the way: tree canopy, a roof, pavement, water/pool, a deck)?
// We do NOT need to know what the obstruction is. Then we draw a clean, gridded ENGINEERING
// property map that marks the fixtures/clearings, place the ADU in the best clearing near the
// house, and render a side-by-side proof against the aerial.
//
// Usage:
//   node tools/siteplan.cjs "<address>" [outPng] [--debug]
//     --debug also writes <base>-classify.png (per-cell class overlaid on the aerial) for tuning.

const fs = require('node:fs');
const path = require('node:path');
const turf = require('@turf/turf');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
try {
  for (const p of ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf']) {
    if (fs.existsSync(p)) GlobalFonts.registerFromPath(p, 'sans-serif');
  }
} catch {}
let emit = () => {}, flush = async () => {};

const ADDRESS = process.argv[2];
if (!ADDRESS) { console.error('Usage: node tools/siteplan.cjs "<address>" [out.png] [--debug]'); process.exit(1); }
const SLUG = ADDRESS.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const DEBUG = process.argv.includes('--debug');
const OUT = (process.argv[3] && !process.argv[3].startsWith('--')) ? process.argv[3] : path.join(process.cwd(), 'reports', `${SLUG}-plan.png`);

const j = async (url) => { const r = await fetch(url, { headers: { 'User-Agent': 'project-mole/1.0' } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

const GRANIT = 'https://nhgeodata.unh.edu/nhgeodata/rest/services/CAD/ParcelMosaic/MapServer';
const ATLAS = 'https://services1.arcgis.com/aguSsLS841Hp3EC4/ArcGIS/rest/services/NH_Atlas_Zoning_Districts_Buildable/FeatureServer/0';
const TIGER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer';
const STRUCT = 'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0';
const TILES = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile';

const D2R = Math.PI / 180;
const globalPx = (lon, lat, z) => { const n = 256 * 2 ** z; const s = Math.sin(lat * D2R); return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n]; };
const mppAt = (lat, z) => 156543.03392 * Math.cos(lat * D2R) / 2 ** z;
async function fetchTile(z, x, y) {
  const r = await fetch(`${TILES}/${z}/${y}/${x}`, { headers: { 'User-Agent': 'project-mole/1.0' } });
  const ct = r.headers.get('content-type') || '';
  if (!r.ok || !/image\//.test(ct)) throw new Error(`tile ${z}/${y}/${x} ${r.status} ${ct}`);
  return loadImage(Buffer.from(await r.arrayBuffer()));
}

async function geocode(addr) {
  const u = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${qs({ address: addr, benchmark: 'Public_AR_Current', format: 'json' })}`;
  const m = (await j(u)).result?.addressMatches?.[0];
  if (!m) throw new Error('no geocode');
  return { lon: m.coordinates.x, lat: m.coordinates.y, matched: m.matchedAddress };
}
async function parcelPoly(gc) {
  const parts = (gc.matched || ADDRESS).split(',').map(s => s.trim());
  const street = (parts[0] || '').toUpperCase(), town = (parts[1] || '').toUpperCase();
  const run = async (where) => (await j(`${GRANIT}/1/query?${qs({ where, outFields: 'PID,StreetAddress', returnGeometry: 'true', outSR: 4326, f: 'json' })}`)).features || [];
  let feats = await run(`StreetAddress='${street}' AND Town='${town}'`);
  if (!feats.length) { const n = (street.match(/^\d+/) || [])[0]; if (n) feats = await run(`StreetAddress LIKE '${n} %' AND Town='${town}'`); }
  const f = feats[0];
  if (!f?.geometry?.rings) throw new Error('no parcel geometry');
  return { poly: turf.polygon(f.geometry.rings), pid: f.attributes.PID, addr: f.attributes.StreetAddress };
}
async function setbacks(center) {
  const run = async (geom, type) => (await j(`${ATLAS}/query?${qs({ geometry: geom, geometryType: type, inSR: 4326, spatialRel: 'esriSpatialRelIntersects', outFields: '*', returnGeometry: 'false', f: 'json' })}`)).features || [];
  let f = (await run(`${center[0]},${center[1]}`, 'esriGeometryPoint'))[0];
  const a = f?.attributes || {};
  const num = (v, d) => (v == null || v === '' ? d : Number(v));
  return {
    district: a.AbbreviatedDistrict || 'unknown',
    front: num(a.F1_Family_Front_Setback____of_feet_, 25),
    side: num(a.F1_Family_Side_Setback____of_feet_, 20),
    rear: num(a.F1_Family_Rear_Setback____of_feet_, 30),
    aduMaxSqFt: num(a.ADU_Max_Size__SF_, 900),
  };
}
async function roadsNear(center) {
  try {
    const rd = (await j(`${TIGER}/8/query?${qs({ geometry: `${center[0]},${center[1]}`, geometryType: 'esriGeometryPoint', inSR: 4326, distance: 220, units: 'esriSRUnit_Meter', spatialRel: 'esriSpatialRelIntersects', outFields: 'NAME', returnGeometry: 'true', outSR: 4326, f: 'json' })}`)).features || [];
    return rd.map(r => { try { return turf.lineString(r.geometry.paths[0]); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
async function buildingsOn(poly, center) {
  try {
    const bs = (await j(`${STRUCT}/query?${qs({ geometry: `${center[0]},${center[1]}`, geometryType: 'esriGeometryPoint', inSR: 4326, distance: 120, units: 'esriSRUnit_Meter', spatialRel: 'esriSpatialRelIntersects', outFields: 'BUILD_ID', returnGeometry: 'true', outSR: 4326, f: 'json' })}`)).features || [];
    return bs.map(b => { try { return turf.polygon(b.geometry.rings); } catch { return null; } })
             .filter(Boolean).filter(bp => turf.booleanIntersects(bp, poly));
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Per-cell classification. The ONLY question we answer: clearing vs obstruction.
// Classes: 'clearing' | 'tree' | 'structure' | 'water'  (last three = obstruction).
// Features per cell: mean RGB, brightness, green-excess (vegetation), warmth (R-B),
// saturation, and TEXTURE (std-dev of pixel brightness — trees/edges are rough, lawn/deck smooth).
// ---------------------------------------------------------------------------
function classifyCell(data) {
  // data: Uint8ClampedArray RGBA for the cell
  let n = 0, sR = 0, sG = 0, sB = 0;
  const bri = [];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    sR += r; sG += g; sB += b;
    bri.push((r + g + b) / 3);
    n++;
  }
  if (!n) return { kind: 'clearing', f: {} };
  const mR = sR / n, mG = sG / n, mB = sB / n, bright = (mR + mG + mB) / 3;
  const gEx = mG - (mR + mB) / 2;          // >0 vegetation
  const warm = mR - mB;                     // >0 warm (dirt/dry grass/red roof)
  const sat = Math.max(mR, mG, mB) - Math.min(mR, mG, mB);
  let mean = 0; for (const v of bri) mean += v; mean /= bri.length;
  let varr = 0; for (const v of bri) varr += (v - mean) * (v - mean); varr /= bri.length;
  const tex = Math.sqrt(varr);              // texture (std dev of brightness)
  const f = { mR: +mR.toFixed(1), mG: +mG.toFixed(1), mB: +mB.toFixed(1), bright: +bright.toFixed(1), gEx: +gEx.toFixed(1), warm: +warm.toFixed(1), sat: +sat.toFixed(1), tex: +tex.toFixed(1) };

  // Empirically-tuned separators (validated on 1325 River Rd, Manchester NH):
  //   trees        -> DARK (bright<80) AND green (gEx high), or near-black shadow
  //   dry clearing -> very WARM (R-B large) with gEx≈0, moderate brightness, SMOOTH (low tex)
  //   green lawn   -> green (gEx>8) but BRIGHT (>80)
  //   red roof     -> strong red dominance (R-G>28) AND gEx very negative
  //   pavement/roof-> low-saturation gray, high-texture ridges/edges, or bright gray
  //   water/pool   -> blue is max and the cell is COOL (warm<0)

  // 1) Water / pool: blue dominant & cool (dark navy OR turquoise).
  if (mB >= mR && mB >= mG - 2 && warm < -4 && bright < 175) return { kind: 'water', f };

  // 2) Near-black = deep shadow / dense canopy -> obstruction.
  if (bright < 42) return { kind: 'tree', f };

  // 3) Tree canopy: green & dark, or dense mid-green that isn't warm (dry ground is warm; canopy isn't).
  if (gEx > 8 && bright < 80) return { kind: 'tree', f };
  if (gEx > 14 && warm < 12 && bright < 115) return { kind: 'tree', f };

  // 4) Structure / impervious (roof, pavement, deck) — the ADU must avoid these.
  if ((mR - mG) > 28 && gEx < -8) return { kind: 'structure', f };        // strong red/orange roof
  if (tex >= 30 && gEx < 10) return { kind: 'structure', f };             // rough non-veg (roof ridges/edges)
  if (bright > 150 && sat < 26) return { kind: 'structure', f };          // bright light roof
  if (sat < 18 && gEx < 6 && bright > 60) return { kind: 'structure', f }; // gray pavement/asphalt

  // 5) Everything else = clearing: open ground — warm dry/bare ground OR bright green lawn.
  return { kind: 'clearing', f };
}

const OBSTRUCTION = new Set(['tree', 'structure', 'water']);
const CLASS_COLOR = { clearing: '#38b000', tree: '#1b5e20', structure: '#9e9e9e', water: '#1e88e5' };
const CLASS_TINT = { clearing: 'rgba(56,176,0,0.30)', tree: 'rgba(20,70,20,0.45)', structure: 'rgba(150,150,150,0.55)', water: 'rgba(30,136,229,0.55)' };

(async () => {
  try { const t = await import('./telemetry.mjs'); emit = t.emit; flush = t.flush; } catch {}
  const t0 = Date.now();
  emit('sitemap', { status: 'start', attributes: { address: ADDRESS } });
  const out = { address: ADDRESS, png: OUT };
  try {
    const gc = await geocode(ADDRESS);
    const { poly, pid, addr } = await parcelPoly(gc);
    const center = turf.centroid(poly).geometry.coordinates;
    const sb = await setbacks(center);
    const roads = await roadsNear(center);
    const buildings = await buildingsOn(poly, center);
    out.pid = pid; out.district = sb.district;
    out.lotAreaSqFt = Math.round(turf.area(poly) * 10.7639);

    // --- Buildable envelope: per-edge setbacks (front = nearest road) ---
    const ring = poly.geometry.coordinates[0];
    const edges = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const mid = turf.midpoint(turf.point(ring[i]), turf.point(ring[i + 1]));
      let dRoad = Infinity;
      for (const rl of roads) { const d = turf.pointToLineDistance(mid, rl, { units: 'feet' }); if (d < dRoad) dRoad = d; }
      edges.push({ i, a: ring[i], b: ring[i + 1], mid, dRoad, len: turf.distance(turf.point(ring[i]), turf.point(ring[i + 1]), { units: 'feet' }) });
    }
    let frontIdx = roads.length ? edges.reduce((m, e) => e.dRoad < edges[m].dRoad ? e.i : m, 0)
                                : edges.reduce((m, e) => e.len > edges[m].len ? e.i : m, 0);
    const frontMid = edges[frontIdx].mid;
    const rearIdx = edges.reduce((m, e) => turf.distance(e.mid, frontMid, { units: 'feet' }) > turf.distance(edges[m].mid, frontMid, { units: 'feet' }) ? e.i : m, 0);
    const setbackFor = (i) => (i === frontIdx ? sb.front : i === rearIdx ? sb.rear : sb.side);
    const diff = (a, b) => { try { return turf.difference(turf.featureCollection([a, b])); } catch { return a; } };
    const pieces = (g) => { if (!g) return []; if (g.geometry.type === 'Polygon') return [g]; return g.geometry.coordinates.map(c => turf.polygon(c)); };
    let envelope = poly;
    for (const e of edges) { const s = setbackFor(e.i); if (!s) continue; const strip = turf.buffer(turf.lineString([e.a, e.b]), s, { units: 'feet' }); if (strip) envelope = diff(envelope, strip) || envelope; }
    const envPieces = pieces(envelope).filter(p => turf.area(p) > 2);
    out.buildableAreaSqFt = Math.round(envPieces.reduce((s, p) => s + turf.area(p), 0) * 10.7639);
    const buildable = envPieces.sort((a, b) => turf.area(b) - turf.area(a))[0] || poly;

    // --- Fetch a dedicated high-zoom aerial canvas over the parcel (z19) ---
    const [minLon, minLat, maxLon, maxLat] = turf.bbox(poly);
    const padLon = (maxLon - minLon) * 0.12, padLat = (maxLat - minLat) * 0.12;
    const bb = { minLon: minLon - padLon, minLat: minLat - padLat, maxLon: maxLon + padLon, maxLat: maxLat + padLat };
    const z = 19;
    const [gx0, gy0] = globalPx(bb.minLon, bb.maxLat, z), [gx1, gy1] = globalPx(bb.maxLon, bb.minLat, z);
    const tx0 = Math.floor(gx0 / 256), tx1 = Math.floor(gx1 / 256), ty0 = Math.floor(gy0 / 256), ty1 = Math.floor(gy1 / 256);
    const W = (tx1 - tx0 + 1) * 256, H = (ty1 - ty0 + 1) * 256, oX = tx0 * 256, oY = ty0 * 256;
    const aerial = createCanvas(W, H), actx = aerial.getContext('2d');
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) actx.drawImage(await fetchTile(z, tx, ty), (tx - tx0) * 256, (ty - ty0) * 256, 256, 256);
    const toPx = (lon, lat) => { const [gx, gy] = globalPx(lon, lat, z); return [gx - oX, gy - oY]; };
    const fromPx = (px, py) => { const n = 256 * 2 ** z; return [(px + oX) / n * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * (py + oY) / n))) * 180 / Math.PI]; };
    const mpp = mppAt(center[1], z);

    // --- Grid the parcel and classify each cell (clearing vs obstruction) ---
    const CELL_FT = 15;                                   // fine grid for placement resolution
    const cellPx = (CELL_FT * 0.3048) / mpp;
    const ringPx = ring.map(c => toPx(c[0], c[1]));
    const pminX = Math.min(...ringPx.map(p => p[0])), pmaxX = Math.max(...ringPx.map(p => p[0]));
    const pminY = Math.min(...ringPx.map(p => p[1])), pmaxY = Math.max(...ringPx.map(p => p[1]));
    emit('vision', { status: 'start' });
    const colLabel = (n) => { let s = ''; n += 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
    const cellByLabel = {};
    const cells = [];
    let ci = 0;
    for (let gx = pminX; gx < pmaxX; gx += cellPx, ci++) {
      let ri = 0;
      for (let gy = pminY; gy < pmaxY; gy += cellPx, ri++) {
        const cxp = gx + cellPx / 2, cyp = gy + cellPx / 2;
        const [lon, lat] = fromPx(cxp, cyp);
        if (!turf.booleanPointInPolygon(turf.point([lon, lat]), poly)) continue;
        const w = Math.max(1, Math.min(Math.floor(cellPx), W - Math.floor(gx)));
        const h = Math.max(1, Math.min(Math.floor(cellPx), H - Math.floor(gy)));
        const img = actx.getImageData(Math.max(0, Math.floor(gx)), Math.max(0, Math.floor(gy)), w, h).data;
        const { kind, f } = classifyCell(img);
        const label = colLabel(ci) + (ri + 1);
        const cell = { label, col: ci, row: ri, gx, gy, cxp, cyp, ll: [lon, lat], kind, f };
        cells.push(cell); cellByLabel[label] = cell;
      }
    }
    out.classCounts = cells.reduce((a, c) => (a[c.kind] = (a[c.kind] || 0) + 1, a), {});
    emit('vision', { status: 'ok', attributes: { classZoom: z, cells: cells.length, ...out.classCounts } });

    // --- Place the ADU: largest 30x30 ft footprint that sits ONLY on clearing cells, inside the
    //     buildable envelope, clear of obstruction cells, chosen NEAREST the house. -----------------
    const houseAnchor = buildings.length
      ? turf.centroid(buildings.sort((a, b) => turf.area(b) - turf.area(a))[0])
      : turf.point([gc.lon, gc.lat]);
    const aduSideFt = Math.sqrt(Math.min(sb.aduMaxSqFt || 900, 900)); // ~30 ft
    const halfDiag = (aduSideFt / 2) * Math.SQRT2;
    // Align ADU to the parcel's principal axis.
    const principalBearing = (() => { let b = 0, best = -1; for (let i = 0; i < ring.length - 1; i++) { const d = turf.distance(turf.point(ring[i]), turf.point(ring[i + 1]), { units: 'feet' }); if (d > best) { best = d; b = turf.bearing(turf.point(ring[i]), turf.point(ring[i + 1])); } } return ((b % 90) + 90) % 90; })();
    out.aduRotationDeg = +principalBearing.toFixed(1);
    const mkBox = (ll) => turf.polygon([[45, 135, 225, 315, 45].map(bd => turf.destination(turf.point(ll), halfDiag, bd + principalBearing, { units: 'feet' }).geometry.coordinates)]);

    const obstrCells = cells.filter(c => OBSTRUCTION.has(c.kind));
    const clearingCells = cells.filter(c => c.kind === 'clearing');
    const nearAny = (ll, arr, ft) => arr.some(c => turf.distance(turf.point(ll), turf.point(c.ll), { units: 'feet' }) < ft);

    // --- Effective ADU-eligible area: ALL open CLEARING ground inside the buildable envelope,
    //     dissolved into one polygon (holes = obstructions). This is the WHOLE usable region — the
    //     ADU can be sited anywhere within it — shown with its total square footage. ---------------
    const cellSquare = (ll) => {
      const h = (CELL_FT * 1.06) / 2, p = turf.point(ll);
      const nLat = turf.destination(p, h, 0, { units: 'feet' }).geometry.coordinates[1];
      const sLat = turf.destination(p, h, 180, { units: 'feet' }).geometry.coordinates[1];
      const eLon = turf.destination(p, h, 90, { units: 'feet' }).geometry.coordinates[0];
      const wLon = turf.destination(p, h, 270, { units: 'feet' }).geometry.coordinates[0];
      return turf.polygon([[[wLon, nLat], [eLon, nLat], [eLon, sLat], [wLon, sLat], [wLon, nLat]]]);
    };
    const eligibleCells = clearingCells.filter(c => turf.booleanPointInPolygon(turf.point(c.ll), buildable));
    let effectiveArea = null, effectivePieces = [];
    if (eligibleCells.length) {
      try {
        const squares = eligibleCells.map(c => cellSquare(c.ll));
        effectiveArea = squares.length === 1 ? squares[0] : turf.union(turf.featureCollection(squares));
        if (effectiveArea) { try { effectiveArea = turf.intersect(turf.featureCollection([effectiveArea, buildable])) || effectiveArea; } catch {} }
      } catch (e) { effectiveArea = null; out.effectiveAreaError = String(e.message || e); }
      const pcs = !effectiveArea ? [] : (effectiveArea.geometry.type === 'Polygon' ? [effectiveArea] : effectiveArea.geometry.coordinates.map(c => turf.polygon(c)));
      effectivePieces = pcs.filter(p => turf.area(p) * 10.7639 > 120).sort((a, b) => turf.area(b) - turf.area(a));
    }
    out.effectiveAreaSqFt = Math.round(effectivePieces.reduce((s, p) => s + turf.area(p), 0) * 10.7639);
    out.effectiveAreaCount = effectivePieces.length;
    // Box footprint (grown by `padFt` for separation) must contain no obstruction cell centers.
    const mkBoxExp = (ll, extraFt) => { const hd = ((aduSideFt + 2 * extraFt) / 2) * Math.SQRT2; return turf.polygon([[45, 135, 225, 315, 45].map(bd => turf.destination(turf.point(ll), hd, bd + principalBearing, { units: 'feet' }).geometry.coordinates)]); };
    const footprintClear = (ll, padFt) => {
      const box = mkBoxExp(ll, padFt);
      for (const c of cells) { if (OBSTRUCTION.has(c.kind) && turf.booleanPointInPolygon(turf.point(c.ll), box)) return false; }
      return true;
    };
    const bbx = turf.bbox(buildable);
    const search = (obFt, padFt, N) => {
      let best = null, bestD = Infinity;
      for (let ix = 0; ix <= N; ix++) for (let iy = 0; iy <= N; iy++) {
        const ll = [bbx[0] + (bbx[2] - bbx[0]) * ix / N, bbx[1] + (bbx[3] - bbx[1]) * iy / N];
        const ctr = turf.point(ll);
        if (!turf.booleanPointInPolygon(ctr, buildable)) continue;
        if (nearAny(ll, obstrCells, obFt)) continue;                 // keep clear of any obstruction cell
        if (!footprintClear(ll, padFt)) continue;                    // footprint (+pad) sits only on clearings
        const box = mkBox(ll);
        if (!box.geometry.coordinates[0].every(p => turf.booleanPointInPolygon(turf.point(p), buildable))) continue;
        const d = turf.distance(ctr, houseAnchor, { units: 'feet' });  // nearest the house wins
        if (d < bestD) { bestD = d; best = box; }
      }
      return best;
    };
    // Prefer a generous clearance + separation from obstructions; relax if nothing fits.
    let aduBox = null, usedClear = 0, aduSource = 'local-classifier';
    for (const [ob, pad] of [[24, 8], [20, 6], [16, 4], [12, 0]]) { aduBox = search(ob, pad, 64); if (aduBox) { usedClear = ob; break; } }

    // --- Agent self-correction hook: MOLE_ADU_HINT = "<cell label e.g. O8>" or "lon,lat".
    //     After LOOKING at the grid image, the Copilot CLI agent can move the ADU to a cell it can
    //     see is open. We snap the hint to the nearest spot where a full box fits on clearings. ---
    if (process.env.MOLE_ADU_HINT) {
      try {
        const raw = process.env.MOLE_ADU_HINT.trim();
        let pt = null;
        const m = raw.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
        if (m) pt = [parseFloat(m[1]), parseFloat(m[2])];
        else if (cellByLabel[raw.toUpperCase()]) pt = cellByLabel[raw.toUpperCase()].ll;
        if (pt) {
          const fits = (ll) => turf.booleanPointInPolygon(turf.point(ll), buildable)
            && footprintClear(ll, 4)
            && mkBox(ll).geometry.coordinates[0].every(p => turf.booleanPointInPolygon(turf.point(p), buildable));
          let target = fits(pt) ? pt : null;
          if (!target) {
            let bD = Infinity;
            for (let ix = 0; ix <= 64; ix++) for (let iy = 0; iy <= 64; iy++) {
              const ll = [bbx[0] + (bbx[2] - bbx[0]) * ix / 64, bbx[1] + (bbx[3] - bbx[1]) * iy / 64];
              if (!fits(ll)) continue;
              const d = turf.distance(turf.point(ll), turf.point(pt), { units: 'feet' });
              if (d < bD) { bD = d; target = ll; }
            }
          }
          if (target) { aduBox = mkBox(target); aduSource = 'agent-corrected'; out.aduHint = raw; }
          else out.aduHintError = 'hint has no fitting box on clearings inside the buildable envelope';
        } else out.aduHintError = 'could not parse MOLE_ADU_HINT (use "lon,lat" or a cell label)';
      } catch (e) { out.aduHintError = String(e.message || e); }
    }
    out.aduSource = aduSource;
    out.aduFitsSqFt = aduBox ? Math.round(aduSideFt * aduSideFt) : 0;
    out.aduClearanceFt = usedClear;
    if (aduBox) out.aduCenter = turf.centroid(aduBox).geometry.coordinates.map(v => +v.toFixed(6));

    // Which grid cell the ADU landed in (nearest cell center).
    if (aduBox) {
      const ac = turf.centroid(aduBox).geometry.coordinates;
      let bc = null, bd = Infinity;
      for (const c of cells) { const d = turf.distance(turf.point(ac), turf.point(c.ll), { units: 'feet' }); if (d < bd) { bd = d; bc = c; } }
      out.aduCell = bc ? bc.label : null;
    }

    // ---------------- RENDER: side-by-side [engineering schematic | aerial proof] ----------------
    const panelW = W, panelH = H, gap = 16, headH = 54;
    const cv = createCanvas(panelW * 2 + gap, panelH + headH); const ctx = cv.getContext('2d');
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, cv.width, cv.height);

    // Header
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.font = 'bold 20px sans-serif';
    ctx.fillText(`Site plan — ${addr || ADDRESS}`, 14, 24);
    ctx.font = '13px sans-serif'; ctx.fillStyle = '#c9d1d9';
    ctx.fillText(`PID ${pid} · ${sb.district} · setbacks F${sb.front}/S${sb.side}/R${sb.rear}ft · buildable ≈ ${out.buildableAreaSqFt.toLocaleString()} sf · ADU-eligible open ≈ ${out.effectiveAreaSqFt.toLocaleString()} sf of ${out.lotAreaSqFt.toLocaleString()} sf lot · grid ${CELL_FT}ft`, 14, 44);

    // Panel drawing helpers (offset x)
    const drawPanel = (ox, mode) => {
      // mode: 'schematic' | 'aerial'
      if (mode === 'aerial') {
        ctx.drawImage(aerial, ox, headH);
        // dim outside parcel
        ctx.save(); ctx.beginPath(); ctx.rect(ox, headH, panelW, panelH);
        ring.forEach((c, i) => { const [x, y] = toPx(c[0], c[1]); i ? ctx.lineTo(ox + x, headH + y) : ctx.moveTo(ox + x, headH + y); });
        ctx.closePath(); ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fill('evenodd'); ctx.restore();
      } else {
        // schematic background
        ctx.fillStyle = '#101822'; ctx.fillRect(ox, headH, panelW, panelH);
        // parcel fill
        ctx.save(); ctx.beginPath(); ring.forEach((c, i) => { const [x, y] = toPx(c[0], c[1]); i ? ctx.lineTo(ox + x, headH + y) : ctx.moveTo(ox + x, headH + y); }); ctx.closePath();
        ctx.fillStyle = '#16202b'; ctx.fill(); ctx.restore();
      }
      // per-cell class squares
      for (const c of cells) {
        const [px, py] = toPx(c.ll[0], c.ll[1]);
        const x = ox + px - cellPx / 2, y = headH + py - cellPx / 2;
        if (mode === 'schematic') { ctx.fillStyle = CLASS_COLOR[c.kind]; ctx.fillRect(x, y, cellPx + 0.8, cellPx + 0.8); }
        else if (c.kind !== 'clearing') { ctx.fillStyle = CLASS_TINT[c.kind]; ctx.fillRect(x, y, cellPx + 0.8, cellPx + 0.8); }
        ctx.strokeStyle = mode === 'schematic' ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.18)'; ctx.lineWidth = 0.5; ctx.strokeRect(x, y, cellPx, cellPx);
      }
      // parcel + buildable outline
      ctx.strokeStyle = '#ffe100'; ctx.lineWidth = 3; ctx.beginPath(); ring.forEach((c, i) => { const [x, y] = toPx(c[0], c[1]); i ? ctx.lineTo(ox + x, headH + y) : ctx.moveTo(ox + x, headH + y); }); ctx.closePath(); ctx.stroke();
      for (const p of envPieces) { ctx.strokeStyle = 'rgba(57,255,20,0.9)'; ctx.setLineDash([9, 6]); ctx.lineWidth = 2; ctx.beginPath(); p.geometry.coordinates[0].forEach((c, i) => { const [x, y] = toPx(c[0], c[1]); i ? ctx.lineTo(ox + x, headH + y) : ctx.moveTo(ox + x, headH + y); }); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]); }
      // effective ADU-eligible area (whole usable open region) — filled + bold outline; holes = obstructions
      for (const p of effectivePieces) {
        ctx.beginPath();
        p.geometry.coordinates.forEach((rc) => { rc.forEach((c, i) => { const [x, y] = toPx(c[0], c[1]); i ? ctx.lineTo(ox + x, headH + y) : ctx.moveTo(ox + x, headH + y); }); ctx.closePath(); });
        ctx.fillStyle = mode === 'schematic' ? 'rgba(0,230,118,0.32)' : 'rgba(0,230,118,0.28)'; ctx.fill('evenodd');
        ctx.strokeStyle = '#00e676'; ctx.setLineDash([]); ctx.lineWidth = 3; ctx.stroke();
      }
      if (effectivePieces.length) {
        const bp = turf.bbox(effectivePieces[0]); const [elx, ely] = toPx((bp[0] + bp[2]) / 2, bp[3]);
        ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center';
        ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 4; ctx.strokeText(`${out.effectiveAreaSqFt.toLocaleString()} sf usable`, ox + elx, headH + ely + 14);
        ctx.fillStyle = '#b9ffcf'; ctx.fillText(`${out.effectiveAreaSqFt.toLocaleString()} sf usable`, ox + elx, headH + ely + 14);
      }
      // house marker
      const [hx, hy] = toPx(houseAnchor.geometry.coordinates[0], houseAnchor.geometry.coordinates[1]);
      ctx.fillStyle = '#00a2ff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(ox + hx, headH + hy, 6, 0, 7); ctx.fill(); ctx.stroke();
      // ADU box
      if (aduBox) {
        ctx.strokeStyle = '#ff3b30'; ctx.fillStyle = 'rgba(255,59,48,0.55)'; ctx.lineWidth = 3;
        ctx.beginPath(); aduBox.geometry.coordinates[0].forEach((c, i) => { const [x, y] = toPx(c[0], c[1]); i ? ctx.lineTo(ox + x, headH + y) : ctx.moveTo(ox + x, headH + y); }); ctx.closePath(); ctx.fill(); ctx.stroke();
        const ac = turf.centroid(aduBox).geometry.coordinates; const [ax, ay] = toPx(ac[0], ac[1]);
        ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
        ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 4; ctx.strokeText(`ADU ${out.aduFitsSqFt} sf`, ox + ax, headH + ay - 10);
        ctx.fillStyle = '#fff'; ctx.fillText(`ADU ${out.aduFitsSqFt} sf`, ox + ax, headH + ay - 10);
      }
      // panel title
      ctx.textAlign = 'left'; ctx.font = 'bold 13px sans-serif';
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(ox + 8, headH + 8, 250, 22);
      ctx.fillStyle = '#fff'; ctx.fillText(mode === 'schematic' ? 'Engineering site plan (classified grid)' : 'Aerial proof (Esri imagery)', ox + 14, headH + 24);
    };
    drawPanel(0, 'schematic');
    drawPanel(panelW + gap, 'aerial');

    // Legend under schematic
    const legend = [['#38b000', 'Clearing (buildable ground)'], ['#00e676', 'ADU-eligible open area (polygon)'], ['#1b5e20', 'Trees / canopy'], ['#9e9e9e', 'Structure / pavement'], ['#1e88e5', 'Water / pool'], ['#ff3b30', 'ADU 900 sf (sample placement)'], ['#00a2ff', 'House']];
    let lx = 14, ly = headH + panelH - 16;
    ctx.font = '12px sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(8, ly - 16, 900, 24);
    for (const [col, txt] of legend) { ctx.fillStyle = col; ctx.fillRect(lx, ly - 11, 13, 12); ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(txt, lx + 18, ly); lx += ctx.measureText(txt).width + 42; }

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, cv.toBuffer('image/png'));
    out.ok = true; out.imageSize = `${cv.width}x${cv.height}`; out.classZoom = z;

    // --- Deterministic site-analysis narrative (from the clearing/obstruction classification) ---
    const cc = out.classCounts || {};
    const totalN = (cc.clearing || 0) + (cc.tree || 0) + (cc.structure || 0) + (cc.water || 0) || 1;
    const features = [];
    if (buildings.length || cc.structure) features.push({ label: 'house', cell: (cells.find(c => c.kind === 'structure') || {}).label });
    if (cc.water) features.push({ label: 'pool', cell: (cells.find(c => c.kind === 'water') || {}).label });
    if (cc.tree) { const t = cells.filter(c => c.kind === 'tree').sort((a, b) => turf.distance(turf.point(a.ll), turf.centroid(poly)) - turf.distance(turf.point(b.ll), turf.centroid(poly)))[0]; if (t) features.push({ label: 'forest', cell: t.label }); }
    out.vision = {
      summary: `Aerial classified into a ${CELL_FT}-ft grid — clearing vs obstruction: ~${Math.round((cc.clearing || 0) / totalN * 100)}% open clearing, ~${Math.round((cc.tree || 0) / totalN * 100)}% tree canopy${cc.water ? ', a pool/water feature' : ''}${cc.structure ? ', and structures/pavement' : ''}. The ADU-eligible open area (all buildable clearing within the setbacks) totals ≈ ${out.effectiveAreaSqFt.toLocaleString()} sf${effectivePieces.length > 1 ? ` across ${effectivePieces.length} areas` : ''} — the ADU can be sited anywhere within that green polygon; the red box is one ${out.aduFitsSqFt || 900} sf placement nearest the house.`,
      rationale: aduBox ? `Open clearing${out.aduCell ? ` at grid cell ${out.aduCell}` : ''} — the closest buildable, unobstructed ground to the house where a full ${out.aduFitsSqFt} sf ADU fits within the setbacks, clear of the pool/structures and the forest.` : 'No open clearing large enough for a full ADU was found clear of trees, structures and water.',
      concerns: (cc.tree || 0) / totalN > 0.5 ? ['Lot is heavily wooded — clearing/tree removal likely required around the ADU envelope.'] : [],
      features: features.filter(f => f.cell),
    };

    // --- Labeled grid image for the CLI agent's review (zoomed into the developed cluster) ---
    //     Aerial + per-cell class tint + readable labels + the current ADU box (red). The agent reads
    //     cells by eye and can move the ADU via MOLE_ADU_HINT=<label>. Always written (not just debug).
    try {
      const gc2 = createCanvas(W, H); const gx2 = gc2.getContext('2d');
      gx2.drawImage(aerial, 0, 0);
      gx2.save(); gx2.beginPath(); gx2.rect(0, 0, W, H); ring.forEach((c, i) => { const [x, y] = toPx(c[0], c[1]); i ? gx2.lineTo(x, y) : gx2.moveTo(x, y); }); gx2.closePath(); gx2.fillStyle = 'rgba(0,0,0,0.35)'; gx2.fill('evenodd'); gx2.restore();
      gx2.strokeStyle = '#ffe100'; gx2.lineWidth = 3; gx2.beginPath(); ring.forEach((c, i) => { const [x, y] = toPx(c[0], c[1]); i ? gx2.lineTo(x, y) : gx2.moveTo(x, y); }); gx2.closePath(); gx2.stroke();
      gx2.font = 'bold 12px sans-serif'; gx2.textAlign = 'center';
      for (const c of cells) {
        const [px, py] = toPx(c.ll[0], c.ll[1]);
        gx2.fillStyle = c.kind === 'clearing' ? 'rgba(255,255,80,0.10)' : CLASS_TINT[c.kind];
        gx2.fillRect(px - cellPx / 2, py - cellPx / 2, cellPx, cellPx);
        gx2.strokeStyle = 'rgba(255,255,255,0.45)'; gx2.lineWidth = 1; gx2.strokeRect(px - cellPx / 2, py - cellPx / 2, cellPx, cellPx);
        gx2.strokeStyle = 'rgba(0,0,0,0.85)'; gx2.lineWidth = 3; gx2.strokeText(c.label, px, py + 4);
        gx2.fillStyle = '#fff'; gx2.fillText(c.label, px, py + 4);
      }
      if (aduBox) { gx2.strokeStyle = '#ff3b30'; gx2.lineWidth = 4; gx2.beginPath(); aduBox.geometry.coordinates[0].forEach((c, i) => { const [x, y] = toPx(c[0], c[1]); i ? gx2.lineTo(x, y) : gx2.moveTo(x, y); }); gx2.closePath(); gx2.stroke(); }
      // whole ADU-eligible open area outline (green) so the agent sees the full usable region
      for (const p of effectivePieces) {
        gx2.beginPath();
        p.geometry.coordinates.forEach((rc) => { rc.forEach((c, i) => { const [x, y] = toPx(c[0], c[1]); i ? gx2.lineTo(x, y) : gx2.moveTo(x, y); }); gx2.closePath(); });
        gx2.strokeStyle = '#00e676'; gx2.setLineDash([]); gx2.lineWidth = 3; gx2.stroke();
      }
      // Zoom into the developed cluster (house + pool + clearing) so features are large and unmistakable.
      const hcog = buildings.length ? turf.centroid(buildings.sort((a, b) => turf.area(b) - turf.area(a))[0]).geometry.coordinates : center;
      const [hcx, hcy] = toPx(hcog[0], hcog[1]);
      const winW = Math.min(W, (360 * 0.3048) / mpp), winH = Math.min(H, (200 * 0.3048) / mpp);
      const sx = Math.max(0, Math.min(W - winW, hcx - winW / 2)), sy = Math.max(0, Math.min(H - winH, hcy - winH / 2));
      const ZW = 1200, ZH = Math.round(ZW * winH / winW);
      const zc = createCanvas(ZW, ZH); const zx = zc.getContext('2d');
      zx.imageSmoothingEnabled = true; zx.drawImage(gc2, sx, sy, winW, winH, 0, 0, ZW, ZH);
      const gridOut = OUT.replace(/\.png$/i, '-grid.png');
      fs.writeFileSync(gridOut, zc.toBuffer('image/png'));
      out.gridImage = path.basename(gridOut);
    } catch (e) { out.gridImageError = String(e.message || e); }

    // Debug: full-parcel classification overlay with per-cell feature values (for threshold tuning).
    if (DEBUG) {
      const dc = createCanvas(W, H); const dx = dc.getContext('2d');
      dx.drawImage(aerial, 0, 0);
      dx.font = 'bold 9px sans-serif'; dx.textAlign = 'center';
      for (const c of cells) {
        const [px, py] = toPx(c.ll[0], c.ll[1]);
        dx.fillStyle = CLASS_TINT[c.kind]; dx.fillRect(px - cellPx / 2, py - cellPx / 2, cellPx, cellPx);
        dx.strokeStyle = 'rgba(255,255,255,0.25)'; dx.lineWidth = 0.5; dx.strokeRect(px - cellPx / 2, py - cellPx / 2, cellPx, cellPx);
        dx.fillStyle = '#fff'; dx.strokeStyle = 'rgba(0,0,0,0.8)'; dx.lineWidth = 2; dx.strokeText(c.label, px, py + 3); dx.fillText(c.label, px, py + 3);
      }
      if (aduBox) { dx.strokeStyle = '#ff3b30'; dx.lineWidth = 3; dx.beginPath(); aduBox.geometry.coordinates[0].forEach((c, i) => { const [x, y] = toPx(c[0], c[1]); i ? dx.lineTo(x, y) : dx.moveTo(x, y); }); dx.closePath(); dx.stroke(); }
      const dbgOut = OUT.replace(/\.png$/i, '-classify.png');
      fs.writeFileSync(dbgOut, dc.toBuffer('image/png'));
      out.debugImage = path.basename(dbgOut);
      out.cellDetail = cells.map(c => ({ label: c.label, kind: c.kind, ...c.f }));
    }
    // Expose cells with the report/agent vocabulary (clearing→open, water→pool, structure→building).
    const KMAP = { clearing: 'open', tree: 'tree', structure: 'building', water: 'pool' };
    out.cells = cells.map(c => ({ label: c.label, kind: KMAP[c.kind] || c.kind, lon: +c.ll[0].toFixed(6), lat: +c.ll[1].toFixed(6) }));
    emit('sitemap', { status: 'ok', durationMs: Date.now() - t0, attributes: { pid, buildableAreaSqFt: out.buildableAreaSqFt, aduFits: !!out.aduFitsSqFt, aduSource: out.aduSource, aduCell: out.aduCell, zoom: z } });
  } catch (e) {
    out.ok = false; out.error = String(e && e.message ? e.message : e);
    emit('sitemap', { status: 'error', durationMs: Date.now() - t0, error: e });
  } finally {
    await flush();
    console.log(JSON.stringify(out, null, 2));
  }
})();
