/* A whole made-up month, end to end, in a real browser against the REAL TEST
 * back office (real Google Drive, real Claude): three DVSA files, nine pages
 * of realistic sample paperwork for three cars (one sheet scanned sideways,
 * one car electric, one handwritten QC note), a blank page removed by
 * mistake, a calibration certificate, the full checklist, the report, and
 * then a second computer opening it all from scratch.
 *
 *   node tests/live-docs.js /tmp/docs
 *   TEST_PASSWORD=… MONTH=2026-05 node tests/live-month.js /tmp/docs
 *
 * Use a month that is empty in the TEST records. */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const fx = require('./fixtures');
const D = process.argv[2], PASSWORD = process.env.TEST_PASSWORD, MONTH = process.env.MONTH || '2026-05';
if (!D || !PASSWORD) { console.error('Usage: TEST_PASSWORD=… node tests/live-month.js <folder made by live-docs.js>'); process.exit(1); }
const T0 = Date.now(); const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(0).padStart(4) + 's', ...a);
const problems = [];
function check(ok, what) { log(ok ? '  ✅' : '  ❌', what); if (!ok) problems.push(what); }

(async () => {
  const [YY, MM] = MONTH.split('-').map(Number);
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][MM - 1];
  const LONG = new Date(YY, MM - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  fs.writeFileSync(D + '/Test log by date.xlsx', fx.testLog(YY, MM, 212));
  fs.writeFileSync(D + '/Test log by duration.xlsx', fx.testLog(YY, MM, 212));
  fs.writeFileSync(D + '/Test Quality.xlsx', fx.testQuality(MON + '-' + String(YY).slice(2)));
  fs.writeFileSync(D + '/blank-page.png', fx.png(400, 560, [252, 252, 252]));

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
    const t = Date.now(); await p.click('#lockSubmitBtn');
    await p.waitForFunction(() => recordsReady_ && document.getElementById('monthOverlay').hidden && !monthChecking_, null, { timeout: 120000 });
    log(name, 'logged in, app ready in ' + ((Date.now() - t) / 1000).toFixed(1) + 's');
    await p.evaluate(m => { const el = document.getElementById('fMonth'); el.value = m; el.dispatchEvent(new Event('change')); switchTab('report'); }, MONTH);
    await p.waitForFunction(m => currentMonth === m && document.getElementById('monthOverlay').hidden && !monthChecking_, MONTH, { timeout: 120000 });
    log(name, 'opened ' + MONTH);
    return p;
  }
  const allSaved = p => p.waitForFunction(() => !hasPendingSaves_() && document.getElementById('syncStatus').textContent === 'All saved ✓', null, { timeout: 300000 });
  const txt = (p, sel) => p.textContent(sel);

  try {
    // ── Computer A: Paul does May ──
    const A = await computer('A');

    log('A adds the three DVSA files');
    await A.setInputFiles('#fileLogDate', D + '/Test log by date.xlsx');
    await A.setInputFiles('#fileLogDuration', D + '/Test log by duration.xlsx');
    await A.setInputFiles('#fileRating', D + '/Test Quality.xlsx');
    await A.waitForFunction(() => ['statusLogDate', 'statusLogDuration', 'statusRating'].every(id => /Filed in Google Drive|Not saved/.test(document.getElementById(id).textContent)), null, { timeout: 180000 });
    for (const id of ['statusLogDate', 'statusLogDuration', 'statusRating']) check(/Filed in Google Drive/.test(await txt(A, '#' + id)), (await txt(A, '#' + id)).replace('Filed', ' · Filed'));

    log('A adds 9 pages of QC paperwork (3 cars, one sheet sideways, one PDF) plus a blank page by mistake, and presses Sort');
    await A.setInputFiles('#fileQcScans', ['LB22FLC-vt20.jpg', 'LB22FLC-inspection.jpg', 'LB22FLC-emissions.jpg', 'WR19KXA-vt20.jpg',
      'WR19KXA-emissions.jpg', 'WR19KXA-inspection-sideways.jpg', 'GN71TVZ-scan.pdf', 'blank-page.png'].map(f => D + '/' + f));
    let t = Date.now();
    await A.click('#sortScansBtn');
    // Since v19 the readings appear first and the pages are filed behind them.
    await A.waitForFunction(() => savedPages_.qc.length + unsavedPages_.qc.length >= 9 && document.getElementById('sortScansBtn').textContent !== 'Reading…', null, { timeout: 600000 });
    log('   results on screen in ' + ((Date.now() - t) / 1000).toFixed(0) + 's' +
        ((await A.isVisible('#savingPanel')) ? ' (tyre panel showing: ' + (await txt(A, '#savingPanel')) + ')' : ''));
    await A.waitForFunction(() => savedPages_.qc.length + unsavedPages_.qc.length === 9 && !savesInFlight_, null, { timeout: 600000 });
    log('   all filed in Google Drive in ' + ((Date.now() - t) / 1000).toFixed(0) + 's');
    const pages = await A.evaluate(() => savedPages_.qc.map(p => ({ src: p.sourceName, status: p.status, reg: p.reading && p.reading.registration, doc: p.reading && p.reading.document_type, rot: p.reading && p.reading.rotation, ev: p.reading && p.reading.is_electric, qc: p.reading && p.reading.qc_flag })));
    pages.forEach(p => log('     ' + p.src.padEnd(34) + ' ' + p.status + '  ' + (p.reg || '—') + '  ' + (p.doc || '') + (p.rot ? '  rotate ' + p.rot + '°' : '') + (p.ev ? '  electric' : '') + (p.qc ? '  QC-marked' : '')));
    check(pages.length === 9 && pages.every(p => p.status === 'read'), 'all 9 pages filed and read');
    const groups = await txt(A, '#qcSortStatus');
    log('   screen says: ' + groups);
    check(/3 vehicles/.test(groups), 'three vehicles found');
    const groupText = await txt(A, '#qcGroupsContainer');
    check(/LB22FLC[\s\S]*Complete set/.test(groupText), 'Focus LB22FLC: complete set');
    check(/WR19KXA[\s\S]*Complete set/.test(groupText), 'Golf WR19KXA: complete set (including the sideways sheet)');
    check(/GN71TVZ[\s\S]*Electric/.test(groupText), 'Tesla GN71TVZ: recognised as electric, no emissions test needed');
    check(pages.some(p => /sideways/.test(p.src) && p.rot === 270), 'sideways sheet (title on the right) will be turned the right way: 270° (got ' + (pages.find(p => /sideways/.test(p.src)) || {}).rot + ')');
    check(pages.some(p => /LB22FLC-vt20/.test(p.src) && p.qc), 'handwritten "QC check" note spotted on the Focus certificate');

    log('A removes the blank page');
    const blankId = await A.evaluate(() => (savedPages_.qc.find(p => /blank/.test(p.sourceName)) || {}).id);
    const before = await A.evaluate(() => savedPages_.qc.length);
    await A.click('#qcPageList summary');
    await A.click(`#qcPageList [data-remove="${blankId}"]`);
    await A.waitForFunction(n => savedPages_.qc.length === n - 1, before, { timeout: 120000 });
    check(true, 'blank page removed (moved to the Removed folder)');

    log('A adds the calibration certificate and presses Read');
    await A.setInputFiles('#fileCalCerts', D + '/calibration-cert-brake-tester.jpg');
    await A.click('#readCertsBtn');
    await A.waitForFunction(() => savedPages_.cert.length === 1 && !savesInFlight_ && document.getElementById('readCertsBtn').textContent !== 'Reading…', null, { timeout: 300000 });
    const certText = await txt(A, '#calCertResults');
    log('   screen says: ' + certText.replace(/\s+/g, ' ').slice(0, 160));
    check(/Roller Brake Tester/i.test(certText) && /80780205/.test(certText), 'certificate read: roller brake tester, serial 80780205');
    const upd = await A.$('#calCertResults button[data-cert]');
    check(!!upd, 'matched to the equipment list and offers to update the due date');
    if (upd) { await upd.click(); }
    await A.waitForTimeout(500);
    const brakeDate = await A.evaluate(() => [...document.querySelectorAll('.cal-row')].find(r => r.querySelector('.calSerial').value === '80780205').querySelector('.calDate').value);
    check(brakeDate === '2027-05-14', 'brake tester next due date updated to 14 May 2027 (was ' + brakeDate + ')');

    log('A answers the whole checklist (two answers NO, with notes)');
    await A.evaluate(() => {
      CHECKLIST.forEach((c, ci) => c.items.forEach((x, ii) => { checklistState[ci + '-' + ii] = 'yes'; }));
      checklistState['2-2'] = 'no'; checklistNotes['2-2'] = 'Triangle sign faded — replacement ordered 15 May';
      checklistState['13-1'] = 'no'; checklistNotes['13-1'] = 'CCTV monitor flickering, engineer booked';
      persistChecklistState(); renderChecklist(); updateProgress();
    });
    t = Date.now(); await allSaved(A);
    check(true, 'everything saved ("All saved ✓") in ' + ((Date.now() - t) / 1000).toFixed(0) + 's');

    log('A generates the report');
    const blockers = await A.evaluate(() => reportBlockers_().map(m => m.what));
    check(blockers.length === 0, 'nothing blocking the report' + (blockers.length ? ': ' + blockers.join('; ') : ''));
    t = Date.now();
    await A.evaluate(() => handleGenerate());
    await A.waitForFunction(() => document.getElementById('reportPreview').style.display === 'flex', null, { timeout: 300000 });
    log('   report ready in ' + ((Date.now() - t) / 1000).toFixed(0) + 's');
    const rep = await A.evaluate(() => {
      const b = document.getElementById('previewBody');
      return { head: b.querySelector('.pr-meta').innerText, imgs: b.querySelectorAll('.pr-evidence-img').length,
               text: b.innerText, kpiTests: (b.innerText.match(/Tests carried out\s*(\d+)/) || [])[1] };
    });
    log('   report header: ' + rep.head.replace(/\n/g, ' | '));
    check(rep.head.indexOf(LONG) > -1 && /Tests 0?1 \w+ \d{4} – 28 \w+ \d{4}/.test(rep.head), 'report is dated ' + LONG + ' with the test date range');
    check(rep.imgs === 9, 'report includes all 9 scanned pages (8 QC + 1 certificate): ' + rep.imgs);
    check(/LB22FLC/.test(rep.text) && /WR19KXA/.test(rep.text) && /GN71TVZ/.test(rep.text), 'all three cars named in the report');
    check(/Triangle sign faded/.test(rep.text) && /CCTV monitor flickering/.test(rep.text), 'the two NO answers and their notes are in the report');
    check(/210/.test(rep.text), 'DVSA figures (210 tests) in the report');
    await A.screenshot({ path: D + '/report-page1.png' });
    // The sideways sheet should now be upright in the report.
    const sideways = await A.evaluate(() => {
      const pages = [...document.querySelectorAll('#previewBody .pr-evidence-page')];
      const pg = pages.find(x => /sideways/.test(x.innerText));
      if (!pg) return null;
      pg.scrollIntoView(); const im = pg.querySelector('img');
      return { w: im.naturalWidth, h: im.naturalHeight };
    });
    check(sideways && sideways.h > sideways.w, 'sideways sheet is printed upright in the report (' + (sideways && sideways.w + '×' + sideways.h) + ')');
    await A.waitForTimeout(300); await A.screenshot({ path: D + '/report-sideways.png' });
    check(A.errors.length === 0, 'no errors on the page');

    // ── Computer B: opens May from scratch ──
    log('B (another computer, nothing saved in its browser) opens the app');
    const B = await computer('B');
    await B.waitForFunction(() => Object.keys(TEST_LOGS).length === 2 && TEST_QUALITY && TEST_QUALITY.site && !dvsaLoading_, null, { timeout: 180000 });
    const seen = await B.evaluate(() => ({ qc: savedPages_.qc.length, cert: savedPages_.cert.length,
      answered: Object.keys(checklistState).filter(k => checklistState[k]).length, note: checklistNotes['13-1'],
      groups: document.getElementById('qcSortStatus').textContent,
      brake: [...document.querySelectorAll('.cal-row')].find(r => r.querySelector('.calSerial').value === '80780205').querySelector('.calDate').value }));
    check(seen.qc === 8 && seen.cert === 1, 'B sees 8 QC pages and 1 certificate');
    check(seen.answered === 61 && /CCTV/.test(seen.note || ''), 'B sees all 61 checklist answers and the notes');
    check(/3 vehicles/.test(seen.groups), 'B sees the 3 vehicles sorted');
    check(seen.brake === '2027-05-14', 'B sees the updated brake tester date');
    t = Date.now();
    await B.evaluate(() => handleGenerate());
    await B.waitForFunction(() => document.getElementById('reportPreview').style.display === 'flex', null, { timeout: 300000 });
    const imgsB = await B.evaluate(() => document.querySelectorAll('#previewBody .pr-evidence-img').length);
    check(imgsB === 9, 'B generates the same report, pages fetched from Google Drive (' + ((Date.now() - t) / 1000).toFixed(0) + 's)');
    check(B.errors.length === 0, 'no errors on the page');
    const tm = await B.evaluate(() => recordsTimings.map(x => x.action + ' ' + (x.totalMs / 1000).toFixed(1) + 's'));
    log('B request times: ' + tm.join(', '));
  } catch (e) { problems.push('STOPPED: ' + e.message.split('\n')[0]); log('STOPPED', e.message.split('\n')[0]); }
  log(problems.length ? 'PROBLEMS: ' + problems.length : 'ALL CHECKS PASSED');
  problems.forEach(p => log('  - ' + p));
  await browser.close();
})();
