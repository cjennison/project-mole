// Fetch a clean aerial of the parcel (outline only) for inspection / vision analysis.
const fs = require('node:fs');
const turf = require('@turf/turf');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const j = async (u) => { const r = await fetch(u, { headers: { 'User-Agent': 'mole/1.0' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
const GRANIT = 'https://nhgeodata.unh.edu/nhgeodata/rest/services/CAD/ParcelMosaic/MapServer';
const TILES = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile';
const D2R = Math.PI / 180;
const gp = (lon, lat, z) => { const n = 256 * 2 ** z; const s = Math.sin(lat * D2R); return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n]; };
const tile = async (z, x, y) => loadImage(Buffer.from(await (await fetch(`${TILES}/${z}/${y}/${x}`)).arrayBuffer()));

(async () => {
  const addr = process.argv[2] || '1325 River Road, Manchester, NH';
  const out = process.argv[3] || 'reports/_aerial.png';
  const zoom = parseInt(process.argv[4] || '19', 10);
  const parts = addr.split(',').map(s => s.trim());
  const street = parts[0].toUpperCase(), town = parts[1].toUpperCase();
  const num = (street.match(/^\d+/) || [])[0];
  const run = async (where) => (await j(`${GRANIT}/1/query?${qs({ where, outFields: 'PID', returnGeometry: 'true', outSR: 4326, f: 'json' })}`)).features || [];
  let feats = await run(`StreetAddress='${street}' AND Town='${town}'`);
  if (!feats.length && num) feats = await run(`StreetAddress LIKE '${num} %' AND Town='${town}'`);
  const pf = feats[0];
  if (!pf) throw new Error('parcel not found for ' + addr);
  const poly = turf.polygon(pf.geometry.rings);
  const [minLon, minLat, maxLon, maxLat] = turf.bbox(poly);
  const pad = 0.25;
  const bb = { minLon: minLon - (maxLon - minLon) * pad, minLat: minLat - (maxLat - minLat) * pad, maxLon: maxLon + (maxLon - minLon) * pad, maxLat: maxLat + (maxLat - minLat) * pad };
  const [gx0, gy0] = gp(bb.minLon, bb.maxLat, zoom), [gx1, gy1] = gp(bb.maxLon, bb.minLat, zoom);
  const tx0 = Math.floor(gx0 / 256), tx1 = Math.floor(gx1 / 256), ty0 = Math.floor(gy0 / 256), ty1 = Math.floor(gy1 / 256);
  const W = (tx1 - tx0 + 1) * 256, H = (ty1 - ty0 + 1) * 256, oX = tx0 * 256, oY = ty0 * 256;
  const cv = createCanvas(W, H), ctx = cv.getContext('2d');
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) ctx.drawImage(await tile(zoom, tx, ty), (tx - tx0) * 256, (ty - ty0) * 256);
  const toPx = (lon, lat) => { const [x, y] = gp(lon, lat, zoom); return [x - oX, y - oY]; };
  const fromPx = (px, py) => { const n = 256 * Math.pow(2, zoom); const gx = px + oX, gy = py + oY; return [gx / n * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * gy / n))) * 180 / Math.PI]; };
  const mpp = 156543.03392 * Math.cos(((minLat + maxLat) / 2) * D2R) / Math.pow(2, zoom);
  const drawPoly = () => { ctx.beginPath(); poly.geometry.coordinates[0].forEach((p, i) => { const [x, y] = toPx(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); };
  // Mask everything OUTSIDE the parcel so analysis only considers land that is actually this lot.
  const mask = process.argv[5] !== 'nomask';
  const grid = process.argv[6] === 'grid';
  if (mask && !grid) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    poly.geometry.coordinates[0].forEach((p, i) => { const [x, y] = toPx(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fill('evenodd');
    ctx.restore();
  }
  if (!grid) { ctx.strokeStyle = '#ffe100'; ctx.lineWidth = 4; drawPoly(); ctx.stroke(); }
  if (grid) {
    const turf2 = turf;
    const cell = Math.max(38, (32 * 0.3048) / mpp);
    const ringPx = poly.geometry.coordinates[0].map(c => toPx(c[0], c[1]));
    const pminX = Math.min(...ringPx.map(p => p[0])), pmaxX = Math.max(...ringPx.map(p => p[0]));
    const pminY = Math.min(...ringPx.map(p => p[1])), pmaxY = Math.max(...ringPx.map(p => p[1]));
    const cols = 'ABCDEFGHIJKLMNOPQRSTUVWX';
    // classify each cell as tree/open by sampling raw aerial pixels (before mask)
    const classify = (gx, gy) => {
      const w = Math.min(cell, W - gx), h = Math.min(cell, H - gy);
      if (w <= 1 || h <= 1) return { tree: 0, gray: 0, blue: 0 };
      const d = ctx.getImageData(Math.max(0, gx), Math.max(0, gy), Math.floor(w), Math.floor(h)).data;
      let tree = 0, gray = 0, blue = 0, tot = 0;
      for (let i = 0; i < d.length; i += 16) {
        const r = d[i], g = d[i + 1], b = d[i + 2]; const bright = (r + g + b) / 3; const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (g > r + 4 && g > b + 4 && bright < 95) tree++;                        // dark green canopy
        else if (b >= r && b >= g && b > 70 && (b - r) > 8) blue++;                // pool/water
        else if ((mx - mn) < 28 && bright > 105) gray++;                          // roof/pavement (low sat, bright)
        tot++;
      }
      return tot ? { tree: tree / tot, gray: gray / tot, blue: blue / tot } : { tree: 0, gray: 0, blue: 0 };
    };
    const cellsInfo = [];
    let ci = 0;
    for (let gx = pminX; gx < pmaxX; gx += cell, ci++) {
      let ri = 0;
      for (let gy = pminY; gy < pmaxY; gy += cell, ri++) {
        const cxp = gx + cell / 2, cyp = gy + cell / 2;
        const [lon, lat] = fromPx(cxp, cyp);
        if (!turf2.booleanPointInPolygon(turf2.point([lon, lat]), poly)) continue;
        cellsInfo.push({ label: (cols[ci] || 'Z') + (ri + 1), gx, gy, cxp, cyp, ...classify(gx, gy) });
      }
    }
    // mask outside parcel
    if (mask) { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); poly.geometry.coordinates[0].forEach((p, i) => { const [x, y] = toPx(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fill('evenodd'); ctx.restore(); }
    ctx.strokeStyle = '#ffe100'; ctx.lineWidth = 4; drawPoly(); ctx.stroke();
    // classify each cell: tree(red) / pool(blue) / building(gray) / open(green)
    const kind = (c) => c.tree > 0.45 ? 'tree' : c.blue > 0.25 ? 'pool' : c.gray > 0.4 ? 'building' : 'open';
    const tint = { tree: 'rgba(255,60,60,0.35)', pool: 'rgba(0,180,255,0.45)', building: 'rgba(180,180,180,0.5)', open: 'rgba(60,255,60,0.35)' };
    ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
    for (const c of cellsInfo) {
      const k = kind(c);
      ctx.fillStyle = tint[k]; ctx.fillRect(c.gx, c.gy, cell, cell);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1; ctx.strokeRect(c.gx, c.gy, cell, cell);
      ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 3; ctx.strokeText(c.label, c.cxp, c.cyp + 4);
      ctx.fillStyle = '#fff'; ctx.fillText(c.label, c.cxp, c.cyp + 4);
    }
    fs.writeFileSync(out, cv.toBuffer('image/png'));
    console.log(JSON.stringify({ out, cells: cellsInfo.map(c => ({ label: c.label, kind: kind(c) })) }));
    return;
  }
  fs.writeFileSync(out, cv.toBuffer('image/png'));
  console.log(JSON.stringify({ out, zoom, size: `${W}x${H}`, pid: pf.attributes.PID, masked: mask, grid }));
})();
