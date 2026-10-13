/**
 * Mortlake Garage — Monthly Report backend.
 *
 * Two jobs, both because they involve a secret that must never sit inside
 * index.html (anyone could read it via "View Source"):
 *
 *  1. checkDashboardPassword — checks the login password against a value
 *     kept privately in Script Properties.
 *
 *  2. analyzeQcPage / analyzeCalibrationCert — the "smart scan" steps. Each
 *     takes one scanned page (as an image) and asks Claude to read the key
 *     fields off it: registration, tester and document type for QC paperwork;
 *     equipment, serial and calibration dates for a certificate. The Anthropic
 *     API key lives only in Script Properties, never in the page.
 *
 * Everything else (reading Excel/CSV/PDF files, generating the report PDF)
 * happens entirely in the browser and never touches this file.
 */

// These scans are genuinely hard to read: often upside-down, with handwritten
// annotations, and mixed document types. Accuracy matters far more than the
// per-page cost here — at ~26 pages a month the difference between models is
// a few pence, while a misread registration means paperwork filed against the
// wrong vehicle in a legal compliance record.
var CLAUDE_MODEL = 'claude-opus-5';

// Bumped whenever this file changes, so the app can confirm which version is
// actually deployed. Apps Script keeps serving the old code unless you pick
// "New version" when deploying, which is very easy to miss.
var BACKEND_VERSION = 13;

// Rate limits are the main failure mode when a whole scan is sorted at once:
// a burst of requests can trip 429s, and UrlFetchApp does not retry for us
// the way the official SDKs do. Retry a few times with growing backoff.
var MAX_ATTEMPTS = 4;

function doPost(e) {
  var data;
  try { data = JSON.parse(e.postData.contents); }
  catch (err) { return jsonResponse_({ status: 'error', message: 'The request could not be understood.' }); }

  // Anything that goes wrong comes back as a clean answer the app can show,
  // never as a Google error page the app cannot read.
  try {
    return jsonResponse_(route_(data));
  } catch (err) {
    if (err && err.isAppError) return jsonResponse_({ status: err.code, message: err.message });
    return jsonResponse_({ status: 'error', message: 'Something went wrong on the server: ' + (err && err.message || err) });
  }
}

function route_(data) {
  // Deliberately needs no password — it exposes nothing sensitive and is
  // purely so the app can check the right code is live.
  if (data.action === 'getVersion') return { status: 'success', version: BACKEND_VERSION };

  if (data.action === 'checkDashboardPassword') {
    return { status: checkPassword_(data.password) ? 'success' : 'fail' };
  }

  // Everything below needs the password.
  if (!checkPassword_(data.password)) return { status: 'forbidden' };

  switch (data.action) {
    // Reading a page. With a month, the page is also filed (Monthly Records);
    // without one it behaves exactly as before, so an older copy of the app
    // keeps working against this version.
    case 'analyzeQcPage':          return data.month ? fileAndReadPage_('qc', data) : analyzeQcPage_(data.imageBase64, data.mimeType);
    case 'analyzeCalibrationCert': return data.month ? fileAndReadPage_('cert', data) : analyzeCalibrationCert_(data.imageBase64, data.mimeType);

    // The old Script Properties store. Kept so the current live page still
    // works after this version is deployed; the new page no longer uses it.
    case 'loadAppData': return loadAppData_();
    case 'saveAppData': return saveAppData_(data.data);

    // Monthly Records (see SPEC.md).
    case 'recordsStatus':    return recordsStatus_();
    case 'migrateLegacy':    return migrateLegacy_(data);
    case 'listMonths':       return listMonths_();
    case 'loadMonth':        return loadMonth_(data.month);
    case 'saveMonthFields':  return saveMonthFields_(data);
    case 'saveDvsaFile':     return saveDvsaFile_(data);
    case 'getDvsaFile':      return getDvsaFile_(data);
    case 'getPageImage':     return getPageImage_(data);
    case 'removePage':       return removePage_(data);
    case 'retryPage':        return retryPage_(data);
    case 'loadEquipment':    return loadEquipment_();
    case 'saveEquipment':    return saveEquipment_(data);
  }
  return { status: 'error', message: 'Unknown action' };
}

/* ─────────────────── Saved app data ───────────────────
 * Calibration dates, checklist answers and the monthly DVSA figures were
 * previously only in the browser's localStorage, so they vanished on a new
 * laptop or a cleared browser. These are small text values, so they live in
 * Script Properties: no Sheet, no Drive file, nothing to maintain.
 *
 * Scanned paperwork and the DVSA exports are deliberately NOT stored — those
 * stay process-and-discard, as originally agreed.
 *
 * Each month is its own property to stay well inside the 9KB-per-value limit;
 * a decade of checklists is still a fraction of the 500KB total. */
var DATA_PREFIX = 'DATA_';
var MONTH_PREFIX = 'DATA_month_';
var TQ_PREFIX = 'DATA_tq_';

function loadAppData_() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var out = { calibration: [], months: {}, testQuality: {} };
  var found = false;

  Object.keys(props).forEach(function (k) {
    if (k.indexOf(TQ_PREFIX) === 0) {
      try { out.testQuality[k.substring(TQ_PREFIX.length)] = JSON.parse(props[k]); found = true; } catch (e) {}
    } else if (k.indexOf(MONTH_PREFIX) === 0) {
      try { out.months[k.substring(MONTH_PREFIX.length)] = JSON.parse(props[k]); found = true; } catch (e) {}
    } else if (k === DATA_PREFIX + 'calibration') {
      try { out.calibration = JSON.parse(props[k]); found = true; } catch (e) {}
    }
  });

  return { status: 'success', hasData: found, data: out };
}

function saveAppData_(data) {
  if (!data) return { status: 'error', message: 'No data supplied.' };
  var props = PropertiesService.getScriptProperties();

  if (data.calibration) props.setProperty(DATA_PREFIX + 'calibration', JSON.stringify(data.calibration));

  if (data.months) {
    Object.keys(data.months).forEach(function (m) {
      // Month keys come from the app's own date picker; keep the guard anyway
      // so a malformed key can never scribble over DASHBOARD_PASSWORD.
      if (!/^\d{4}-\d{2}$/.test(m)) return;
      props.setProperty(MONTH_PREFIX + m, JSON.stringify(data.months[m]));
    });
  }

  // Test Quality exports are keyed by the DVSA period label on the file
  // itself, e.g. "Jul-26".
  if (data.testQuality) {
    Object.keys(data.testQuality).forEach(function (p) {
      if (!/^[A-Za-z]{3}-\d{2}$/.test(p)) return;
      props.setProperty(TQ_PREFIX + p, JSON.stringify(data.testQuality[p]));
    });
  }

  return { status: 'success' };
}

function checkPassword_(submitted) {
  var correct = PropertiesService.getScriptProperties().getProperty('DASHBOARD_PASSWORD');
  return !!correct && submitted === correct;
}

/**
 * Sends one page image to Claude with the given instructions and returns the
 * parsed JSON answer. Never throws — the caller always gets a clean
 * { status: 'success' | 'error', ... } back. Shared by every page reader: the
 * retry, refusal and block-scanning handling is fiddly enough that having one
 * copy of it matters.
 */
function readPageWithClaude_(imageBase64, mimeType, instructions) {
  if (!imageBase64) return { status: 'error', message: 'No image received.' };

  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) return { status: 'error', message: 'No Anthropic API key configured on the server yet.' };

  var payload = {
    model: CLAUDE_MODEL,
    // Opus 5 thinks before answering, and thinking consumes tokens from this
    // same allowance. A tight cap here truncates the reply before the JSON is
    // written, which surfaces as an empty answer. max_tokens is only a ceiling
    // — unused tokens cost nothing — so leave real headroom.
    max_tokens: 8000,
    // Reading a few fields off a page is a simple, well-specified task, so keep
    // the reasoning brief rather than letting it deliberate at full depth.
    output_config: { effort: 'low' },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/png', data: imageBase64 } },
        { type: 'text', text: instructions }
      ]
    }]
  };

  // Retry loop. 429 (rate limited), 500 and 529 (overloaded) are all
  // transient — worth retrying. Anything else is a real error, so fail fast
  // rather than hammering the API.
  var response, code, body, lastMessage = '';
  for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
        method: 'post',
        contentType: 'application/json',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
    } catch (err) {
      lastMessage = 'Could not reach Claude: ' + err.message;
      if (attempt === MAX_ATTEMPTS) return { status: 'error', message: lastMessage };
      Utilities.sleep(backoffMs_(attempt, null));
      continue;
    }

    code = response.getResponseCode();
    try { body = JSON.parse(response.getContentText()); } catch (err) { body = null; }

    if (code === 200) break;

    var apiMsg = (body && body.error && body.error.message) || ('Claude API returned HTTP ' + code);
    var retryable = (code === 429 || code === 500 || code === 529);
    if (!retryable || attempt === MAX_ATTEMPTS) {
      return {
        status: 'error',
        message: retryable ? ('Rate limited — gave up after ' + MAX_ATTEMPTS + ' attempts. ' + apiMsg) : apiMsg
      };
    }

    // Honour the server's own retry-after hint when it gives one.
    var retryAfter = null;
    try {
      var hdrs = response.getAllHeaders();
      retryAfter = hdrs['retry-after'] || hdrs['Retry-After'] || null;
    } catch (err) { retryAfter = null; }
    Utilities.sleep(backoffMs_(attempt, retryAfter));
  }

  if (code !== 200) {
    return { status: 'error', message: lastMessage || ('Claude API returned HTTP ' + code) };
  }

  // Safety classifiers can decline a page outright — that arrives as HTTP 200,
  // so it has to be checked before reading the content.
  if (body && body.stop_reason === 'refusal') {
    return { status: 'error', message: 'Claude declined to read this page.' };
  }

  // The reply is a LIST of blocks, and the answer is not necessarily first:
  // when Claude thinks before answering, block 0 is the thinking and the text
  // comes after it. Pick out the text block rather than assuming a position —
  // assuming content[0] was text is exactly what made most pages come back
  // "empty" once this moved to a thinking-enabled model.
  var text = '';
  if (body && body.content && body.content.length) {
    for (var i = 0; i < body.content.length; i++) {
      var block = body.content[i];
      if (block && block.type === 'text' && block.text) { text += block.text; }
    }
  }

  if (!text) {
    var why = (body && body.stop_reason === 'max_tokens')
      ? 'Ran out of room before answering (max_tokens reached).'
      : 'No readable answer came back for this page.';
    return { status: 'error', message: why };
  }

  var parsed;
  try {
    // Claude is asked for pure JSON, but strip any stray fencing just in case,
    // and fall back to the outermost {...} if it wraps the JSON in prose.
    var cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try {
      parsed = JSON.parse(cleaned);
    } catch (inner) {
      var first = cleaned.indexOf('{'), last = cleaned.lastIndexOf('}');
      if (first === -1 || last <= first) throw inner;
      parsed = JSON.parse(cleaned.slice(first, last + 1));
    }
  } catch (err) {
    return { status: 'error', message: "Could not understand Claude's answer for this page." };
  }

  return { status: 'success', result: parsed };
}


function analyzeQcPage_(imageBase64, mimeType) {
  var instructions =
    'You are looking at a single scanned page from a UK MOT garage\'s monthly compliance file. ' +
    'The page may be upside-down or rotated — mentally rotate it and read it regardless.\n\n' +
    'IMPORTANT CONTEXT so you do not misread things:\n' +
    '- This garage is "Mortlake Station Garage", VTS number 22453. "22453" is the site number and appears on ' +
    'many pages — it is NEVER a vehicle registration. Never return it as a registration.\n' +
    '- A UK vehicle registration looks like "AB12CDE", "LB22FLC", "A6HAC" or "T90JRN". If you cannot clearly ' +
    'see a real number plate on the page, return null for registration rather than guessing.\n' +
    '- Many pages are NOT about a single vehicle at all — they are whole-site reports, big tables of many ' +
    'testers, or tick-box checklists. Those must NOT be classed as vehicle paperwork.\n\n' +
    'First decide which broad CATEGORY the page belongs to:\n' +
    '- "mot_vehicle_paperwork": paperwork about ONE specific vehicle (emissions printout, VT20 test certificate, ' +
    'MOT inspection sheet with brake readings, VT30 refusal notice).\n' +
    '- "dvsa_test_quality": a DVSA "Test Quality Information" report — a big table of testers with tests done, ' +
    'average test time, failure percentages by category, and site vs national average columns.\n' +
    '- "dvsa_test_log": a DVSA VTS test log listing many tests in date or duration order.\n' +
    '- "vts_checklist": a VTS Site Self Assessment checklist, with rows of YES/NO boxes about the premises.\n' +
    '- "equipment_calibration": a table of MOT equipment with serial numbers and calibration due dates.\n' +
    '- "admin_tracker": a month-by-month grid ticking off admin tasks (quality control check, site assessment etc).\n' +
    '- "other": anything else.\n\n' +
    'Then reply with ONLY a single JSON object, no other text, in exactly this shape:\n' +
    '{"category": one of the category strings above, ' +
    '"document_type": "emissions_test" | "vt20_certificate" | "inspection_sheet" | "vt30_refusal" | "other" ' +
    '(only meaningful when category is mot_vehicle_paperwork, otherwise use "other"), ' +
    '"registration": string or null (ONLY for mot_vehicle_paperwork: the vehicle registration plate, UK format, spaces removed; null otherwise), ' +
    '"make_model": string or null (the vehicle make and model as printed, e.g. "PORSCHE TAYCAN 4XZ"), ' +
    '"is_electric": true | false | null (true ONLY if the vehicle is fully battery-electric and therefore has no exhaust emissions test — ' +
    'judge from the make/model and any fuel indication. Well-known EVs include the Porsche Taycan, Tesla models, Nissan Leaf, ' +
    'VW ID range, BMW i-series. Petrol, diesel, hybrid and mild-hybrid (MHEV) vehicles are NOT fully electric, so use false for those. ' +
    'Use null if the page does not identify the vehicle), ' +
    '"tester_name": string or null (the tester/inspector name shown, if any), ' +
    '"test_date": string or null (the date of test shown, in whatever format is printed), ' +
    '"period": string or null (for DVSA reports/trackers: the month or period the page covers, e.g. "May-26"), ' +
    '"qc_flag": true or false (true only if there is a handwritten note marking this specifically as a QC / quality-control check), ' +
    // Landscape paperwork fed through a portrait scanner comes out sideways.
    // The printed evidence appendix rotates by this, so it can be read without
    // turning the paper round.
    '"rotation": 0 | 90 | 180 | 270 (degrees this page must be rotated CLOCKWISE for its text to read normally left-to-right; ' +
    'use 0 if it is already upright), ' +
    '"confidence": "high" | "low" (low if the page is blurry, cropped, or any key field is genuinely hard to read)}';

  return readPageWithClaude_(imageBase64, mimeType, instructions);
}

/**
 * Reads one scanned equipment calibration certificate. Separate from the QC
 * reader because it is a different document with different fields — asking one
 * prompt to cover both made it worse at each.
 */
function analyzeCalibrationCert_(imageBase64, mimeType) {
  var instructions =
    'You are looking at a single scanned page from a UK MOT garage\'s equipment records. ' +
    'It is most likely a CALIBRATION CERTIFICATE or calibration report for a piece of MOT test ' +
    'equipment. The page may be rotated or upside-down — read it regardless.\n\n' +
    'CONTEXT so you do not misread things:\n' +
    '- The garage is "Mortlake Station Garage", VTS number 22453. Numbers like 22453 are the site ' +
    'number, never an equipment serial number.\n' +
    '- Typical equipment: roller brake tester, decelerometer, headlamp beam tester, exhaust gas ' +
    'analyser, diesel smoke meter, tapley meter, plate/axle weigher.\n' +
    '- Certificates usually carry TWO dates: the date the equipment was calibrated/tested, and the ' +
    'date the next calibration is due (sometimes written as "valid until" or "expires"). Do not ' +
    'confuse them. If only one date is shown, put it in calibrated_on and leave next_due null.\n' +
    '- Do NOT guess. Any field you cannot clearly read must be null.\n\n' +
    'Reply with ONLY a JSON object, no prose and no code fences:\n' +
    '{"is_calibration_certificate": true or false (false if this page is something else entirely), ' +
    '"equipment_name": string or null (what the equipment is, e.g. "Roller Brake Tester"), ' +
    '"make_model": string or null (manufacturer and model, e.g. "Hofmann Brekon 120"), ' +
    '"serial_number": string or null (the equipment serial number, exactly as printed), ' +
    '"certificate_number": string or null, ' +
    '"calibrated_on": string or null (the date it was calibrated, in the format printed on the page), ' +
    '"next_due": string or null (the date the next calibration is due, in the format printed), ' +
    '"calibrated_by": string or null (the company or engineer who carried out the calibration), ' +
    '"rotation": 0 | 90 | 180 | 270 (degrees this page must be rotated CLOCKWISE to read normally; ' +
    '0 if already upright), ' +
    '"confidence": "high" | "low" (low if the page is blurry, cropped, or any key field is hard to read)}';

  return readPageWithClaude_(imageBase64, mimeType, instructions);
}

// Exponential backoff with a little jitter, so a burst of pages that all get
// rate-limited together don't then all retry at exactly the same moment.
function backoffMs_(attempt, retryAfterHeader) {
  if (retryAfterHeader) {
    var secs = parseFloat(retryAfterHeader);
    if (!isNaN(secs) && secs > 0) return Math.min(secs * 1000, 30000);
  }
  var base = Math.pow(2, attempt) * 1000;      // 2s, 4s, 8s…
  return Math.min(base + Math.random() * 1000, 30000);
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ═══════════════════════ Monthly Records ═══════════════════════
 * Everything for a month lives in a folder in the Google Drive of the account
 * this script runs as (Paul's), so the records belong to the business and are
 * plain files he can open without the app. SPEC.md is the full description;
 * the short version:
 *
 *   Mortlake Garage Records/
 *     equipment.json          current equipment list and calibration dates
 *     records-index.json      one line per month, so the app can list months
 *                             without opening every folder
 *     2026-09/
 *       details.json          what is in the month, what Claude read, the
 *                             checklist, the DVSA figures and a history
 *       DVSA files/  QC paperwork/  Calibration certificates/
 *       Removed/              anything taken out — never deleted
 *
 * Every change to a month happens inside a lock, because the app reads three
 * pages at once and two of them finishing together would otherwise each save
 * their own copy of details.json and lose the other's page. */

var RECORDS_SCHEMA = 1;
var DEFAULT_RECORDS_FOLDER_NAME = 'Mortlake Garage Records';
var DETAILS_FILE = 'details.json';
var INDEX_FILE = 'records-index.json';
var EQUIPMENT_FILE = 'equipment.json';
var SUBFOLDERS = { qc: 'QC paperwork', cert: 'Calibration certificates', dvsa: 'DVSA files', removed: 'Removed' };
var DVSA_INPUTS = {
  fileLogDate: { label: 'Test log (by date)', base: 'test-log-by-date' },
  fileLogDuration: { label: 'Test log (by duration)', base: 'test-log-by-duration' },
  fileRating: { label: 'Test Quality Information', base: 'test-quality' }
};
// A page that has said "reading" for longer than this was abandoned (the
// browser was closed mid-read), so it may be read again.
var READING_STALE_MS = 5 * 60 * 1000;

/* ── Errors the app can show as they are ── */
function appError_(code, message) {
  var e = new Error(message);
  e.isAppError = true;
  e.code = code;
  return e;
}

function checkMonth_(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) throw appError_('error', 'That is not a valid month.');
  return month;
}

function checkKind_(kind) {
  if (kind !== 'qc' && kind !== 'cert') throw appError_('error', 'Unknown page type.');
  return kind;
}

/* ── Locking ── */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    throw appError_('busy', 'The records are busy saving something else. Try again in a moment.');
  }
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ── Folders and files ── */
function recordsRoot_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('RECORDS_FOLDER_ID');
  if (id) {
    try {
      var existing = DriveApp.getFolderById(id);
      if (!existing.isTrashed()) return existing;
    } catch (e) { /* the folder was deleted by hand: make a new one below */ }
  }
  var name = props.getProperty('RECORDS_FOLDER_NAME') || DEFAULT_RECORDS_FOLDER_NAME;
  var folder = DriveApp.createFolder(name);
  props.setProperty('RECORDS_FOLDER_ID', folder.getId());
  return folder;
}

function childFolder_(parent, name, create) {
  var it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return create ? parent.createFolder(name) : null;
}

function childFile_(folder, name) {
  var it = folder.getFilesByName(name);
  return it.hasNext() ? it.next() : null;
}

function readJson_(folder, name) {
  var f = childFile_(folder, name);
  if (!f) return null;
  return JSON.parse(f.getBlob().getDataAsString());
}

function writeJson_(folder, name, obj) {
  var text = JSON.stringify(obj, null, 1);
  var f = childFile_(folder, name);
  if (f) f.setContent(text);
  else folder.createFile(name, text, 'application/json');
}

function nowIso_() { return new Date().toISOString(); }

/* Moves a file into the month's Removed folder with the time in its name, so
   two removals of "page-007.jpg" never collide and nothing is ever lost. */
function moveToRemoved_(monthFolder, file) {
  var removed = childFolder_(monthFolder, SUBFOLDERS.removed, true);
  file.setName('removed ' + nowIso_().replace(/[:.]/g, '-') + ' ' + file.getName());
  file.moveTo(removed);
}

/* ── details.json ── */
function emptyDetails_(month) {
  return {
    schema: RECORDS_SCHEMA,
    month: month,
    status: 'draft',            // draft | signed | amending  (signing is stage B)
    signedVersion: 0,
    revisions: { checklist: 0, dvsa: 0 },
    checklist: { state: {}, notes: {} },
    testQuality: null,
    testLog: null,
    dvsaFiles: {},
    qcPages: [],
    certPages: [],
    removedPages: [],
    nextPageNo: 1,
    calibrationSnapshot: null,
    versions: [],
    history: [],
    createdAt: nowIso_(),
    updatedAt: nowIso_()
  };
}

/* Returns { folder, details } for a month. With create=false and nothing
   saved yet, returns null rather than leaving empty folders behind. */
function openMonth_(month, create) {
  var root = recordsRoot_();
  var folder = childFolder_(root, month, create);
  if (!folder) return null;
  var details = readJson_(folder, DETAILS_FILE);
  if (!details) {
    if (!create) return null;
    details = emptyDetails_(month);
  }
  return { root: root, folder: folder, details: details };
}

function saveMonth_(ctx) {
  ctx.details.updatedAt = nowIso_();
  writeJson_(ctx.folder, DETAILS_FILE, ctx.details);
  updateIndex_(ctx.root, ctx.details);
}

function addHistory_(details, what) {
  details.history.push({ at: nowIso_(), what: what });
}

/* Signed months are locked here, on the server, so that nothing in the page —
   including a bug — can change a signed record. */
function assertEditable_(details) {
  if (details.status === 'signed') {
    throw appError_('locked', formatMonthName_(details.month) +
      ' is signed off. Use Amend to make changes.');
  }
}

function formatMonthName_(month) {
  var names = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
               'August', 'September', 'October', 'November', 'December'];
  var p = String(month).split('-');
  return names[parseInt(p[1], 10) - 1] + ' ' + p[0];
}

function pagesOf_(details, kind) { return kind === 'qc' ? details.qcPages : details.certPages; }

function findPage_(details, kind, id) {
  var list = pagesOf_(details, kind);
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

/* What the app needs to know about a page, without the image. */
function publicPage_(p) {
  return {
    id: p.id, kind: p.kind, fileName: p.fileName, sourceName: p.sourceName,
    status: p.status, reading: p.reading || null, error: p.error || null,
    fingerprint: p.fingerprint || null, addedAt: p.addedAt
  };
}

function publicDetails_(d) {
  var out = JSON.parse(JSON.stringify(d));
  out.qcPages = d.qcPages.map(publicPage_);
  out.certPages = d.certPages.map(publicPage_);
  return out;
}

/* ── records-index.json ── */
function readIndex_(root) {
  return readJson_(root, INDEX_FILE) || { schema: RECORDS_SCHEMA, months: {} };
}

function updateIndex_(root, d) {
  var index = readIndex_(root);
  var answered = Object.keys(d.checklist.state || {}).filter(function (k) { return d.checklist.state[k]; }).length;
  var tq = d.testQuality && d.testQuality.site ? {
    period: d.testQuality.period || null,
    siteTests: d.testQuality.site.tests,
    siteFailed: d.testQuality.site.failed,
    nationalFailed: d.testQuality.national ? d.testQuality.national.failed : null
  } : null;
  index.months[d.month] = {
    status: d.status,
    signedVersion: d.signedVersion,
    qcPages: d.qcPages.length,
    qcUnread: d.qcPages.filter(function (p) { return p.status !== 'read'; }).length,
    certPages: d.certPages.length,
    dvsaFiles: Object.keys(d.dvsaFiles),
    checklistAnswered: answered,
    testQuality: tq,
    updatedAt: d.updatedAt
  };
  writeJson_(root, INDEX_FILE, index);
}

/* ── Requests ── */

function recordsStatus_() {
  var root = recordsRoot_();
  return {
    status: 'success',
    migrated: !!PropertiesService.getScriptProperties().getProperty('RECORDS_MIGRATED'),
    folderUrl: root.getUrl()
  };
}

function listMonths_() {
  var root = recordsRoot_();
  return { status: 'success', months: readIndex_(root).months };
}

function loadMonth_(month) {
  checkMonth_(month);
  var ctx = openMonth_(month, false);
  if (!ctx) return { status: 'success', exists: false, details: emptyDetails_(month) };
  return { status: 'success', exists: true, details: publicDetails_(ctx.details) };
}

/* Saves one part of a month that Paul edits by hand (only the checklist so
   far). Each part has its own revision number: if the app's copy is older
   than what is saved, someone changed it on another computer since, and
   saving would silently undo their change — so it is refused instead. */
var EDITABLE_FIELDS = { checklist: true };

function saveMonthFields_(data) {
  var month = checkMonth_(data.month);
  var field = data.field;
  if (!EDITABLE_FIELDS[field]) throw appError_('error', 'That cannot be saved this way.');
  return withLock_(function () {
    var ctx = openMonth_(month, true);
    var d = ctx.details;
    assertEditable_(d);
    var current = d.revisions[field] || 0;
    if (data.baseRevision !== current) {
      return {
        status: 'conflict',
        message: 'This month was changed on another computer. Reload to see the latest.',
        revision: current,
        value: d[field]
      };
    }
    var before = d[field] || {};
    var after = data.value || {};
    d[field] = { state: after.state || {}, notes: after.notes || {} };
    d.revisions[field] = current + 1;
    addHistory_(d, describeChecklistChange_(before, d[field]));
    saveMonth_(ctx);
    return { status: 'success', revision: d.revisions[field] };
  });
}

function describeChecklistChange_(before, after) {
  var keys = {};
  [before.state || {}, after.state || {}, before.notes || {}, after.notes || {}].forEach(function (o) {
    Object.keys(o).forEach(function (k) { keys[k] = true; });
  });
  var changed = Object.keys(keys).filter(function (k) {
    return ((before.state || {})[k] || '') !== ((after.state || {})[k] || '') ||
           ((before.notes || {})[k] || '') !== ((after.notes || {})[k] || '');
  });
  return 'Checklist: ' + changed.length + ' answer' + (changed.length === 1 ? '' : 's') + ' changed';
}

/* Files one of the three DVSA exports, replacing any earlier one for the same
   slot (the earlier one goes to Removed). The figures the app worked out from
   it are saved alongside, so the dashboard does not need to re-read the file. */
function saveDvsaFile_(data) {
  var month = checkMonth_(data.month);
  var slot = DVSA_INPUTS[data.inputId];
  if (!slot) throw appError_('error', 'Unknown DVSA file type.');
  if (!data.base64) throw appError_('error', 'No file received.');
  return withLock_(function () {
    var ctx = openMonth_(month, true);
    var d = ctx.details;
    assertEditable_(d);
    var folder = childFolder_(ctx.folder, SUBFOLDERS.dvsa, true);
    var prev = d.dvsaFiles[data.inputId];
    if (prev) {
      try { moveToRemoved_(ctx.folder, DriveApp.getFileById(prev.fileId)); } catch (e) { /* already gone */ }
    }
    var ext = (String(data.fileName || '').match(/\.[A-Za-z0-9]{1,5}$/) || ['.xlsx'])[0].toLowerCase();
    var blob = Utilities.newBlob(Utilities.base64Decode(data.base64),
                                 data.mimeType || 'application/octet-stream', slot.base + ext);
    var file = folder.createFile(blob);
    d.dvsaFiles[data.inputId] = {
      fileId: file.getId(), fileName: String(data.fileName || slot.base + ext),
      mimeType: data.mimeType || '', size: file.getSize(), savedAt: nowIso_()
    };
    var figures = data.figures || {};
    if (figures.testQuality) d.testQuality = figures.testQuality;
    if (figures.testLog) d.testLog = figures.testLog;
    d.revisions.dvsa = (d.revisions.dvsa || 0) + 1;
    addHistory_(d, (prev ? 'Replaced ' : 'Added ') + slot.label + ': ' + d.dvsaFiles[data.inputId].fileName);
    saveMonth_(ctx);
    return { status: 'success', file: d.dvsaFiles[data.inputId], revision: d.revisions.dvsa };
  });
}

function getDvsaFile_(data) {
  var month = checkMonth_(data.month);
  var ctx = openMonth_(month, false);
  var entry = ctx && ctx.details.dvsaFiles[data.inputId];
  if (!entry) throw appError_('missing', 'That file is not saved for ' + formatMonthName_(month) + '.');
  var file;
  try { file = DriveApp.getFileById(entry.fileId); }
  catch (e) { throw appError_('missing', 'File missing from Google Drive: ' + entry.fileName); }
  return { status: 'success', fileName: entry.fileName, mimeType: entry.mimeType,
           base64: Utilities.base64Encode(file.getBlob().getBytes()) };
}

/* Files a scanned page and asks Claude to read it, in three steps so that the
   slow part (Claude) happens outside the lock:
     1. (locked)   file the image and mark the page "reading"
     2. (unlocked) Claude reads it
     3. (locked)   record what was read
   The image is filed before it is read, so a page Claude can't read is still
   kept and can be retried later. A page already filed (same fingerprint) is
   not stored or read again. */
function fileAndReadPage_(kind, data) {
  var month = checkMonth_(data.month);
  if (!data.imageBase64) throw appError_('error', 'No image received.');

  var step1 = withLock_(function () {
    var ctx = openMonth_(month, true);
    var d = ctx.details;
    assertEditable_(d);
    var existing = null;
    if (data.fingerprint) {
      pagesOf_(d, kind).forEach(function (p) { if (p.fingerprint === data.fingerprint) existing = p; });
    }
    if (existing && existing.status === 'read') return { duplicate: true, page: existing };
    if (existing && existing.status === 'reading' &&
        Date.now() - new Date(existing.readingStartedAt).getTime() < READING_STALE_MS) {
      return { duplicate: true, page: existing };
    }
    var page = existing;
    if (!page) {
      var no = d.nextPageNo++;
      var name = (kind === 'qc' ? 'page-' : 'cert-') + ('00' + no).slice(-3) + '.jpg';
      var folder = childFolder_(ctx.folder, SUBFOLDERS[kind], true);
      var blob = Utilities.newBlob(Utilities.base64Decode(data.imageBase64), data.mimeType || 'image/jpeg', name);
      var file = folder.createFile(blob);
      page = {
        id: kind + '-' + no, kind: kind, fileId: file.getId(), fileName: name,
        mimeType: data.mimeType || 'image/jpeg', sourceName: String(data.sourceName || name),
        fingerprint: data.fingerprint || null, addedAt: nowIso_(), status: 'reading'
      };
      pagesOf_(d, kind).push(page);
      addHistory_(d, 'Added ' + (kind === 'qc' ? 'QC page ' : 'certificate ') + name + ' (' + page.sourceName + ')');
    }
    page.status = 'reading';
    page.readingStartedAt = nowIso_();
    saveMonth_(ctx);
    return { page: page };
  });

  if (step1.duplicate) {
    return { status: 'success', duplicate: true, saved: true, result: step1.page.reading || null,
             page: publicPage_(step1.page) };
  }
  return readAndRecord_(kind, month, step1.page.id, data.imageBase64, data.mimeType);
}

function readAndRecord_(kind, month, pageId, imageBase64, mimeType) {
  var res = kind === 'qc' ? analyzeQcPage_(imageBase64, mimeType) : analyzeCalibrationCert_(imageBase64, mimeType);
  var page = withLock_(function () {
    var ctx = openMonth_(month, false);
    var p = ctx && findPage_(ctx.details, kind, pageId);
    if (!p) return null;   // removed while it was being read
    if (res.status === 'success') {
      p.status = 'read';
      p.reading = res.result;
      p.error = null;
      addHistory_(ctx.details, 'Read ' + p.fileName + describeReading_(kind, res.result));
    } else {
      p.status = 'error';
      p.error = res.message || 'Could not read this page.';
      addHistory_(ctx.details, 'Could not read ' + p.fileName + ': ' + p.error);
    }
    delete p.readingStartedAt;
    saveMonth_(ctx);
    return p;
  });
  return {
    status: res.status === 'success' ? 'success' : 'error',
    message: res.message,
    result: res.result || null,
    saved: !!page,
    page: page ? publicPage_(page) : null
  };
}

function describeReading_(kind, r) {
  if (!r) return '';
  if (kind === 'cert') return r.equipment_name ? ' (' + r.equipment_name + (r.serial_number ? ', serial ' + r.serial_number : '') + ')' : '';
  var bits = [];
  if (r.registration) bits.push(r.registration);
  if (r.document_type && r.document_type !== 'other') bits.push(r.document_type.replace(/_/g, ' '));
  return bits.length ? ' (' + bits.join(', ') + ')' : '';
}

function retryPage_(data) {
  var month = checkMonth_(data.month);
  var kind = checkKind_(data.kind);
  var step1 = withLock_(function () {
    var ctx = openMonth_(month, false);
    var p = ctx && findPage_(ctx.details, kind, data.id);
    if (!p) throw appError_('missing', 'That page is no longer filed.');
    assertEditable_(ctx.details);
    p.status = 'reading';
    p.readingStartedAt = nowIso_();
    saveMonth_(ctx);
    return p;
  });
  var bytes = DriveApp.getFileById(step1.fileId).getBlob().getBytes();
  return readAndRecord_(kind, month, step1.id, Utilities.base64Encode(bytes), step1.mimeType);
}

function getPageImage_(data) {
  var month = checkMonth_(data.month);
  var kind = checkKind_(data.kind);
  var ctx = openMonth_(month, false);
  var p = ctx && findPage_(ctx.details, kind, data.id);
  if (!p) throw appError_('missing', 'That page is not filed.');
  var file;
  try { file = DriveApp.getFileById(p.fileId); }
  catch (e) { throw appError_('missing', 'File missing from Google Drive: ' + p.fileName); }
  return { status: 'success', mimeType: p.mimeType, base64: Utilities.base64Encode(file.getBlob().getBytes()) };
}

function removePage_(data) {
  var month = checkMonth_(data.month);
  var kind = checkKind_(data.kind);
  return withLock_(function () {
    var ctx = openMonth_(month, false);
    var d = ctx && ctx.details;
    var p = d && findPage_(d, kind, data.id);
    if (!p) throw appError_('missing', 'That page is not filed.');
    assertEditable_(d);
    try { moveToRemoved_(ctx.folder, DriveApp.getFileById(p.fileId)); } catch (e) { /* already gone */ }
    var list = pagesOf_(d, kind);
    list.splice(list.indexOf(p), 1);
    p.removedAt = nowIso_();
    d.removedPages.push(p);
    addHistory_(d, 'Removed ' + p.fileName + ' (' + p.sourceName + ')');
    saveMonth_(ctx);
    return { status: 'success' };
  });
}

/* ── Equipment ── */
function loadEquipment_() {
  var root = recordsRoot_();
  var eq = readJson_(root, EQUIPMENT_FILE);
  return { status: 'success', exists: !!eq, list: eq ? eq.list : [], revision: eq ? eq.revision : 0 };
}

function saveEquipment_(data) {
  if (!data.list || typeof data.list.length !== 'number') throw appError_('error', 'No equipment list received.');
  return withLock_(function () {
    var root = recordsRoot_();
    var eq = readJson_(root, EQUIPMENT_FILE) || { revision: 0, list: [] };
    if (data.baseRevision !== eq.revision) {
      return { status: 'conflict', message: 'The equipment list was changed on another computer. Reload to see the latest.',
               revision: eq.revision, list: eq.list };
    }
    eq.list = data.list;
    eq.revision++;
    eq.updatedAt = nowIso_();
    writeJson_(root, EQUIPMENT_FILE, eq);
    return { status: 'success', revision: eq.revision };
  });
}

/* ── Moving across what was saved before Monthly Records ──
   Runs once. The old Script Properties are copied, never deleted, so the
   previous version of the app keeps working and nothing can be lost if this
   goes wrong. The test-log totals were only ever kept in Paul's browser, so
   the app sends those; any month that has none yet takes the browser's. That
   part may run again from another computer without harm. */
function monthFromPeriod_(period) {
  var m = /^([A-Za-z]{3})-(\d{2})$/.exec(String(period || ''));
  if (!m) return null;
  var idx = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[1].toLowerCase());
  return idx < 0 ? null : '20' + m[2] + '-' + ('0' + (idx + 1)).slice(-2);
}

function migrateLegacy_(data) {
  return withLock_(function () {
    var props = PropertiesService.getScriptProperties();
    var root = recordsRoot_();
    var already = !!props.getProperty('RECORDS_MIGRATED');
    var touched = {};
    var cache = {};
    function month_(m) {
      if (!cache[m]) cache[m] = openMonth_(m, true);
      return cache[m];
    }

    if (!already) {
      var all = props.getProperties();
      Object.keys(all).forEach(function (k) {
        var v;
        try { v = JSON.parse(all[k]); } catch (e) { return; }
        if (k.indexOf(MONTH_PREFIX) === 0) {
          var m = k.substring(MONTH_PREFIX.length);
          if (!/^\d{4}-\d{2}$/.test(m) || !v) return;
          var ctx = month_(m);
          if (!Object.keys(ctx.details.checklist.state).length) {
            ctx.details.checklist = { state: v.state || {}, notes: v.notes || {} };
            touched[m] = true;
          }
        } else if (k.indexOf(TQ_PREFIX) === 0) {
          var m2 = monthFromPeriod_(k.substring(TQ_PREFIX.length));
          if (!m2 || !v || !v.site) return;   // only full breakdowns carry over
          var ctx2 = month_(m2);
          if (!ctx2.details.testQuality) { ctx2.details.testQuality = v; touched[m2] = true; }
        } else if (k === DATA_PREFIX + 'calibration') {
          if (!childFile_(root, EQUIPMENT_FILE) && v && v.length) {
            writeJson_(root, EQUIPMENT_FILE, { revision: 1, list: v, updatedAt: nowIso_() });
          }
        }
      });
    }

    var testLogs = data.browserTestLog || {};
    Object.keys(testLogs).forEach(function (m) {
      if (!/^\d{4}-\d{2}$/.test(m) || !testLogs[m]) return;
      var ctx = month_(m);
      if (!ctx.details.testLog) { ctx.details.testLog = testLogs[m]; touched[m] = true; }
    });

    Object.keys(touched).forEach(function (m) {
      addHistory_(cache[m].details, 'Moved across from the previous version of the app');
      saveMonth_(cache[m]);
    });
    if (!already) props.setProperty('RECORDS_MIGRATED', nowIso_());
    return { status: 'success', alreadyMigrated: already, monthsUpdated: Object.keys(touched).sort() };
  });
}
