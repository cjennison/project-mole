// Deterministic ADU feasibility report builder (no LLM) from collect.mjs data + sitemap output.
// Encodes the NH ADU playbook: RSA 674:72 makes 1 ADU by-right where single-family is allowed;
// current state law overrides the NH Zoning Atlas ADU "treatment" snapshot.

export function buildReport(data, sitemap = {}) {
  const p = data.parcel || {};
  const z = data.zoning || {};
  const fl = data.flood || {};
  const sh = data.shoreland || {};
  const wt = data.wetlands || {};
  const env = data.environmental || {};

  const sfAllowed = /allow/i.test(z.singleFamilyTreatment || '');
  const inSFHA = fl.sfha === 'T';
  const shoreland = sh.applies === true;
  const wetlandsNear = (wt.within100ft || 0) > 0;
  const lotOk = p.acres != null && z.sfMinLotAcres != null ? p.acres >= z.sfMinLotAcres : null;

  const gate = (name, status, detail, source) => ({ name, status, detail, source });
  const floodFailed = !!(data.errors && data.errors.flood);
  const gates = [
    gate('Legal / Zoning', sfAllowed ? 'pass' : (z.district ? 'warn' : 'unknown'),
      sfAllowed
        ? `${z.district}: single-family allowed → one ADU by right under RSA 674:72 (HB 577). Atlas ADU treatment "${z.aduTreatmentAtlas}" is a pre-2025 snapshot and is overridden by current state law.`
        : `District ${z.district || 'unknown'}: confirm single-family / ADU treatment with the town.`,
      'NH Zoning Atlas + RSA 674:72'),
    gate('Dimensional fit', lotOk === true ? 'pass' : lotOk === false ? 'warn' : 'unknown',
      `Lot ${p.acres ?? '?'} ac vs ${z.sfMinLotAcres ?? '?'} ac min; setbacks F${z.frontSetbackFt}/S${z.sideSetbackFt}/R${z.rearSetbackFt} ft; max coverage ${z.maxCoveragePct}%.`
      + (sitemap.buildableAreaSqFt ? ` Buildable ≈ ${Number(sitemap.buildableAreaSqFt).toLocaleString()} sf; sample 900 sf ADU ${sitemap.aduFitsSqFt ? 'fits' : 'needs review'}.` : ''),
      'NH Zoning Atlas + site map'),
    gate('Flood', floodFailed ? 'unknown' : inSFHA ? 'warn' : 'pass',
      floodFailed ? `FEMA flood query did not complete — verify the flood zone on FEMA MSC.`
        : inSFHA ? `In FEMA Special Flood Hazard Area (Zone ${fl.zone}) — elevation + floodplain permit required.`
             : `FEMA Zone ${fl.zone || 'X'} — not a Special Flood Hazard Area.`,
      'FEMA NFHL'),
    gate('Shoreland', shoreland ? 'warn' : 'pass',
      shoreland ? `Within 250 ft of a protected water — NHDES Shoreland permit + 50 ft setback apply.`
                : `Not in NHDES shoreland jurisdiction${sh.nearest4thOrderWithinFt ? ` (nearest protected water ≈ ${sh.nearest4thOrderWithinFt} ft)` : ''}.`,
      'NH GRANIT + NHDES'),
    gate('Wetlands', wetlandsNear ? 'warn' : 'pass',
      wetlandsNear ? `Wetland feature(s) within 100 ft — possible RSA 482-A permit.` : `No wetlands within 100 ft.`,
      'NH GRANIT / NHDES'),
    gate('Environmental', env.clean ? 'pass' : (env.hazardSitesWithin1000ft ? 'warn' : 'unknown'),
      env.clean ? `No hazard sites within 1,000 ft. Groundwater class ${env.groundwaterClass || 'n/a'}.`
                : `Nearby sites: ${Object.keys(env.hazardSitesWithin1000ft || {}).join(', ') || 'n/a'}.`,
      'NHDES'),
    gate('Wastewater / process', 'human',
      `Confirm public sewer/water at the tap (NHDES OneStop is bot-protected). Building permit (2021 IRC/IBC), impact fee, owner-occupancy deed restriction, NH811 locate.`,
      'town / NHDES'),
  ];

  const blockers = gates.filter(g => g.status === 'warn').length;
  let verdict, verdictClass;
  if (!p.pid || !z.district) { verdict = 'Needs verification'; verdictClass = 'unknown'; }
  else if (!sfAllowed) { verdict = 'Conditional — confirm zoning'; verdictClass = 'warn'; }
  else if (blockers === 0) { verdict = 'Feasible by-right'; verdictClass = 'pass'; }
  else { verdict = 'Feasible with conditions'; verdictClass = 'warn'; }

  const snapshot = {
    address: data.address, pid: p.pid, town: p.town,
    lotAcres: p.acres, lotSqFt: p.areaSqFt, district: z.district,
    aduMaxSqFt: z.aduMaxSqFt, aduMaxBedrooms: z.aduMaxBedrooms,
    ownerOccupancyRequired: z.aduOwnerOccRequired,
    matchStrategy: p.matchStrategy, addressMatch: p.addressMatch,
  };

  const tasks = [
    { task: 'Zoning, dimensional & ADU rules', type: 'agentic' },
    { task: 'Flood, shoreland, wetlands, environmental screens', type: 'agentic' },
    { task: 'Buildable-area site map', type: 'agentic' },
    { task: 'Confirm public sewer & water at the tap', type: 'human' },
    { task: 'Building permit + plans (2021 IRC/IBC)', type: 'request' },
    { task: 'Owner-occupancy deed restriction', type: 'request' },
    { task: 'NH811 / Dig Safe locate before excavation', type: 'request' },
    { task: 'On-site inspections', type: 'human' },
  ];

  const dataGaps = [];
  if (p.addressMatch === false) dataGaps.push(p.warning || 'Address did not exactly match a parcel.');
  if (Object.keys(data.errors || {}).length) dataGaps.push('Some data sources failed: ' + Object.keys(data.errors).join(', '));
  dataGaps.push('Septic/well records (NHDES OneStop) are bot-protected — confirm sewer/water manually.');

  const report = { verdict, verdictClass, snapshot, gates, tasks, dataGaps, generatedAt: new Date().toISOString() };
  // Aerial/site analysis (deterministic local pixel classification, via sitemap).
  if (sitemap.vision) {
    report.siteAnalysis = {
      summary: sitemap.vision.summary || '',
      rationale: sitemap.vision.rationale || '',
      features: sitemap.vision.features || [],
      concerns: sitemap.vision.concerns || [],
      aduSource: sitemap.aduSource || 'geometric',
    };
  }
  report.markdown = toMarkdown(report, sitemap);
  return report;
}

function toMarkdown(r, sitemap) {
  const s = r.snapshot;
  const icon = (st) => ({ pass: '✅', warn: '⚠️', human: '🧑', unknown: '❓' }[st] || '•');
  return [
    `# ADU Feasibility Report — ${s.address}`,
    ``,
    `**Verdict: ${r.verdict}** · Parcel ${s.pid || '?'} · ${s.district || '?'} · ${s.lotAcres ?? '?'} ac`,
    ``,
    sitemap.mapUrl ? `![Effective buildable area](${sitemap.mapUrl})\n` : '',
    ...(r.siteAnalysis ? [
      `## Site analysis (aerial review)`,
      r.siteAnalysis.summary,
      r.siteAnalysis.rationale ? `\n**Recommended ADU location:** ${r.siteAnalysis.rationale}` : '',
      r.siteAnalysis.features && r.siteAnalysis.features.length ? `\n**Detected on the lot:** ` + r.siteAnalysis.features.map(f => `${f.label}`).join(', ') : '',
      r.siteAnalysis.concerns && r.siteAnalysis.concerns.length ? `\n**Verify:** ` + r.siteAnalysis.concerns.join('; ') : '',
      ``,
    ] : []),
    `## Feasibility gates`,
    `| Gate | Status | Detail |`,
    `|---|---|---|`,
    ...r.gates.map(g => `| ${g.name} | ${icon(g.status)} ${g.status} | ${g.detail} |`),
    ``,
    `## Task matrix`,
    ...r.tasks.map(t => `- ${t.type === 'agentic' ? '🤖' : t.type === 'request' ? '📨' : '🧑'} ${t.task}`),
    ``,
    `## Data gaps`,
    ...r.dataGaps.map(d => `- ${d}`),
    ``,
    `_Generated ${r.generatedAt}. Verify against official town/state sources before design._`,
  ].join('\n');
}
