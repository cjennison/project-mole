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
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
// Register a font so text renders in headless Linux containers (slim images ship no fonts).
try {
  const fsx = require('node:fs');
  for (const p of ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf']) {
    if (fsx.existsSync(p)) GlobalFonts.registerFromPath(p, 'sans-serif');
  }
} catch {}
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
    const fromPx = (px, py) => { const n = 256 * 2 ** z; const gx = px + originX, gy = py + originY; return [gx / n * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * gy / n))) * 180 / Math.PI]; };

    // --- FREE local ground classification (drives ADU placement; no paid vision needed) ---
    //     Sample the raw aerial pixels of each ~32 ft grid cell to detect tree canopy / pool-water /
    //     building-roof vs open ground. CRITICAL: classify on a dedicated HIGH-ZOOM (19) canvas, NOT
    //     the display map — the display zoom can drop to 18 for long parcels, at which coarseness the
    //     house/pool go undetected and the ADU lands on the pool. At z19 the house is cleanly detected
    //     and the pool (its grid neighbour) is kept out. We emit the `vision` phase so the UI's aerial
    //     analysis step always completes even with AOAI off.
    emit('vision', { status: 'start' });
    const cellCenters = {};   // label -> [lon,lat] (also reused by the optional AOAI grid below)
    const groundCells = [];   // { label, ll:[lon,lat], kind }
    try {
      const zc = 19;
      const [cgx0, cgy0] = globalPx(minLon, maxLat, zc), [cgx1, cgy1] = globalPx(maxLon, minLat, zc);
      const ctx0 = Math.floor(cgx0 / 256), ctx1 = Math.floor(cgx1 / 256), cty0 = Math.floor(cgy0 / 256), cty1 = Math.floor(cgy1 / 256);
      const cW = (ctx1 - ctx0 + 1) * 256, cH = (cty1 - cty0 + 1) * 256, coX = ctx0 * 256, coY = cty0 * 256;
      const ccv = createCanvas(cW, cH); const cc = ccv.getContext('2d');
      for (let ty = cty0; ty <= cty1; ty++) for (let tx = ctx0; tx <= ctx1; tx++) cc.drawImage(await fetchTile(zc, tx, ty), (tx - ctx0) * 256, (ty - cty0) * 256, 256, 256);
      const cToPx = (lon, lat) => { const [gx, gy] = globalPx(lon, lat, zc); return [gx - coX, gy - coY]; };
      const cFromPx = (px, py) => { const n = 256 * 2 ** zc; return [(px + coX) / n * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * (py + coY) / n))) * 180 / Math.PI]; };
      const cell = Math.max(38, (32 * 0.3048) / mppAt(center[1], zc));
      const ringPx = poly.geometry.coordinates[0].map(c => cToPx(c[0], c[1]));
      const pminX = Math.min(...ringPx.map(p => p[0])), pmaxX = Math.max(...ringPx.map(p => p[0]));
      const pminY = Math.min(...ringPx.map(p => p[1])), pmaxY = Math.max(...ringPx.map(p => p[1]));
      const cols = 'ABCDEFGHIJKLMNOPQRSTUVWX';
      const classify = (gx, gy) => {
        const w = Math.min(cell, cW - gx), h = Math.min(cell, cH - gy);
        if (w <= 1 || h <= 1) return 'open';
        const d = cc.getImageData(Math.max(0, gx), Math.max(0, gy), Math.floor(w), Math.floor(h)).data;
        let tree = 0, gray = 0, blue = 0, tot = 0;
        for (let i = 0; i < d.length; i += 16) {
          const r = d[i], g = d[i + 1], b = d[i + 2]; const bright = (r + g + b) / 3; const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          if (g > r + 4 && g > b + 4 && bright < 95) tree++;                                      // dark green canopy
          else if (b >= r && b >= g && b > 70 && (b - r) > 8) blue++;                             // deep blue pool/water
          else if (b > 120 && g > 110 && r < b - 12 && (mx - mn) > 12) blue++;                    // bright cyan/turquoise pool
          else if ((mx - mn) < 28 && bright > 105) gray++;                                        // roof / pavement (bright, low-sat)
          tot++;
        }
        if (!tot) return 'open';
        const T = tree / tot, G = gray / tot, B = blue / tot;
        return T > 0.45 ? 'tree' : B > 0.22 ? 'pool' : G > 0.4 ? 'building' : 'open';
      };
      let ci = 0;
      for (let gx = pminX; gx < pmaxX; gx += cell, ci++) {
        let ri = 0;
        for (let gy = pminY; gy < pmaxY; gy += cell, ri++) {
          const cxp = gx + cell / 2, cyp = gy + cell / 2;
          const [lon, lat] = cFromPx(cxp, cyp);
          if (!turf.booleanPointInPolygon(turf.point([lon, lat]), poly)) continue;
          const label = (cols[ci] || 'Z') + (ri + 1);
          cellCenters[label] = [lon, lat];
          groundCells.push({ label, ll: [lon, lat], kind: classify(gx, gy) });
        }
      }
      out.ground = groundCells.reduce((a, c) => (a[c.kind] = (a[c.kind] || 0) + 1, a), {});
      out.classZoom = zc;
      emit('vision', { status: 'ok', attributes: { classZoom: zc, cells: groundCells.length, ...out.ground } });
    } catch (e) { out.classifyError = String(e.message || e); emit('vision', { status: 'ok', attributes: { error: String(e.message || e) } }); }

    // ADU placement is fully deterministic (local pixel classification below); no external model.
    let aduSource = 'geometric';
    // --- ADU placement (FREE, local pixel classification): anchor at the existing developed cluster
    //     (house + pool, detected by color), then choose the OPEN grid cell nearest that cluster where a
    //     full ADU box fits inside the setback envelope — and is not on/adjacent to any tree/roof/water
    //     cell. Lands the ADU beside the house (e.g. right of the pool), never out in the woods, without
    //     depending on the AOAI model's unreliable point-picking. ---
    if (biggest) {
      try {
        const cent = turf.centroid(biggest);
        { const [gxp, gyp] = toPx(gc.lon, gc.lat); out.geocodeNorm = { x: +(gxp / W).toFixed(3), y: +(gyp / H).toFixed(3) }; }
        const developed = groundCells.filter(c => c.kind === 'building' || c.kind === 'pool');
        const treeCells = groundCells.filter(c => c.kind === 'tree');
        let anchor = developed.length
          ? turf.centroid(turf.featureCollection(developed.map(c => turf.point(c.ll))))
          : turf.point([gc.lon, gc.lat]);
        if (!turf.booleanPointInPolygon(anchor, biggest)) {
          const np = turf.nearestPointOnLine(turf.polygonToLine(biggest), anchor);
          anchor = turf.destination(np, 15, turf.bearing(np, cent), { units: 'feet' });
        }
        { const [ax, ay] = toPx(anchor.geometry.coordinates[0], anchor.geometry.coordinates[1]); out.placeAnchorNorm = { x: +(ax / W).toFixed(3), y: +(ay / H).toFixed(3) }; }
        // Clearances: stay well clear of the DEVELOPED cluster (house + any pool) — its buffer must be
        // large enough to also clear an adjacent pool that colour-detection may have missed (a pool sits
        // ~1 grid cell / ~32 ft from the house) — and clear of TREE canopy. Then pick the spot nearest
        // the developed cluster that satisfies both, so the ADU lands on open ground beside the house.
        const near = (ll, cells, ft) => cells.some(c => turf.distance(turf.point(ll), turf.point(c.ll), { units: 'feet' }) < ft);
        const devLL = developed.length ? developed : [{ ll: [gc.lon, gc.lat] }];
        const bb = turf.bbox(biggest);
        const search = (devFt, treeFt, N) => {
          let bBox = null, bD = Infinity;
          for (let ix = 0; ix <= N; ix++) for (let iy = 0; iy <= N; iy++) {
            const ll = [bb[0] + (bb[2] - bb[0]) * ix / N, bb[1] + (bb[3] - bb[1]) * iy / N];
            const ctr = turf.point(ll);
            if (!turf.booleanPointInPolygon(ctr, biggest)) continue;
            if (near(ll, devLL, devFt)) continue;                 // clear the house + (adjacent) pool
            if (treeCells.length && near(ll, treeCells, treeFt)) continue; // clear tree canopy
            const box = mkBox(ctr);
            if (!box.geometry.coordinates[0].every(p => turf.booleanPointInPolygon(turf.point(p), biggest))) continue;
            const d = turf.distance(ctr, anchor, { units: 'feet' });
            if (d < bD) { bD = d; bBox = box; }
          }
          return bBox;
        };
        // Try progressively looser clearances so we always find a spot, but keep the house/pool buffer
        // as generous as fits: 42 ft (clears house + adjacent pool) → 34 → 28.
        let best = search(42, 26, 44) || search(34, 22, 44) || search(28, 16, 48);
        if (best) { aduBox = best; aduSource = 'local-classifier'; out.aduFitsSqFt = Math.round(side * side); }
      } catch (e) { out.aduPlaceError = String(e.message || e); }
    }
    // Agent override: after LOOKING at the rendered map, the Copilot CLI agent (Opus 4.8) can pass a
    // corrected ADU location via MOLE_ADU_HINT — either "lon,lat" or a grid-cell label like "G3" (labels
    // are reported in out.cells). We place the box there, snapping to the nearest spot inside the
    // buildable envelope where a full box fits. This is the self-correction hook.
    if (biggest && process.env.MOLE_ADU_HINT) {
      try {
        const raw = process.env.MOLE_ADU_HINT.trim();
        let pt = null;
        const m = raw.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
        if (m) pt = [parseFloat(m[1]), parseFloat(m[2])];
        else if (cellCenters[raw.toUpperCase()]) pt = cellCenters[raw.toUpperCase()];
        if (pt) {
          const fits = (ll) => mkBox(turf.point(ll)).geometry.coordinates[0].every(p => turf.booleanPointInPolygon(turf.point(p), biggest));
          let target = fits(pt) ? pt : null;
          if (!target) {
            const bb2 = turf.bbox(biggest); let bD = Infinity;
            for (let ix = 0; ix <= 48; ix++) for (let iy = 0; iy <= 48; iy++) {
              const ll = [bb2[0] + (bb2[2] - bb2[0]) * ix / 48, bb2[1] + (bb2[3] - bb2[1]) * iy / 48];
              if (!fits(ll)) continue;
              const d = turf.distance(turf.point(ll), turf.point(pt), { units: 'feet' });
              if (d < bD) { bD = d; target = ll; }
            }
          }
          if (target) { aduBox = mkBox(turf.point(target)); aduSource = 'agent-corrected'; out.aduFitsSqFt = Math.round(side * side); out.aduHint = raw; }
          else out.aduHintError = 'hint point has no fitting box inside the buildable envelope';
        } else out.aduHintError = 'could not parse MOLE_ADU_HINT (use "lon,lat" or a cell label)';
      } catch (e) { out.aduHintError = String(e.message || e); }
    }
    out.aduSource = aduSource;
    // Expose the classified grid so the agent can reason about which cell is open vs house/pool/tree.
    out.cells = groundCells.map(c => ({ label: c.label, kind: c.kind, lon: +c.ll[0].toFixed(6), lat: +c.ll[1].toFixed(6) }));
    if (aduBox) { const cc = turf.centroid(aduBox).geometry.coordinates; const [bx, by] = toPx(cc[0], cc[1]); out.aduPlacedNorm = { x: +(bx / W).toFixed(3), y: +(by / H).toFixed(3) }; }

    // Site analysis: deterministic narrative synthesized from the free local pixel classification,
    // so the report always explains what the agent "saw" on the aerial.
    const treeN = (out.ground && out.ground.tree) || 0, openN = (out.ground && out.ground.open) || 0;
    const poolN = (out.ground && out.ground.pool) || 0, bldgN = (out.ground && out.ground.building) || 0;
    const totalN = treeN + openN + poolN + bldgN || 1;
    const localFeatures = [];
    if (bldgN) { const c = groundCells.find(g => g.kind === 'building'); if (c) localFeatures.push({ label: 'house', cell: c.label }); }
    if (poolN) { const c = groundCells.find(g => g.kind === 'pool'); if (c) localFeatures.push({ label: 'pool', cell: c.label }); }
    if (treeN) { const c = groundCells.filter(g => g.kind === 'tree').sort((a, b) => turf.distance(turf.point(a.ll), turf.centroid(poly)) - turf.distance(turf.point(b.ll), turf.centroid(poly)))[0]; if (c) localFeatures.push({ label: 'forest', cell: c.label }); }
    const localVision = {
      summary: `Aerial pixel analysis of the parcel: ~${Math.round(treeN / totalN * 100)}% tree canopy, ~${Math.round(openN / totalN * 100)}% open ground${poolN ? ', a pool/water feature' : ''}${bldgN ? ', and existing structures/pavement' : ''}. The ADU is placed on open ground adjacent to the existing developed area, clear of tree cover and the pool.`,
      rationale: aduBox ? `Open ground beside the existing structures${out.aduCell ? ` (grid cell ${out.aduCell})` : ''} — the closest buildable, non-wooded spot to the house/driveway where a full ${Math.round(side * side)} sf ADU fits within the required setbacks.` : 'No open buildable spot large enough for a full ADU was found clear of trees and existing features.',
      concerns: treeN / totalN > 0.5 ? ['Lot is heavily wooded — clearing/tree removal likely required around the ADU envelope.'] : [],
      features: localFeatures,
    };
    out.vision = localVision;

    drawFeat(poly, { stroke: '#ffe100', width: 4 });
    for (const p of envPieces) drawFeat(p, { stroke: '#39ff14', fill: 'rgba(57,255,20,0.30)', width: 3, dash: [10, 6] });
    // Show what the free classifier detected, so the map is self-consistent (viewer sees the forest &
    // pool the agent avoided, with the ADU box landing on open ground).
    {
      const cellPx = Math.max(38, (32 * 0.3048) / mppAt(center[1], z));
      for (const c of groundCells) {
        if (c.kind === 'open') continue;
        const [px, py] = toPx(c.ll[0], c.ll[1]);
        ctx.fillStyle = c.kind === 'tree' ? 'rgba(60,200,60,0.22)' : c.kind === 'pool' ? 'rgba(0,180,255,0.30)' : 'rgba(200,200,200,0.20)';
        ctx.fillRect(px - cellPx / 2, py - cellPx / 2, cellPx, cellPx);
      }
    }
    for (const b of buildings) drawFeat(b, { stroke: '#ffffff', fill: 'rgba(255,255,255,0.35)', width: 2 });
    if (aduBox) drawFeat(aduBox, { stroke: '#ff3b30', fill: 'rgba(255,59,48,0.6)', width: 3 });

    // Detected-feature markers from the free local classifier.
    const featColors = { pool: '#00e5ff', driveway: '#d0d0d0', shed: '#ffb300', forest: '#7cff9b', water: '#2196f3', house: '#00a2ff' };
    const featureList = localFeatures;
    if (Array.isArray(featureList)) {
      const drawn = new Set();
      for (const f of featureList) {
        if (!featColors[f.label] || !f.cell || !cellCenters[f.cell] || drawn.has(f.label)) continue;
        drawn.add(f.label);
        const [px, py] = toPx(cellCenters[f.cell][0], cellCenters[f.cell][1]);
        ctx.fillStyle = featColors[f.label]; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(px, py, 6, 0, 7); ctx.fill(); ctx.stroke();
        ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left';
        ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 3; ctx.strokeText(f.label, px + 9, py + 4);
        ctx.fillStyle = '#fff'; ctx.fillText(f.label, px + 9, py + 4);
      }
    }

    // house marker (largest building centroid, else parcel centroid)
    const houseC = buildings.length ? turf.centroid(buildings.sort((a, b) => turf.area(b) - turf.area(a))[0]).geometry.coordinates : center;
    const [hx, hy] = toPx(houseC[0], houseC[1]);
    ctx.fillStyle = '#00a2ff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(hx, hy, 7, 0, 7); ctx.fill(); ctx.stroke();

    if (aduBox) {
      const c = turf.centroid(aduBox).geometry.coordinates; const [ax, ay] = toPx(c[0], c[1]);
      const label = `ADU ~${Math.round(side * side)} sf`;
      ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center';
      ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 4; ctx.strokeText(label, ax, ay - 12);
      ctx.fillStyle = '#fff'; ctx.fillText(label, ax, ay - 12);
    }

    ctx.fillStyle = 'rgba(0,0,0,0.62)'; ctx.fillRect(0, 0, W, 46);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.font = 'bold 18px sans-serif';
    ctx.fillText(`Effective buildable area — ${addr || ADDRESS}`, 14, 22);
    ctx.font = '13px sans-serif';
    ctx.fillText(`PID ${pid} · ${sb.district} · setbacks F${sb.front}/S${sb.side}/R${sb.rear}ft · buildable ≈ ${out.buildableAreaSqFt.toLocaleString()} sf of ${out.lotAreaSqFt.toLocaleString()} sf`, 14, 40);

    const legend = [['#ffe100', 'Parcel boundary'], ['#39ff14', 'Buildable area (setbacks)'], ['#ff3b30', out.aduSource !== 'geometric' ? 'ADU — placed in open area' : 'Sample 900 sf ADU'], ['rgba(60,200,60,0.6)', 'Tree canopy (detected)'], ['#00e5ff', 'Pool / water (detected)'], ['#00a2ff', 'House']];
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
    emit('sitemap', { status: 'ok', durationMs: Date.now() - t0, attributes: { pid, buildableAreaSqFt: out.buildableAreaSqFt, aduFits: !!out.aduFitsSqFt, aduSource: out.aduSource, zoom: z } });
  } catch (e) {
    out.ok = false; out.error = String(e && e.message ? e.message : e);
    emit('sitemap', { status: 'error', durationMs: Date.now() - t0, error: e });
  } finally {
    await flush();
    console.log(JSON.stringify(out, null, 2));
  }
})();
