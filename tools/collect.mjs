#!/usr/bin/env node
// NH ADU feasibility data collector.
// Usage: node tools/collect.mjs "1341 River Road, Manchester, NH"
// Prints a JSON blob of raw facts gathered from public REST APIs (no LLM, no browser).
// Endpoints & rationale are documented in knowledge/nh-data-sources.md.

import { emit, flush } from './telemetry.mjs';

const ADDRESS = process.argv.slice(2).join(' ').trim();
if (!ADDRESS) { console.error('Usage: node collect.mjs "<address>"'); process.exit(1); }
process.env.MOLE_ADDRESS = process.env.MOLE_ADDRESS || ADDRESS;

// Local phase wrapper: emits start/ok|error telemetry AND records gaps into out.errors.
async function step(name, fn) {
  const t0 = Date.now();
  emit(name, { status: 'start' });
  try {
    const r = await fn();
    emit(name, { status: 'ok', durationMs: Date.now() - t0 });
    return r;
  } catch (e) {
    emit(name, { status: 'error', durationMs: Date.now() - t0, error: e });
    out.errors[name] = String(e && e.message ? e.message : e);
    return undefined;
  }
}

const j = async (url) => {
  const r = await fetch(url, { headers: { 'User-Agent': 'project-mole/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
};
const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const out = { address: ADDRESS, generatedAt: new Date().toISOString(), errors: {} };

// ---------- 1. Geocode (US Census) ----------
async function geocode() {
  const u = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${qs({
    address: ADDRESS, benchmark: 'Public_AR_Current', format: 'json' })}`;
  const d = await j(u);
  const m = d.result?.addressMatches?.[0];
  if (!m) throw new Error('no geocode match');
  out.geocode = { lon: m.coordinates.x, lat: m.coordinates.y, matched: m.matchedAddress };
  return out.geocode;
}

// ---------- 2. Parcel (NH GRANIT ParcelMosaic) ----------
const GRANIT = 'https://nhgeodata.unh.edu/nhgeodata/rest/services/CAD/ParcelMosaic/MapServer';
async function parcel({ lon, lat }) {
  // The geocoder returns a normalized address like "1341 RIVER RD, MANCHESTER, NH, 03104".
  // Primary strategy: exact StreetAddress + Town match (most reliable — avoids picking an
  // adjacent parcel). Fallbacks: LIKE on house number, then point-envelope nearest.
  const matched = out.geocode?.matched || ADDRESS;
  const parts = matched.split(',').map(s => s.trim());
  const streetFull = (parts[0] || '').toUpperCase();
  const town = (parts[1] || '').toUpperCase();
  const houseNum = (streetFull.match(/^\s*(\d+)/) || [])[1];
  let f = null, strategy = null;

  const runQuery = async (where) => {
    const u = `${GRANIT}/1/query?${qs({ where, outFields: '*', returnGeometry: 'false', f: 'json' })}`;
    return (await j(u)).features || [];
  };
  // 1. exact street + town
  try {
    const feats = await runQuery(`StreetAddress='${streetFull}' AND Town='${town}'`);
    if (feats.length) { f = feats[0]; strategy = 'exact-address'; }
  } catch (e) { out.errors.parcelExact = String(e); }
  // 2. house-number LIKE within town
  if (!f && houseNum && town) {
    try {
      const feats = await runQuery(`StreetAddress LIKE '${houseNum} %' AND Town='${town}'`);
      const streetName = streetFull.replace(/^\d+\s+/, '').split(/\s+/)[0]; // first word of street
      f = feats.find(x => new RegExp('^' + houseNum + '\\s+' + streetName, 'i').test(x.attributes.StreetAddress || '')) || feats[0];
      if (f) strategy = 'housenum-like';
    } catch (e) { out.errors.parcelLike = String(e); }
  }
  // 3. point envelope (wider), pick house-number match then first
  if (!f) {
    const d = 0.0015;
    const env = JSON.stringify({ xmin: lon - d, ymin: lat - d, xmax: lon + d, ymax: lat + d, spatialReference: { wkid: 4326 } });
    const u = `${GRANIT}/1/query?${qs({ geometry: env, geometryType: 'esriGeometryEnvelope', inSR: 4326,
      spatialRel: 'esriSpatialRelIntersects', outFields: '*', returnGeometry: 'false', f: 'json' })}`;
    const feats = (await j(u)).features || [];
    f = feats.find(x => houseNum && String(x.attributes.StreetAddress || '').trim().startsWith(houseNum + ' ')) || feats[0];
    if (f) strategy = 'envelope-nearest';
  }
  if (!f) throw new Error('no parcel found');

  const a = f.attributes;
  const areaSqFt = a.Shape_Area || null;
  const parcelNum = (String(a.StreetAddress || '').match(/^\s*(\d+)/) || [])[1];
  out.parcel = {
    pid: a.PID, town: a.Town, townId: a.TownID, county: a.CountyId, nhGisId: a.NH_GIS_ID,
    streetAddress: a.StreetAddress, sluc: a.SLUC, matchStrategy: strategy,
    areaSqFt: areaSqFt ? Math.round(areaSqFt) : null,
    acres: areaSqFt ? +(areaSqFt / 43560).toFixed(3) : null,
    addressMatch: !!(houseNum && parcelNum && houseNum === parcelNum),
  };
  if (!out.parcel.addressMatch) {
    out.parcel.warning = `Input street number ${houseNum || '?'} did not match the resolved parcel's address (${a.StreetAddress}). The queried address may not be a distinct parcel, or the geocode landed on an adjacent lot. VERIFY before relying on parcel-specific figures.`;
  }
  try {
    const g = await j(`${GRANIT}/1/query?${qs({ where: `PID='${a.PID}' AND Town='${a.Town}'`,
      outFields: 'PID', returnGeometry: 'true', outSR: 102686, f: 'json' })}`);
    const ring = g.features?.[0]?.geometry?.rings?.[0];
    if (ring) {
      const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
      out.parcel.bboxFt = { w: Math.round(Math.max(...xs) - Math.min(...xs)), h: Math.round(Math.max(...ys) - Math.min(...ys)) };
    }
  } catch (e) { out.errors.parcelGeom = String(e); }
  return out.parcel;
}

// ---------- 3. Zoning + ADU + dimensional (NH Zoning Atlas) ----------
const ATLAS = 'https://services1.arcgis.com/aguSsLS841Hp3EC4/ArcGIS/rest/services/NH_Atlas_Zoning_Districts_Buildable/FeatureServer/0';
async function zoning({ lon, lat }, town) {
  const tryPoint = async () => {
    const u = `${ATLAS}/query?${qs({ geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: 4326,
      spatialRel: 'esriSpatialRelIntersects', outFields: '*', returnGeometry: 'false', f: 'json' })}`;
    return (await j(u)).features?.[0];
  };
  const tryEnvelope = async () => {
    const d = 0.006;
    const env = JSON.stringify({ xmin: lon - d, ymin: lat - d, xmax: lon + d, ymax: lat + d, spatialReference: { wkid: 4326 } });
    const u = `${ATLAS}/query?${qs({ geometry: env, geometryType: 'esriGeometryEnvelope', inSR: 4326,
      spatialRel: 'esriSpatialRelIntersects', outFields: '*', returnGeometry: 'false', f: 'json' })}`;
    const feats = (await j(u)).features || [];
    const tn = (town || '').toString();
    return feats.find(x => new RegExp(tn, 'i').test(x.attributes.Jurisdiction || '')) || feats[0];
  };
  const f = (await tryPoint()) || (await tryEnvelope());
  if (!f) throw new Error('no zoning polygon found');
  const a = f.attributes;
  const g = (k) => a[k];
  out.zoning = {
    jurisdiction: g('Jurisdiction'), district: g('AbbreviatedDistrict'), fullName: g('Full_District_Name'),
    type: g('Type_of_Zoning_District'),
    singleFamilyTreatment: g('F1_Family_Treatment'),
    aduTreatmentAtlas: g('Accessory_Dwelling_Unit__ADU__Treatment'),
    detachedAduTreatment: g('Detached_ADU_Treatment__if_allowed_'),
    aduMaxPerLot: g('ADU_Max___Per_Lot'),
    aduOwnerOccRequired: g('ADU_Owner_Occupancy_Required'),
    aduExtraParking: g('ADU_Min___Parking_Spaces__Additional_to_Main_Unit_'),
    aduMaxSqFt: g('ADU_Max_Size__SF_'),
    aduMaxBedrooms: g('ADU_Max___Bedrooms_Per_Unit'),
    sfMinLotAcres: g('F1_Family_Min_Lot__ACRES_'),
    frontSetbackFt: g('F1_Family_Front_Setback____of_feet_'),
    sideSetbackFt: g('F1_Family_Side_Setback____of_feet_'),
    rearSetbackFt: g('F1_Family_Rear_Setback____of_feet_'),
    minFrontageFt: g('F1_Family_Min_Road_Frontage____of_feet__0_if_none_'),
    maxCoveragePct: g('F1_Family_Max_Lot_Coverage___Buildings___Impervious_Surface____'),
    maxHeightFt: g('F1_Family_Max_Height____of_feet_'),
    far: g('F1_Family_Floor_to_Area_Ratio'),
  };
  return out.zoning;
}

// ---------- 4. Flood (FEMA NFHL) ----------
async function flood({ lon, lat }) {
  const u = `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?${qs({
    geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: 4326,
    spatialRel: 'esriSpatialRelIntersects', outFields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE',
    returnGeometry: 'false', f: 'json' })}`;
  const d = await j(u);
  const a = d.features?.[0]?.attributes;
  out.flood = a ? { zone: a.FLD_ZONE, subtype: a.ZONE_SUBTY, sfha: a.SFHA_TF, bfe: a.STATIC_BFE }
                : { zone: 'X (implied)', sfha: 'F', note: 'no NFHL polygon at point = outside mapped SFHA' };
  return out.flood;
}

// ---------- 5. Shoreland (NHDES official + GRANIT distance) ----------
const WR = 'https://nhgeodata.unh.edu/nhgeodata/rest/services/IWR/WaterResources/MapServer';
const NHDES_SHORE = 'https://gis.des.nh.gov/server/rest/services/Projects_LRM/Shoreland_Protection_Act/MapServer';
async function shoreland({ lon, lat }) {
  const inShore = async (layer) => {
    const u = `${NHDES_SHORE}/${layer}/query?${qs({ geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint',
      inSR: 4326, spatialRel: 'esriSpatialRelIntersects', returnCountOnly: 'true', f: 'json' })}`;
    return (await j(u)).count > 0;
  };
  let official = false;
  for (const l of [0, 1, 2]) { try { if (await inShore(l)) official = true; } catch {} }
  const within = async (ft) => {
    const u = `${WR}/8/query?${qs({ geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: 4326,
      distance: ft, units: 'esriSRUnit_Foot', spatialRel: 'esriSpatialRelIntersects', returnCountOnly: 'true', f: 'json' })}`;
    return (await j(u)).count > 0;
  };
  let nearestFt = null;
  for (const ft of [250, 500, 1000, 2000, 3000, 5000]) { try { if (await within(ft)) { nearestFt = ft; break; } } catch {} }
  const applies = official || (await within(250).catch(() => false));
  out.shoreland = { applies, officialInJurisdiction: official, nearest4thOrderWithinFt: nearestFt };
  return out.shoreland;
}

// ---------- 6. Wetlands (GRANIT) ----------
async function wetlands({ lon, lat }) {
  const near = async (layer) => {
    const u = `${WR}/${layer}/query?${qs({ geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: 4326,
      distance: 100, units: 'esriSRUnit_Foot', spatialRel: 'esriSpatialRelIntersects', returnCountOnly: 'true', f: 'json' })}`;
    return (await j(u)).count;
  };
  let total = 0;
  for (const l of [26, 28, 32]) { try { total += await near(l); } catch {} }
  out.wetlands = { within100ft: total };
  return out.wetlands;
}

// ---------- 7. Environmental due-diligence + groundwater (NHDES) ----------
const NHDES_PUB = 'https://gis.des.nh.gov/server/rest/services/Core_GIS_Datasets/DES_Data_Public/MapServer';
async function environmental({ lon, lat }) {
  const names = { 0: 'abovegroundTanks', 2: 'asbestos', 3: 'autoSalvage', 7: 'hazWasteGenerators',
    8: 'localContamSources', 11: 'remediationSites', 12: 'solidWaste', 13: 'undergroundTanks' };
  const sites = {};
  for (const [id, name] of Object.entries(names)) {
    try {
      const u = `${NHDES_PUB}/${id}/query?${qs({ geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: 4326,
        distance: 1000, units: 'esriSRUnit_Foot', spatialRel: 'esriSpatialRelIntersects', returnCountOnly: 'true', f: 'json' })}`;
      const c = (await j(u)).count;
      if (c > 0) sites[name] = c;
    } catch {}
  }
  let gw = null;
  for (const [id, cls] of [[5, 'GA1'], [6, 'GA2']]) {
    try {
      const u = `${NHDES_PUB}/${id}/query?${qs({ geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: 4326,
        spatialRel: 'esriSpatialRelIntersects', returnCountOnly: 'true', f: 'json' })}`;
      if ((await j(u)).count > 0) gw = cls;
    } catch {}
  }
  out.environmental = { hazardSitesWithin1000ft: sites, clean: Object.keys(sites).length === 0, groundwaterClass: gw };
  return out.environmental;
}

(async () => {
  emit('run_start', { status: 'start', attributes: { tool: 'collect', address: ADDRESS } });
  try {
    const gc = await step('geocode', () => geocode());
    if (!gc) throw new Error('geocode failed — cannot continue');
    const p = (await step('parcel', () => parcel(gc))) || {};
    await step('zoning', () => zoning(gc, p.town));
    await step('flood', () => flood(gc));
    await step('shoreland', () => shoreland(gc));
    await step('wetlands', () => wetlands(gc));
    await step('environmental', () => environmental(gc));
    if (p.pid && /-/.test(p.pid)) { const [m, l] = p.pid.split('-'); out.vgsiHint = { map: m, lot: l }; }
    emit('collect_done', { status: 'ok', attributes: {
      pid: out.parcel?.pid, district: out.zoning?.district,
      addressMatch: out.parcel?.addressMatch, matchStrategy: out.parcel?.matchStrategy,
      floodZone: out.flood?.zone, shorelandApplies: out.shoreland?.applies,
      dataGaps: Object.keys(out.errors).length,
    } });
  } catch (e) {
    out.fatal = String(e);
    emit('collect_done', { status: 'error', error: e });
  } finally {
    await flush();
    console.log(JSON.stringify(out, null, 2));
  }
})();
