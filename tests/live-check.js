/* Runs the real flow in a real browser against the REAL TEST back office
 * (real Google Drive, real Claude), using the scratch month June 2026 in the
 * TEST records. Run this before asking anyone to try a change.
 *
 *   TEST_PASSWORD=… node tests/live-check.js
 *
 * Needs script.google.com and script.googleusercontent.com in the
 * environment's allowed domains, and test.html made from the latest
 * index.html (node tools/make-test-copy.js <url>). */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const fx = require('./fixtures');
const ROOT = path.join(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mortlake-live-'));
const PASSWORD = process.env.TEST_PASSWORD;
if (!PASSWORD) { console.error('Set TEST_PASSWORD (ask Ediz; never commit it).'); process.exit(1); }
const T0 = Date.now(); const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(1) + 's', ...a);


(async () => {
  const files = {
    log: path.join(OUT, 'Test log by date Jun 2026.xlsx'), tq: path.join(OUT, 'TQI Jun-26.xlsx'),
    a: path.join(OUT, 'scan-a.png'), b: path.join(OUT, 'scan-b.png')
  };
  fs.writeFileSync(files.log, fx.testLog(2026, 6, 30)); fs.writeFileSync(files.tq, fx.testQuality('Jun-26'));
  fs.writeFileSync(files.a, fx.png(300, 420, [244, 243, 238])); fs.writeFileSync(files.b, fx.png(300, 420, [238, 242, 246]));

  const browser = await chromium.launch(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {});
  async function computer(name) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const p = await ctx.newPage();
    // Serve the site's own files from this repo at the real address.
    await p.route('https://mortlakemotreport.exposureboost.co.uk/**', route => {
      const f = path.join(ROOT, decodeURIComponent(new URL(route.request().url()).pathname));
      if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
      route.fulfill({ status: 200, body: fs.readFileSync(f),
        contentType: f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : f.endsWith('.png') ? 'image/png' : 'application/octet-stream' });
    });
    p.on('pageerror', e => log(name, 'PAGE ERROR', e.message));
    p.on('dialog', d => { log(name, 'dialog:', d.message().slice(0, 120)); d.accept(); });
    p.on('console', m => { if (/\[records\]/.test(m.text())) log(name, m.text()); });
    await p.goto('https://mortlakemotreport.exposureboost.co.uk/test.html');
    await p.fill('#lockPasswordInput', PASSWORD);
    const t = Date.now();
    await p.click('#lockSubmitBtn');
    await p.waitForFunction(() => (recordsReady_ && document.getElementById('monthOverlay').hidden) ||
      (!document.getElementById('monthOverlayRetry').hidden) || document.getElementById('lockError').textContent, null, { timeout: 120000 });
    const err = await p.evaluate(() => document.getElementById('lockError').textContent || (!document.getElementById('monthOverlayRetry').hidden && document.getElementById('monthOverlayText').textContent));
    if (err) { log(name, 'FAILED TO OPEN:', err); await p.screenshot({ path: OUT + '/fail-' + name + '.png' }); throw new Error(err); }
    log(name, 'app ready in', ((Date.now() - t) / 1000).toFixed(1) + 's');
    await p.evaluate(() => switchTab('report'));
    return p;
  }
  async function month(p, m) {
    await p.evaluate(m => { const el = document.getElementById('fMonth'); el.value = m; el.dispatchEvent(new Event('change')); }, m);
    await p.waitForFunction(m => currentMonth === m && document.getElementById('monthOverlay').hidden && !monthChecking_, m, { timeout: 120000 });
  }
  const saved = (p) => p.waitForFunction(() => !hasPendingSaves_() && document.getElementById('syncStatus').textContent === 'All saved ✓', null, { timeout: 180000 });

  try {
    const A = await computer('A');
    await month(A, '2026-06'); log('A opened June');
    await A.setInputFiles('#fileLogDate', files.log);
    await A.setInputFiles('#fileRating', files.tq);
    await A.waitForFunction(() => /Filed in Google Drive|Not saved/.test(document.getElementById('statusRating').textContent) &&
                                  /Filed in Google Drive|Not saved/.test(document.getElementById('statusLogDate').textContent), null, { timeout: 120000 });
    log('A DVSA:', await A.textContent('#statusLogDate'), '|', await A.textContent('#statusRating'));
    await A.setInputFiles('#fileQcScans', [files.a, files.b]);
    await A.click('#sortScansBtn');
    await A.waitForFunction(() => savedPages_.qc.length + unsavedPages_.qc.length === 2 && !savesInFlight_, null, { timeout: 240000 });
    log('A scans:', JSON.stringify(await A.evaluate(() => savedPages_.qc.map(p => [p.sourceName, p.status, p.error]))));
    await A.evaluate(() => { checklistState['0-0'] = 'yes'; checklistState['0-1'] = 'no'; checklistNotes['0-1'] = 'live test note'; persistChecklistState(); });
    await saved(A);
    log('A says:', await A.textContent('#syncStatus'));
    await A.screenshot({ path: OUT + '/A.png', fullPage: false });

    const B = await computer('B');
    await month(B, '2026-06'); log('B opened June');
    await B.waitForFunction(() => Object.keys(TEST_LOGS).length === 1 && TEST_QUALITY && TEST_QUALITY.site, null, { timeout: 120000 });
    log('B sees:', JSON.stringify(await B.evaluate(() => ({ pages: savedPages_.qc.length, note: checklistNotes['0-1'], ans: checklistState['0-1'],
      tests: TEST_QUALITY.site.tests, dvsa: document.getElementById('statusRating').textContent }))));
    log('timings:', JSON.stringify(await B.evaluate(() => recordsTimings)));
  } catch (e) { log('STOPPED:', e.message); }
  await browser.close();
})();
