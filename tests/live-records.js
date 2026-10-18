/* Stage C acceptance test (SPEC.md section 14: "show me July"), in a real
 * browser against the REAL TEST back office. Nothing is changed in the records.
 *
 *   TEST_PASSWORD=… MONTH=2026-07 node tests/live-records.js
 *
 * MONTH must be a signed month in the TEST records. It checks:
 *   - the Records screen draws at once and agrees with Google's month list;
 *   - a signed month says who signed it and when;
 *   - on a computer that has never seen the report, Open report fetches it
 *     (timed);
 *   - Paul's computer keeps copies of signed reports in the background, so
 *     Records → year → month → Open report takes under 10 seconds. */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const PASSWORD = process.env.TEST_PASSWORD, MONTH = process.env.MONTH || '2026-07';
if (!PASSWORD) { console.error('Usage: TEST_PASSWORD=… MONTH=YYYY-MM node tests/live-records.js'); process.exit(1); }
const T0 = Date.now(); const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(0).padStart(4) + 's', ...a);
const secs = t => ((Date.now() - t) / 1000).toFixed(1) + 's';
const problems = [];
function check(ok, what) { log(ok ? '  ✅' : '  ❌', what); if (!ok) problems.push(what); }

(async () => {
  const browser = await chromium.launch(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {});
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', e => { p.errors.push(e.message); log('PAGE ERROR', e.message); });
  p.on('dialog', d => d.accept());
  await p.route('https://mortlakemotreport.exposureboost.co.uk/**', route => {
    const f = path.join(ROOT, decodeURIComponent(new URL(route.request().url()).pathname));
    if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : 'image/png' });
  });
  const ready = () => p.waitForFunction(() => recordsReady_ && document.getElementById('monthOverlay').hidden && !monthChecking_, null, { timeout: 120000 });

  // A computer that has never seen the app.
  await p.goto('https://mortlakemotreport.exposureboost.co.uk/test.html');
  let t = Date.now();
  await p.fill('#lockPasswordInput', PASSWORD);
  await p.click('#lockSubmitBtn');
  await ready();
  log('logged in and opened in ' + secs(t));
  check(await p.evaluate(() => { const w = document.getElementById('backendWarning'); return !w || w.style.display !== 'block'; }), 'the back office is up to date (no version warning)');

  // Records: drawn at once from what start-up brought, then refreshed.
  t = Date.now();
  await p.click('#tab-records');
  await p.waitForSelector('.rec-tile');
  log('Records drawn in ' + secs(t));
  await p.waitForFunction(() => !recRefreshing_, null, { timeout: 60000 });
  log('Google\'s month list arrived in ' + secs(t));
  const year = MONTH.slice(0, 4);
  await p.click('.rec-year[data-year="' + year + '"]');
  const tiles = await p.$$eval('.rec-tile', ts => ts.map(x => x.dataset.month + ' ' + x.className.replace('rec-tile', '').trim() + ': ' + x.innerText.replace(/\n/g, ' · ')));
  tiles.forEach(x => log('     ' + x));
  const tile = await p.textContent('.rec-tile[data-month="' + MONTH + '"]');
  check(/(Signed|Amended) \d\d \w{3}/.test(tile), MONTH + ' shows when it was signed: ' + tile.replace(/\s+/g, ' '));

  await p.click('.rec-tile[data-month="' + MONTH + '"]');
  const panel = await p.textContent('#recPanel');
  check(/(Signed off|Amended and signed off) \d+ \w+ \d{4} by \S/.test(panel), 'the panel says who signed it and when');
  check(await p.isVisible('#recPanel >> text=Open folder in Google Drive'), 'there is a link to the month folder');

  // This computer has no copy yet: the report comes from Google.
  const had = await p.evaluate(m => cacheGet_('report:' + m + ':v' + recordsIndex_[m].versions.slice(-1)[0].version).then(Boolean), MONTH);
  t = Date.now();
  await p.click('#recPanel >> text=Open report');
  await p.waitForSelector('#pdfViewerBody iframe', { timeout: 180000 });
  log('report opened ' + (had ? 'from this computer' : 'from Google') + ' in ' + secs(t));
  check(/^(Signed off|Amended) .* by \S/.test(await p.textContent('#pdfViewerSub')), 'the viewer says who signed it');
  await p.click('#pdfViewerActions >> text=Back');

  // Paul's computer copies every signed report in the background.
  t = Date.now();
  const all = await p.evaluate(() => Object.keys(recordsIndex_).filter(m => (recordsIndex_[m].versions || []).length && recordsIndex_[m].status !== 'draft'));
  log('signed months to copy: ' + all.join(', '));
  await p.waitForFunction(async () => {
    const ms = Object.keys(recordsIndex_).filter(m => (recordsIndex_[m].versions || []).length && recordsIndex_[m].status !== 'draft');
    for (const m of ms) if (!(await cacheGet_('report:' + m + ':v' + recordsIndex_[m].versions.slice(-1)[0].version))) return false;
    return true;
  }, null, { timeout: 900000, polling: 2000 });
  log('all ' + all.length + ' signed reports copied to this computer in ' + secs(t));

  // "Show me July", on Paul's computer: a fresh start of the app.
  await p.reload();
  await ready();
  t = Date.now();
  await p.click('#tab-records');
  await p.click('.rec-year[data-year="' + year + '"]');
  await p.click('.rec-tile[data-month="' + MONTH + '"]');
  await p.click('#recPanel >> text=Open report');
  await p.waitForSelector('#pdfViewerBody iframe', { timeout: 180000 });
  const took = (Date.now() - t) / 1000;
  check(took < 10, '"show me ' + MONTH + '": Records → ' + year + ' → month → Open report took ' + took.toFixed(1) + 's (under 10s)');

  check(p.errors.length === 0, 'no page errors');
  await browser.close();
  console.log(problems.length ? '\n❌ ' + problems.length + ' problem(s):\n - ' + problems.join('\n - ') : '\n✅ All good.');
  process.exit(problems.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
