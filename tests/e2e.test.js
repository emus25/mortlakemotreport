/* Drives the real page in a real browser against the real Code.gs (on the
 * fake Google), checking stage A of SPEC.md from Paul's side of the screen.
 *
 * Needs Playwright:  npm i -D playwright   (or a global install)
 * Run:               node --test tests/e2e.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { start } = require('./serve');
const fx = require('./fixtures');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mortlake-e2e-'));
function tmpFile(name, buf) { const p = path.join(TMP, name); fs.writeFileSync(p, buf); return p; }

const LOG_SEP = tmpFile('Test log by date Sep 2026.xlsx', fx.testLog(2026, 9, 30));
const LOG_SEP_DUR = tmpFile('Test log by duration Sep 2026.xlsx', fx.testLog(2026, 9, 30));
const TQ_SEP = tmpFile('TQI Sep-26.xlsx', fx.testQuality('Sep-26'));
const SCAN_A = tmpFile('scan-a.png', fx.png(60, 85, [240, 240, 235]));
const SCAN_B = tmpFile('scan-b.png', fx.png(60, 85, [230, 236, 240]));
const SCAN_C = tmpFile('scan-c.png', fx.png(85, 60, [235, 230, 240]));
const CERT = tmpFile('cert.png', fx.png(60, 85, [250, 250, 250]));

// Claude, pretending: QC pages get a registration and document type in turn.
function fakeClaude() {
  let n = 0;
  const plan = [['AB12CDE', 'vt20_certificate'], ['AB12CDE', 'inspection_sheet'], ['XY65ZZZ', 'vt20_certificate']];
  const state = { fail: 0 };
  return {
    state,
    claude: (kind) => {
      if (state.fail > 0) { state.fail--; return { http: 400 }; }
      if (kind === 'cert') {
        return { status: 'success', result: { is_calibration_certificate: true, equipment_name: 'Roller Brake Tester',
          serial_number: '80780205', next_due: '31/10/2027', calibrated_on: '01/10/2026', rotation: 0, confidence: 'high' } };
      }
      const [reg, doc] = plan[n++ % plan.length];
      return { status: 'success', result: { category: 'mot_vehicle_paperwork', document_type: doc, registration: reg,
        tester_name: 'T STONE', rotation: 0, confidence: 'high' } };
    }
  };
}

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser.close(); });

/* A fresh browser profile is a fresh computer: nothing in its storage. */
async function newComputer(srv) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.errors = [];
  page.dialogs = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', (d) => { page.dialogs.push(d.message()); d.accept(); });
  await page.goto(srv.url + '/index.html');
  await page.fill('#lockPasswordInput', 'pw');
  await page.click('#lockSubmitBtn');
  await waitReady(page);
  await page.evaluate(() => switchTab('report'));
  return page;
}

async function waitReady(page) {
  await page.waitForFunction(() => {
    const o = document.getElementById('monthOverlay');
    return recordsReady_ && o && o.hidden && !hasPendingSaves_();
  }, null, { timeout: 15000 });
}

async function waitSaved(page) {
  try {
    await page.waitForFunction(() => !hasPendingSaves_() && document.getElementById('syncStatus').textContent === 'All saved ✓',
                               null, { timeout: 15000 });
  } catch (e) {
    const state = await page.evaluate(() => ({ status: document.getElementById('syncStatus').textContent,
      inFlight: savesInFlight_, failed: failedSaves_.map(f => f.label + ': ' + f.message), cl: !!clPending_ || clSaving_,
      eq: eqDirty_ || eqSaving_, unsaved: unsavedCount_() }));
    throw new Error('Never reached "All saved": ' + JSON.stringify(state));
  }
}

async function setMonth(page, m) {
  await page.evaluate((m) => { const el = document.getElementById('fMonth'); el.value = m; el.dispatchEvent(new Event('change')); }, m);
  await page.waitForFunction((m) => currentMonth === m, m);
  await waitReady(page);
}

function details(srv, month) {
  return JSON.parse(srv.backend.drive.readText('Mortlake Garage Records/' + month + '/details.json'));
}

test('Paul fills in September; everything is filed and comes back on another computer', async () => {
  const fc = fakeClaude();
  const srv = await start(0, { claude: fc.claude });
  try {
    const a = await newComputer(srv);
    // The test machine's clock is in October; Paul is doing September's paperwork.
    await setMonth(a, '2026-10');

    // 1. Dropping September's test log while on October offers to switch.
    await a.setInputFiles('#fileLogDate', LOG_SEP);
    await a.waitForFunction(() => currentMonth === '2026-09');
    assert.match(a.dialogs[0], /is for September 2026, but you are working on October 2026/);
    await waitReady(a);
    await a.waitForFunction(() => /Filed in Google Drive/.test(document.getElementById('statusLogDate').textContent));
    await a.setInputFiles('#fileLogDuration', LOG_SEP_DUR);
    await a.setInputFiles('#fileRating', TQ_SEP);
    await a.waitForFunction(() => /Filed in Google Drive/.test(document.getElementById('statusRating').textContent) &&
                                  /Filed in Google Drive/.test(document.getElementById('statusLogDuration').textContent));
    let files = srv.backend.drive.list();
    assert.ok(files.includes('Mortlake Garage Records/2026-09/DVSA files/test-log-by-date.xlsx'));
    assert.ok(files.includes('Mortlake Garage Records/2026-09/DVSA files/test-quality.xlsx'));
    assert.ok(!files.some(f => f.includes('2026-10/DVSA')), 'nothing filed under October');
    assert.equal(details(srv, '2026-09').testQuality.site.tests, 210);
    assert.equal(details(srv, '2026-09').testLog.total, 30);

    // 2. Scans: three pages, sorted and filed.
    await a.setInputFiles('#fileQcScans', [SCAN_A, SCAN_B, SCAN_C]);
    assert.match(await a.textContent('#qcCount'), /0 pages filed · 3 waiting to be read/);
    await a.click('#sortScansBtn');
    await a.waitForFunction(() => savedPages_.qc.length === 3 && savedPages_.qc.every(p => p.status === 'read'));
    assert.match(await a.textContent('#qcSortStatus'), /2 vehicles found across 3 pages/);
    assert.equal(srv.backend.drive.list().filter(f => f.includes('2026-09/QC paperwork/')).length, 3);

    // The same scans again are recognised, not filed or read twice.
    const calls = srv.backend.calls.claude;
    await a.setInputFiles('#fileQcScans', [SCAN_A]);
    await a.click('#sortScansBtn');
    await a.waitForFunction(() => pickedFiles.fileQcScans.length === 0 && !savesInFlight_);
    assert.equal(srv.backend.calls.claude, calls);
    assert.equal(srv.backend.drive.list().filter(f => f.includes('2026-09/QC paperwork/')).length, 3);

    // 3. A calibration certificate.
    await a.setInputFiles('#fileCalCerts', [CERT]);
    await a.click('#readCertsBtn');
    await a.waitForFunction(() => savedPages_.cert.length === 1 && !savesInFlight_);
    assert.match(await a.textContent('#calCertResults'), /Roller Brake Tester/);

    // 4. Checklist answers save on their own.
    await a.evaluate(() => {
      checklistState['0-0'] = 'yes'; checklistState['0-1'] = 'no'; checklistNotes['0-1'] = 'Rota out of date';
      persistChecklistState();
    });
    await waitSaved(a);
    assert.equal(details(srv, '2026-09').checklist.state['0-1'], 'no');
    assert.equal(details(srv, '2026-09').checklist.notes['0-1'], 'Rota out of date');

    // 5. Equipment dates save on their own.
    await a.evaluate(() => {
      const d = document.querySelector('.cal-row .calDate'); d.value = '2027-01-15'; d.dispatchEvent(new Event('input'));
    });
    await waitSaved(a);
    const eq = JSON.parse(srv.backend.drive.readText('Mortlake Garage Records/equipment.json'));
    assert.equal(eq.list[0].date, '2027-01-15');
    assert.deepEqual(a.errors, []);

    // 6. Another computer, nothing in its browser storage.
    const b = await newComputer(srv);
    await setMonth(b, '2026-09');
    await b.waitForFunction(() => Object.keys(TEST_LOGS).length === 2 && TEST_QUALITY && TEST_QUALITY.site.tests === 210);
    const seen = await b.evaluate(() => ({
      qc: savedPages_.qc.length, cert: savedPages_.cert.length,
      checklist: checklistState['0-1'], note: checklistNotes['0-1'],
      date: document.querySelector('.cal-row .calDate').value,
      dvsa: ['statusLogDate', 'statusLogDuration', 'statusRating'].map(id => document.getElementById(id).textContent),
      groups: document.getElementById('qcSortStatus').textContent,
      kpi: document.getElementById('kpiTests').textContent
    }));
    assert.equal(seen.qc, 3);
    assert.equal(seen.cert, 1);
    assert.equal(seen.checklist, 'no');
    assert.equal(seen.note, 'Rota out of date');
    assert.equal(seen.date, '2027-01-15');
    seen.dvsa.forEach(t => assert.match(t, /Filed in Google Drive/));
    assert.match(seen.groups, /2 vehicles found across 3 pages/);
    assert.equal(seen.kpi, '210');

    // 7. The report on the second computer includes the filed pages, fetched from Drive.
    await b.evaluate(() => { CHECKLIST.forEach((c, ci) => c.items.forEach((t, ii) => { checklistState[ci + '-' + ii] = 'yes'; })); persistChecklistState(); });
    await waitSaved(b);
    await b.evaluate(() => handleGenerate());
    await b.waitForFunction(() => document.getElementById('reportPreview').style.display === 'flex', null, { timeout: 15000 });
    const imgs = await b.evaluate(() => document.querySelectorAll('#previewBody .pr-evidence-img').length);
    assert.equal(imgs, 4, '3 QC pages + 1 certificate');
    assert.match(await b.textContent('#previewBody .pr-meta'), /September 2026/);
    assert.deepEqual(b.errors, []);
  } finally { srv.server.close(); }
});

test('a page Claude cannot read is kept and can be retried; a page can be removed', async () => {
  const fc = fakeClaude();
  const srv = await start(0, { claude: fc.claude });
  try {
    const p = await newComputer(srv);
    await setMonth(p, '2026-09');
    fc.state.fail = 1;
    await p.setInputFiles('#fileQcScans', [SCAN_A, SCAN_B]);
    await p.click('#sortScansBtn');
    await p.waitForFunction(() => savedPages_.qc.length === 2 && !savesInFlight_);
    assert.equal(await p.evaluate(() => savedPages_.qc.filter(x => x.status === 'error').length), 1);
    assert.match(await p.textContent('#qcPageList'), /Could not read/);
    let blockers = await p.evaluate(() => reportBlockers_().map(m => m.what).join('|'));
    assert.match(blockers, /1 QC page could not be read/);

    await p.click('#qcPageList summary');
    await p.click('#qcPageList [data-retry]');
    await p.waitForFunction(() => savedPages_.qc.every(x => x.status === 'read'));
    blockers = await p.evaluate(() => reportBlockers_().map(m => m.what).join('|'));
    assert.doesNotMatch(blockers, /could not be read/);

    await p.click('#qcPageList [data-remove]');
    await p.waitForFunction(() => savedPages_.qc.length === 1);
    assert.match(p.dialogs.pop(), /moved to the Removed folder in Google Drive, not deleted/);
    assert.ok(srv.backend.drive.list().some(f => /2026-09\/Removed\/removed .* page-00\d\.jpg$/.test(f)));
    assert.deepEqual(p.errors, []);
  } finally { srv.server.close(); }
});

test('a save that fails says so, blocks the report, and Retry fixes it', async () => {
  const srv = await start(0, fakeClaude());
  try {
    const p = await newComputer(srv);
    await setMonth(p, '2026-09');
    srv.failures.saveDvsaFile = 1;
    await p.setInputFiles('#fileRating', TQ_SEP);
    await p.waitForFunction(() => /not saved/.test(document.getElementById('syncStatus').textContent));
    assert.match(await p.textContent('#statusRating'), /Not saved/);
    const blockers = await p.evaluate(() => reportBlockers_().map(m => m.what).join('|'));
    assert.match(blockers, /not saved/);
    await p.click('#syncStatus .sync-retry');
    await waitSaved(p);
    assert.match(await p.textContent('#statusRating'), /Filed in Google Drive/);
    assert.ok(srv.backend.drive.list().includes('Mortlake Garage Records/2026-09/DVSA files/test-quality.xlsx'));
  } finally { srv.server.close(); }
});

test('two computers: a checklist change made elsewhere is never overwritten', async () => {
  const srv = await start(0, fakeClaude());
  try {
    const a = await newComputer(srv);
    const b = await newComputer(srv);
    await setMonth(a, '2026-09');
    await setMonth(b, '2026-09');
    await a.evaluate(() => { checklistState['0-0'] = 'yes'; persistChecklistState(); });
    await waitSaved(a);
    await b.evaluate(() => { checklistState['0-0'] = 'no'; persistChecklistState(); });
    await b.waitForFunction(() => !hasPendingSaves_());
    assert.match(b.dialogs.pop(), /changed on another computer/);
    assert.equal(details(srv, '2026-09').checklist.state['0-0'], 'yes');
    assert.equal(await b.evaluate(() => checklistState['0-0']), 'yes', 'B now shows the saved answer');
  } finally { srv.server.close(); }
});

test('what was saved before Monthly Records is moved across on first login', async () => {
  const tq = { period: 'Aug-26', site: { tests: 200, failed: 20 }, national: { failed: 28 }, testers: [], failureCategories: [] };
  const srv = await start(0, Object.assign(fakeClaude(), { properties: {
    'DATA_month_2026-08': JSON.stringify({ state: { '0-0': 'yes' }, notes: {} }),
    'DATA_tq_Aug-26': JSON.stringify(tq),
    'DATA_calibration': JSON.stringify([{ name: 'Headlamp Tester', serial: '2245', date: '2026-10-31' }])
  } }));
  try {
    // Paul's browser still holds the test-log totals the old app kept locally.
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      if (!localStorage.getItem('mortlake_report_v1')) {
        localStorage.setItem('mortlake_report_v1', JSON.stringify({ testLog: { '2026-08': { total: 200, passed: 180, failed: 20 } } }));
      }
    });
    const p = await ctx.newPage();
    p.on('dialog', (d) => d.accept());
    await p.goto(srv.url + '/index.html');
    await p.fill('#lockPasswordInput', 'pw');
    await p.click('#lockSubmitBtn');
    await waitReady(p);
    const d = details(srv, '2026-08');
    assert.equal(d.checklist.state['0-0'], 'yes');
    assert.equal(d.testQuality.site.tests, 200);
    assert.equal(d.testLog.total, 200);
    assert.equal(await p.evaluate(() => document.querySelector('.cal-row .calName').value), 'Headlamp Tester');
    assert.ok(srv.backend.props.has('DATA_month_2026-08'), 'old copy left in place');
  } finally { srv.server.close(); }
});

test('a signed month cannot be changed from the page', async () => {
  const srv = await start(0, fakeClaude());
  try {
    const p = await newComputer(srv);
    await setMonth(p, '2026-09');
    await p.evaluate(() => { checklistState['0-0'] = 'yes'; persistChecklistState(); });
    await waitSaved(p);
    // Sign-off is stage B; mark it signed directly to check the lock holds.
    const file = [...srv.backend.drive.items.values()].find(x => x._name === 'details.json');
    const d = JSON.parse(file._bytes.toString()); d.status = 'signed'; file.setContent(JSON.stringify(d));
    await p.evaluate(() => { checklistState['0-1'] = 'yes'; persistChecklistState(); });
    await p.waitForFunction(() => !clPending_ && !clSaving_);
    assert.match(p.dialogs.pop(), /September 2026 is signed off/);
    assert.equal(details(srv, '2026-09').checklist.state['0-1'], undefined);
  } finally { srv.server.close(); }
});

test('opening the app takes two round trips, shows a counter while waiting, and loads files behind the page', async () => {
  // Fill a month first, at normal speed.
  const fast = await start(0, fakeClaude());
  const a = await newComputer(fast);
  await setMonth(a, '2026-09');
  await a.setInputFiles('#fileLogDate', LOG_SEP);
  await a.setInputFiles('#fileRating', TQ_SEP);
  await a.waitForFunction(() => /Filed in Google Drive/.test(document.getElementById('statusRating').textContent) &&
                                /Filed in Google Drive/.test(document.getElementById('statusLogDate').textContent));
  await waitSaved(a);

  // Now make every request take 1.5s, roughly like real Apps Script, and
  // open the app on another computer that last worked on September.
  const SLOW = 1500;
  const slow = await start(0, { latencyMs: SLOW });
  slow.backend.drive.items.clear();
  for (const [k, v] of fast.backend.drive.items) slow.backend.drive.items.set(k, v);
  for (const [k, v] of fast.backend.props) slow.backend.props.set(k, v);
  fast.server.close();
  try {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      if (!localStorage.getItem('mortlake_report_v1')) localStorage.setItem('mortlake_report_v1', JSON.stringify({ selectedMonth: '2026-09' }));
    });
    const b = await ctx.newPage();
    b.on('dialog', (d) => d.accept());
    await b.goto(slow.url + '/index.html');
    await b.fill('#lockPasswordInput', 'pw');
    const t0 = Date.now();
    await b.click('#lockSubmitBtn');
    await b.waitForFunction(() => !document.getElementById('monthOverlay').hidden);
    await b.waitForFunction(() => /\ds/.test(document.getElementById('monthOverlayNote').textContent), null, { timeout: 5000 });
    await b.waitForFunction(() => recordsReady_ && document.getElementById('monthOverlay').hidden, null, { timeout: 15000 });
    const ready = Date.now() - t0;
    assert.deepEqual(slow.log.slice(0, 2), ['checkDashboardPassword', 'openSession']);
    // The request log above is the real check; this guards against something
    // slow creeping in, with room for a busy test machine.
    assert.ok(ready < 4 * SLOW + 2500, 'ready after about two round trips, took ' + ready + 'ms');
    // The files are still arriving behind the page, and the report waits for them.
    assert.match(await b.evaluate(() => reportBlockers_().map(m => m.what).join('|')), /still loading/);
    await b.waitForFunction(() => Object.keys(TEST_LOGS).length === 1 && TEST_QUALITY && TEST_QUALITY.site.tests === 210,
                            null, { timeout: 15000 });
    assert.doesNotMatch(await b.evaluate(() => reportBlockers_().map(m => m.what).join('|')), /still loading/);
    const timings = await b.evaluate(() => recordsTimings.map(t => t.action));
    assert.ok(timings.includes('openSession') && timings.includes('getDvsaFile'));
  } finally { slow.server.close(); }
});

test('login never blames the password when Google does not answer', async () => {
  const srv = await start(0, fakeClaude());
  try {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(srv.url + '/index.html');

    // Google fails: the message must say it is not a password problem.
    srv.failures.checkDashboardPassword = 1;
    await p.fill('#lockPasswordInput', 'pw');
    await p.click('#lockSubmitBtn');
    await p.waitForFunction(() => document.getElementById('lockSubmitBtn').textContent === 'Unlock');
    const msg = await p.textContent('#lockError');
    assert.match(msg, /not a password problem/);
    assert.doesNotMatch(msg, /Incorrect password/);

    // A genuinely wrong password says so.
    await p.fill('#lockPasswordInput', 'nope');
    await p.click('#lockSubmitBtn');
    await p.waitForFunction(() => document.getElementById('lockSubmitBtn').textContent === 'Unlock');
    assert.equal(await p.textContent('#lockError'), 'Incorrect password.');

    // While checking, the previous message is cleared.
    srv.failures.checkDashboardPassword = 0;
    await p.fill('#lockPasswordInput', 'pw');
    await p.click('#lockSubmitBtn');
    assert.equal(await p.textContent('#lockError'), '');
    await waitReady(p);

    // Reopening while Google is down keeps the saved password and doesn't call it wrong.
    srv.failures.checkDashboardPassword = 1;
    await p.reload();
    await p.waitForFunction(() => /not a password problem/.test(document.getElementById('lockError').textContent));
    assert.equal(await p.evaluate(() => localStorage.getItem('mortlake_report_password')), 'pw');
    assert.equal(await p.inputValue('#lockPasswordInput'), 'pw', 'Paul just presses Unlock again');
    await p.click('#lockSubmitBtn');
    await waitReady(p);
  } finally { srv.server.close(); }
});

test('a single hiccup from Google while opening is retried quietly', async () => {
  const srv = await start(0, fakeClaude());
  try {
    srv.failures.openSession = 1;
    const p = await newComputer(srv);       // waits until the app is ready
    assert.deepEqual(srv.log.filter(a => a === 'openSession').length, 2);
    srv.failures.loadMonth = 1;
    await setMonth(p, '2026-09');
    assert.equal(await p.evaluate(() => document.getElementById('monthOverlay').hidden), true);
  } finally { srv.server.close(); }
});

test('a lost reply while a page is being read never makes a filed page look unfiled', async () => {
  const srv = await start(0, fakeClaude());
  try {
    const p = await newComputer(srv);
    await setMonth(p, '2026-09');
    await p.evaluate(() => { READ_POLL_MS = 200; });
    // Page A: Google files and reads it, but the reading reply is lost.
    // Page B: the reading request never reaches Google at all.
    srv.lostReplies.readPage = 1;
    await p.setInputFiles('#fileQcScans', [SCAN_A]);
    await p.click('#sortScansBtn');
    await p.waitForFunction(() => savedPages_.qc.length === 1 && !savesInFlight_);
    assert.equal(await p.evaluate(() => savedPages_.qc[0].status), 'read', 'found out it had been read');
    assert.equal(await p.evaluate(() => unsavedPages_.qc.length), 0);

    srv.failures.readPage = 2;           // never arrives, even when asked again
    await p.setInputFiles('#fileQcScans', [SCAN_B]);
    await p.click('#sortScansBtn');
    await p.waitForFunction(() => savedPages_.qc.length === 2 && !savesInFlight_);
    const b = await p.evaluate(() => savedPages_.qc[1].status);
    assert.equal(b, 'unread', 'filed, not read');
    assert.equal(await p.evaluate(() => unsavedPages_.qc.length), 0, 'it is filed, so nothing is "not saved"');
    assert.match(await p.textContent('#qcPageList'), /waiting to be read/);
    await p.click('#qcPageList summary');
    await p.click('#qcPageList [data-retry]');
    await p.waitForFunction(() => savedPages_.qc.every(x => x.status === 'read'));
    // A lost filing reply is simply tried again and recognised.
    srv.lostReplies.filePage = 1;
    await p.setInputFiles('#fileQcScans', [SCAN_C]);
    await p.click('#sortScansBtn');
    await p.waitForFunction(() => savedPages_.qc.length === 3 && !savesInFlight_ && savedPages_.qc.every(x => x.status === 'read'));
    assert.equal(srv.backend.drive.list().filter(f => f.includes('2026-09/QC paperwork/')).length, 3, 'no duplicate files');
  } finally { srv.server.close(); }
});

test('a reading request that never reached Google is asked for again', async () => {
  const srv = await start(0, fakeClaude());
  try {
    const p = await newComputer(srv);
    await setMonth(p, '2026-09');
    await p.evaluate(() => { READ_POLL_MS = 200; });
    srv.failures.readPage = 1;           // the first request to read never arrives
    await p.setInputFiles('#fileQcScans', [SCAN_A]);
    await p.click('#sortScansBtn');
    await p.waitForFunction(() => savedPages_.qc.length === 1 && !savesInFlight_);
    assert.equal(await p.evaluate(() => savedPages_.qc[0].status), 'read');
  } finally { srv.server.close(); }
});
