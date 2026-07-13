#!/usr/bin/env node
// Renders a static "effective available area" site map for an ADU (v2):
//   Esri World Imagery tiles + parcel outline + PER-EDGE setback buildable envelope
//   (front/side/rear detected via nearest road) + existing-building carve-out
//   + a sample ~900 sqft ADU placed in the open rear/side yard.
//
// Usage: node tools/sitemap.cjs "<address>" [outPngPath]
const fs = require('node:fs');
const path = require('node:path');
const turf = require('@turf/turf');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
let emit = () => {}, flush = async () => {};

const ADDRESS = process.argv[2];
if (!ADDRESS) { console.error('Usage: node sitemap.cjs "<address>" [out.png]'); process.exit(1); }
const SLUG = ADDRESS.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const OUT = process.argv[3] || path.join(process.cwd(), 'reports', `${SLUG}-sitemap.png`);

const j = async (url) => { const r = await fetch(url, { headers: { 'User-Agent': 'project-mole/1.0' } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

const GRANIT = 'https://nhgeodata.unh.edu/nhgeodata/rest/services/CAD/ParcelMosaic/MapServer';
const ATLAS = 'https://services1.arcgis.com/aguSsLS841Hp3EC4/ArcGIS/rest/services/NH_Atlas_Zoning_Districts_Buildable/FeatureServer/0';
const STRUCT = 'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0';
const TIGER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer';
const TILES = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile';

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
  if (!f) { const d = 0.006; const env = JSON.stringify({ xmin: center[0] - d, ymin: center[1] - d, xmax: center[0] + d, ymax: center[1] + d, spatialReference: { wkid: 4326 } }); f = (await run(env, 'esriGeometryEnvelope'))[0]; }
  const a = f?.attributes || {};
  const num = (v, d) => (v == null || v === '' ? d : Number(v));
  return {
    district: a.AbbreviatedDistrict || 'unknown',
    front: num(a.F1_Family_Front_Setback____of_feet_, 25),
    side: num(a.F1_Family_Side_Setback____of_feet_, 20),
    rear: num(a.F1_Family_Rear_Setback____of_feet_, 30),
    aduMaxSqFt: num(a.ADU_Max_Size__SF_, 900),
    maxCoveragePct: num(a.F1_Family_Max_Lot_Coverage___Buildings___Impervious_Surface____, 40),
  };
}
async function roadsNear(center) {
  try {
    const rd = (await j(`${TIGER}/8/query?${qs({ geometry: `${center[0]},${center[1]}`, geometryType: 'esriGeometryPoint', inSR: 4326, distance: 200, units: 'esriSRUnit_Meter', spatialRel: 'esriSpatialRelIntersects', outFields: 'NAME', returnGeometry: 'true', outSR: 4326, f: 'json' })}`)).features || [];
    return rd.map(r => { try { return turf.lineString(r.geometry.paths[0]); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
async function buildingsOn(poly, center) {
  try {
    const bs = (await j(`${STRUCT}/query?${qs({ geometry: `${center[0]},${center[1]}`, geometryType: 'esriGeometryPoint', inSR: 4326, distance: 90, units: 'esriSRUnit_Meter', spatialRel: 'esriSpatialRelIntersects', outFields: 'BUILD_ID', returnGeometry: 'true', outSR: 4326, f: 'json' })}`)).features || [];
    return bs.map(b => { try { return turf.polygon(b.geometry.rings); } catch { return null; } })
             .filter(Boolean).filter(bp => turf.booleanIntersects(bp, poly));
  } catch { return []; }
}

const diff = (a, b) => { try { return turf.difference(turf.featureCollection([a, b])); } catch { return a; } };
const pieces = (g) => { if (!g) return []; if (g.geometry.type === 'Polygon') return [g]; return g.geometry.coordinates.map(c => turf.polygon(c)); };

// --- XYZ tile helpers ---
const D2R = Math.PI / 180;
const globalPx = (lon, lat, z) => { const n = 256 * 2 ** z; const s = Math.sin(lat * D2R); return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n]; };
const mppAt = (lat, z) => 156543.03392 * Math.cos(lat * D2R) / 2 ** z;
async function fetchTile(z, x, y) {
  const r = await fetch(`${TILES}/${z}/${y}/${x}`, { headers: { 'User-Agent': 'project-mole/1.0' } });
  const ct = r.headers.get('content-type') || '';
  if (!r.ok || !/image\//.test(ct)) throw new Error(`tile ${z}/${y}/${x} ${r.status} ${ct}`);
  return loadImage(Buffer.from(await r.arrayBuffer()));
}

(async () => {
  try { const t = await import('./telemetry.mjs'); emit = t.emit; flush = t.flush; } catch {}
  const t0 = Date.now();
  emit('sitemap', { status: 'start', attributes: { address: ADDRESS } });
  const out = { address: ADDRESS, png: OUT };
  try {
    const gc = await geocode(ADDRESS);
    const { poly, pid, addr } = await parcelPoly(gc);
    const center = turf.centroid(poly).geometry.coordinates; // reliable interior point
    const sb = await setbacks(center);
    out.pid = pid; out.district = sb.district;
    out.lotAreaSqFt = Math.round(turf.area(poly) * 10.7639);

    // --- Per-edge setbacks: detect the FRONT edge (nearest a road), REAR (opposite), SIDES ---
    const roads = await roadsNear(center);
    const ring = poly.geometry.coordinates[0];
    const edges = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const mid = turf.midpoint(turf.point(ring[i]), turf.point(ring[i + 1]));
      let dRoad = Infinity;
      for (const rl of roads) { const d = turf.pointToLineDistance(mid, rl, { units: 'feet' }); if (d < dRoad) dRoad = d; }
      edges.push({ i, a: ring[i], b: ring[i + 1], mid, dRoad, len: turf.distance(turf.point(ring[i]), turf.point(ring[i + 1]), { units: 'feet' }) });
    }
    let frontIdx = 0;
    if (roads.length) frontIdx = edges.reduce((m, e) => e.dRoad < edges[m].dRoad ? e.i : m, 0);
    else frontIdx = edges.reduce((m, e) => e.len > edges[m].len ? e.i : m, 0); // fallback: longest edge
    const frontMid = edges[frontIdx].mid;
    const rearIdx = edges.reduce((m, e) => turf.distance(e.mid, frontMid, { units: 'feet' }) > turf.distance(edges[m].mid, frontMid, { units: 'feet' }) ? e.i : m, 0);
    const setbackFor = (i) => (i === frontIdx ? sb.front : i === rearIdx ? sb.rear : sb.side);
    out.frontSetback = sb.front; out.sideSetback = sb.side; out.rearSetback = sb.rear;

    // Build envelope by subtracting each edge's own setback strip.
    let envelope = poly;
    for (const e of edges) {
      const s = setbackFor(e.i); if (!s) continue;
      const strip = turf.buffer(turf.lineString([e.a, e.b]), s, { units: 'feet' });
      if (strip) envelope = diff(envelope, strip) || envelope;
    }

    // --- Carve existing buildings (+5 ft separation) ---
    const buildings = await buildingsOn(poly, center);
    out.buildingsCarved = buildings.length;
    for (const b of buildings) {
      const keepout = turf.buffer(b, 5, { units: 'feet' });
      if (keepout) envelope = diff(envelope, keepout) || envelope;
    }

    const envPieces = pieces(envelope).filter(p => turf.area(p) > 2); // drop slivers
    out.buildableAreaSqFt = Math.round(envPieces.reduce((s, p) => s + turf.area(p), 0) * 10.7639);
    const biggest = envPieces.sort((a, b) => turf.area(b) - turf.area(a))[0] || null;

    // --- Place a sample ADU in the OPEN yard: grid-search the biggest piece for the ADU
    //     square footprint that fits AND is farthest from the front edge (rear/side yard). ---
    const side = Math.sqrt(Math.min(sb.aduMaxSqFt || 900, 900));
    const halfDiag = (side / 2) * Math.SQRT2;
    const mkBox = (ctr) => turf.polygon([[45, 135, 225, 315, 45].map(bd => turf.destination(ctr, halfDiag, bd, { units: 'feet' }).geometry.coordinates)]);
    let aduBox = null;
    if (biggest) {
      const [x0, y0, x1, y1] = turf.bbox(biggest);
      const N = 26; let best = null, bestScore = -Infinity;
      for (let ix = 0; ix <= N; ix++) for (let iy = 0; iy <= N; iy++) {
        const ctr = turf.point([x0 + (x1 - x0) * ix / N, y0 + (y1 - y0) * iy / N]);
        if (!turf.booleanPointInPolygon(ctr, biggest)) continue;
        const box = mkBox(ctr);
        if (!box.geometry.coordinates[0].every(c => turf.booleanPointInPolygon(turf.point(c), biggest))) continue;
        const score = turf.distance(ctr, frontMid, { units: 'feet' }); // farther from front = better
        if (score > bestScore) { bestScore = score; best = box; }
      }
      aduBox = best;
    }
    out.aduFitsSqFt = aduBox ? Math.round(side * side) : 0;

    // --- Imagery tiles over padded parcel bbox ---
    const [minLon, minLat, maxLon, maxLat] = turf.bbox(poly);
    const padLon = (maxLon - minLon) * 0.35, padLat = (maxLat - minLat) * 0.35;
    const bb = { minLon: minLon - padLon, minLat: minLat - padLat, maxLon: maxLon + padLon, maxLat: maxLat + padLat };
    let z = 19, tx0, tx1, ty0, ty1, tiles = null;
    for (; z >= 15; z--) {
      const [gx0, gy0] = globalPx(bb.minLon, bb.maxLat, z), [gx1, gy1] = globalPx(bb.maxLon, bb.minLat, z);
      if (Math.max(gx1 - gx0, gy1 - gy0) > 1300) continue;
      tx0 = Math.floor(gx0 / 256); tx1 = Math.floor(gx1 / 256); ty0 = Math.floor(gy0 / 256); ty1 = Math.floor(gy1 / 256);
      try { const t = []; for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) t.push([tx, ty, await fetchTile(z, tx, ty)]); tiles = t; break; }
      catch { tiles = null; }
    }
    if (!tiles) throw new Error('could not fetch imagery tiles');
    const originX = tx0 * 256, originY = ty0 * 256, W = (tx1 - tx0 + 1) * 256, H = (ty1 - ty0 + 1) * 256;
    const canvas = createCanvas(W, H); const ctx = canvas.getContext('2d');
    for (const [tx, ty, img] of tiles) ctx.drawImage(img, (tx - tx0) * 256, (ty - ty0) * 256, 256, 256);

    const toPx = (lon, lat) => { const [gx, gy] = globalPx(lon, lat, z); return [gx - originX, gy - originY]; };
    const drawFeat = (feat, { stroke, fill, width = 3, dash = [] }) => {
      if (!feat) return;
      for (const pc of pieces(feat)) {
        const rings = pc.geometry.coordinates;
        ctx.save(); ctx.lineWidth = width; ctx.setLineDash(dash); ctx.lineJoin = 'round';
        for (const r of rings) {
          ctx.beginPath();
          r.forEach((c, i) => { const [px, py] = toPx(c[0], c[1]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
          ctx.closePath();
          if (fill) { ctx.fillStyle = fill; ctx.fill(); }
          if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
        }
        ctx.restore();
      }
    };
    const drawLine = (a, b, style, width = 5) => { const [ax, ay] = toPx(a[0], a[1]), [bx, by] = toPx(b[0], b[1]); ctx.save(); ctx.strokeStyle = style; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.restore(); };

    drawFeat(poly, { stroke: '#ffe100', width: 4 });
    drawLine(edges[frontIdx].a, edges[frontIdx].b, '#00d5ff', 6);           // front edge = cyan
    for (const p of envPieces) drawFeat(p, { stroke: '#39ff14', fill: 'rgba(57,255,20,0.30)', width: 3, dash: [10, 6] });
    for (const b of buildings) drawFeat(b, { stroke: '#ffffff', fill: 'rgba(255,255,255,0.35)', width: 2 });
    if (aduBox) drawFeat(aduBox, { stroke: '#ff3b30', fill: 'rgba(255,59,48,0.6)', width: 3 });

    // house marker (largest building centroid, else parcel centroid)
    const houseC = buildings.length ? turf.centroid(buildings.sort((a, b) => turf.area(b) - turf.area(a))[0]).geometry.coordinates : center;
    const [hx, hy] = toPx(houseC[0], houseC[1]);
    ctx.fillStyle = '#00a2ff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(hx, hy, 7, 0, 7); ctx.fill(); ctx.stroke();

    if (aduBox) {
      const c = turf.centroid(aduBox).geometry.coordinates; const [ax, ay] = toPx(c[0], c[1]);
      ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center';
      ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 4; ctx.strokeText(`ADU ~${Math.round(side * side)} sf`, ax, ay);
      ctx.fillStyle = '#fff'; ctx.fillText(`ADU ~${Math.round(side * side)} sf`, ax, ay);
    }

    ctx.fillStyle = 'rgba(0,0,0,0.62)'; ctx.fillRect(0, 0, W, 46);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.font = 'bold 18px sans-serif';
    ctx.fillText(`Effective buildable area — ${addr || ADDRESS}`, 14, 22);
    ctx.font = '13px sans-serif';
    ctx.fillText(`PID ${pid} · ${sb.district} · setbacks F${sb.front}/S${sb.side}/R${sb.rear}ft · buildable ≈ ${out.buildableAreaSqFt.toLocaleString()} sf of ${out.lotAreaSqFt.toLocaleString()} sf`, 14, 40);

    const legend = [['#ffe100', 'Parcel boundary'], ['#00d5ff', 'Front (street) edge'], ['#39ff14', 'Buildable area (per-edge setbacks)'], ['#ffffff', `Existing building${buildings.length ? '' : ' (none found)'}`], ['#ff3b30', 'Sample 900 sf ADU'], ['#00a2ff', 'House']];
    const lh = 20, lw = 300, ly0 = H - lh * legend.length - 14;
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(10, ly0 - 8, lw, lh * legend.length + 10);
    legend.forEach(([col, txt], i) => { const y = ly0 + i * lh; ctx.fillStyle = col; ctx.fillRect(16, y, 14, 12); ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(txt, 36, y + 11); });

    const px100 = (100 * 0.3048) / mppAt(center[1], z); const sx = W - px100 - 20, sy = H - 22;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + px100, sy); ctx.stroke();
    ctx.textAlign = 'center'; ctx.font = 'bold 12px sans-serif'; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 3;
    ctx.strokeText('100 ft', sx + px100 / 2, sy - 6); ctx.fillStyle = '#fff'; ctx.fillText('100 ft', sx + px100 / 2, sy - 6);

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, canvas.toBuffer('image/png'));
    out.ok = true; out.zoom = z; out.imageSize = `${W}x${H}`;
    emit('sitemap', { status: 'ok', durationMs: Date.now() - t0, attributes: { pid, buildableAreaSqFt: out.buildableAreaSqFt, aduFits: !!out.aduFitsSqFt, buildingsCarved: out.buildingsCarved, zoom: z } });
  } catch (e) {
    out.ok = false; out.error = String(e && e.message ? e.message : e);
    emit('sitemap', { status: 'error', durationMs: Date.now() - t0, error: e });
  } finally {
    await flush();
    console.log(JSON.stringify(out, null, 2));
  }
})();
