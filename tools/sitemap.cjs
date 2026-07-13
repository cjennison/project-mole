#!/usr/bin/env node
// Renders a static "effective available area" site map for an ADU:
//   Esri World Imagery XYZ tiles (no API key) + parcel outline +
//   setback-based buildable envelope + a sample ~900 sqft ADU footprint.
//
// Usage: node tools/sitemap.cjs "<address>" [outPngPath]
// Prints JSON: { png, lotAreaSqFt, buildableAreaSqFt, insetFt, aduFitsSqFt, ... }
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
async function setbacks(gc) {
  const run = async (geom, type) => (await j(`${ATLAS}/query?${qs({ geometry: geom, geometryType: type, inSR: 4326, spatialRel: 'esriSpatialRelIntersects', outFields: '*', returnGeometry: 'false', f: 'json' })}`)).features || [];
  let f = (await run(`${gc.lon},${gc.lat}`, 'esriGeometryPoint'))[0];
  if (!f) { const d = 0.006; const env = JSON.stringify({ xmin: gc.lon - d, ymin: gc.lat - d, xmax: gc.lon + d, ymax: gc.lat + d, spatialReference: { wkid: 4326 } }); f = (await run(env, 'esriGeometryEnvelope'))[0]; }
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

// --- Web Mercator XYZ global-pixel helpers ---
const D2R = Math.PI / 180;
const globalPx = (lon, lat, z) => {
  const n = 256 * Math.pow(2, z);
  const x = (lon + 180) / 360 * n;
  const s = Math.sin(lat * D2R);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  return [x, y];
};
const mppAt = (lat, z) => 156543.03392 * Math.cos(lat * D2R) / Math.pow(2, z);

async function fetchTile(z, x, y) {
  const r = await fetch(`${TILES}/${z}/${y}/${x}`, { headers: { 'User-Agent': 'project-mole/1.0' } });
  const ct = r.headers.get('content-type') || '';
  if (!r.ok || !/image\//.test(ct)) throw new Error(`tile ${z}/${y}/${x} not image (${r.status} ${ct})`);
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
    const sb = await setbacks(gc);
    out.pid = pid; out.district = sb.district;
    out.lotAreaSqFt = Math.round(turf.area(poly) * 10.7639);

    // Buildable envelope: conservative uniform inset by the LARGEST setback.
    const insetFt = Math.max(sb.front, sb.side, sb.rear);
    out.insetFt = insetFt;
    let envelope = null;
    try { envelope = turf.buffer(poly, -insetFt, { units: 'feet' }); } catch {}
    if (!(envelope && envelope.geometry && envelope.geometry.coordinates.length)) { envelope = null; }
    out.buildableAreaSqFt = envelope ? Math.round(turf.area(envelope) * 10.7639) : 0;

    // Sample ADU footprint (square, area = min(aduMaxSqFt,900)), placed in the envelope
    // at the interior point farthest from the existing house, nudged toward centroid.
    const side = Math.sqrt(Math.min(sb.aduMaxSqFt || 900, 900));
    const halfDiag = (side / 2) * Math.SQRT2;
    let aduBox = null;
    if (envelope) {
      const house = turf.point([gc.lon, gc.lat]);
      const centroid = turf.centroid(envelope);
      const ring = envelope.geometry.type === 'MultiPolygon' ? envelope.geometry.coordinates[0][0] : envelope.geometry.coordinates[0];
      let best = null, bestD = -1;
      for (const c of ring) { const d = turf.distance(house, turf.point(c), { units: 'feet' }); if (d > bestD) { bestD = d; best = c; } }
      const mk = (ctr) => turf.polygon([[45, 135, 225, 315, 45].map(b => turf.destination(ctr, halfDiag, b, { units: 'feet' }).geometry.coordinates)]);
      const inside = (b) => b.geometry.coordinates[0].every(c => turf.booleanPointInPolygon(turf.point(c), envelope));
      let center = best ? turf.destination(turf.point(best), side, turf.bearing(turf.point(best), centroid), { units: 'feet' }) : centroid;
      let box = mk(center);
      if (!inside(box)) { center = centroid; box = mk(center); }
      if (inside(box)) { aduBox = box; out.aduFitsSqFt = Math.round(side * side); } else { out.aduFitsSqFt = 0; }
    } else { out.aduFitsSqFt = 0; }

    // --- Choose zoom + assemble imagery tiles over the padded parcel bbox ---
    const [minLon, minLat, maxLon, maxLat] = turf.bbox(poly);
    const padLon = (maxLon - minLon) * 0.35, padLat = (maxLat - minLat) * 0.35;
    const bb = { minLon: minLon - padLon, minLat: minLat - padLat, maxLon: maxLon + padLon, maxLat: maxLat + padLat };
    let z = 19, tx0, tx1, ty0, ty1, aerial = null;
    for (; z >= 15; z--) {
      const [gx0, gy0] = globalPx(bb.minLon, bb.maxLat, z);
      const [gx1, gy1] = globalPx(bb.maxLon, bb.minLat, z);
      if (Math.max(gx1 - gx0, gy1 - gy0) > 1300) continue; // too big, zoom out
      tx0 = Math.floor(gx0 / 256); tx1 = Math.floor(gx1 / 256);
      ty0 = Math.floor(gy0 / 256); ty1 = Math.floor(gy1 / 256);
      try {
        const tiles = [];
        for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) tiles.push([tx, ty, await fetchTile(z, tx, ty)]);
        aerial = tiles; break;
      } catch (e) { aerial = null; /* zoom out and retry */ }
    }
    if (!aerial) throw new Error('could not fetch imagery tiles at any zoom');

    const originX = tx0 * 256, originY = ty0 * 256;
    const W = (tx1 - tx0 + 1) * 256, H = (ty1 - ty0 + 1) * 256;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    for (const [tx, ty, img] of aerial) ctx.drawImage(img, (tx - tx0) * 256, (ty - ty0) * 256, 256, 256);

    const toPx = (lon, lat) => { const [gx, gy] = globalPx(lon, lat, z); return [gx - originX, gy - originY]; };
    const drawRing = (feat, { stroke, fill, width = 3, dash = [] }) => {
      const rings = feat.geometry.type === 'MultiPolygon' ? feat.geometry.coordinates.flat() : feat.geometry.coordinates;
      ctx.save(); ctx.lineWidth = width; ctx.setLineDash(dash); ctx.lineJoin = 'round';
      for (const r of rings) {
        ctx.beginPath();
        r.forEach((c, i) => { const [px, py] = toPx(c[0], c[1]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
        ctx.closePath();
        if (fill) { ctx.fillStyle = fill; ctx.fill(); }
        if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
      }
      ctx.restore();
    };

    drawRing(poly, { stroke: '#ffe100', width: 4 });
    if (envelope) drawRing(envelope, { stroke: '#39ff14', fill: 'rgba(57,255,20,0.28)', width: 3, dash: [10, 6] });
    if (aduBox) drawRing(aduBox, { stroke: '#ff3b30', fill: 'rgba(255,59,48,0.55)', width: 3 });

    // house marker
    const [hx, hy] = toPx(gc.lon, gc.lat);
    ctx.fillStyle = '#00a2ff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(hx, hy, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

    // ADU label
    if (aduBox) {
      const c = turf.centroid(aduBox).geometry.coordinates; const [ax, ay] = toPx(c[0], c[1]);
      ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center';
      ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 4; ctx.strokeText(`ADU ~${Math.round(side * side)} sf`, ax, ay);
      ctx.fillStyle = '#fff'; ctx.fillText(`ADU ~${Math.round(side * side)} sf`, ax, ay);
    }

    // title bar
    ctx.fillStyle = 'rgba(0,0,0,0.62)'; ctx.fillRect(0, 0, W, 46);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.font = 'bold 18px sans-serif';
    ctx.fillText(`Effective buildable area — ${addr || ADDRESS}`, 14, 22);
    ctx.font = '13px sans-serif';
    ctx.fillText(`PID ${pid} · ${sb.district} · ${insetFt}ft setback inset · buildable ≈ ${out.buildableAreaSqFt.toLocaleString()} sf of ${out.lotAreaSqFt.toLocaleString()} sf lot`, 14, 40);

    // legend
    const legend = [['#ffe100', 'Parcel boundary'], ['#39ff14', `Buildable area (-${insetFt}ft setback)`], ['#ff3b30', 'Sample 900 sf ADU'], ['#00a2ff', 'Existing house']];
    const lh = 20, lw = 275, ly0 = H - lh * legend.length - 14;
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(10, ly0 - 8, lw, lh * legend.length + 10);
    legend.forEach(([col, txt], i) => {
      const y = ly0 + i * lh; ctx.fillStyle = col; ctx.fillRect(16, y, 14, 12);
      ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(txt, 36, y + 11);
    });

    // scale bar (100 ft)
    const mpp = mppAt(gc.lat, z); const px100 = (100 * 0.3048) / mpp;
    const sx = W - px100 - 20, sy = H - 22;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + px100, sy); ctx.stroke();
    ctx.textAlign = 'center'; ctx.font = 'bold 12px sans-serif';
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 3; ctx.strokeText('100 ft', sx + px100 / 2, sy - 6);
    ctx.fillStyle = '#fff'; ctx.fillText('100 ft', sx + px100 / 2, sy - 6);

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, canvas.toBuffer('image/png'));
    out.ok = true; out.zoom = z; out.imageSize = `${W}x${H}`;
    emit('sitemap', { status: 'ok', durationMs: Date.now() - t0, attributes: { pid, buildableAreaSqFt: out.buildableAreaSqFt, aduFits: !!out.aduFitsSqFt, zoom: z } });
  } catch (e) {
    out.ok = false; out.error = String(e && e.message ? e.message : e);
    emit('sitemap', { status: 'error', durationMs: Date.now() - t0, error: e });
  } finally {
    await flush();
    console.log(JSON.stringify(out, null, 2));
  }
})();
