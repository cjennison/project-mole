const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const out = {};
  const WAIT = 'domcontentloaded';
  const submit = () => page.evaluate(() => document.getElementById('MainContent_btnSubmit').click());

  async function tryMblu(map, block, lot) {
    await page.goto('https://gis.vgsi.com/manchesternh/Search.aspx', { waitUntil: WAIT, timeout: 60000 });
    await page.waitForSelector('#MainContent_ddlSearchSource', { timeout: 30000 });
    await page.selectOption('#MainContent_ddlSearchSource', '3');
    await page.waitForTimeout(1200);
    if (map)   await page.fill('#MainContent_txtM', map).catch(()=>{});
    if (block) await page.fill('#MainContent_txtB', block).catch(()=>{});
    if (lot)   await page.fill('#MainContent_txtL', lot).catch(()=>{});
    await Promise.all([ page.waitForNavigation({ waitUntil: WAIT, timeout: 60000 }).catch(()=>{}), submit() ]);
    await page.waitForTimeout(1500);
    if (/Search\.aspx/i.test(page.url())) {
      const link = await page.$('a[href*="Parcel.aspx"]');
      if (link) { await Promise.all([ page.waitForNavigation({ waitUntil: WAIT, timeout: 60000 }).catch(()=>{}), link.click() ]); }
    }
    return /Parcel\.aspx/i.test(page.url());
  }

  try {
    let ok = await tryMblu('222', '', '83');
    if (!ok) ok = await tryMblu('222', '83', '');
    if (!ok) ok = await tryMblu('0222', '', '0083');
    out.reachedParcel = ok;
    out.url = page.url();

    const spans = await page.$$eval('span[id*="lbl"], span[id*="Lbl"]', els =>
      els.map(e => ({ id: e.id.replace('MainContent_',''), t: (e.innerText||'').trim() }))
         .filter(x => x.t && x.t.length < 140)
    ).catch(()=>[]);
    out.spans = spans;

    const body = await page.evaluate(() => document.body.innerText).catch(()=> '');
    out.bodySample = body.split('\n').map(l=>l.trim()).filter(Boolean).slice(0, 80).join(' | ');
  } catch (e) {
    out.error = String(e);
  } finally {
    console.log(JSON.stringify(out, null, 2));
    await browser.close();
  }
})();
