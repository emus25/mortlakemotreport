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
var BACKEND_VERSION = 18;

// Rate limits are the main failure mode when a whole scan is sorted at once:
// a burst of requests can trip 429s, and UrlFetchApp does not retry for us
// the way the official SDKs do. Retry a few times with growing backoff.
var MAX_ATTEMPTS = 4;

function doPost(e) {
  var data;
  try { data = JSON.parse(e.postData.contents); }
  catch (err) { return jsonResponse_({ status: 'error', message: 'The request could not be understood.' }); }

  // Anything that goes wrong comes back as a clean answer the app can show,
  // never as a Google error page the app cannot read. Every answer says how
  // long the work took here, so slowness can be traced to Google's own
  // start-up and network time versus the work done in this script.
  var started = Date.now();
  var out;
  try {
    out = route_(data);
  } catch (err) {
    out = (err && err.isAppError)
      ? { status: err.code, message: err.message }
      : { status: 'error', message: 'Something went wrong on the server: ' + (err && err.message || err) };
    if (!err || !err.isAppError || err.code === 'busy') logError_(data.action, out.message);
  }
  out.ms = Date.now() - started;
  return jsonResponse_(out);
}

function route_(data) {
  memo_ = {};   // Drive objects found during this request only
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
    case 'openSession':      return openSession_(data);
    case 'recordsStatus':    return recordsStatus_();
    case 'migrateLegacy':    return migrateLegacy_(data);
    case 'listMonths':       return listMonths_();
    case 'loadMonth':        return loadMonth_(data.month);
    case 'saveMonthFields':  return saveMonthFields_(data);
    case 'saveDvsaFile':     return saveDvsaFile_(data);
    case 'getDvsaFile':      return getDvsaFile_(data);
    case 'getPageImage':     return getPageImage_(data);
    case 'removePage':       return removePage_(data);
    case 'filePage':         return filePage_(data);
    case 'readPage':         return readPage_(data, false);
    case 'retryPage':        return readPage_(data, true);
    case 'getPage':          return getPage_(data);
    case 'getErrors':        return { status: 'success', errors: readErrors_() };
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
var READING_STALE_MS = 3 * 60 * 1000;

/* ── Errors the app can show as they are ── */
function appError_(code, message) {
  var e = new Error(message);
  e.isAppError = true;
  e.code = code;
  return e;
}

/* A short log of the last things that went wrong on the server, kept in
   Script Properties, so problems can be seen directly instead of guessed
   at (getErrors). */
function logError_(action, message) {
  try {
    var list = readErrors_();
    list.push({ at: nowIso_(), action: String(action || ''), message: String(message || '').slice(0, 300) });
    PropertiesService.getScriptProperties().setProperty('ERRLOG', JSON.stringify(list.slice(-30)));
  } catch (e) { /* logging must never cause a failure of its own */ }
}

function readErrors_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('ERRLOG') || '[]'); } catch (e) { return []; }
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
/* Changes to the records happen one at a time. Most wait up to 30 seconds
   for their turn; recording what Claude has just read waits longer
   (RECORD_WAIT_MS), because giving up there would waste a finished reading
   and leave the page stuck on "being read". */
var RECORD_WAIT_MS = 120000;

function withLock_(fn, waitMs) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(waitMs || 30000);
  } catch (e) {
    throw appError_('busy', 'The records are busy saving something else. Try again in a moment.');
  }
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ── Folders and files ──
   Every Drive call costs a fraction of a second, and saves happen one at a
   time (inside the lock), so the number of Drive calls per save decides how
   fast a batch of scans goes through. Searching a folder by name is the
   expensive part, so once a folder or file has been found its id is
   remembered in Script Properties (ID_…) and it is opened directly from then
   on. If a remembered id no longer works (deleted by hand), it is searched
   for again. */
var memo_ = {};

function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function setProp_(k, v) { PropertiesService.getScriptProperties().setProperty(k, v); }

function recordsRoot_() {
  if (memo_.root) return memo_.root;
  var id = prop_('RECORDS_FOLDER_ID');
  if (id) {
    try {
      var existing = DriveApp.getFolderById(id);
      if (!existing.isTrashed()) return (memo_.root = existing);
    } catch (e) { /* the folder was deleted by hand: make a new one below */ }
  }
  var name = prop_('RECORDS_FOLDER_NAME') || DEFAULT_RECORDS_FOLDER_NAME;
  var folder = DriveApp.createFolder(name);
  setProp_('RECORDS_FOLDER_ID', folder.getId());
  // Everything remembered pointed into the old folder: forget it all.
  var props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(function (k) {
    if (k.indexOf('ID_') === 0 || k.indexOf(INDEX_PREFIX) === 0) props.deleteProperty(k);
  });
  memo_ = { root: folder };
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

/* A folder found by remembered id, or by name inside getParent() (called only
   when it has to be searched for). */
function folderAt_(key, getParent, name, create) {
  if (memo_[key]) return memo_[key];
  var id = prop_('ID_' + key);
  if (id) {
    try { return (memo_[key] = DriveApp.getFolderById(id)); } catch (e) { /* search below */ }
  }
  var parent = getParent();
  var f = parent && childFolder_(parent, name, create);
  if (!f) return null;
  setProp_('ID_' + key, f.getId());
  return (memo_[key] = f);
}

function fileAt_(key, folder, name) {
  if (memo_[key]) return memo_[key];
  var id = prop_('ID_' + key);
  if (id) {
    try { return (memo_[key] = DriveApp.getFileById(id)); } catch (e) { /* search below */ }
  }
  var f = childFile_(folder, name);
  if (!f) return null;
  setProp_('ID_' + key, f.getId());
  return (memo_[key] = f);
}

function readJsonAt_(key, folder, name) {
  var f = fileAt_(key, folder, name);
  return f ? JSON.parse(f.getBlob().getDataAsString()) : null;
}

function writeJsonAt_(key, folder, name, obj) {
  var text = JSON.stringify(obj, null, 1);
  var f = fileAt_(key, folder, name);
  if (f) { f.setContent(text); return; }
  f = folder.createFile(name, text, 'application/json');
  setProp_('ID_' + key, f.getId());
  memo_[key] = f;
}

function monthFolder_(month, create) {
  return folderAt_('m_' + month, recordsRoot_, month, create);
}

function subFolder_(ctx, sub) {
  return folderAt_('s_' + ctx.details.month + '_' + sub, function () { return ctx.folder; }, SUBFOLDERS[sub], true);
}

function readEquipment_() { return readJsonAt_('equipment', recordsRoot_(), EQUIPMENT_FILE); }
function writeEquipment_(eq) { writeJsonAt_('equipment', recordsRoot_(), EQUIPMENT_FILE, eq); }

function nowIso_() { return new Date().toISOString(); }

/* Moves a file into the month's Removed folder with the time in its name, so
   two removals of "page-007.jpg" never collide and nothing is ever lost. */
function moveToRemoved_(ctx, file) {
  var removed = subFolder_(ctx, 'removed');
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
  var folder = monthFolder_(month, create);
  if (!folder) return null;
  var details = readJsonAt_('d_' + month, folder, DETAILS_FILE);
  if (!details) {
    if (!create) return null;
    details = emptyDetails_(month);
  }
  return { folder: folder, details: details };
}

function saveMonth_(ctx) {
  ctx.details.updatedAt = nowIso_();
  writeJsonAt_('d_' + ctx.details.month, ctx.folder, DETAILS_FILE, ctx.details);
  putProp_('MST_' + ctx.details.month, ctx.details.status);
  updateIndex_(ctx.details);
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

/* ── The records index ──
   One short line per month (status, counts, headline figures), so the app can
   list the months without opening every folder. It is kept in Script
   Properties (IDX_YYYY-MM), which is far quicker than a Drive file, and can
   always be rebuilt from the months' details.json. Version 13–15 kept it in
   records-index.json; that is read once and moved across. */
var INDEX_PREFIX = 'IDX_';

function readIndex_() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var months = {};
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(INDEX_PREFIX) !== 0) return;
    try { months[k.substring(INDEX_PREFIX.length)] = JSON.parse(all[k]); } catch (e) {}
  });
  if (!all.INDEX_MOVED) {
    var old = readJsonAt_('index', recordsRoot_(), INDEX_FILE);
    if (old && old.months) {
      Object.keys(old.months).forEach(function (m) {
        if (!months[m] && /^\d{4}-\d{2}$/.test(m)) {
          months[m] = old.months[m];
          setProp_(INDEX_PREFIX + m, JSON.stringify(old.months[m]));
        }
      });
    }
    setProp_('INDEX_MOVED', nowIso_());
  }
  return { schema: RECORDS_SCHEMA, months: months };
}

function updateIndex_(d) {
  var pages = pagesLive_(d.month) ? readLivePages_(d.month) : { qc: d.qcPages, cert: d.certPages };
  var answered = Object.keys(d.checklist.state || {}).filter(function (k) { return d.checklist.state[k]; }).length;
  var tq = d.testQuality && d.testQuality.site ? {
    period: d.testQuality.period || null,
    siteTests: d.testQuality.site.tests,
    siteFailed: d.testQuality.site.failed,
    nationalFailed: d.testQuality.national ? d.testQuality.national.failed : null
  } : null;
  setProp_(INDEX_PREFIX + d.month, JSON.stringify({
    status: d.status,
    signedVersion: d.signedVersion,
    qcPages: pages.qc.length,
    qcUnread: pages.qc.filter(function (p) { return p.status !== 'read'; }).length,
    certPages: pages.cert.length,
    dvsaFiles: Object.keys(d.dvsaFiles),
    checklistAnswered: answered,
    testQuality: tq,
    updatedAt: d.updatedAt
  }));
}

/* ── Requests ── */

/* Everything the app needs to start, in one trip. Each request to Apps Script
   costs a second or more before any work is done (and much more when Google
   has to wake the script up), so asking five questions one after another made
   opening the app painfully slow. This answers them all at once:
     - moves the old data across, if that hasn't happened yet;
     - files the equipment list from this browser, if none is filed yet;
     - returns the equipment list, the records index and the chosen month. */
function openSession_(data) {
  var month = checkMonth_(data.month);
  var props = PropertiesService.getScriptProperties();
  var root = recordsRoot_();

  var migration = null;
  var browserLogs = data.browserTestLog || {};
  if (!props.getProperty('RECORDS_MIGRATED') || Object.keys(browserLogs).length) {
    migration = migrateLegacy_(data);
  }

  var eq = readEquipment_();
  if (!eq && data.seedEquipment && data.seedEquipment.length) {
    eq = withLock_(function () {
      var again = readEquipment_();   // another computer may have just done it
      if (again) return again;
      var fresh = { revision: 1, list: data.seedEquipment, updatedAt: nowIso_() };
      writeEquipment_(fresh);
      return fresh;
    });
  }

  var m = loadMonth_(month);
  return {
    status: 'success',
    version: BACKEND_VERSION,
    folderUrl: root.getUrl(),
    migration: migration,
    equipment: { exists: !!eq, list: eq ? eq.list : [], revision: eq ? eq.revision : 0 },
    months: readIndex_().months,
    month: { exists: m.exists, details: m.details }
  };
}

function recordsStatus_() {
  var root = recordsRoot_();
  return {
    status: 'success',
    migrated: !!PropertiesService.getScriptProperties().getProperty('RECORDS_MIGRATED'),
    folderUrl: root.getUrl()
  };
}

function listMonths_() {
  return { status: 'success', months: readIndex_().months };
}

function loadMonth_(month) {
  checkMonth_(month);
  // Opening a month brings its Drive record up to date with quick storage.
  if (pagesLive_(month) && allProps_()['PGDIRTY_' + month]) {
    withLock_(function () { flushPages_(month); });
    memo_ = {};
  }
  var ctx = openMonth_(month, false);
  if (!ctx) return { status: 'success', exists: false, details: emptyDetails_(month) };
  var d = ctx.details;
  if (pagesLive_(month)) {
    var live = readLivePages_(month);
    d.qcPages = live.qc;
    d.certPages = live.cert;
  }
  return { status: 'success', exists: true, details: publicDetails_(d) };
}

/* Saves one part of a month that Paul edits by hand (only the checklist so
   far). Each part has its own revision number: if the app's copy is older
   than what is saved, someone changed it on another computer since, and
   saving would silently undo their change — so it is refused instead. */
var EDITABLE_FIELDS = { checklist: true };

function saveMonthFields_(data) {
  var month = checkMonth_(data.month);
  var field = data.field;
  if (!Object.prototype.hasOwnProperty.call(EDITABLE_FIELDS, field)) throw appError_('error', 'That cannot be saved this way.');
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
  var slot = dvsaSlot_(data.inputId);
  if (!data.base64) throw appError_('error', 'No file received.');
  assertMonthEditable_(month);
  if (!prop_('ID_s_' + month + '_dvsa')) {
    withLock_(function () {
      var c = openMonth_(month, true);
      subFolder_(c, 'dvsa');
      if (!readJsonAt_('d_' + month, c.folder, DETAILS_FILE)) saveMonth_(c);
    });
    memo_ = {};
  }
  // Upload outside the lock (the slow part); only the record change is inside.
  var ext = (String(data.fileName || '').match(/\.[A-Za-z0-9]{1,5}$/) || ['.xlsx'])[0].toLowerCase();
  var folder = folderAt_('s_' + month + '_dvsa', function () { return monthFolder_(month, true); }, SUBFOLDERS.dvsa, true);
  var file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(data.base64),
                                                 data.mimeType || 'application/octet-stream', slot.base + ext));
  var size = file.getSize();
  var out = withLock_(function () {
    var ctx = openMonth_(month, true);
    var d = ctx.details;
    assertEditable_(d);
    var prev = d.dvsaFiles[data.inputId];
    d.dvsaFiles[data.inputId] = {
      fileId: file.getId(), fileName: String(data.fileName || slot.base + ext),
      mimeType: data.mimeType || '', size: size, savedAt: nowIso_()
    };
    var figures = data.figures || {};
    if (figures.testQuality) d.testQuality = figures.testQuality;
    if (figures.testLog) d.testLog = figures.testLog;
    d.revisions.dvsa = (d.revisions.dvsa || 0) + 1;
    addHistory_(d, (prev ? 'Replaced ' : 'Added ') + slot.label + ': ' + d.dvsaFiles[data.inputId].fileName);
    saveMonth_(ctx);
    return { prev: prev, ctx: ctx, entry: d.dvsaFiles[data.inputId], revision: d.revisions.dvsa };
  });
  if (out.prev) {
    try { moveToRemoved_(out.ctx, DriveApp.getFileById(out.prev.fileId)); }
    catch (e) { logError_('saveDvsaFile', 'Could not move the replaced file to Removed: ' + e.message); }
  }
  return { status: 'success', file: out.entry, revision: out.revision };
}

function dvsaSlot_(inputId) {
  if (!Object.prototype.hasOwnProperty.call(DVSA_INPUTS, inputId)) throw appError_('error', 'Unknown DVSA file type.');
  return DVSA_INPUTS[inputId];
}

function getDvsaFile_(data) {
  var month = checkMonth_(data.month);
  dvsaSlot_(data.inputId);
  var ctx = openMonth_(month, false);
  var entry = ctx && ctx.details.dvsaFiles[data.inputId];
  if (!entry) throw appError_('missing', 'That file is not saved for ' + formatMonthName_(month) + '.');
  var file;
  try { file = DriveApp.getFileById(entry.fileId); }
  catch (e) { throw appError_('missing', 'File missing from Google Drive: ' + entry.fileName); }
  return { status: 'success', fileName: entry.fileName, mimeType: entry.mimeType,
           base64: Utilities.base64Encode(file.getBlob().getBytes()) };
}

/* ═══════════════ Pages: the quick-storage page list ═══════════════
 * Decided 15 Oct 2026 (SPEC.md section 4), for speed. While a month is being
 * worked on, each scanned page's details live in Script Properties, which
 * takes a fraction of a second to change, instead of in details.json, which
 * takes several seconds to read and rewrite in Drive. Saves happen one at a
 * time, so that difference decides whether a batch of scans flows or queues.
 *
 *   PGLIVE_<month>        the month's page list is in quick storage
 *   PGNEXT_<month>        the next page number
 *   PG_<month>_<id>       one page (what Claude read, its status, its file)
 *   PGX_<month>_<id>      a page removed since the last write to Drive
 *   HB_<month>_<time>_<n> a history line not yet written to Drive
 *   PGDIRTY_<month>       something changed since the last write to Drive
 *   MST_<month>           the month's status (draft / signed / amending)
 *
 * The page IMAGES always go straight into Drive. flushPages_ writes the list
 * into details.json whenever the month is opened; months untouched for a
 * while are then cleared from quick storage (makeLive_ brings them back). */

var ARCHIVE_AFTER_MS = 35 * 24 * 60 * 60 * 1000;

function allProps_(fresh) {
  if (fresh || !memo_.props) memo_.props = PropertiesService.getScriptProperties().getProperties();
  return memo_.props;
}
function putProp_(k, v) {
  PropertiesService.getScriptProperties().setProperty(k, v);
  if (memo_.props) memo_.props[k] = v;
}
function dropProp_(k) {
  PropertiesService.getScriptProperties().deleteProperty(k);
  if (memo_.props) delete memo_.props[k];
}

function monthStatus_(month) {
  var s = allProps_()['MST_' + month];
  if (s) return s;
  var ctx = openMonth_(month, false);
  s = ctx ? ctx.details.status : 'draft';
  putProp_('MST_' + month, s);
  return s;
}

function assertMonthEditable_(month) {
  if (monthStatus_(month) === 'signed') {
    throw appError_('locked', formatMonthName_(month) + ' is signed off. Use Amend to make changes.');
  }
}

function pagesLive_(month) { return !!allProps_()['PGLIVE_' + month]; }

function pageNo_(p) { return parseInt(String(p.id).split('-')[1], 10) || 0; }

function readLivePages_(month) {
  var all = allProps_(), pre = 'PG_' + month + '_', out = { qc: [], cert: [] };
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(pre) !== 0) return;
    try { var p = JSON.parse(all[k]); (out[p.kind] || out.qc).push(p); } catch (e) {}
  });
  out.qc.sort(function (a, b) { return pageNo_(a) - pageNo_(b); });
  out.cert.sort(function (a, b) { return pageNo_(a) - pageNo_(b); });
  return out;
}

/* Puts a month's page list into quick storage. Called inside the lock, and
   only the first time a month is worked on (or after it was cleared). */
function makeLive_(month) {
  if (allProps_(true)['PGLIVE_' + month]) return;
  var ctx = openMonth_(month, true);
  var d = ctx.details;
  if (!readJsonAt_('d_' + month, ctx.folder, DETAILS_FILE)) saveMonth_(ctx);   // first ever save of this month
  d.qcPages.concat(d.certPages).forEach(function (p) { putProp_('PG_' + month + '_' + p.id, JSON.stringify(p)); });
  putProp_('PGNEXT_' + month, String(d.nextPageNo || 1));
  putProp_('MST_' + month, d.status);
  putProp_('PGLIVE_' + month, nowIso_());
}

function putPage_(month, p) {
  putProp_('PG_' + month + '_' + p.id, JSON.stringify(p));
  putProp_('PGDIRTY_' + month, nowIso_());
}

function pageHistory_(month, what) {
  putProp_('HB_' + month + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
           JSON.stringify({ at: nowIso_(), what: what }));
  putProp_('PGDIRTY_' + month, nowIso_());
}

function findLivePage_(month, kind, id) {
  var s = allProps_()['PG_' + month + '_' + id];
  if (!s) return null;
  var p = JSON.parse(s);
  return p.kind === kind ? p : null;
}

/* The index's page counts, kept up to date from quick storage. */
function updateIndexPages_(month) {
  var key = INDEX_PREFIX + month;
  var entry = {};
  try { entry = JSON.parse(allProps_()[key] || '{}'); } catch (e) {}
  var live = readLivePages_(month);
  entry.qcPages = live.qc.length;
  entry.qcUnread = live.qc.filter(function (p) { return p.status !== 'read'; }).length;
  entry.certPages = live.cert.length;
  entry.status = entry.status || 'draft';
  entry.updatedAt = nowIso_();
  putProp_(key, JSON.stringify(entry));
}

/* Writes the quick-storage page list, removals and history into
   details.json. Inside the lock. Clears quick storage for a month nobody has
   touched for ARCHIVE_AFTER_MS once every page is settled. */
function flushPages_(month) {
  var all = allProps_(true);
  if (!all['PGLIVE_' + month]) return;
  var ctx = openMonth_(month, true);
  var d = ctx.details;
  var live = readLivePages_(month);
  if (all['PGDIRTY_' + month]) {
    d.qcPages = live.qc;
    d.certPages = live.cert;
    d.nextPageNo = parseInt(all['PGNEXT_' + month] || d.nextPageNo || 1, 10);
    Object.keys(all).sort().forEach(function (k) {
      if (k.indexOf('PGX_' + month + '_') === 0) {
        try { d.removedPages.push(JSON.parse(all[k])); } catch (e) {}
        dropProp_(k);
      } else if (k.indexOf('HB_' + month + '_') === 0) {
        try { d.history.push(JSON.parse(all[k])); } catch (e) {}
        dropProp_(k);
      }
    });
    saveMonth_(ctx);
    dropProp_('PGDIRTY_' + month);
  }
  var settled = live.qc.concat(live.cert).every(function (p) { return p.status === 'read' || p.status === 'error'; });
  var newest = 0;
  live.qc.concat(live.cert).forEach(function (p) { newest = Math.max(newest, new Date(p.readAt || p.addedAt || 0).getTime()); });
  if (settled && Date.now() - newest > ARCHIVE_AFTER_MS) {
    live.qc.concat(live.cert).forEach(function (p) { dropProp_('PG_' + month + '_' + p.id); });
    dropProp_('PGNEXT_' + month);
    dropProp_('PGLIVE_' + month);
  }
}

/* A page by id from quick storage, or from details.json for a month not in
   quick storage. */
function lookupPage_(month, kind, id) {
  if (pagesLive_(month)) return findLivePage_(month, kind, id);
  var ctx = openMonth_(month, false);
  return ctx ? findPage_(ctx.details, kind, id) : null;
}

/* ── Requests ── */

function fileAndReadPage_(kind, data) {
  var month = checkMonth_(data.month);
  if (!data.imageBase64) throw appError_('error', 'No image received.');
  var step1 = fileStep_(kind, month, data, true);
  if (step1.duplicate) {
    return { status: 'success', duplicate: true, saved: true, result: step1.page.reading || null,
             page: publicPage_(step1.page) };
  }
  return readAndRecord_(kind, month, step1.page.id, data.imageBase64, data.mimeType);
}

/* Filing on its own: safe to send twice (the fingerprint recognises a page
   already filed). The app files every page this way first, then asks for
   each to be read in a separate request (readPage_). */
function filePage_(data) {
  var kind = checkKind_(data.kind);
  var month = checkMonth_(data.month);
  if (!data.imageBase64) throw appError_('error', 'No image received.');
  var step1 = fileStep_(kind, month, data, false);
  return { status: 'success', duplicate: !!step1.duplicate, page: publicPage_(step1.page) };
}

function fileStep_(kind, month, data, markReading) {
  function duplicateOf_(live) {
    var existing = null;
    if (data.fingerprint) {
      live[kind].forEach(function (p) { if (p.fingerprint === data.fingerprint) existing = p; });
    }
    if (!existing) return null;
    if (existing.status === 'read' || isFreshlyReading_(existing) || !markReading) return { duplicate: true, page: existing };
    return { again: existing };   // filed before but not read: read it now
  }

  assertMonthEditable_(month);

  // 1. The first page of a month (or after it was cleared) sets things up.
  if (!pagesLive_(month) || !prop_('ID_s_' + month + '_' + kind)) {
    withLock_(function () {
      makeLive_(month);
      subFolder_(openMonth_(month, true), kind);
    });
    allProps_(true);
  }

  // 2. A page already filed needs no upload at all.
  var known = duplicateOf_(readLivePages_(month));
  if (known && known.duplicate) return known;

  // 3. Upload the image OUTSIDE the lock: the slow part.
  var folder = folderAt_('s_' + month + '_' + kind, function () { return monthFolder_(month, true); }, SUBFOLDERS[kind], true);
  var blob = Utilities.newBlob(Utilities.base64Decode(data.imageBase64), data.mimeType || 'image/jpeg',
                               'incoming ' + nowIso_().replace(/[:.]/g, '-') + ' ' + Math.random().toString(36).slice(2, 8) + '.jpg');
  var file = folder.createFile(blob);

  // 4. File it: quick storage only, so the lock is held for a moment.
  var out = withLock_(function () {
    allProps_(true);
    assertMonthEditable_(month);
    var dup = duplicateOf_(readLivePages_(month));
    if (dup && dup.duplicate) return { result: dup, binUpload: true };
    var page = dup && dup.again;
    var name = null;
    if (!page) {
      var no = parseInt(prop_('PGNEXT_' + month) || '1', 10);
      putProp_('PGNEXT_' + month, String(no + 1));
      name = (kind === 'qc' ? 'page-' : 'cert-') + ('00' + no).slice(-3) + '.jpg';
      page = {
        id: kind + '-' + no, kind: kind, fileId: file.getId(), fileName: name,
        mimeType: data.mimeType || 'image/jpeg', sourceName: String(data.sourceName || name),
        fingerprint: data.fingerprint || null, addedAt: nowIso_(), status: 'unread'
      };
      pageHistory_(month, 'Added ' + (kind === 'qc' ? 'QC page ' : 'certificate ') + name + ' (' + page.sourceName + ')');
    }
    if (markReading) {
      page.status = 'reading';
      page.readingStartedAt = nowIso_();
    }
    putPage_(month, page);
    updateIndexPages_(month);
    return { result: { page: page }, name: name, binUpload: !name };
  });

  // 5. Tidy the upload outside the lock: give it its page name, or bin it if
  //    this page was already filed (that copy was never part of the records).
  try {
    if (out.binUpload) file.setTrashed(true); else file.setName(out.name);
  } catch (e) { logError_('fileStep', 'Could not rename/bin upload: ' + e.message); }
  return out.result;
}

function isFreshlyReading_(p) {
  return p.status === 'reading' && p.readingStartedAt &&
         Date.now() - new Date(p.readingStartedAt).getTime() < READING_STALE_MS;
}

/* Claude reads the page (outside the lock), then the result is recorded in
   quick storage. Recording waits longer for its turn (RECORD_WAIT_MS), so a
   finished reading is never thrown away. */
function readAndRecord_(kind, month, pageId, imageBase64, mimeType) {
  var res = kind === 'qc' ? analyzeQcPage_(imageBase64, mimeType) : analyzeCalibrationCert_(imageBase64, mimeType);
  var page = withLock_(function () {
    allProps_(true);
    var p = findLivePage_(month, kind, pageId);
    if (!p) return null;   // removed while it was being read
    if (res.status === 'success') {
      p.status = 'read';
      p.reading = res.result;
      p.error = null;
      pageHistory_(month, 'Read ' + p.fileName + describeReading_(kind, res.result));
    } else {
      p.status = 'error';
      p.error = res.message || 'Could not read this page.';
      pageHistory_(month, 'Could not read ' + p.fileName + ': ' + p.error);
    }
    p.readAt = nowIso_();
    delete p.readingStartedAt;
    putPage_(month, p);
    updateIndexPages_(month);
    return p;
  }, RECORD_WAIT_MS);
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

/* Has Claude read a filed page. A page already read is returned as it is
   (unless `again` — Paul pressed Retry), and a page another request is
   reading right now is not read twice: the app checks back with getPage. */
function readPage_(data, again) {
  var month = checkMonth_(data.month);
  var kind = checkKind_(data.kind);
  var step1 = withLock_(function () {
    allProps_(true);
    assertMonthEditable_(month);
    makeLive_(month);
    var p = findLivePage_(month, kind, data.id);
    if (!p) throw appError_('missing', 'That page is no longer filed.');
    if (isFreshlyReading_(p) || (p.status === 'read' && !again)) return { already: true, page: p };
    p.status = 'reading';
    p.readingStartedAt = nowIso_();
    putPage_(month, p);
    return { page: p };
  });
  if (step1.already) {
    return { status: 'success', saved: true, result: step1.page.reading || null, page: publicPage_(step1.page) };
  }
  var bytes = DriveApp.getFileById(step1.page.fileId).getBlob().getBytes();
  return readAndRecord_(kind, month, step1.page.id, Utilities.base64Encode(bytes), step1.page.mimeType);
}

function getPage_(data) {
  var month = checkMonth_(data.month);
  var kind = checkKind_(data.kind);
  var p = lookupPage_(month, kind, data.id);
  if (!p) throw appError_('missing', 'That page is not filed.');
  return { status: 'success', page: publicPage_(p) };
}

function getPageImage_(data) {
  var month = checkMonth_(data.month);
  var kind = checkKind_(data.kind);
  var p = lookupPage_(month, kind, data.id);
  if (!p) throw appError_('missing', 'That page is not filed.');
  var file;
  try { file = DriveApp.getFileById(p.fileId); }
  catch (e) { throw appError_('missing', 'File missing from Google Drive: ' + p.fileName); }
  return { status: 'success', mimeType: p.mimeType, base64: Utilities.base64Encode(file.getBlob().getBytes()) };
}

function removePage_(data) {
  var month = checkMonth_(data.month);
  var kind = checkKind_(data.kind);
  var removed = withLock_(function () {
    allProps_(true);
    assertMonthEditable_(month);
    makeLive_(month);
    var p = findLivePage_(month, kind, data.id);
    if (!p) throw appError_('missing', 'That page is not filed.');
    dropProp_('PG_' + month + '_' + p.id);
    p.removedAt = nowIso_();
    putProp_('PGX_' + month + '_' + p.id, JSON.stringify(p));
    pageHistory_(month, 'Removed ' + p.fileName + ' (' + p.sourceName + ')');
    updateIndexPages_(month);
    return p;
  });
  // Moving the file is Drive work, so it happens after the lock is released.
  try {
    var ctx = { folder: monthFolder_(month, true), details: { month: month } };
    moveToRemoved_(ctx, DriveApp.getFileById(removed.fileId));
  } catch (e) { logError_('removePage', 'Could not move ' + removed.fileName + ' to Removed: ' + e.message); }
  return { status: 'success' };
}

/* ── Equipment ── */
function loadEquipment_() {
  var eq = readEquipment_();
  return { status: 'success', exists: !!eq, list: eq ? eq.list : [], revision: eq ? eq.revision : 0 };
}

function saveEquipment_(data) {
  if (!data.list || typeof data.list.length !== 'number') throw appError_('error', 'No equipment list received.');
  return withLock_(function () {
    var eq = readEquipment_() || { revision: 0, list: [] };
    if (data.baseRevision !== eq.revision) {
      return { status: 'conflict', message: 'The equipment list was changed on another computer. Reload to see the latest.',
               revision: eq.revision, list: eq.list };
    }
    eq.list = data.list;
    eq.revision++;
    eq.updatedAt = nowIso_();
    writeEquipment_(eq);
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
          if (!readEquipment_() && v && v.length) {
            writeEquipment_({ revision: 1, list: v, updatedAt: nowIso_() });
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
