/* Checks the Monthly Records back office (Code.gs) against SPEC.md, using
 * the fake Google in fake-google.js. Run with:  node --test tests/ */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackend } = require('./fake-google');

const IMG = Buffer.from('fake-jpeg-page-1').toString('base64');
const IMG2 = Buffer.from('fake-jpeg-page-2').toString('base64');
const QC_READ = { category: 'mot_vehicle_paperwork', document_type: 'vt20_certificate', registration: 'AB12CDE',
                  tester_name: 'J SMITH', rotation: 0, confidence: 'high' };

function backendReading(result) { return { claude: () => ({ status: 'success', result }) }; }

test('password is required for everything except the version check', () => {
  const b = loadBackend();
  assert.equal(b.call('getVersion', { password: '' }).version, 21);
  assert.equal(b.call('loadMonth', { month: '2026-09', password: 'wrong' }).status, 'forbidden');
  assert.equal(b.call('checkDashboardPassword', { password: 'wrong' }).status, 'fail');
  assert.equal(b.call('checkDashboardPassword').status, 'success');
});

test('a bad request comes back as a readable error, not a crash', () => {
  const b = loadBackend();
  assert.equal(b.doPostRaw('not json').status, 'error');
  assert.equal(b.call('loadMonth', { month: '2026-13' }).status, 'error');
  assert.equal(b.call('loadMonth', { month: 'DASHBOARD_PASSWORD' }).status, 'error');
  assert.equal(b.call('saveDvsaFile', { month: '2026-09', inputId: 'constructor', base64: 'eA==' }).status, 'error');
  assert.equal(b.call('getDvsaFile', { month: '2026-09', inputId: '__proto__' }).status, 'error');
  assert.equal(b.call('saveMonthFields', { month: '2026-09', field: 'constructor', value: {}, baseRevision: 0 }).status, 'error');
});

test('an empty month loads as Not started and leaves nothing behind in Drive', () => {
  const b = loadBackend();
  const r = b.call('loadMonth', { month: '2026-09' });
  assert.equal(r.status, 'success');
  assert.equal(r.exists, false);
  assert.equal(r.details.status, 'draft');
  assert.deepEqual(b.drive.list(), []);
});

test('the old requests still work, so the current live page keeps working', () => {
  const b = loadBackend(backendReading(QC_READ));
  assert.equal(b.call('saveAppData', { data: { calibration: [{ name: 'X' }] } }).status, 'success');
  assert.equal(b.call('loadAppData').data.calibration[0].name, 'X');
  const r = b.call('analyzeQcPage', { imageBase64: IMG, mimeType: 'image/jpeg' });
  assert.equal(r.result.registration, 'AB12CDE');
  assert.deepEqual(b.drive.list(), [], 'without a month nothing is filed');
});

test('a scanned page is filed in the month folder and what Claude read is recorded', () => {
  const b = loadBackend(backendReading(QC_READ));
  const r = b.call('analyzeQcPage', { month: '2026-09', imageBase64: IMG, mimeType: 'image/jpeg',
                                      fingerprint: 'fp1', sourceName: 'scan.pdf (page 1)' });
  assert.equal(r.status, 'success');
  assert.equal(r.saved, true);
  assert.equal(r.page.status, 'read');
  assert.equal(r.page.reading.registration, 'AB12CDE');
  assert.ok(b.drive.list().includes('Mortlake Garage Records/2026-09/QC paperwork/page-001.jpg'));
  assert.deepEqual(b.drive.readBytes('Mortlake Garage Records/2026-09/QC paperwork/page-001.jpg'), Buffer.from('fake-jpeg-page-1'));

  const d = b.call('loadMonth', { month: '2026-09' }).details;
  assert.equal(d.qcPages.length, 1);
  assert.equal(d.qcPages[0].sourceName, 'scan.pdf (page 1)');
  assert.ok(!('fileId' in d.qcPages[0]), 'internal Drive ids are not sent to the page');
  assert.ok(d.history.some(h => /Added QC page page-001.jpg/.test(h.what)));
  assert.ok(d.history.some(h => /Read page-001.jpg \(AB12CDE, vt20 certificate\)/.test(h.what)));

  const idx = b.call('listMonths').months['2026-09'];
  assert.equal(idx.qcPages, 1);
  assert.equal(idx.qcUnread, 0);
});

test('the same page added twice is not stored or read twice', () => {
  const b = loadBackend(backendReading(QC_READ));
  const args = { month: '2026-09', imageBase64: IMG, mimeType: 'image/jpeg', fingerprint: 'fp1', sourceName: 'a.pdf (page 1)' };
  b.call('analyzeQcPage', args);
  const again = b.call('analyzeQcPage', args);
  assert.equal(again.duplicate, true);
  assert.equal(again.result.registration, 'AB12CDE');
  assert.equal(b.calls.claude, 1);
  assert.equal(b.call('loadMonth', { month: '2026-09' }).details.qcPages.length, 1);
});

test('a page Claude cannot read is still kept, and can be retried', () => {
  let fail = true;
  const b = loadBackend({ claude: () => (fail ? { http: 400 } : { status: 'success', result: QC_READ }) });
  const r = b.call('analyzeQcPage', { month: '2026-09', imageBase64: IMG, fingerprint: 'fp1' });
  assert.equal(r.status, 'error');
  assert.equal(r.saved, true);
  assert.equal(r.page.status, 'error');
  assert.equal(b.call('listMonths').months['2026-09'].qcUnread, 1);

  fail = false;
  const retry = b.call('retryPage', { month: '2026-09', kind: 'qc', id: r.page.id });
  assert.equal(retry.status, 'success');
  assert.equal(retry.page.status, 'read');
  assert.equal(b.call('listMonths').months['2026-09'].qcUnread, 0);
});

test('adding the same page again after a failed read reads it again instead of duplicating it', () => {
  let fail = true;
  const b = loadBackend({ claude: () => (fail ? { http: 400 } : { status: 'success', result: QC_READ }) });
  const args = { month: '2026-09', imageBase64: IMG, fingerprint: 'fp1' };
  b.call('analyzeQcPage', args);
  fail = false;
  const r = b.call('analyzeQcPage', args);
  assert.equal(r.page.status, 'read');
  assert.equal(b.call('loadMonth', { month: '2026-09' }).details.qcPages.length, 1);
});

test('a removed page goes to the Removed folder, never deleted', () => {
  const b = loadBackend(backendReading(QC_READ));
  const r = b.call('analyzeQcPage', { month: '2026-09', imageBase64: IMG, fingerprint: 'fp1' });
  assert.equal(b.call('removePage', { month: '2026-09', kind: 'qc', id: r.page.id }).status, 'success');
  const files = b.drive.list();
  assert.ok(!files.includes('Mortlake Garage Records/2026-09/QC paperwork/page-001.jpg'));
  assert.ok(files.some(f => /^Mortlake Garage Records\/2026-09\/Removed\/removed .* page-001\.jpg$/.test(f)));
  const d = b.call('loadMonth', { month: '2026-09' }).details;
  assert.equal(d.qcPages.length, 0);
  assert.equal(d.removedPages.length, 1);
  assert.ok(d.history.some(h => /Removed page-001.jpg/.test(h.what)));
  // A new page never reuses the removed page's number.
  const r2 = b.call('analyzeQcPage', { month: '2026-09', imageBase64: IMG2, fingerprint: 'fp2' });
  assert.equal(r2.page.fileName, 'page-002.jpg');
});

test('a page image can be fetched back exactly as filed', () => {
  const b = loadBackend(backendReading(QC_READ));
  const r = b.call('analyzeQcPage', { month: '2026-09', imageBase64: IMG, fingerprint: 'fp1' });
  const img = b.call('getPageImage', { month: '2026-09', kind: 'qc', id: r.page.id });
  assert.equal(img.base64, IMG);
});

test('calibration certificates are filed in their own folder', () => {
  const b = loadBackend({ claude: (kind) => ({ status: 'success', result: kind === 'cert'
    ? { is_calibration_certificate: true, equipment_name: 'Brake tester', serial_number: '80780205' } : QC_READ }) });
  const r = b.call('analyzeCalibrationCert', { month: '2026-09', imageBase64: IMG, fingerprint: 'c1' });
  assert.equal(r.page.reading.serial_number, '80780205');
  assert.ok(b.drive.list().includes('Mortlake Garage Records/2026-09/Calibration certificates/cert-001.jpg'));
  assert.equal(b.call('loadMonth', { month: '2026-09' }).details.certPages.length, 1);
});

test('a DVSA file is filed with its figures; replacing it moves the old one to Removed', () => {
  const b = loadBackend();
  const xlsx1 = Buffer.from('xlsx-v1').toString('base64');
  const tq = { period: 'Sep-26', site: { tests: 240, failed: 25 }, national: { failed: 28 } };
  let r = b.call('saveDvsaFile', { month: '2026-09', inputId: 'fileRating', fileName: 'TQI Sep.xlsx', base64: xlsx1,
                                   figures: { testQuality: tq } });
  assert.equal(r.status, 'success');
  assert.ok(b.drive.list().includes('Mortlake Garage Records/2026-09/DVSA files/test-quality.xlsx'));
  assert.equal(b.call('getDvsaFile', { month: '2026-09', inputId: 'fileRating' }).base64, xlsx1);
  assert.equal(b.call('listMonths').months['2026-09'].testQuality.siteFailed, 25);

  r = b.call('saveDvsaFile', { month: '2026-09', inputId: 'fileRating', fileName: 'TQI Sep v2.xlsx',
                               base64: Buffer.from('xlsx-v2').toString('base64'), figures: { testQuality: tq } });
  assert.equal(r.status, 'success');
  const files = b.drive.list();
  assert.equal(files.filter(f => f.endsWith('DVSA files/test-quality.xlsx')).length, 1);
  assert.ok(files.some(f => /Removed\/removed .* test-quality\.xlsx$/.test(f)));
  const d = b.call('loadMonth', { month: '2026-09' }).details;
  assert.equal(d.dvsaFiles.fileRating.fileName, 'TQI Sep v2.xlsx');
  assert.ok(d.history.some(h => /Replaced Test Quality Information: TQI Sep v2.xlsx/.test(h.what)));
});

test('checklist saves are refused if another computer saved in between', () => {
  const b = loadBackend();
  const v = { state: { '0-0': 'yes' }, notes: {} };
  let r = b.call('saveMonthFields', { month: '2026-09', field: 'checklist', value: v, baseRevision: 0 });
  assert.equal(r.status, 'success');
  assert.equal(r.revision, 1);
  // Computer B still thinks the revision is 0.
  r = b.call('saveMonthFields', { month: '2026-09', field: 'checklist', value: { state: {}, notes: {} }, baseRevision: 0 });
  assert.equal(r.status, 'conflict');
  assert.deepEqual(r.value.state, { '0-0': 'yes' }, 'the conflict hands back what is saved');
  assert.equal(b.call('loadMonth', { month: '2026-09' }).details.checklist.state['0-0'], 'yes');
  // Only the checklist can be saved this way.
  assert.equal(b.call('saveMonthFields', { month: '2026-09', field: 'status', value: 'signed', baseRevision: 0 }).status, 'error');
});

test('a signed month refuses every change, on the server', () => {
  const b = loadBackend(backendReading(QC_READ));
  const r = b.call('analyzeQcPage', { month: '2026-09', imageBase64: IMG, fingerprint: 'fp1' });
  // Sign-off itself is stage B; set the status directly to test the lock.
  const p = 'Mortlake Garage Records/2026-09/details.json';
  b.call('loadMonth', { month: '2026-09' });   // writes the page list into details.json
  const d = JSON.parse(b.drive.readText(p));
  d.status = 'signed';
  const file = [...b.drive.items.values()].find(x => x._name === 'details.json');
  file.setContent(JSON.stringify(d));
  b.props.set('MST_2026-09', 'signed');   // where the server keeps the status (sign-off sets both)

  const locked = (res) => assert.equal(res.status, 'locked', JSON.stringify(res));
  locked(b.call('analyzeQcPage', { month: '2026-09', imageBase64: IMG2, fingerprint: 'fp2' }));
  locked(b.call('removePage', { month: '2026-09', kind: 'qc', id: r.page.id }));
  locked(b.call('retryPage', { month: '2026-09', kind: 'qc', id: r.page.id }));
  locked(b.call('saveDvsaFile', { month: '2026-09', inputId: 'fileRating', fileName: 'x.xlsx', base64: IMG }));
  locked(b.call('saveMonthFields', { month: '2026-09', field: 'checklist', value: {}, baseRevision: 0 }));
  assert.match(b.call('removePage', { month: '2026-09', kind: 'qc', id: r.page.id }).message, /September 2026 is signed off/);
  // Reading is still allowed.
  assert.equal(b.call('getPageImage', { month: '2026-09', kind: 'qc', id: r.page.id }).status, 'success');
});

test('equipment list saves with the same another-computer protection', () => {
  const b = loadBackend();
  assert.equal(b.call('loadEquipment').exists, false);
  assert.equal(b.call('saveEquipment', { list: [{ name: 'Brake tester' }], baseRevision: 0 }).revision, 1);
  assert.equal(b.call('saveEquipment', { list: [], baseRevision: 0 }).status, 'conflict');
  assert.equal(b.call('loadEquipment').list[0].name, 'Brake tester');
});

test('moving across: old saved data is copied into Drive once, and never deleted', () => {
  const tq = { period: 'Aug-26', site: { tests: 200, failed: 20 }, national: { failed: 28 } };
  const b = loadBackend({ properties: {
    'DATA_month_2026-08': JSON.stringify({ state: { '0-0': 'yes', '1-0': 'no' }, notes: { '1-0': 'fixing' } }),
    'DATA_tq_Aug-26': JSON.stringify(tq),
    'DATA_calibration': JSON.stringify([{ name: 'Headlamp tester', serial: '2245', date: '2026-10-31' }])
  } });
  assert.equal(b.call('recordsStatus').migrated, false);
  const r = b.call('migrateLegacy', { browserTestLog: { '2026-08': { total: 200, passed: 180 }, 'junk': {} } });
  assert.equal(r.status, 'success');
  assert.deepEqual(r.monthsUpdated, ['2026-08']);

  const d = b.call('loadMonth', { month: '2026-08' }).details;
  assert.equal(d.checklist.state['1-0'], 'no');
  assert.equal(d.checklist.notes['1-0'], 'fixing');
  assert.equal(d.testQuality.site.tests, 200);
  assert.equal(d.testLog.total, 200);
  assert.ok(d.history.some(h => /Moved across/.test(h.what)));
  assert.equal(b.call('loadEquipment').list[0].serial, '2245');
  assert.equal(b.call('listMonths').months['2026-08'].testQuality.siteTests, 200);
  assert.equal(b.call('recordsStatus').migrated, true);
  // The old copies are still there.
  assert.ok(b.props.has('DATA_month_2026-08'));
  assert.ok(b.props.has('DATA_tq_Aug-26'));

  // Running again (e.g. from a second computer) changes nothing already moved,
  // but still takes test-log totals for months that have none.
  const again = b.call('migrateLegacy', { browserTestLog: { '2026-08': { total: 999 }, '2026-07': { total: 150 } } });
  assert.equal(again.alreadyMigrated, true);
  assert.deepEqual(again.monthsUpdated, ['2026-07']);
  assert.equal(b.call('loadMonth', { month: '2026-08' }).details.testLog.total, 200);
});

test('a records folder deleted by hand is recreated rather than breaking the app', () => {
  const b = loadBackend();
  b.call('saveEquipment', { list: [], baseRevision: 0 });
  const id = b.props.get('RECORDS_FOLDER_ID');
  b.drive.DriveApp.getFolderById(id).setTrashed(true);
  assert.equal(b.call('loadEquipment').status, 'success');
  assert.notEqual(b.props.get('RECORDS_FOLDER_ID'), id);
});

test('the test copy can use its own folder name', () => {
  const b = loadBackend({ properties: { RECORDS_FOLDER_NAME: 'Mortlake Garage Records (TEST)' } });
  b.call('saveEquipment', { list: [], baseRevision: 0 });
  assert.deepEqual(b.drive.list(), ['Mortlake Garage Records (TEST)/equipment.json']);
});

test('opening the app is one request: moves old data, seeds equipment, returns the month', () => {
  const b = loadBackend({ properties: {
    'DATA_month_2026-08': JSON.stringify({ state: { '0-0': 'yes' }, notes: {} })
  } });
  const r = b.call('openSession', { month: '2026-08', browserTestLog: { '2026-08': { total: 50 } },
                                    seedEquipment: [{ name: 'Headlamp Tester', serial: '2245' }] });
  assert.equal(r.status, 'success');
  assert.equal(r.version, 21);
  assert.equal(typeof r.ms, 'number', 'every answer says how long it took');
  assert.deepEqual(r.migration.monthsUpdated, ['2026-08']);
  assert.equal(r.month.exists, true);
  assert.equal(r.month.details.checklist.state['0-0'], 'yes');
  assert.equal(r.month.details.testLog.total, 50);
  assert.equal(r.equipment.list[0].serial, '2245');
  assert.equal(r.equipment.revision, 1);
  assert.ok(r.months['2026-08']);

  // Next time: nothing to move, and the filed equipment list wins over the browser's.
  const again = b.call('openSession', { month: '2026-09', seedEquipment: [{ name: 'Something else' }] });
  assert.equal(again.migration, null);
  assert.equal(again.equipment.list[0].name, 'Headlamp Tester');
  assert.equal(again.month.exists, false);
  assert.deepEqual(b.drive.list().filter(f => f.includes('2026-09')), [], 'opening an empty month leaves nothing behind');
});

test('filing and reading are separate short steps, each safe to repeat', () => {
  const b = loadBackend(backendReading(QC_READ));
  const args = { month: '2026-09', kind: 'qc', imageBase64: IMG, mimeType: 'image/jpeg', fingerprint: 'fp1', sourceName: 'a.pdf (page 1)' };
  const f = b.call('filePage', args);
  assert.equal(f.status, 'success');
  assert.equal(f.page.status, 'unread');
  assert.equal(b.calls.claude, 0, 'filing alone does not call Claude');
  // Filing the same page again (e.g. a lost reply) gives the same page back.
  const again = b.call('filePage', args);
  assert.equal(again.duplicate, true);
  assert.equal(again.page.id, f.page.id);
  assert.equal(b.call('loadMonth', { month: '2026-09' }).details.qcPages.length, 1);

  const r = b.call('readPage', { month: '2026-09', kind: 'qc', id: f.page.id });
  assert.equal(r.page.status, 'read');
  assert.equal(r.page.reading.registration, 'AB12CDE');
  // Asking to read it again doesn't call Claude again…
  b.call('readPage', { month: '2026-09', kind: 'qc', id: f.page.id });
  assert.equal(b.calls.claude, 1);
  // …unless Paul presses Retry.
  b.call('retryPage', { month: '2026-09', kind: 'qc', id: f.page.id });
  assert.equal(b.calls.claude, 2);
  assert.equal(b.call('getPage', { month: '2026-09', kind: 'qc', id: f.page.id }).page.status, 'read');
  assert.equal(b.call('filePage', args).page.status, 'read', 'a filed and read page is recognised');
});

test('a page being read by another request is not read twice', () => {
  const b = loadBackend(backendReading(QC_READ));
  const f = b.call('filePage', { month: '2026-09', kind: 'qc', imageBase64: IMG, fingerprint: 'fp1' });
  const key = 'PG_2026-09_' + f.page.id;
  const pg = JSON.parse(b.props.get(key));
  pg.status = 'reading'; pg.readingStartedAt = new Date().toISOString();
  b.props.set(key, JSON.stringify(pg));
  const r = b.call('readPage', { month: '2026-09', kind: 'qc', id: f.page.id });
  assert.equal(r.page.status, 'reading');
  assert.equal(b.calls.claude, 0);
});

test('saves hold the queue for only a handful of Drive calls (that is what makes batches slow)', () => {
  const b = loadBackend(backendReading(QC_READ));
  b.call('filePage', { month: '2026-09', kind: 'qc', imageBase64: IMG, fingerprint: 'warm-up' });
  const per = (action, payload) => {
    const n0 = b.drive.calls.n, l0 = b.drive.calls.locked;
    const r = b.call(action, payload);
    return { r, n: b.drive.calls.n - n0, locked: b.drive.calls.locked - l0 };
  };
  const f = per('filePage', { month: '2026-09', kind: 'qc', imageBase64: IMG2, fingerprint: 'fp2' });
  assert.ok(f.locked <= 1, 'filing a page holds the queue for ' + f.locked + ' Drive calls');
  const r = per('readPage', { month: '2026-09', kind: 'qc', id: f.r.page.id });
  assert.ok(r.locked <= 1, 'reading a page holds the queue for ' + r.locked + ' Drive calls');
  const c = per('saveMonthFields', { month: '2026-09', field: 'checklist', value: { state: { '0-0': 'yes' } }, baseRevision: 0 });
  assert.ok(c.n <= 6, 'saving the checklist: ' + c.n + ' Drive calls');
  per('openSession', { month: '2026-09' });   // the first open writes the page list into Drive
  const o = per('openSession', { month: '2026-09' });
  assert.ok(o.n <= 8, 'opening the app: ' + o.n + ' Drive calls');
  assert.equal(o.r.months['2026-09'].qcPages, 2, 'the index (now in Script Properties) is up to date');
  // An already-filed page is recognised without uploading it again.
  const d = per('filePage', { month: '2026-09', kind: 'qc', imageBase64: IMG2, fingerprint: 'fp2' });
  assert.equal(d.r.duplicate, true);
  assert.equal(d.locked, 0, 'no queue needed for a duplicate');
  assert.equal(b.drive.list().filter(x => /QC paperwork\//.test(x)).length, 2, 'no stray uploads');
  assert.ok(!b.drive.list().some(x => /incoming/.test(x)), 'every upload got its proper name');
});

test('problems on the server are written to a log that can be read back', () => {
  const b = loadBackend();
  b.sandbox.LockService.getScriptLock = () => ({ waitLock: () => { throw new Error('timeout'); }, releaseLock: () => {} });
  const r = b.call('saveEquipment', { list: [], baseRevision: 0 });
  assert.equal(r.status, 'busy');
  const errs = b.call('getErrors').errors;
  assert.equal(errs.length, 1);
  assert.equal(errs[0].action, 'saveEquipment');
});

test('a records index from an earlier version is moved across', () => {
  const b = loadBackend();
  b.call('saveEquipment', { list: [], baseRevision: 0 });
  const root = b.drive.DriveApp.getFolderById(b.props.get('RECORDS_FOLDER_ID'));
  root.createFile('records-index.json', JSON.stringify({ months: { '2026-07': { status: 'draft', qcPages: 4 } } }), 'application/json');
  assert.equal(b.call('listMonths').months['2026-07'].qcPages, 4);
});

test('the page list is written into the Drive record when the month is opened', () => {
  const b = loadBackend(backendReading(QC_READ));
  const f = b.call('filePage', { month: '2026-09', kind: 'qc', imageBase64: IMG, fingerprint: 'fp1', sourceName: 'a.pdf (page 1)' });
  b.call('readPage', { month: '2026-09', kind: 'qc', id: f.page.id });
  const f2 = b.call('filePage', { month: '2026-09', kind: 'qc', imageBase64: IMG2, fingerprint: 'fp2' });
  b.call('removePage', { month: '2026-09', kind: 'qc', id: f2.page.id });
  b.call('loadMonth', { month: '2026-09' });
  const d = JSON.parse(b.drive.readText('Mortlake Garage Records/2026-09/details.json'));
  assert.equal(d.qcPages.length, 1);
  assert.equal(d.qcPages[0].reading.registration, 'AB12CDE');
  assert.equal(d.removedPages.length, 1);
  assert.equal(d.nextPageNo, 3);
  assert.ok(d.history.some(h => /Added QC page page-001.jpg/.test(h.what)));
  assert.ok(d.history.some(h => /Read page-001.jpg/.test(h.what)));
  assert.ok(d.history.some(h => /Removed page-002.jpg/.test(h.what)));
  assert.ok(!['HB_', 'PGX_', 'PGDIRTY_'].some(pre => [...b.props.keys()].some(k => k.startsWith(pre))), 'nothing left waiting');
});

test('a month untouched for over a month is cleared from quick storage, and comes back if worked on', () => {
  const b = loadBackend(backendReading(QC_READ));
  const f = b.call('filePage', { month: '2026-09', kind: 'qc', imageBase64: IMG, fingerprint: 'fp1' });
  b.call('readPage', { month: '2026-09', kind: 'qc', id: f.page.id });
  // Pretend it was all done 40 days ago.
  const key = 'PG_2026-09_' + f.page.id;
  const pg = JSON.parse(b.props.get(key));
  pg.readAt = pg.addedAt = new Date(Date.now() - 40 * 864e5).toISOString();
  b.props.set(key, JSON.stringify(pg));
  b.call('loadMonth', { month: '2026-09' });
  assert.ok(![...b.props.keys()].some(k => k.startsWith('PG_2026-09')), 'cleared from quick storage');
  const m = b.call('loadMonth', { month: '2026-09' }).details;
  assert.equal(m.qcPages.length, 1, 'still there, from details.json');
  const f2 = b.call('filePage', { month: '2026-09', kind: 'qc', imageBase64: IMG2, fingerprint: 'fp2' });
  assert.equal(f2.page.id, 'qc-2', 'numbering carries on');
  assert.equal(b.call('loadMonth', { month: '2026-09' }).details.qcPages.length, 2);
});

test('a page filed with what Claude already read is not read again', () => {
  const b = loadBackend(backendReading(QC_READ));
  const f = b.call('filePage', { month: '2026-09', kind: 'qc', imageBase64: IMG, fingerprint: 'fp1', sourceName: 'a.jpg', reading: QC_READ });
  assert.equal(f.status, 'success');
  assert.equal(f.page.status, 'read');
  assert.equal(f.page.reading.registration, 'AB12CDE');
  assert.equal(b.calls.claude, 0, 'no second reading');
  const e = b.call('filePage', { month: '2026-09', kind: 'qc', imageBase64: IMG2, fingerprint: 'fp2', readError: 'Too blurry' });
  assert.equal(e.page.status, 'error');
  assert.equal(e.page.error, 'Too blurry');
  // A page filed earlier without a reading takes the reading when it arrives, with no new upload.
  const u = b.call('filePage', { month: '2026-09', kind: 'qc', imageBase64: Buffer.from('p3').toString('base64'), fingerprint: 'fp3' });
  assert.equal(u.page.status, 'unread');
  const files = b.drive.list().length;
  const r = b.call('filePage', { month: '2026-09', kind: 'qc', imageBase64: Buffer.from('p3').toString('base64'), fingerprint: 'fp3', reading: QC_READ });
  assert.equal(r.page.status, 'read');
  assert.equal(b.drive.list().length, files, 'no extra upload');
  assert.equal(b.call('filePage', { month: '2026-09', kind: 'qc', imageBase64: IMG, fingerprint: 'x', reading: 'nonsense' }).status, 'error');
  const d = b.call('loadMonth', { month: '2026-09' }).details;
  assert.ok(d.history.some(h => /Read page-001.jpg \(AB12CDE/.test(h.what)));
  assert.ok(d.history.some(h => /Could not read page-002.jpg: Too blurry/.test(h.what)));
});

test('logging in gives a 30-day pass; the password is never needed again, and guessing is slowed down', () => {
  const b = loadBackend();
  const raw = (body) => b.doPostRaw(JSON.stringify(body));
  const login = raw({ action: 'checkDashboardPassword', password: 'pw' });
  assert.equal(login.status, 'success');
  assert.ok(login.token.length >= 32);
  assert.ok(Math.abs(login.expires - (Date.now() + 30 * 86400000)) < 60000, '30 days');
  // Only a fingerprint of the pass is stored, never the pass itself.
  assert.ok(![...b.props.values()].some(v => v.includes(login.token)));
  assert.ok(![...b.props.keys()].some(k => k.includes(login.token)));
  // The pass works on its own; a made-up one doesn't.
  assert.equal(raw({ action: 'listMonths', token: login.token }).status, 'success');
  assert.equal(raw({ action: 'listMonths', token: 'x'.repeat(64) }).status, 'forbidden');
  assert.equal(raw({ action: 'listMonths' }).status, 'forbidden');
  // The older page, sending the password itself, keeps working.
  assert.equal(raw({ action: 'listMonths', password: 'pw' }).status, 'success');

  // Five wrong guesses pause logging in, even with the right password…
  for (let i = 0; i < 4; i++) assert.equal(raw({ action: 'checkDashboardPassword', password: 'guess' + i }).status, 'fail');
  assert.equal(raw({ action: 'checkDashboardPassword', password: 'guess5' }).status, 'fail');
  const paused = raw({ action: 'checkDashboardPassword', password: 'pw' });
  assert.equal(paused.status, 'paused');
  assert.match(paused.message, /paused for 15 more minutes/);
  assert.equal(raw({ action: 'listMonths', password: 'pw' }).status, 'forbidden', 'no guessing through other requests');
  // …but a computer that already has a pass carries on.
  assert.equal(raw({ action: 'listMonths', token: login.token }).status, 'success');
  // After the pause, the right password works again.
  const f = JSON.parse(b.props.get('LOGIN_FAILS')); f.until = Date.now() - 1; b.props.set('LOGIN_FAILS', JSON.stringify(f));
  const second = raw({ action: 'checkDashboardPassword', password: 'pw' });
  assert.equal(second.status, 'success');

  // Logging out ends that pass only.
  assert.equal(raw({ action: 'logout', token: second.token }).status, 'success');
  assert.equal(raw({ action: 'listMonths', token: second.token }).status, 'forbidden');
  assert.equal(raw({ action: 'listMonths', token: login.token }).status, 'success');

  // A pass runs out after 30 days.
  const key = [...b.props.keys()].find(k => k.startsWith('TOK_'));
  const p = JSON.parse(b.props.get(key)); p.exp = Date.now() - 1; b.props.set(key, JSON.stringify(p));
  assert.equal(raw({ action: 'listMonths', token: login.token }).status, 'forbidden');

  // Changing the password logs every computer out.
  const third = raw({ action: 'checkDashboardPassword', password: 'pw' }).token;
  b.props.set('DASHBOARD_PASSWORD', 'new-password');
  assert.equal(raw({ action: 'listMonths', token: third }).status, 'forbidden');
  assert.equal(raw({ action: 'checkDashboardPassword', password: 'new-password' }).status, 'success');
  assert.equal([...b.props.keys()].filter(k => k.startsWith('TOK_')).length, 1, 'old passes tidied away');
});

/* ── Stage B: signing off and amending ── */

// A month that is ready to sign: 3 DVSA files and two read QC pages.
function readyMonth(b, month) {
  if (b.call('loadEquipment').revision === 0) b.call('saveEquipment', { list: [{ name: 'Roller Brake Tester', serial: '80780205', date: '2027-05-14' }], baseRevision: 0 });
  ['fileLogDate', 'fileLogDuration', 'fileRating'].forEach((inputId, i) =>
    assert.equal(b.call('saveDvsaFile', { month, inputId, fileName: inputId + '.xlsx', base64: Buffer.from('xlsx-' + i).toString('base64') }).status, 'success'));
  b.call('filePage', { month, kind: 'qc', imageBase64: IMG, fingerprint: 'fp-a', sourceName: 'a.jpg', reading: QC_READ });
  b.call('filePage', { month, kind: 'qc', imageBase64: IMG2, fingerprint: 'fp-b', sourceName: 'b.jpg', reading: QC_READ });
}
// A small fake PDF, sent in pieces the way the page does it.
function fakePdf(text) { return Buffer.from('%PDF-1.4 ' + text + ' ' + 'x'.repeat(5000)); }
function sign(b, month, pdf, opts) {
  opts = opts || {};
  const b64 = pdf.toString('base64');
  const size = 2000;   // base64 characters per piece (a multiple of 4)
  const pieces = Math.ceil(b64.length / size);
  const start = b.call('signStart', { month, mode: opts.mode || 'sign', bytes: pdf.length, pieces, signedBy: 'Paul Testman', confirm: true });
  if (start.status !== 'success') return start;
  for (let i = 0; i < pieces; i++) {
    if (opts.skipPiece === i) continue;
    assert.equal(b.call('signPiece', { uploadId: start.uploadId, index: i, data: b64.substr(i * size, size) }).status, 'success');
  }
  if (opts.beforeFinish) opts.beforeFinish(start);
  return Object.assign(b.call('signFinish', { month, uploadId: start.uploadId }), { uploadId: start.uploadId, start });
}
const signedPdfs = (b, month) => b.drive.list().filter(p => p.startsWith('Mortlake Garage Records/' + month + '/Signed reports/'));

test('signing off files the PDF, locks the month, and is never half-done', () => {
  const b = loadBackend(backendReading(QC_READ));
  const month = '2026-09';
  // Not ready: refused, and says why.
  b.call('saveDvsaFile', { month, inputId: 'fileLogDate', fileName: 'a.xlsx', base64: 'eA==' });
  const early = b.call('signStart', { month, bytes: 100, pieces: 1, signedBy: 'Paul Testman', confirm: true });
  assert.equal(early.status, 'error');
  assert.match(early.message, /Test log \(by duration\) is not filed.*No QC paperwork/);
  readyMonth(b, month);
  // A name and the tick are required.
  assert.match(b.call('signStart', { month, bytes: 100, pieces: 1, signedBy: 'P', confirm: true }).message, /full name/);
  assert.match(b.call('signStart', { month, bytes: 100, pieces: 1, signedBy: 'Paul Testman' }).message, /Tick the box/);

  // A piece goes missing: nothing is signed, nothing is filed.
  const lost = sign(b, month, fakePdf('lost'), { skipPiece: 1 });
  assert.equal(lost.status, 'missing');
  assert.equal(b.call('loadMonth', { month }).details.status, 'draft');
  assert.deepEqual(signedPdfs(b, month), []);
  // The size doesn't match what was promised: nothing is signed.
  const pdf0 = fakePdf('short');
  const st = b.call('signStart', { month, bytes: pdf0.length + 10, pieces: 1, signedBy: 'Paul Testman', confirm: true });
  b.call('signPiece', { uploadId: st.uploadId, index: 0, data: pdf0.toString('base64') });
  assert.match(b.call('signFinish', { month, uploadId: st.uploadId }).message, /damaged/);
  assert.equal(b.call('loadMonth', { month }).details.status, 'draft');
  // Something changes while the report is being made: refused, the PDF is not kept.
  const changed = sign(b, month, fakePdf('changed'), { beforeFinish: () =>
    b.call('saveMonthFields', { month, field: 'checklist', value: { state: { '0-0': 'yes' }, notes: {} }, baseRevision: 0 }) });
  assert.equal(changed.status, 'conflict');
  assert.deepEqual(signedPdfs(b, month), []);

  // The real thing.
  const pdf = fakePdf('version one');
  const ok = sign(b, month, pdf);
  assert.equal(ok.status, 'success');
  assert.equal(ok.version.version, 1);
  assert.equal(ok.version.signedBy, 'Paul Testman');
  const files = signedPdfs(b, month);
  assert.equal(files.length, 1);
  assert.match(files[0], /Mortlake DVSA report – September 2026 – v1 – signed \d{4}-\d{2}-\d{2}\.pdf$/);
  assert.deepEqual(b.drive.readBytes(files[0]), pdf);
  assert.ok(!b.drive.list().some(p => p.includes('Uploading')), 'the pieces are tidied away');
  const d = b.call('loadMonth', { month }).details;
  assert.equal(d.status, 'signed');
  assert.equal(d.signedVersion, 1);
  assert.ok(d.calibrationSnapshot, 'calibration dates kept as they were at sign-off');
  assert.ok(d.history.some(h => /Signed off as version 1 by Paul Testman/.test(h.what)));
  assert.equal(b.call('listMonths').months[month].status, 'signed');
  // Sending the finish again is harmless.
  assert.equal(b.call('signFinish', { month, uploadId: ok.uploadId }).status, 'success');
  assert.equal(signedPdfs(b, month).length, 1);

  // Locked: every kind of change is refused by the back office itself.
  assert.equal(b.call('saveMonthFields', { month, field: 'checklist', value: { state: {}, notes: {} }, baseRevision: d.revisions.checklist }).status, 'locked');
  assert.equal(b.call('saveDvsaFile', { month, inputId: 'fileRating', fileName: 'x.xlsx', base64: 'eA==' }).status, 'locked');
  assert.equal(b.call('filePage', { month, kind: 'qc', imageBase64: IMG, fingerprint: 'new', reading: QC_READ }).status, 'locked');
  assert.equal(b.call('removePage', { month, kind: 'qc', id: d.qcPages[0].id }).status, 'locked');
  assert.equal(b.call('signStart', { month, bytes: 100, pieces: 1, signedBy: 'Paul Testman', confirm: true }).status, 'locked');

  // Opening the report gives back exactly the signed bytes, in pieces.
  const first = b.call('getReport', { month });
  assert.equal(first.version.version, 1);
  let all = first.data;
  for (let i = 1; i < first.pieces; i++) all += b.call('getReport', { month, version: 1, index: i }).data;
  assert.deepEqual(Buffer.from(all, 'base64'), pdf);
});

test('amending needs a reason, files v2 next to an untouched v1, and cancelling puts everything back', () => {
  const b = loadBackend(backendReading(QC_READ));
  const month = '2026-09';
  readyMonth(b, month);
  const v1pdf = fakePdf('version one');
  assert.equal(sign(b, month, v1pdf).status, 'success');
  const v1Path = signedPdfs(b, month)[0];
  const asSigned = b.call('loadMonth', { month }).details;

  // A reason is required.
  assert.match(b.call('startAmend', { month, confirm: true, reason: 'oops' }).message, /reason/);
  assert.match(b.call('startAmend', { month, reason: 'Missing inspection sheet for AB12CDE' }).message, /Tick the box/);

  // --- Amendment 1: cancelled. ---
  let r = b.call('startAmend', { month, confirm: true, reason: 'Missing inspection sheet for AB12CDE' });
  assert.equal(r.status, 'success');
  assert.equal(r.details.status, 'amending');
  assert.ok(b.drive.list().includes('Mortlake Garage Records/2026-09/details-v1.json'));
  // Change everything: replace a DVSA file, remove a page, add a page, change the checklist.
  b.call('saveDvsaFile', { month, inputId: 'fileLogDate', fileName: 'corrected.xlsx', base64: Buffer.from('xlsx-new').toString('base64') });
  b.call('removePage', { month, kind: 'qc', id: asSigned.qcPages[0].id });
  b.call('filePage', { month, kind: 'qc', imageBase64: Buffer.from('p3').toString('base64'), fingerprint: 'fp-c', sourceName: 'c.jpg', reading: QC_READ });
  b.call('saveMonthFields', { month, field: 'checklist', value: { state: { '2-3': 'no' }, notes: { '2-3': 'x' } }, baseRevision: asSigned.revisions.checklist });
  r = b.call('cancelAmend', { month });
  assert.equal(r.status, 'success');
  const back = b.call('loadMonth', { month }).details;
  assert.equal(back.status, 'signed');
  assert.deepEqual(back.qcPages.map(p => p.id), asSigned.qcPages.map(p => p.id), 'pages exactly as signed');
  assert.deepEqual(back.dvsaFiles, asSigned.dvsaFiles, 'DVSA files exactly as signed');
  assert.deepEqual(back.checklist, asSigned.checklist, 'checklist exactly as signed');
  assert.deepEqual(b.drive.readBytes('Mortlake Garage Records/2026-09/DVSA files/test-log-by-date.xlsx'), Buffer.from('xlsx-0'), 'the original file is back');
  assert.ok(b.drive.list().includes('Mortlake Garage Records/2026-09/QC paperwork/page-001.jpg'), 'the removed page is back');
  assert.ok(!b.drive.list().includes('Mortlake Garage Records/2026-09/QC paperwork/page-003.jpg'), 'the added page went to Removed');
  assert.ok(b.drive.list().some(p => /Removed\/removed .* page-003\.jpg$/.test(p)));
  assert.ok(back.history.some(h => /Amendment cancelled/.test(h.what)));
  assert.equal(b.call('saveMonthFields', { month, field: 'checklist', value: { state: {}, notes: {} }, baseRevision: back.revisions.checklist }).status, 'locked');

  // --- Amendment 2: signed off as v2. ---
  b.call('startAmend', { month, confirm: true, reason: 'Corrected test log export' });
  b.call('saveDvsaFile', { month, inputId: 'fileLogDate', fileName: 'corrected.xlsx', base64: Buffer.from('xlsx-new').toString('base64') });
  b.call('filePage', { month, kind: 'qc', imageBase64: Buffer.from('p4').toString('base64'), fingerprint: 'fp-d', sourceName: 'd.jpg', reading: QC_READ });
  const cur = b.call('loadMonth', { month }).details;
  b.call('saveMonthFields', { month, field: 'checklist', value: { state: { '0-0': 'yes' }, notes: {} }, baseRevision: cur.revisions.checklist });
  // Plain "Sign off" is refused while amending; it has to be "Sign off amendment".
  assert.equal(sign(b, month, fakePdf('wrong mode')).status, 'error');
  const v2pdf = fakePdf('version two');
  const v2 = sign(b, month, v2pdf, { mode: 'amend' });
  assert.equal(v2.status, 'success');
  assert.equal(v2.version.version, 2);
  assert.equal(v2.version.reason, 'Corrected test log export');
  const files = signedPdfs(b, month);
  assert.equal(files.length, 2);
  assert.ok(files.some(p => /– v2 – amended /.test(p)));
  assert.deepEqual(b.drive.readBytes(v1Path), v1pdf, 'v1 is untouched, byte for byte');
  const d = b.call('loadMonth', { month }).details;
  assert.equal(d.status, 'signed');
  assert.equal(d.signedVersion, 2);
  assert.equal(d.versions.length, 2);
  assert.ok(d.history.some(h => /question 1\.1: not answered → YES/.test(h.what)), 'checklist changes are spelled out');
  // Open report shows the latest by default; v1 can still be opened.
  assert.equal(b.call('getReport', { month }).version.version, 2);
  assert.equal(b.call('getReport', { month, version: 1 }).version.version, 1);
});
