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
  const drawPoly = () => { ctx.beginPath(); poly.geometry.coordinates[0].forEach((p, i) => { const [x, y] = toPx(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); };
  // Mask everything OUTSIDE the parcel so analysis only considers land that is actually this lot.
  const mask = process.argv[5] !== 'nomask';
  if (mask) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    poly.geometry.coordinates[0].forEach((p, i) => { const [x, y] = toPx(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fill('evenodd');
    ctx.restore();
  }
  ctx.strokeStyle = '#ffe100'; ctx.lineWidth = 4; drawPoly(); ctx.stroke();
  fs.writeFileSync(out, cv.toBuffer('image/png'));
  console.log(JSON.stringify({ out, zoom, size: `${W}x${H}`, pid: pf.attributes.PID, masked: mask }));
})();
