#!/usr/bin/env node
// VGSI (Vision Government Solutions) assessor-card scraper via Playwright.
// Usage: node tools/vgsi.cjs <town-slug> <map> <lot>
//   e.g. node tools/vgsi.cjs manchesternh 222 83
// Prints JSON: owner, assessment, use code, land size, sale, building attrs.
// Run inside the container:  --entrypoint node -e NODE_PATH=/usr/local/lib/node_modules
const { chromium } = require('playwright');

const TOWN = process.argv[2] || 'manchesternh';
const MAP  = process.argv[3];
const LOT  = process.argv[4];
if (!MAP || !LOT) { console.error('Usage: node vgsi.cjs <town-slug> <map> <lot>'); process.exit(1); }
const BASE = `https://gis.vgsi.com/${TOWN}`;

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const out = { town: TOWN, map: MAP, lot: LOT };
  const WAIT = 'domcontentloaded';
  const submit = () => page.evaluate(() => document.getElementById('MainContent_btnSubmit').click());

  async function tryMblu(map, block, lot) {
    await page.goto(`${BASE}/Search.aspx`, { waitUntil: WAIT, timeout: 60000 });
    await page.waitForSelector('#MainContent_ddlSearchSource', { timeout: 30000 });
    await page.selectOption('#MainContent_ddlSearchSource', '3');
    await page.waitForTimeout(1200);
    if (map)   await page.fill('#MainContent_txtM', map).catch(() => {});
    if (block) await page.fill('#MainContent_txtB', block).catch(() => {});
    if (lot)   await page.fill('#MainContent_txtL', lot).catch(() => {});
    await Promise.all([page.waitForNavigation({ waitUntil: WAIT, timeout: 60000 }).catch(() => {}), submit()]);
    await page.waitForTimeout(1500);
    if (/Search\.aspx/i.test(page.url())) {
      const link = await page.$('a[href*="Parcel.aspx"]');
      if (link) await Promise.all([page.waitForNavigation({ waitUntil: WAIT, timeout: 60000 }).catch(() => {}), link.click()]);
    }
    return /Parcel\.aspx/i.test(page.url());
  }

  try {
    let ok = await tryMblu(MAP, '', LOT);
    if (!ok) ok = await tryMblu(MAP, LOT, '');
    out.reachedParcel = ok;
    out.url = page.url();
    const pick = async (id) => (await page.$(`#MainContent_${id}`).then(e => e ? e.innerText() : null).catch(() => null))?.trim() || null;
    out.owner       = await pick('lblGenOwner');
    out.location    = await pick('lblLocation');
    out.mblu        = await pick('lblMblu');
    out.assessment  = await pick('lblGenAssessment');
    out.useCode     = await pick('lblUseCode');
    out.useDesc     = await pick('lblUseCodeDescription');
    out.landSqFt    = await pick('lblLndSize');
    out.salePrice   = await pick('lblPrice');
    out.saleDate    = await pick('lblSaleDate');
    out.bookPage    = await pick('lblBp');
    out.yearBuilt   = await pick('ctl02_lblYearBuilt');
    out.livingArea  = await pick('ctl02_lblBldArea');
  } catch (e) {
    out.error = String(e);
  } finally {
    console.log(JSON.stringify(out, null, 2));
    await browser.close();
  }
})();
