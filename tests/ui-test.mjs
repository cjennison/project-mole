import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://localhost:8080';
const ADDR = process.argv[3] || '1335 River Road, Manchester, NH';
const SHOT = process.argv[4] || 'reports/_ui-test.png';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
  const out = {};
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    out.title = await page.title();
    await page.fill('#addr', ADDR);
    await page.click('#go');
    await page.waitForSelector('#progress:not(.hidden)', { timeout: 10000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: 'reports/_ui-progress.png', fullPage: true });
    await page.waitForSelector('.badge', { timeout: 120000 });
    out.verdict = (await page.textContent('.badge'))?.trim();
    out.status = (await page.textContent('#p-status'))?.trim();
    const img = await page.$('img.mapimg');
    if (img) { try { await page.waitForFunction(() => { const i = document.querySelector('img.mapimg'); return i && i.complete && i.naturalWidth > 0; }, { timeout: 30000 }); } catch {} }
    out.mapLoaded = img ? await img.evaluate(e => e.complete && e.naturalWidth > 0) : false;
    out.gateRows = await page.$$eval('table.gates tr', rs => rs.length);
    await page.waitForTimeout(800);
    await page.screenshot({ path: SHOT, fullPage: true });
    out.screenshot = SHOT;
    out.ok = !!out.verdict;
  } catch (e) {
    out.ok = false; out.error = String(e.message || e);
    try { await page.screenshot({ path: 'reports/_ui-error.png', fullPage: true }); } catch {}
  } finally {
    console.log(JSON.stringify(out, null, 2));
    await browser.close();
  }
})();
