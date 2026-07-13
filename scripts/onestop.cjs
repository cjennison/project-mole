const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' });
  const out = {};
  try {
    await page.goto('https://www4.des.state.nh.us/DESOnestop/BasicSearch.aspx', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    out.title = await page.title();

    // Discovery: list text inputs and checkbox labels
    out.textInputs = await page.$$eval('input[type=text], input:not([type])', els =>
      els.map(e => ({ id: e.id, name: e.name })).filter(x => x.id || x.name)).catch(()=>[]);
    out.checkboxes = await page.$$eval('input[type=checkbox]', els =>
      els.map(e => {
        let lbl = '';
        if (e.id) { const l = document.querySelector(`label[for="${e.id}"]`); if (l) lbl = l.innerText.trim(); }
        return { id: e.id, label: lbl };
      })).catch(()=>[]);
    out.buttons = await page.$$eval('input[type=submit], input[type=button], button', els =>
      els.map(e => ({ id: e.id, value: e.value || e.innerText }))).catch(()=>[]);

    // Attempt search: Town/City + Address + Water Well
    const setByLabelText = async (labelText, value) => {
      const xp = `xpath=//*[contains(normalize-space(text()),"${labelText}")]/following::input[@type="text" or not(@type)][1]`;
      const el = page.locator(xp).first();
      await el.fill(value, { timeout: 8000 });
      return true;
    };
    try { await setByLabelText('Town/City', 'MANCHESTER'); out.setTown = true; } catch(e){ out.setTown = String(e).slice(0,80); }
    try { await setByLabelText('Address', '1335 RIVER'); out.setAddr = true; } catch(e){ out.setAddr = String(e).slice(0,80); }

    // Check "Water Well"
    try { await page.getByLabel('Water Well', { exact: true }).check({ timeout: 8000 }); out.checkedWell = true; }
    catch(e){ out.checkedWell = String(e).slice(0,80); }

    // Submit (Enter/Search button)
    const btn = page.locator('input[type=submit]').first();
    await Promise.all([ page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{}), btn.click().catch(()=>{}) ]);
    await page.waitForTimeout(2500);
    out.afterUrl = page.url();

    const body = await page.evaluate(() => document.body.innerText).catch(()=> '');
    out.resultSample = body.split('\n').map(l=>l.trim()).filter(Boolean).slice(0, 60).join(' | ');
  } catch (e) {
    out.error = String(e);
  } finally {
    console.log(JSON.stringify(out, null, 2));
    await browser.close();
  }
})();
