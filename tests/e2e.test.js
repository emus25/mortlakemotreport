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
const LOG_SEP_DUR = tmpFile('Test log by duration Sep 2026.xlsx', fx.testLog(2026, 9, 30, 'duration'));
const TQ_SEP = tmpFile('TQI Sep-26.xlsx', fx.testQuality('Sep-26'));
const SCAN_A = tmpFile('scan-a.png', fx.png(60, 85, [240, 240, 235]));
const SCAN_B = tmpFile('scan-b.png', fx.png(60, 85, [230, 236, 240]));
const SCAN_C = tmpFile('scan-c.png', fx.png(85, 60, [235, 230, 240]));
const CERT = tmpFile('cert.png', fx.png(60, 85, [250, 250, 250]));
const SCAN_D = tmpFile('scan-d.png', fx.png(60, 85, [228, 232, 236]));
const SCAN_E = tmpFile('scan-e.png', fx.png(60, 85, [226, 238, 230]));

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
    return recordsReady_ && o && o.hidden && !hasPendingSaves_() && !monthChecking_;
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
    await a.waitForFunction(() => savedPages_.qc.length === 3 && savedPages_.qc.every(p => p.status === 'read'));
    assert.match(await a.textContent('#qcSortStatus'), /2 vehicles found across 3 pages/);
    assert.equal(srv.backend.drive.list().filter(f => f.includes('2026-09/QC paperwork/')).length, 3);

    // The same scans again are recognised, not filed or read twice.
    const calls = srv.backend.calls.claude;
    await a.setInputFiles('#fileQcScans', [SCAN_A]);
    await a.waitForFunction(() => pickedFiles.fileQcScans.length === 0 && !savesInFlight_);
    assert.equal(srv.backend.calls.claude, calls);
    assert.equal(srv.backend.drive.list().filter(f => f.includes('2026-09/QC paperwork/')).length, 3);

    // 3. A calibration certificate.
    await a.setInputFiles('#fileCalCerts', [CERT]);
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
    await b.waitForFunction(() => Object.keys(TEST_LOGS).length === 2 && TEST_QUALITY && TEST_QUALITY.site.tests === 210 && !dvsaLoading_ &&
      ['statusLogDate', 'statusLogDuration', 'statusRating'].every(id => /Filed in Google Drive/.test(document.getElementById(id).textContent)));
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
    // These made-up cars are each missing a document, so the app leaves "QC
    // checks fully documented" unanswered and the report is blocked...
    assert.equal(await b.evaluate(() => checklistState['16-3'] || null), null);
    assert.ok(await b.evaluate(() => reportBlockers_().some(m => /checklist/i.test(m.what))));
    // ...so for this check (the pages in the report) that rule is set aside.
    await b.evaluate(() => { AUTO_CHECKS['16-3'] = () => ({ val: 'yes', why: 'test' }); applyAutoChecklist_(); });
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
    const file = [...srv.backend.drive.items.values()].find(x => x._name === 'details.json' && JSON.parse(x._bytes.toString()).month === '2026-09');
    const d = JSON.parse(file._bytes.toString()); d.status = 'signed'; file.setContent(JSON.stringify(d));
    srv.backend.props.set('MST_2026-09', 'signed');   // sign-off sets both
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

test('a correct password always gets in, safely: the browser keeps a pass, never the password', async () => {
  const srv = await start(0, fakeClaude());
  const appShown = (p) => p.waitForFunction(() => document.getElementById('appRoot').style.display === 'block', null, { timeout: 20000 });
  try {
    const ctx = await browser.newContext();
    // An older version saved the password itself in the browser.
    await ctx.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', 1); localStorage.setItem('mortlake_report_password', 'pw'); } });
    const p = await ctx.newPage();
    p.on('dialog', (d) => d.accept());
    await p.goto(srv.url + '/index.html');
    assert.equal(await p.evaluate(() => localStorage.getItem('mortlake_report_password')), null, 'old saved password wiped');
    assert.ok(await p.isVisible('#lockScreen'));
    await p.evaluate(() => { LOGIN_ATTEMPT_MS = 1500; });

    // A genuinely wrong password says so.
    await p.fill('#lockPasswordInput', 'nope');
    await p.click('#lockSubmitBtn');
    await p.waitForFunction(() => document.getElementById('lockSubmitBtn').textContent === 'Unlock');
    assert.equal(await p.textContent('#lockError'), 'Incorrect password.');

    // Google fails twice, then is slower than one try: the app keeps going,
    // the late answer still counts, and a stray space on the end is ignored.
    srv.failures.checkDashboardPassword = 2;
    srv.slow.checkDashboardPassword = 2500;
    await p.fill('#lockPasswordInput', 'pw ');
    await p.click('#lockSubmitBtn');
    assert.equal(await p.textContent('#lockError'), '', 'old message cleared');
    await appShown(p);
    await waitReady(p);
    srv.slow.checkDashboardPassword = 0;
    const stored = JSON.stringify(await p.evaluate(() => Object.assign({}, localStorage)));
    assert.doesNotMatch(stored, /"pw"|\bpw\b/, 'the password is not kept in the browser');
    const pass = await p.evaluate(() => JSON.parse(localStorage.getItem('mortlake_report_pass')));
    assert.ok(pass.token.length >= 32 && pass.expires > Date.now() + 29 * 86400000);

    // Coming back: straight in, without asking Google for the password at all.
    const before = srv.log.filter(a => a === 'checkDashboardPassword').length;
    await p.reload();
    await appShown(p);
    await waitReady(p);
    assert.equal(srv.log.filter(a => a === 'checkDashboardPassword').length, before);

    // The pass is refused (30 days are up, or the password was changed): asked again, politely.
    srv.backend.props.set('DASHBOARD_PASSWORD', 'new-password');
    await p.reload();
    await p.waitForFunction(() => /type the password again/.test(document.getElementById('lockError').textContent), null, { timeout: 20000 });
    assert.doesNotMatch(await p.textContent('#lockError'), /Incorrect/);
    assert.equal(await p.evaluate(() => localStorage.getItem('mortlake_report_pass')), null);
    await p.fill('#lockPasswordInput', 'new-password');
    await p.click('#lockSubmitBtn');
    await appShown(p);
    await waitReady(p);

    // Log out ends this computer's pass with Google too.
    const token = await p.evaluate(() => JSON.parse(localStorage.getItem('mortlake_report_pass')).token);
    await p.click('#logoutBtn');
    await p.waitForFunction(() => { const l = document.getElementById('lockScreen'), a = document.getElementById('appRoot');
      return l && a && a.style.display === 'none' && !localStorage.getItem('mortlake_report_pass'); });
    await p.waitForTimeout(300);
    assert.equal(srv.backend.doPostRaw(JSON.stringify({ action: 'listMonths', token })).status, 'forbidden');
  } finally { srv.server.close(); }
});

test('the guessing pause and a missing Google are never called a wrong password', async () => {
  const srv = await start(0, fakeClaude());
  try {
    const p = await (await browser.newContext()).newPage();
    await p.goto(srv.url + '/index.html');
    // Too many wrong guesses: says it's paused, not "incorrect".
    for (let i = 0; i < 5; i++) srv.backend.doPostRaw(JSON.stringify({ action: 'checkDashboardPassword', password: 'guess' + i }));
    await p.fill('#lockPasswordInput', 'pw');
    await p.click('#lockSubmitBtn');
    await p.waitForFunction(() => document.getElementById('lockSubmitBtn').textContent === 'Unlock');
    assert.match(await p.textContent('#lockError'), /paused for 15 more minutes/);
    srv.backend.props.delete('LOGIN_FAILS');

    // Google can't be reached at all.
    await p.evaluate(() => { LOGIN_GIVE_UP_MS = 4000; LOGIN_ATTEMPT_MS = 1000; });
    srv.failures.checkDashboardPassword = 999;
    await p.click('#lockSubmitBtn');
    await p.waitForFunction(() => document.getElementById('lockSubmitBtn').textContent === 'Unlock', null, { timeout: 15000 });
    const msg = await p.textContent('#lockError');
    assert.match(msg, /not a password problem/);
    assert.doesNotMatch(msg, /Incorrect password/);
    assert.ok(srv.log.filter(a => a === 'checkDashboardPassword').length >= 3, 'it kept trying');

    // Caps Lock is pointed out.
    const capsKey = (on) => p.evaluate((on) => document.getElementById('lockPasswordInput')
      .dispatchEvent(new KeyboardEvent('keyup', { key: 'a', modifierCapsLock: on })), on);
    await capsKey(true);
    assert.ok(await p.isVisible('#lockCaps'), 'Caps Lock warning shown');
    await capsKey(false);
    assert.equal(await p.isVisible('#lockCaps'), false);
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
    // Page A: the quick read's reply is lost, then Google files and reads it
    // on the backup route, but that reply is lost too.
    // Page B: neither request reaches Google at all.
    srv.lostReplies.analyzeQcPage = 2;
    await p.setInputFiles('#fileQcScans', [SCAN_A]);
    await p.waitForFunction(() => savedPages_.qc.length === 1 && !savesInFlight_);
    assert.equal(await p.evaluate(() => savedPages_.qc[0].status), 'read', 'found out it had been read');
    assert.equal(await p.evaluate(() => unsavedPages_.qc.length), 0);

    srv.failures.analyzeQcPage = 2;      // the quick read and the one-trip request never arrive…
    srv.failures.readPage = 2;           // …and neither does reading it, even when asked again
    await p.setInputFiles('#fileQcScans', [SCAN_B]);
    await p.waitForFunction(() => savedPages_.qc.length === 2 && !savesInFlight_);
    const b = await p.evaluate(() => savedPages_.qc[1].status);
    assert.equal(b, 'unread', 'filed, not read');
    assert.equal(await p.evaluate(() => unsavedPages_.qc.length), 0, 'it is filed, so nothing is "not saved"');
    assert.match(await p.textContent('#qcPageList'), /waiting to be read/);
    await p.click('#qcPageList summary');
    await p.click('#qcPageList [data-retry]');
    await p.waitForFunction(() => savedPages_.qc.every(x => x.status === 'read'));
    // A lost filing reply on the backup route is simply tried again and recognised.
    srv.failures.analyzeQcPage = 2;
    srv.lostReplies.filePage = 1;
    await p.setInputFiles('#fileQcScans', [SCAN_C]);
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
    srv.failures.analyzeQcPage = 2;      // the quick read and the one-trip request never arrive
    srv.failures.readPage = 1;           // and the first request to read never arrives either
    await p.setInputFiles('#fileQcScans', [SCAN_A]);
    await p.waitForFunction(() => savedPages_.qc.length === 1 && !savesInFlight_);
    assert.equal(await p.evaluate(() => savedPages_.qc[0].status), 'read');
  } finally { srv.server.close(); }
});

test('pages are read first, then filed in the background with the reading, under the tyre', async () => {
  const srv = await start(0, fakeClaude());
  try {
    const p = await newComputer(srv);
    await setMonth(p, '2026-09');
    srv.slow.filePage = 1500;   // filing is slow, so the panel can be seen
    await p.setInputFiles('#fileQcScans', [SCAN_A, SCAN_B]);
    // The readings are on screen while the pages are still being filed.
    await p.waitForFunction(() => savedPages_.qc.length === 2 && savedPages_.qc.every(x => x.provisional));
    assert.ok(await p.isVisible('#savingPanel'), 'tyre panel shows');
    assert.match(await p.textContent('#savingPanel'), /Don't leave yet, we're saving stuff in the backend/);
    assert.match(await p.textContent('#savingSub'), / of 2 saved/, 'counts this batch only');
    assert.match(await p.textContent('#qcPageList'), /saving to Google Drive/);
    assert.ok(await p.evaluate(() => hasPendingSaves_()), 'report blocked while filing');
    await p.waitForFunction(() => !savesInFlight_ && savedPages_.qc.length === 2 && savedPages_.qc.every(x => !x.provisional && x.status === 'read'));
    assert.match(await p.textContent('#savingPanel'), /All saved/);
    // Claude was asked once per page: the quick read. Filing didn't read again.
    const reads = srv.log.filter(a => a === 'analyzeQcPage' || a === 'readPage' || a === 'retryPage').length;
    assert.equal(reads, 2);
    assert.equal(srv.backend.call('loadMonth', { month: '2026-09' }).details.qcPages.filter(x => x.status === 'read').length, 2);
    await p.waitForFunction(() => document.getElementById('savingPanel').hidden, null, { timeout: 6000 });
  } finally { srv.server.close(); }
});

test('stage B: nothing missing, sign off, locked, open the report, amend to v2, cancel an amendment', async () => {
  const plan = [['AB12CDE', 'vt20_certificate'], ['AB12CDE', 'inspection_sheet'], ['AB12CDE', 'emissions_test'], ['AB12CDE', 'vt20_certificate'], ['AB12CDE', 'inspection_sheet']];
  let n = 0;
  const srv = await start(0, { claude: (kind) => kind === 'cert'
    ? { status: 'success', result: { is_calibration_certificate: true, equipment_name: 'Roller Brake Tester', serial_number: '80780205', next_due: '31/10/2027', rotation: 0, confidence: 'high' } }
    : { status: 'success', result: { category: 'mot_vehicle_paperwork', document_type: plan[n % plan.length][1], registration: plan[n++ % plan.length][0], tester_name: 'T STONE', rotation: 0, confidence: 'high' } } });
  const signed = () => srv.backend.drive.list().filter(p => p.startsWith('Mortlake Garage Records/2026-09/Signed reports/'));
  try {
    const p = await newComputer(srv);
    await setMonth(p, '2026-09');
    await p.setInputFiles('#fileLogDate', LOG_SEP);
    await p.setInputFiles('#fileLogDuration', LOG_SEP_DUR);
    await p.setInputFiles('#fileRating', TQ_SEP);
    await p.setInputFiles('#fileQcScans', [SCAN_A, SCAN_B]);
    await p.waitForFunction(() => savedPages_.qc.length === 2 && !savesInFlight_);
    // Real pages finish saving in any order; the page must not mistake that for a change.
    await p.evaluate(() => savedPages_.qc.reverse());
    await p.evaluate(() => {
      CHECKLIST.forEach((c, ci) => c.items.forEach((t, ii) => { checklistState[ci + '-' + ii] = 'yes'; }));
      checklistState['2-0'] = 'no';          // a NO with no note yet
      persistChecklistState();
    });
    await waitSaved(p);

    // Something is missing: Sign off is greyed out and says exactly what.
    assert.ok(await p.isVisible('#signOffBtn'));
    assert.ok(await p.evaluate(() => document.getElementById('signOffBtn').classList.contains('is-blocked')));
    assert.ok(await p.isVisible('.req'), 'required items carry a red asterisk');
    await p.click('#signOffBtn');
    const why = await p.textContent('#reportBlockers');
    assert.match(why, /Not ready to sign off/);
    assert.match(why, /AB12CDE is missing its emissions test/);
    assert.match(why, /marked NO needs a note/);
    assert.equal(await p.isVisible('#signDialog'), false);

    // Put it right.
    await p.setInputFiles('#fileQcScans', [SCAN_C]);
    await p.waitForFunction(() => savedPages_.qc.length === 3 && !savesInFlight_);
    await p.evaluate(() => { checklistNotes['2-0'] = 'New sign ordered, fitted by 30 Sept'; persistChecklistState(); });
    await waitSaved(p);
    assert.equal(await p.evaluate(() => signOffBlockers_().length), 0);

    // The sign-off screen needs the tick and a name.
    await p.click('#signOffBtn');
    assert.ok(await p.isVisible('#signDialog'));
    assert.ok(await p.isDisabled('#signGo'));
    await p.check('#signConfirm');
    assert.ok(await p.isDisabled('#signGo'), 'still needs a name');
    await p.fill('#signName', 'Paul Testman');
    assert.ok(await p.isEnabled('#signGo'));
    await p.click('#signGo');
    await p.waitForFunction(() => /Filed\. September 2026 is signed off/.test(document.getElementById('signProgressText').textContent), null, { timeout: 60000 });
    assert.equal(signed().length, 1);
    const v1 = srv.backend.drive.readBytes(signed()[0]);
    assert.equal(v1.slice(0, 4).toString(), '%PDF');
    assert.equal(details(srv, '2026-09').status, 'signed');

    // Signed: locked, with the banner and Open report.
    await p.click('#signProgressActions .btn-secondary');
    assert.match(await p.textContent('#monthBanner'), /September 2026 is signed off\. Signed .* by Paul Testman/);
    assert.ok(await p.evaluate(() => document.body.classList.contains('month-locked')));
    assert.equal(await p.isVisible('#signOffBtn'), false);
    await p.click('#monthBanner button:text-is("Open report")');
    await p.waitForSelector('#pdfViewerBody iframe', { timeout: 20000 });
    assert.match(await p.textContent('#pdfViewerSub'), /^Signed off .* by Paul Testman$/);
    await p.click('#pdfViewerActions >> text=Back');

    // Amend: needs the tick and a reason; then the month unlocks.
    await p.click('#monthBanner button:text-is("Amend")');
    assert.ok(await p.isDisabled('#amendGo'));
    await p.check('#amendConfirm');
    await p.fill('#amendReason', 'short');
    assert.ok(await p.isDisabled('#amendGo'), 'a reason of a few words is needed');
    await p.fill('#amendReason', 'Second inspection sheet found for AB12CDE');
    await p.click('#amendGo');
    await p.waitForFunction(() => /You are amending September 2026/.test(document.getElementById('monthBanner').textContent));
    assert.equal(await p.evaluate(() => document.body.classList.contains('month-locked')), false);
    assert.match(await p.textContent('#signOffBtn'), /Sign off amendment/);
    await p.setInputFiles('#fileQcScans', [SCAN_D]);
    await p.waitForFunction(() => savedPages_.qc.length === 4 && !savesInFlight_);
    await waitSaved(p);
    await p.click('#signOffBtn');
    await p.check('#signConfirm');
    assert.equal(await p.inputValue('#signName'), 'Paul Testman', 'the name is remembered');
    await p.click('#signGo');
    await p.waitForFunction(() => /Filed\./.test(document.getElementById('signProgressText').textContent), null, { timeout: 60000 });
    await p.click('#signProgressActions .btn-secondary');
    assert.equal(signed().length, 2);
    assert.deepEqual(srv.backend.drive.readBytes(signed().find(f => / v1 /.test(f))), v1, 'v1 untouched');
    assert.match(await p.textContent('#monthBanner'), /is signed off\. Amended /);
    assert.match(await p.textContent('#monthBanner'), /Earlier reports, kept as signed: original report of /);
    assert.doesNotMatch(await p.textContent('#monthBanner'), /[Vv]ersion/);

    // An amendment that is cancelled leaves the month exactly as signed.
    await p.click('#monthBanner button:text-is("Amend")');
    await p.check('#amendConfirm');
    await p.fill('#amendReason', 'Trying something that turns out to be wrong');
    await p.click('#amendGo');
    await p.waitForFunction(() => monthStatus_() === 'amending');
    await p.setInputFiles('#fileQcScans', [SCAN_E]);
    await p.waitForFunction(() => savedPages_.qc.length === 5 && !savesInFlight_);
    await waitSaved(p);
    await p.click('#monthBanner button:text-is("Cancel amendment")');
    await p.waitForFunction(() => monthStatus_() === 'signed' && savedPages_.qc.length === 4, null, { timeout: 20000 });
    await p.waitForTimeout(2500);
    assert.ok(!p.dialogs.some(d => /Use Amend to make changes/.test(d)), 'nothing tries to save into the signed month: ' + p.dialogs.join(' | '));
    assert.equal(details(srv, '2026-09').qcPages.length, 4);
    assert.equal(signed().length, 2, 'no new version');
    assert.deepEqual(p.errors, []);
    // No version numbers anywhere on a signed or amended report (Ediz, 18 Oct 2026).
    const printed = await p.evaluate(() => [
      buildReportHTML({ version: 1, signedBy: 'Paul Testman', signedAt: new Date(), history: [{ at: new Date().toISOString(), what: 'Signed off by Paul Testman' }] }),
      buildReportHTML({ version: 2, signedBy: 'Paul Testman', signedAt: new Date(), history: [],
        amendment: { reason: 'x', previous: { version: 1, signedAt: '2026-10-04T10:00:00Z', signedBy: 'Paul Testman' }, changes: ['Added a page'] } })
    ].map(h => h.replace(/<[^>]+>/g, ' ')).join(' '));
    assert.doesNotMatch(printed, /\bv\d\b|[Vv]ersion/);
    assert.match(printed, /Amended report/);
    // A fresh computer fetches the signed report from Google, in small bites.
    const q = await newComputer(srv);
    await setMonth(q, '2026-09');
    srv.log.length = 0;
    await q.click('#monthBanner button:text-is("Open report")');
    await q.waitForSelector('#pdfViewerBody iframe', { timeout: 20000 });
    const got = await q.evaluate(async () => new Uint8Array(await (await fetch(document.querySelector('#pdfViewerBody iframe').src)).arrayBuffer()));
    const v2 = srv.backend.drive.readBytes(signed().find(f => / v2 /.test(f)));
    assert.deepEqual(Buffer.from(Object.values(got)), v2, 'exactly version 2, byte for byte');
    assert.ok(srv.log.filter(a => a === 'getReport').length >= 1);
  } finally { srv.server.close(); }
});

test('the browser keeps copies of filed files, so nothing is fetched twice; Log out empties it', async () => {
  const srv = await start(0, fakeClaude());
  try {
    const p = await newComputer(srv);
    await setMonth(p, '2026-09');
    await p.setInputFiles('#fileLogDate', LOG_SEP);
    await p.setInputFiles('#fileRating', TQ_SEP);
    await p.setInputFiles('#fileQcScans', [SCAN_A, SCAN_B]);
    await p.waitForFunction(() => savedPages_.qc.length === 2 && !savesInFlight_);
    await waitSaved(p);
    // Reopening on the same computer: the DVSA files and page images come from the browser.
    srv.log.length = 0;
    await p.reload();
    await waitReady(p);
    await p.evaluate(() => switchTab('report'));
    await p.waitForFunction(() => !dvsaLoading_ && Object.keys(TEST_LOGS).length === 1 && TEST_QUALITY && TEST_QUALITY.site);
    await p.evaluate(() => ensureEvidence_());
    assert.equal(srv.log.filter(a => a === 'getDvsaFile' || a === 'getPageImage').length, 0, 'nothing fetched again: ' + srv.log.join(','));
    assert.match(await p.textContent('#statusRating'), /Filed in Google Drive/);
    // The test copy keeps its own; Log out empties this computer's copy.
    const dbs = await p.evaluate(async () => (await indexedDB.databases()).map(d => d.name));
    assert.ok(dbs.includes('mortlake_files'), dbs.join(','));
    assert.ok(await p.evaluate(async () => !!(await cacheGet_('page:2026-09:' + savedPages_.qc[0].id))));
    await p.click('#logoutBtn');
    await p.waitForFunction(() => { const a = document.getElementById('appRoot'); return a && a.style.display === 'none'; });
    assert.equal(await p.evaluate(async () => await cacheGet_('page:2026-09:qc-1')), null, 'emptied on Log out');
  } finally { srv.server.close(); }
});

test('a month shows at once from this computer, locked until Google confirms; changes elsewhere still appear', async () => {
  const srv = await start(0, fakeClaude());
  try {
    const p = await newComputer(srv);
    await setMonth(p, '2026-09');
    await p.setInputFiles('#fileQcScans', [SCAN_A, SCAN_B]);
    await p.waitForFunction(() => savedPages_.qc.length === 2 && !savesInFlight_);
    await waitSaved(p);
    // Google is slow to answer the next time the app opens.
    srv.slow.openSession = 2500;
    await p.reload();
    await p.waitForFunction(() => savedPages_.qc.length === 2 && monthChecking_, null, { timeout: 2000 });
    assert.match(await p.textContent('#syncStatus'), /Checking with Google/);
    assert.ok(await p.evaluate(() => getComputedStyle(document.querySelector('#view-report .section')).pointerEvents === 'none'), 'locked while checking');
    assert.match(await p.evaluate(() => reportBlockers_().map(b => b.what).join('|')), /Still checking/);
    await waitReady(p);
    assert.equal(await p.evaluate(() => monthChecking_), false);
    // Another computer adds a page meanwhile: the copy here is out of date, so Google's copy wins.
    srv.backend.call('filePage', { month: '2026-09', kind: 'qc', imageBase64: Buffer.from('elsewhere').toString('base64'),
      fingerprint: 'other-computer', sourceName: 'from-the-other-computer.jpg', reading: { registration: 'AB12CDE', document_type: 'emissions_test' } });
    await p.reload();
    await p.waitForFunction(() => monthChecking_ && savedPages_.qc.length === 2, null, { timeout: 2000 });
    await waitReady(p);
    assert.equal(await p.evaluate(() => savedPages_.qc.length), 3, 'the page added elsewhere appears');
    assert.deepEqual(p.errors, []);
  } finally { srv.server.close(); }
});

test('Records: every month at a glance; a signed month opens its report, a draft carries on', async () => {
  const srv = await start(0, fakeClaude());
  const b = srv.backend;
  const reading = { category: 'mot_vehicle_paperwork', document_type: 'vt20_certificate', registration: 'AB12CDE', tester_name: 'T STONE', rotation: 0, confidence: 'high' };
  // July: signed off. August: started, one DVSA file in.
  ['fileLogDate', 'fileLogDuration', 'fileRating'].forEach((inputId, i) =>
    b.call('saveDvsaFile', { month: '2026-07', inputId, fileName: inputId + '.xlsx', base64: Buffer.from('x' + i).toString('base64') }));
  ['vt20_certificate', 'inspection_sheet', 'emissions_test'].forEach((document_type, i) =>
    b.call('filePage', { month: '2026-07', kind: 'qc', imageBase64: fx.png(60, 85, [240, 240, 230 + i]).toString('base64'), fingerprint: 'fp-' + i, sourceName: i + '.png', reading: Object.assign({}, reading, { document_type }) }));
  const state = {};
  b.sandbox.CHECKLIST_SIZES.forEach((n, ci) => { for (let ii = 0; ii < n; ii++) state[ci + '-' + ii] = 'yes'; });
  b.call('saveMonthFields', { month: '2026-07', field: 'checklist', value: { state, notes: {} }, baseRevision: 0 });
  const pdf = Buffer.from('%PDF-1.4 July report ' + 'x'.repeat(4000));
  const st = b.call('signStart', { month: '2026-07', mode: 'sign', bytes: pdf.length, pieces: 1, signedBy: 'Paul Testman', confirm: true });
  b.call('signPiece', { uploadId: st.uploadId, index: 0, data: pdf.toString('base64') });
  assert.equal(b.call('signFinish', { month: '2026-07', uploadId: st.uploadId }).status, 'success');
  b.call('saveDvsaFile', { month: '2026-08', inputId: 'fileLogDate', fileName: 'a.xlsx', base64: 'eA==' });
  try {
    const p = await newComputer(srv);
    await p.click('#tab-records');
    await p.waitForSelector('.rec-tile[data-month="2026-07"].signed');
    assert.match(await p.textContent('.rec-tile[data-month="2026-07"]'), /July.*Signed \d\d \w{3}.*1 vehicle/);
    assert.match(await p.textContent('.rec-tile[data-month="2026-08"]'), /August.*things left/);
    assert.match(await p.textContent('.rec-tile[data-month="2026-06"]'), /Not started/);
    assert.ok(await p.isDisabled('.rec-tile[data-month="2026-12"]'), 'months to come cannot be picked');

    // Paul's computer quietly keeps a copy of the signed report.
    await p.waitForFunction(async () => !!(await cacheGet_('report:2026-07:v1')), null, { timeout: 15000, polling: 200 });

    // July: Open report shows it straight from this computer.
    await p.click('.rec-tile[data-month="2026-07"]');
    assert.match(await p.textContent('#recPanel'), /Signed off .* by Paul Testman/);
    assert.ok(await p.isVisible('#recPanel >> text=Open folder in Google Drive'));
    srv.log.length = 0;
    await p.click('#recPanel >> text=Open report');
    await p.waitForSelector('#pdfViewerBody iframe', { timeout: 10000 });
    assert.equal(srv.log.filter(a => a === 'getReport').length, 0, 'opened from this computer');
    assert.match(await p.textContent('#pdfViewerTitle'), /July 2026/);
    await p.click('#pdfViewerActions >> text=Back');

    // August: says what is left, and Continue takes Paul to it.
    await p.click('.rec-tile[data-month="2026-08"]');
    const left = await p.textContent('#recPanel');
    assert.match(left, /2 DVSA files to upload/);
    assert.match(left, /QC paperwork to scan/);
    assert.match(left, /checklist questions to answer/);
    await p.click('#recPanel >> text=Continue August 2026');
    await p.waitForFunction(() => currentMonth === '2026-08' && document.getElementById('view-report').classList.contains('active'));
    await waitReady(p);

    // Amend from Records opens the month and the amend box.
    await p.click('#tab-records');
    await p.click('.rec-tile[data-month="2026-07"]');
    await p.click('#recPanel >> text=Amend');
    await p.waitForSelector('#amendDialog:not([hidden])', { timeout: 15000 });
    assert.equal(await p.evaluate(() => currentMonth), '2026-07');
    assert.deepEqual(p.errors, []);
  } finally { srv.server.close(); }
});

test('the checklist is a job card: one section at a time, moves on by itself, a NO asks for a note', async () => {
  const srv = await start(0, fakeClaude());
  try {
    const p = await newComputer(srv);
    await setMonth(p, '2026-09');
    await p.click('#tab-checklist');
    // Every section is listed; only the first one's questions are shown.
    assert.equal(await p.locator('.jc-item').count(), await p.evaluate(() => CHECKLIST.length));
    assert.equal(await p.locator('.jc-sec.current').count(), 1);
    assert.match(await p.textContent('.jc-sec.current h2'), /^1\. VTS site appearance/);
    assert.match(await p.textContent('#jcMain .jc-next'), /Next: 2\. Customer parking/);

    // Answering every question YES moves on to the next section by itself.
    for (const b of await p.$$('.jc-sec.current .check-pill.yes')) await b.click();
    await p.waitForFunction(() => jcCurrent_ === 1);
    assert.match(await p.textContent('.jc-item[data-cat-index="0"]'), /VTS site appearance/);
    assert.ok(await p.evaluate(() => document.querySelector('.jc-item[data-cat-index="0"]').classList.contains('complete')));

    // The keyboard: Y answers the next question.
    await p.keyboard.press('y');
    assert.equal(await p.evaluate(() => checklistState['1-0']), 'yes');
    // A NO stays put and asks for a note; the section shows red until it has one.
    await p.keyboard.press('n');
    assert.equal(await p.evaluate(() => checklistState['1-1']), 'no');
    assert.equal(await p.evaluate(() => document.activeElement.tagName), 'TEXTAREA', 'the note box is ready to type in');
    await p.waitForTimeout(600);
    assert.equal(await p.evaluate(() => jcCurrent_), 1, 'stays on the section until the note is written');
    assert.match(await p.textContent('.jc-item[data-cat-index="1"] .jc-count'), /1 NO/);
    assert.match(await p.textContent('#clFlag'), /1 NO needs a note/);
    await p.fill('.check-item[data-key="1-1"] textarea', 'Bay lines repainted by 30 Oct');
    assert.equal(await p.textContent('#clFlag'), '');

    // Any section can be picked from the list; Next skips finished ones.
    await p.click('.jc-item[data-cat-index="5"]');
    assert.match(await p.textContent('.jc-sec.current h2'), /^6\. /);
    await p.click('.jc-item[data-cat-index="0"]');
    assert.match(await p.textContent('#jcMain .jc-sec.current .jc-next'), /Next: 3\. /);
    await waitSaved(p);
    assert.equal(details(srv, '2026-09').checklist.notes['1-1'], 'Bay lines repainted by 30 Oct');

    // "Go there" from the report's list of what's missing opens the first unfinished section.
    await p.click('#tab-report');
    await p.click('#generateBtn');
    await p.click('#reportBlockers .blockers-go[data-go="checklist"]');
    assert.ok(await p.isVisible('#view-checklist'));
    assert.match(await p.textContent('.jc-sec.current h2'), /^3\. /);
    assert.deepEqual(p.errors, []);
  } finally { srv.server.close(); }
});

test('the app answers the questions it can check itself, and only those', async () => {
  const srv = await start(0, fakeClaude());
  try {
    const p = await newComputer(srv);
    await p.waitForTimeout(2500);
    assert.equal(srv.log.filter(x => x === 'saveMonthFields').length, 0, 'opening the app files nothing for a month not started');
    await setMonth(p, '2026-09');
    const ans = (k) => p.evaluate((k) => [checklistState[k] || null, checklistNotes[k] || ''], k);
    // Nothing in yet: left unanswered, saying what will tick it.
    assert.deepEqual(await ans('10-0'), [null, '']);
    await p.click('#tab-checklist');
    await p.click('.jc-item[data-cat-index="10"]');
    assert.match(await p.textContent('.check-item[data-key="10-0"] .auto-why'), /once the test log by date is uploaded/);
    assert.ok(await p.isDisabled('.check-item[data-key="10-0"] .check-pill.yes'), 'Paul cannot change an automatic answer');
    // The DVSA files and the QC sets tick their questions.
    await p.click('#tab-report');
    await p.setInputFiles('#fileLogDate', LOG_SEP);
    await p.setInputFiles('#fileRating', TQ_SEP);
    await p.waitForFunction(() => checklistState['10-0'] === 'yes' && checklistState['10-2'] === 'yes');
    assert.deepEqual(await ans('10-1'), [null, ''], 'the duration log is not in yet');
    // Equipment in date to the end of September: YES; one out of date: NO, with the reason as the note.
    await p.evaluate(() => {
      store.calibration = [
        { name: 'Roller Brake Tester', serial: '80780205', date: '2027-03-01' },
        { name: 'Headlamp Tester', serial: '2245', date: '2027-03-01' },
        { name: 'Exhaust Gas Meter', serial: '11210011', date: '2026-09-12' },
        { name: 'Diesel Smoke Meter', serial: '', date: '2027-01-01' }];
      applyAutoChecklist_();
    });
    assert.deepEqual(await ans('17-0'), ['yes', '']);
    const eca = await ans('17-1');
    assert.equal(eca[0], 'no');
    assert.match(eca[1], /Calibration out of date: Exhaust Gas Meter \(due 12 September 2026\)/);
    assert.deepEqual(await ans('17-3'), [null, ''], 'a serial number is missing');
    // Questions the app can't see stay for Paul.
    assert.deepEqual(await ans('16-4'), [null, '']);
    assert.equal(await p.evaluate(() => !!AUTO_CHECKS['16-4']), false);
    await waitSaved(p);
    assert.equal(details(srv, '2026-09').checklist.state['10-0'], 'yes', 'automatic answers are saved like any other');
    assert.deepEqual(p.errors, []);
  } finally { srv.server.close(); }
});

test('the road: the car moves as the month fills in, waits at an unfinished stop, and parks at the flag when signed', async () => {
  const srv = await start(0, fakeClaude());
  const b = srv.backend;
  try {
    const p = await newComputer(srv);
    await setMonth(p, '2026-09');
    const car = () => p.evaluate(() => roadPos_);
    await p.waitForSelector('#roadStrip .road-stop');
    assert.equal(await car(), 0);
    assert.match(await p.textContent('.road-stop[data-go="dvsa"]'), /DVSA files\s*3 to upload/);
    assert.match(await p.textContent('.road-finish'), /Sign off/);
    assert.ok(await p.evaluate(() => document.querySelector('.road-finish .btn').classList.contains('is-blocked')));

    // One DVSA file moves the car a little; it can't pass the DVSA stop yet.
    await p.setInputFiles('#fileLogDate', LOG_SEP);
    await p.waitForFunction(() => roadPos_ > 0.05);
    await p.evaluate(() => { CHECKLIST.forEach((c, ci) => c.items.forEach((t, ii) => { checklistState[ci + '-' + ii] = 'yes'; })); persistChecklistState(); });
    await p.waitForTimeout(100);
    assert.ok(await car() < 0.25, 'waits at the DVSA stop: ' + await car());
    await p.setInputFiles('#fileLogDuration', LOG_SEP_DUR);
    await p.setInputFiles('#fileRating', TQ_SEP);
    await p.waitForFunction(() => document.querySelector('.road-stop[data-go="dvsa"]').classList.contains('done'));
    assert.ok(await car() > 0.25 && await car() < 0.5, 'now on to QC paperwork: ' + await car());

    // A stop takes Paul there.
    await p.click('#tab-dashboard');
    await p.click('.road-stop[data-go="checklist"]');
    assert.ok(await p.isVisible('#view-checklist'));
    await p.click('#tab-records');
    assert.equal(await p.isVisible('#roadStrip'), false, 'not on Records, which is about every month');
    await waitSaved(p);

    // A signed month: the car is parked at the flag.
    ['vt20_certificate', 'inspection_sheet', 'emissions_test'].forEach((document_type, i) =>
      b.call('filePage', { month: '2026-08', kind: 'qc', imageBase64: fx.png(60, 85, [240, 240, 230 + i]).toString('base64'), fingerprint: 'f' + i, sourceName: i + '.png',
        reading: { category: 'mot_vehicle_paperwork', registration: 'AB12CDE', document_type, rotation: 0, confidence: 'high' } }));
    ['fileLogDate', 'fileLogDuration', 'fileRating'].forEach((inputId, i) =>
      b.call('saveDvsaFile', { month: '2026-08', inputId, fileName: inputId + '.xlsx', base64: Buffer.from('x' + i).toString('base64') }));
    const state = {};
    b.sandbox.CHECKLIST_SIZES.forEach((n, ci) => { for (let ii = 0; ii < n; ii++) state[ci + '-' + ii] = 'yes'; });
    b.call('saveMonthFields', { month: '2026-08', field: 'checklist', value: { state, notes: {} }, baseRevision: 0 });
    const pdf = Buffer.from('%PDF-1.4 ' + 'x'.repeat(3000));
    const st = b.call('signStart', { month: '2026-08', mode: 'sign', bytes: pdf.length, pieces: 1, signedBy: 'Paul Testman', confirm: true });
    b.call('signPiece', { uploadId: st.uploadId, index: 0, data: pdf.toString('base64') });
    assert.equal(b.call('signFinish', { month: '2026-08', uploadId: st.uploadId }).status, 'success');
    await p.click('#tab-report');
    await setMonth(p, '2026-08');
    await p.waitForFunction(() => roadPos_ === 1);
    assert.match(await p.textContent('.road-finish'), /Signed off ✓\s*Open report/);
    assert.deepEqual(p.errors, []);
  } finally { srv.server.close(); }
});

test('Monthly Report boxes: a file in the wrong box is not filed; scans read themselves into number-plate cards', async () => {
  let n = 0;
  const plan = [['AB10CDE', 'vt20_certificate'], ['AB10CDE', 'inspection_sheet'], ['AB11CDE', 'vt20_certificate'], [null, 'other', 'calibration_certificate']];
  const srv = await start(0, { claude: () => {
    const [reg, doc, cat] = plan[n++ % plan.length];
    return { status: 'success', result: { category: cat || 'mot_vehicle_paperwork', document_type: doc, registration: reg, tester_name: 'T STONE', test_date: '04/09/2026', rotation: 0, confidence: 'high' } };
  } });
  try {
    const p = await newComputer(srv);
    await setMonth(p, '2026-09');
    // The duration log dropped on the date box: refused, red, nothing filed.
    // A full month has many tests with the same time on the ramp.
    await p.setInputFiles('#fileLogDate', tmpFile('dur-240.xlsx', fx.testLog(2026, 9, 240, 'duration')));
    await p.waitForFunction(() => /Not filed/.test(document.getElementById('statusLogDate').textContent));
    assert.match(await p.textContent('#statusLogDate'), /looks like the test log by duration/);
    assert.ok(await p.evaluate(() => document.getElementById('statusLogDate').classList.contains('warn')));
    await p.setInputFiles('#fileLogDuration', tmpFile('date-240.xlsx', fx.testLog(2026, 9, 240)));
    await p.waitForFunction(() => /looks like the test log by date/.test(document.getElementById('statusLogDuration').textContent));
    // The Test Quality file on a test log box, and a test log on the Test Quality box.
    await p.setInputFiles('#fileLogDuration', TQ_SEP);
    await p.waitForFunction(() => /Test Quality file, not a test log/.test(document.getElementById('statusLogDuration').textContent));
    await p.setInputFiles('#fileRating', LOG_SEP);
    await p.waitForFunction(() => /a test log, not the Test Quality file/.test(document.getElementById('statusRating').textContent));
    assert.equal(srv.log.filter(a => a === 'saveDvsaFile').length, 0, 'nothing filed');
    // The right files in the right boxes.
    await p.setInputFiles('#fileLogDate', LOG_SEP);
    await p.setInputFiles('#fileLogDuration', LOG_SEP_DUR);
    await p.setInputFiles('#fileRating', TQ_SEP);
    await waitSaved(p);
    assert.equal(srv.log.filter(a => a === 'saveDvsaFile').length, 3);
    for (const id of ['statusLogDate', 'statusLogDuration', 'statusRating']) assert.ok(await p.evaluate((id) => document.getElementById(id).classList.contains('uploaded'), id));

    // Scans start reading by themselves: no button to press.
    await p.setInputFiles('#fileQcScans', [SCAN_A, SCAN_B, SCAN_C, SCAN_D]);
    await p.waitForFunction(() => savedPages_.qc.length === 4 && !savesInFlight_, null, { timeout: 20000 });
    assert.equal(await p.isVisible('#sortScansBtn'), false);
    const plates = await p.$$eval('.qc-car .plate', els => els.map(e => e.textContent));
    assert.deepEqual(plates, ['UKAB10 CDE', 'UKAB11 CDE']);
    assert.match(await p.textContent('.qc-car[data-reg="AB10CDE"]'), /VT20 ✓.*Inspection ✓.*Emissions missing/);
    assert.match(await p.textContent('.qc-car[data-reg="AB10CDE"] .qc-meta'), /^T STONE · 04\/09\/2026/, 'the tester\'s name from the Test Quality file');
    // Who tested each car comes from the test log, by registration.
    assert.match(await p.textContent('#qcTesters'), /QC by tester:.*\(1 car\).*no QC car yet/);
    // A certificate dropped with the QC scans is pointed out, with Remove.
    assert.match(await p.textContent('.qc-review'), /looks like a calibration certificate/);
    assert.ok(await p.isVisible('.qc-review [data-remove]'));
    // The equipment shows its lights under the certificates.
    assert.ok(await p.locator('#eqLights .eq-row').count() >= 1);
    assert.deepEqual(p.errors, []);
  } finally { srv.server.close(); }
});

test('the report judges equipment at the end of its month, counts overdue and due soon apart, and lists only real changes', async () => {
  const srv = await start(0, fakeClaude());
  try {
    const p = await newComputer(srv);
    await setMonth(p, '2026-09');
    await p.setInputFiles('#fileRating', TQ_SEP);
    await p.waitForFunction(() => TEST_QUALITY && TEST_QUALITY.site);
    const html = await p.evaluate(() => {
      document.querySelectorAll('.cal-row').forEach(r => r.remove());
      [{ name: 'Roller Brake Tester', serial: '1', date: '2026-10-05' },     // in date all September, though past today
       { name: 'Headlamp Tester', serial: '2', date: '2026-09-12' },         // ran out during September
       { name: 'Exhaust Gas Meter', serial: '3', date: '2026-10-20' }]       // due within 30 days of month end
        .forEach(c => addCalRow(c));
      return buildReportHTML().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    });
    assert.match(html, /Equipment 3 1 overdue · 2 due soon/);
    assert.match(html, /Headlamp Tester calibration overdue Equipment Due 12 Sept? 2026/);
    // A checklist answer that went to "not answered" and back is not a change.
    const changes = await p.evaluate(() => changesSince_({ amendment: { startedAt: '2026-10-01T00:00:00Z' }, history: [
      { at: '2026-10-02T00:00:00Z', what: 'Checklist: question 17.4: YES → not answered' },
      { at: '2026-10-02T00:01:00Z', what: 'Added QC page page-009.jpg (x.jpg)' },
      { at: '2026-10-02T00:02:00Z', what: 'Checklist: question 17.4: not answered → YES; question 3.1: YES → NO' },
      { at: '2026-10-02T00:03:00Z', what: 'Checklist: 61 answers changed' }] }));
    assert.deepEqual(changes, ['Added QC page page-009.jpg (x.jpg)', 'Checklist: question 3.1: YES → NO', 'Checklist: 61 answers changed']);
    assert.deepEqual(p.errors, []);
  } finally { srv.server.close(); }
});
