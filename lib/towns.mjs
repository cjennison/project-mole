// Per-town handling for NH ADU feasibility.
//
// Two concerns are separated here:
//   1. Statewide law that ALWAYS applies (HB 577 / RSA 674:71-73 ADU size bounds) — enforced in
//      code for every town via resolveAduMaxSqFt().
//   2. Genuine per-town variation (VGSI assessor slug, local ordinance nuances the pre-2025 Atlas
//      snapshot gets wrong, known data quirks) — read from knowledge/nh-towns.json.
//
// Any town NOT listed in the registry is handled with auto-derived defaults, so a brand-new town
// works unattended; the registry only layers curated overrides/notes on top.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = path.join(ROOT, 'knowledge', 'nh-towns.json');

// HB 577 (RSA 674:72): a town cannot cap an ADU below 750 sf or above 950 sf. Always applies.
export const ADU_SIZE_FLOOR_SQFT = 750;
export const ADU_SIZE_CEIL_SQFT = 950;

let _registry;
function loadRegistry() {
  if (_registry) return _registry;
  try { _registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); }
  catch { _registry = {}; }
  return _registry;
}

const normKey = (t) => String(t || '').trim().toLowerCase();

// Derive the default Vision/VGSI assessor slug from a town name.
// "Manchester" -> "manchesternh", "New Boston" -> "newbostonnh".
export function deriveVgsiSlug(town) {
  const base = String(town || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return base ? `${base}nh` : null;
}

// Merged town config: curated registry entry (if any) over auto-derived defaults. `curated` tells
// callers whether a hand-verified entry backed this config or it was fully derived.
export function getTownConfig(town) {
  const reg = loadRegistry();
  const key = normKey(town);
  const entry = (Object.entries(reg).find(([k]) => normKey(k) === key) || [])[1] || {};
  return {
    town: town || null,
    curated: !!Object.keys(entry).length,
    vgsiSlug: entry.vgsiSlug || deriveVgsiSlug(town),
    aduMaxSqFtOverride: entry.aduMaxSqFtOverride ?? null,
    ownerOccupancyOverride: entry.ownerOccupancyOverride ?? null,
    detachedAduNote: entry.detachedAduNote || null,
    notes: Array.isArray(entry.notes) ? entry.notes : [],
  };
}

// Apply the statewide HB 577 bounds to an ADU size cap. A curated override wins over the Atlas
// snapshot; both are then clamped into [750, 950]. When no local cap is known, state law still
// guarantees the ceiling by right.
export function resolveAduMaxSqFt({ atlasMax, override } = {}) {
  const raw = override ?? (atlasMax != null ? Number(atlasMax) : null);
  if (raw == null || Number.isNaN(raw)) {
    return { effectiveMaxSqFt: ADU_SIZE_CEIL_SQFT, localCap: null, source: 'state-default', clamped: false, note: null };
  }
  const effective = Math.min(Math.max(raw, ADU_SIZE_FLOOR_SQFT), ADU_SIZE_CEIL_SQFT);
  let note = null;
  if (raw > ADU_SIZE_CEIL_SQFT) note = `Local cap ${raw} sf exceeds the HB 577 statewide ceiling — ADUs are allowed by right up to ${ADU_SIZE_CEIL_SQFT} sf.`;
  else if (raw < ADU_SIZE_FLOOR_SQFT) note = `Local cap ${raw} sf is below the HB 577 statewide floor — a town cannot cap ADUs below ${ADU_SIZE_FLOOR_SQFT} sf.`;
  return {
    effectiveMaxSqFt: effective, localCap: raw,
    source: override != null ? 'town-override' : 'atlas',
    clamped: effective !== raw, note,
  };
}
