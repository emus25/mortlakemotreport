/* Stage B acceptance test (SPEC.md section 14), in a real browser against the
 * REAL TEST back office (real Google Drive, real Claude):
 *   a made-up month is filled in and signed off; then amended with a replaced
 *   DVSA file and an added page. v2 must carry the new figures and the
 *   amendment box, and v1 must be unchanged byte for byte. A second amendment
 *   is cancelled and must leave the month exactly as it was. A second
 *   computer then opens the signed report.
 *
 *   node tests/live-docs.js /tmp/docs
 *   TEST_PASSWORD=… MONTH=2025-01 node tests/live-stageb.js /tmp/docs
 *
 * Use a month that is empty in the TEST records. Writes page 1 of each
 * version to <docs>/v1-page1.png and v2-page1.png for a look. */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const fx = require('./fixtures');
const D = process.argv[2], PASSWORD = process.env.TEST_PASSWORD, MONTH = process.env.MONTH || '2025-01';
if (!D || !PASSWORD) { console.error('Usage: TEST_PASSWORD=… MONTH=YYYY-MM node tests/live-stageb.js <folder made by live-docs.js>'); process.exit(1); }
const T0 = Date.now(); const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(0).padStart(4) + 's', ...a);
const problems = [];
function check(ok, what) { log(ok ? '  ✅' : '  ❌', what); if (!ok) problems.push(what); }

(async () => {
  const [YY, MM] = MONTH.split('-').map(Number);
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][MM - 1];
  const LONG = new Date(YY, MM - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  fs.writeFileSync(D + '/Test log by date.xlsx', fx.testLog(YY, MM, 212));
  fs.writeFileSync(D + '/Test log by duration.xlsx', fx.testLog(YY, MM, 212));
  fs.writeFileSync(D + '/Test log by date (corrected).xlsx', fx.testLog(YY, MM, 215));
  fs.writeFileSync(D + '/Test Quality.xlsx', fx.testQuality(MON + '-' + String(YY).slice(2)));
  // Two "new" pages: real paperwork with one extra byte, so they count as new scans.
  fs.writeFileSync(D + '/LB22FLC-inspection-second-copy.jpg', Buffer.concat([fs.readFileSync(D + '/LB22FLC-inspection.jpg'), Buffer.from([0])]));
  fs.writeFileSync(D + '/WR19KXA-vt20-second-copy.jpg', Buffer.concat([fs.readFileSync(D + '/WR19KXA-vt20.jpg'), Buffer.from([0])]));

  const browser = await chromium.launch(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {});
  async function computer(name) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    p.errors = [];
    p.on('pageerror', e => { p.errors.push(e.message); log(name, 'PAGE ERROR', e.message); });
    p.on('dialog', d => { log(name, '   (asked: "' + d.message().split('\n')[0].slice(0, 90) + '" → OK)'); d.accept(); });
    await p.route('https://mortlakemotreport.exposureboost.co.uk/**', route => {
      const f = path.join(ROOT, decodeURIComponent(new URL(route.request().url()).pathname));
      if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
      route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : 'image/png' });
    });
    await p.goto('https://mortlakemotreport.exposureboost.co.uk/test.html');
    await p.fill('#lockPasswordInput', PASSWORD);
    await p.click('#lockSubmitBtn');
    await p.waitForFunction(() => recordsReady_ && document.getElementById('monthOverlay').hidden && !monthChecking_, null, { timeout: 120000 });
    await p.evaluate(m => { const el = document.getElementById('fMonth'); el.value = m; el.dispatchEvent(new Event('change')); switchTab('report'); }, MONTH);
    await p.waitForFunction(m => currentMonth === m && document.getElementById('monthOverlay').hidden && !monthChecking_ && !dvsaLoading_, MONTH, { timeout: 120000 });
    log(name, 'opened ' + MONTH);
    return p;
  }
  const allSaved = p => p.waitForFunction(() => !hasPendingSaves_() && document.getElementById('syncStatus').textContent === 'All saved ✓', null, { timeout: 300000 });
  async function scan(p, files) {
    const before = await p.evaluate(() => savedPages_.qc.length + unsavedPages_.qc.length);
    let expected = before;
    for (const f of files) expected += /\.pdf$/.test(f) ? 2 : 1;
    await p.setInputFiles('#fileQcScans', files.map(f => D + '/' + f));
    await p.click('#sortScansBtn');
    await p.waitForFunction(n => savedPages_.qc.length + unsavedPages_.qc.length === n && !savesInFlight_, expected, { timeout: 600000 });
  }
  // A signed version, fetched through the back office, with its fingerprint.
  async function fetchVersion(p, v) {
    const t = Date.now();
    const out = await p.evaluate(async ({ month, v }) => {
      let parts = [], i = 0, r;
      let retries = 0, pieces = 1;
      while (i < pieces) {
        r = await apiOnce_('getReport', { month, version: v, index: i });
        if (r.noReply && retries < 4) { retries++; continue; }   // the same patience the app has
        if (r.status !== 'success') return { error: r.message };
        pieces = r.pieces; parts.push(r.data); i++;
      }
      window.__retries = (window.__retries || 0) + retries;
      const bin = atob(parts.join('')); const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      const h = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('');
      const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      const pg = await doc.getPage(1); const vp = pg.getViewport({ scale: 1.4 });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      return { sha: h, size: bytes.length, pages: doc.numPages, page1: c.toDataURL('image/png').split(',')[1], meta: r.version };
    }, { month: MONTH, v });
    if (out.error) throw new Error('could not fetch version ' + v + ': ' + out.error);
    log('   fetched version ' + v + ' in ' + ((Date.now() - t) / 1000).toFixed(0) + 's');
    return out;
  }
  async function signOff(p, label) {
    await p.click('#signOffBtn');
    const blocked = await p.isVisible('#reportBlockers');
    if (blocked && !(await p.isVisible('#signDialog'))) {
      check(false, label + ': Sign off says something is missing: ' + (await p.textContent('#reportBlockers')).slice(0, 300));
      throw new Error('blocked');
    }
    await p.check('#signConfirm');
    await p.fill('#signName', 'Paul Testman (TEST)');
    const t = Date.now();
    await p.click('#signGo');
    await p.waitForFunction(() => /^(Filed|Not signed off)/.test(document.getElementById('signProgressText').textContent), null, { timeout: 600000 });
    const text = await p.textContent('#signProgressText'), sub = await p.textContent('#signProgressSub');
    log('   ' + label + ' took ' + ((Date.now() - t) / 1000).toFixed(0) + 's: ' + text + ' ' + sub);
    await p.click('#signProgressActions .btn-secondary');
    return /^Filed/.test(text);
  }

  try {
    const A = await computer('A');
    log('A fills in ' + LONG + ': 3 DVSA files, 8 pages for 3 cars (one electric), the checklist with one NO');
    await A.setInputFiles('#fileLogDate', D + '/Test log by date.xlsx');
    await A.setInputFiles('#fileLogDuration', D + '/Test log by duration.xlsx');
    await A.setInputFiles('#fileRating', D + '/Test Quality.xlsx');
    await scan(A, ['LB22FLC-vt20.jpg', 'LB22FLC-inspection.jpg', 'LB22FLC-emissions.jpg', 'WR19KXA-vt20.jpg',
                   'WR19KXA-emissions.jpg', 'WR19KXA-inspection-sideways.jpg', 'GN71TVZ-scan.pdf']);
    await A.evaluate(() => {
      CHECKLIST.forEach((c, ci) => c.items.forEach((t, ii) => { checklistState[ci + '-' + ii] = 'yes'; }));
      checklistState['2-0'] = 'no'; checklistNotes['2-0'] = 'Sign faded; replacement ordered';
      persistChecklistState();
    });
    await allSaved(A);
    const blockers = await A.evaluate(() => signOffBlockers_().map(b => b.what));
    check(blockers.length === 0, 'nothing missing' + (blockers.length ? ': ' + blockers.join(' | ') : ''));

    log('A signs off');
    check(await signOff(A, 'sign-off'), 'filed and signed off');
    check(/is signed off\. Version 1/.test(await A.textContent('#monthBanner')), 'banner: signed off, version 1');
    check(await A.evaluate(() => document.body.classList.contains('month-locked')), 'the month is locked on screen');
    if (!(await A.evaluate(() => monthStatus_() === 'signed'))) throw new Error('not signed, so stopping here');
    const locked = await A.evaluate(m => api_('saveMonthFields', { month: m, field: 'checklist', value: { state: {}, notes: {} }, baseRevision: checklistRev_[m] }), MONTH);
    check(locked.status === 'locked', 'Google itself refuses a change to the signed month (' + locked.status + ')');
    const v1 = await fetchVersion(A, 1);
    fs.writeFileSync(D + '/v1-page1.png', Buffer.from(v1.page1, 'base64'));
    log('   v1: ' + v1.pages + ' pages, ' + (v1.size / 1048576).toFixed(1) + 'MB, ' + v1.meta.fileName);

    log('A amends: replaces the test log and adds a page');
    await A.click('#monthBanner button:text-is("Amend")');
    await A.check('#amendConfirm');
    await A.fill('#amendReason', 'Corrected test log export; second inspection sheet for LB22FLC found');
    await A.click('#amendGo');
    await A.waitForFunction(() => monthStatus_() === 'amending', null, { timeout: 120000 });
    check(true, 'amendment started');
    await A.setInputFiles('#fileLogDate', D + '/Test log by date (corrected).xlsx');
    await scan(A, ['LB22FLC-inspection-second-copy.jpg']);
    await allSaved(A);
    check(await signOff(A, 'amendment sign-off'), 'v2 filed');
    const v2 = await fetchVersion(A, 2);
    fs.writeFileSync(D + '/v2-page1.png', Buffer.from(v2.page1, 'base64'));
    log('   v2: ' + v2.pages + ' pages, ' + (v2.size / 1048576).toFixed(1) + 'MB, ' + v2.meta.fileName);
    const v1again = await fetchVersion(A, 1);
    check(v1again.sha === v1.sha && v1again.size === v1.size, 'v1 is unchanged byte for byte');
    check(v2.meta.reason && /Corrected test log/.test(v2.meta.reason), 'v2 carries the reason');
    const d2 = (await A.evaluate(m => api_('loadMonth', { month: m }), MONTH)).details;
    check(d2.versions.length === 2 && d2.signedVersion === 2, 'two versions, v2 is the current one');
    check(d2.testLog && d2.testLog.total === 215, 'v2 has the new figures (215 tests, was 212): ' + (d2.testLog && d2.testLog.total));
    check(d2.history.some(h => /Replaced Test log \(by date\)/.test(h.what)) && d2.history.some(h => /Added QC page/.test(h.what) && /second-copy/.test(h.what)),
          'the history records the replaced file and the added page');

    log('A starts another amendment, adds a page, then cancels');
    const pagesBefore = d2.qcPages.length;
    await A.click('#monthBanner button:text-is("Amend")');
    await A.check('#amendConfirm');
    await A.fill('#amendReason', 'Trying something that turns out to be wrong');
    await A.click('#amendGo');
    await A.waitForFunction(() => monthStatus_() === 'amending', null, { timeout: 120000 });
    await scan(A, ['WR19KXA-vt20-second-copy.jpg']);
    await allSaved(A);
    await A.click('#monthBanner button:text-is("Cancel amendment")');
    await A.waitForFunction(() => monthStatus_() === 'signed' && document.getElementById('monthOverlay').hidden, null, { timeout: 120000 });
    const d3 = (await A.evaluate(m => api_('loadMonth', { month: m }), MONTH)).details;
    check(d3.status === 'signed' && d3.qcPages.length === pagesBefore, 'back to signed, ' + d3.qcPages.length + ' pages as before');
    check(d3.versions.length === 2, 'no new version was made');
    check((await fetchVersion(A, 1)).sha === v1.sha && (await fetchVersion(A, 2)).sha === v2.sha, 'both signed PDFs unchanged');
    check(A.errors.length === 0, 'no errors on the page');

    log('A comes back to the app on the same computer');
    let t0 = Date.now();
    await A.reload();
    await A.waitForFunction(() => monthDoc_ && savedPages_.qc.length > 0, null, { timeout: 120000 });
    const shownIn = (Date.now() - t0) / 1000;
    await A.waitForFunction(() => recordsReady_ && !monthChecking_ && document.getElementById('monthOverlay').hidden && !dvsaLoading_, null, { timeout: 120000 });
    check(true, 'the month is on screen in ' + shownIn.toFixed(1) + 's and confirmed with Google in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    t0 = Date.now();
    await A.click('#monthBanner button:text-is("Open report")');
    await A.waitForSelector('#pdfViewerBody iframe', { timeout: 120000 });
    check(true, 'the signed report opens on this computer in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    await A.click('#pdfViewerActions >> text=Back');

    const B = await computer('B');
    check(/is signed off\. Version 2/.test(await B.textContent('#monthBanner')), 'another computer sees it signed off, version 2');
    const t = Date.now();
    await B.click('#monthBanner button:text-is("Open report")');
    await B.waitForSelector('#pdfViewerBody iframe', { timeout: 120000 });
    check(true, 'another computer opens the signed report in ' + ((Date.now() - t) / 1000).toFixed(0) + 's');
    check(B.errors.length === 0, 'no errors on the page');
  } catch (e) {
    log('STOPPED', e.message);
    problems.push('STOPPED: ' + e.message);
  }
  log(problems.length ? 'PROBLEMS: ' + problems.length : 'ALL CHECKS PASSED');
  problems.forEach(p => log('  - ' + p));
  await browser.close();
})();
