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
var BACKEND_VERSION = 28;

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

  if (data.action === 'checkDashboardPassword') return logIn_(data.password);

  // Everything below needs a pass (from logging in) or, for the older page
  // that doesn't know about passes, the password itself.
  if (data.token) {
    if (!passOk_(data.token)) return { status: 'forbidden', message: 'Please type the password again.' };
  } else {
    if (!data.password) return { status: 'forbidden' };   // nothing sent: not a guess
    if (loginPaused_()) return { status: 'forbidden' };
    if (!checkPassword_(data.password)) { noteWrongPassword_(); return { status: 'forbidden' }; }
  }
  if (data.action === 'logout') { forgetPass_(data.token); return { status: 'success' }; }

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
    // Stage B: signing off, amending, and opening a signed report.
    case 'signStart':        return signStart_(data);
    case 'signPiece':        return signPiece_(data);
    case 'signFinish':       return signFinish_(data);
    case 'startAmend':       return startAmend_(data);
    case 'cancelAmend':      return cancelAmend_(data);
    case 'getReport':        return getReport_(data);
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

/* ─────────────────── Logging in (v20) ───────────────────
 * The password is checked once; the computer then gets a "pass": a long
 * random code that works for PASS_DAYS. The app keeps the pass, never the
 * password. Only a fingerprint of each pass is stored here (TOK_<sha256>),
 * so even someone reading the Script Properties can't use one.
 *
 * Changing DASHBOARD_PASSWORD logs every computer out: each pass remembers a
 * fingerprint of the password it was given under, and stops working when
 * that no longer matches. That's the "log out everywhere" switch.
 *
 * Guessing is slowed down: after LOGIN_MAX_WRONG wrong passwords in a row,
 * logging in is paused for LOGIN_PAUSE_MS. Computers that already have a pass
 * carry on working, so this can't lock Paul out of his own computer. */
var PASS_DAYS = 30;
var LOGIN_MAX_WRONG = 5;
var LOGIN_PAUSE_MS = 15 * 60 * 1000;
var PASS_PREFIX = 'TOK_';

function sha256Hex_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function passwordStamp_() {
  var correct = PropertiesService.getScriptProperties().getProperty('DASHBOARD_PASSWORD') || '';
  return sha256Hex_('stamp:' + correct).slice(0, 16);
}

function loginPaused_() {
  var raw = PropertiesService.getScriptProperties().getProperty('LOGIN_FAILS');
  var f = raw ? JSON.parse(raw) : null;
  return f && f.until && f.until > Date.now() ? f.until : 0;
}

function noteWrongPassword_() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('LOGIN_FAILS');
  var f = raw ? JSON.parse(raw) : { n: 0 };
  f.n = (f.n || 0) + 1;
  if (f.n >= LOGIN_MAX_WRONG) { f = { n: 0, until: Date.now() + LOGIN_PAUSE_MS }; }
  props.setProperty('LOGIN_FAILS', JSON.stringify(f));
}

function logIn_(password) {
  var until = loginPaused_();
  if (until) {
    var mins = Math.max(1, Math.ceil((until - Date.now()) / 60000));
    return { status: 'paused', minutes: mins,
             message: 'Too many wrong passwords were tried, so logging in is paused for ' + mins +
                      ' more minute' + (mins === 1 ? '' : 's') + '. This is a safety lock, not a fault.' };
  }
  if (!checkPassword_(password)) { noteWrongPassword_(); return { status: 'fail' }; }
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('LOGIN_FAILS');
  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  var expires = Date.now() + PASS_DAYS * 24 * 3600 * 1000;
  props.setProperty(PASS_PREFIX + sha256Hex_(token), JSON.stringify({ exp: expires, stamp: passwordStamp_() }));
  prunePasses_();
  return { status: 'success', token: token, expires: expires };
}

function passOk_(token) {
  if (typeof token !== 'string' || token.length < 32) return false;
  var raw = PropertiesService.getScriptProperties().getProperty(PASS_PREFIX + sha256Hex_(token));
  if (!raw) return false;
  var p = JSON.parse(raw);
  return p.exp > Date.now() && p.stamp === passwordStamp_();
}

function forgetPass_(token) {
  if (token) PropertiesService.getScriptProperties().deleteProperty(PASS_PREFIX + sha256Hex_(token));
}

// Old and expired passes are tidied away whenever someone logs in.
function prunePasses_() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties(), now = Date.now(), stamp = passwordStamp_();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(PASS_PREFIX) !== 0) return;
    try {
      var p = JSON.parse(all[k]);
      if (p.exp <= now || p.stamp !== stamp) props.deleteProperty(k);
    } catch (e) { props.deleteProperty(k); }
  });
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


/* Which way up a page is (v25, 17 Oct 2026). Asking for "degrees to rotate
   clockwise" gave 90 for a page that needed 270, so the report would have
   printed it upside down: clockwise is easy to get backwards. Instead Claude
   says which edge of the image the document's title is nearest to, which is
   something it can see, and the rotation is worked out here. */
var DOCUMENT_TOP_FIELD =
  '"document_top": "top" | "right" | "bottom" | "left" (which edge of the IMAGE the top of the document — its title or ' +
  'heading — is nearest to. An upright page is "top". A page lying on its side whose title runs down the right-hand edge is "right". ' +
  'An upside-down page is "bottom"), ';
var ROTATION_FOR_TOP = { top: 0, right: 270, bottom: 180, left: 90 };

function withRotation_(res) {
  if (res && res.status === 'success' && res.result) {
    var top = String(res.result.document_top || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ROTATION_FOR_TOP, top)) res.result.rotation = ROTATION_FOR_TOP[top];
    else if ([0, 90, 180, 270].indexOf(res.result.rotation) === -1) res.result.rotation = 0;
  }
  return res;
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
    DOCUMENT_TOP_FIELD +
    '"confidence": "high" | "low" (low if the page is blurry, cropped, or any key field is genuinely hard to read)}';

  return withRotation_(readPageWithClaude_(imageBase64, mimeType, instructions));
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
    DOCUMENT_TOP_FIELD +
    '"confidence": "high" | "low" (low if the page is blurry, cropped, or any key field is hard to read)}';

  return withRotation_(readPageWithClaude_(imageBase64, mimeType, instructions));
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
var SUBFOLDERS = { qc: 'QC paperwork', cert: 'Calibration certificates', dvsa: 'DVSA files', removed: 'Removed',
                   signed: 'Signed reports', uploading: 'Uploading (temporary)',
                   pieces: 'Signed reports (pieces for the app)' };
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
  updateIndex_(ctx.details, ctx.folder);
}

/* How many vehicles the QC pages cover: distinct registrations that look
   like real plates (letters and digits, not the VTS number). For the
   Records screen only; the page does the full check before sign-off. */
function vehicleCount_(pages) {
  var regs = {};
  pages.forEach(function (p) {
    var r = String((p.reading && p.reading.registration) || '').toUpperCase().replace(/\s+/g, '');
    if (r.length >= 5 && r.length <= 8 && /[A-Z]/.test(r) && /\d/.test(r) && r !== '22453') regs[r] = true;
  });
  return Object.keys(regs).length;
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
  // Lines written before v26 lack what the Records screen shows (who signed
  // and when, the folder link). Each is rebuilt once from its details.json.
  Object.keys(months).forEach(function (m) {
    if (months[m].versions) return;
    try {
      var ctx = openMonth_(m, false);
      if (!ctx) return;
      updateIndex_(ctx.details, ctx.folder);
      months[m] = JSON.parse(prop_(INDEX_PREFIX + m));
    } catch (e) {}
  });
  return { schema: RECORDS_SCHEMA, months: months };
}

function updateIndex_(d, folder) {
  var pages = pagesLive_(d.month) ? readLivePages_(d.month) : { qc: d.qcPages, cert: d.certPages };
  var old = {};
  try { old = JSON.parse(prop_(INDEX_PREFIX + d.month) || '{}'); } catch (e) {}
  // Stage C (v26): what the Records screen shows for a month, without
  // opening it: each signed report's date, signer and kind, and where the
  // month's folder is.
  var versions = (d.versions || []).map(function (v) {
    return { version: v.version, signedAt: v.signedAt, signedBy: v.signedBy, kind: v.kind, reason: v.reason || null };
  });
  var folderUrl = old.folderUrl || null;
  if (!folderUrl && folder) { try { folderUrl = folder.getUrl(); } catch (e) {} }
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
    versions: versions,
    amendment: d.amendment ? { reason: d.amendment.reason, startedAt: d.amendment.startedAt } : null,
    folderUrl: folderUrl,
    qcPages: pages.qc.length,
    qcUnread: pages.qc.filter(function (p) { return p.status !== 'read'; }).length,
    vehicles: vehicleCount_(pages.qc),
    certPages: pages.cert.length,
    certUnread: pages.cert.filter(function (p) { return p.status !== 'read'; }).length,
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

/* Opening a month used to rewrite its details.json every time anything had
   changed, which made opening take 8 seconds (v24, 17 Oct 2026). Now the
   page list and any new history lines are read straight from quick storage,
   and details.json is brought up to date only if it is more than
   FLUSH_EVERY_MS behind — and always before signing off or amending. */
var FLUSH_EVERY_MS = 30 * 60 * 1000;

function loadMonth_(month) {
  checkMonth_(month);
  var all = allProps_();
  var dirty = all['PGDIRTY_' + month];
  if (pagesLive_(month) && dirty && Date.now() - new Date(all['PGFLUSHED_' + month] || 0).getTime() > FLUSH_EVERY_MS) {
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
    d.history = d.history.concat(liveHistory_(month));
  }
  return { status: 'success', exists: true, details: publicDetails_(d) };
}

// History lines still waiting in quick storage, oldest first.
function liveHistory_(month) {
  var all = allProps_(), pre = 'HB_' + month + '_', out = [];
  Object.keys(all).sort().forEach(function (k) {
    if (k.indexOf(pre) === 0) { try { out.push(JSON.parse(all[k])); } catch (e) {} }
  });
  return out;
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
  // Each change is spelled out (question 3.5: YES → NO), so an amended report
  // can list exactly what changed since it was signed.
  function show(v) { return v ? String(v).toUpperCase() : 'not answered'; }
  var parts = changed.sort().map(function (k) {
    var n = k.split('-').map(function (x) { return (parseInt(x, 10) || 0) + 1; }).join('.');
    var a = (before.state || {})[k] || '', b = (after.state || {})[k] || '';
    return a !== b ? 'question ' + n + ': ' + show(a) + ' → ' + show(b) : 'question ' + n + ': note changed';
  });
  return 'Checklist: ' + (parts.length > 6 ? parts.length + ' answers changed' : parts.join('; '));
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
  entry.vehicles = vehicleCount_(live.qc);
  entry.certPages = live.cert.length;
  entry.certUnread = live.cert.filter(function (p) { return p.status !== 'read'; }).length;
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
    putProp_('PGFLUSHED_' + month, nowIso_());
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
   already filed). Since v19 the app has Claude read each page first (a quick
   read-only request) so Paul sees the results straight away, then files the
   page in the background with what was read (`reading`, or `readError` if
   Claude couldn't read it), so the page is never read twice. */
function filePage_(data) {
  var kind = checkKind_(data.kind);
  var month = checkMonth_(data.month);
  if (!data.imageBase64) throw appError_('error', 'No image received.');
  if (data.reading != null && (typeof data.reading !== 'object' || Array.isArray(data.reading))) {
    throw appError_('error', 'That reading could not be understood.');
  }
  var step1 = fileStep_(kind, month, data, false);
  return { status: 'success', duplicate: !!step1.duplicate, page: publicPage_(step1.page) };
}

/* Records a reading the app already has on a page in quick storage. */
function applyReading_(month, page, data) {
  if (data.reading) {
    page.status = 'read';
    page.reading = data.reading;
    page.error = null;
    pageHistory_(month, 'Read ' + page.fileName + describeReading_(page.kind, data.reading));
  } else {
    page.status = 'error';
    page.error = String(data.readError).slice(0, 300);
    pageHistory_(month, 'Could not read ' + page.fileName + ': ' + page.error);
  }
  page.readAt = nowIso_();
  delete page.readingStartedAt;
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

  // 2. A page already filed needs no upload at all. If it arrives with a
  //    reading and isn't read yet, the reading is recorded on it.
  var hasReading = !!(data.reading || data.readError);
  var known = duplicateOf_(readLivePages_(month));
  if (known && known.duplicate) {
    if (!hasReading || known.page.status === 'read') return known;
    return withLock_(function () {
      allProps_(true);
      var p = findLivePage_(month, kind, known.page.id);
      if (!p) return known;
      if (p.status !== 'read') { applyReading_(month, p, data); putPage_(month, p); updateIndexPages_(month); }
      return { duplicate: true, page: p };
    }, RECORD_WAIT_MS);
  }

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
    } else if (hasReading && page.status !== 'read') {
      applyReading_(month, page, data);
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

/* ═══════════════ Stage B: signing off and amending (v21) ═══════════════
 * SPEC.md sections 6 and 7.3–7.5. The page makes the report PDF and sends it
 * here in pieces (a 20MB file is too big for one request). Nothing is ever
 * half-signed: the month only becomes "signed" after the whole PDF has been
 * joined, saved and checked against the size that was sent. A signed PDF is
 * never changed or deleted by anything here.
 *
 *   signStart   checks the month is ready, notes what it looks like, and
 *               hands back an upload id (plus the month's details, so the
 *               PDF is built from exactly what is filed)
 *   signPiece   stores one piece in "Uploading (temporary)"
 *   signFinish  joins the pieces, files the PDF, then — only if the month
 *               hasn't changed since signStart — marks it signed. Safe to send
 *               twice: a finished upload is recognised.
 *   startAmend  needs a reason; keeps a copy of the month as signed
 *               (details-vN.json) and unlocks it
 *   cancelAmend puts the month back exactly as it was signed
 *   getReport   a signed PDF, in pieces */

var UPLOAD_PREFIX = 'UPL_';
var REPORT_PIECE_CHARS = 2000000;      // base64 characters per piece made for an older report (about 1.5MB)
var MAX_REPORT_BYTES = 60 * 1024 * 1024;

function signedFolder_(month) {
  return folderAt_('s_' + month + '_signed', function () { return monthFolder_(month, true); }, SUBFOLDERS.signed, true);
}
/* Opening a signed report hands back the pieces it was uploaded in, kept
   here at sign-off, so Google never has to convert a 10MB file on the spot
   (that took over 40 seconds and failed). The PDF in Signed reports is the
   record; these are only the app's copy of it, in pieces. */
function piecesFolder_(month) {
  return folderAt_('s_' + month + '_pieces', function () { return monthFolder_(month, true); }, SUBFOLDERS.pieces, true);
}
function uploadingFolder_(month) {
  return folderAt_('s_' + month + '_uploading', function () { return monthFolder_(month, true); }, SUBFOLDERS.uploading, true);
}

/* How many questions each section of the self-assessment has, in order (the
   page's CHECKLIST). A test checks the two never drift apart. */
var CHECKLIST_SIZES = [3, 2, 3, 5, 4, 1, 1, 1, 2, 2, 3, 2, 3, 3, 2, 5, 5, 4, 3, 2, 3, 2];

// Every QC vehicle needs these three; an electric car has no emissions test.
var QC_DOCS = { emissions_test: 'emissions test', vt20_certificate: 'VT20 certificate', inspection_sheet: 'inspection sheet' };

function realPlate_(reg) {
  var r = String(reg || '').toUpperCase().replace(/\s+/g, '');
  if (!r || r === '22453' || r.length < 5 || r.length > 8 || !/^[A-Z0-9]+$/.test(r)) return '';
  return /[A-Z]/.test(r) && /\d/.test(r) ? r : '';
}

/* What the back office itself insists on before anything is signed (agreed
   17 Oct 2026, made firm here 20 Oct 2026: nothing may be signed with
   anything missing). The page checks the same things first and says what is
   missing; these checks mean even a fault in the page can't get round them. */
function serverSignBlockers_(d) {
  var out = [];
  Object.keys(DVSA_INPUTS).forEach(function (id) {
    if (!d.dvsaFiles[id]) out.push(DVSA_INPUTS[id].label + ' is not filed');
  });
  if (!d.qcPages.length) out.push('No QC paperwork is filed');
  var unread = d.qcPages.concat(d.certPages).filter(function (p) { return p.status !== 'read'; }).length;
  if (unread) out.push(unread + ' page' + (unread === 1 ? ' has' : 's have') + ' not been read');

  // Each QC vehicle's full set, and no page without a readable registration.
  var cars = {}, noReg = 0;
  d.qcPages.forEach(function (p) {
    if (p.status !== 'read') return;
    var r = p.reading || {}, reg = realPlate_(r.registration);
    if (!reg) { noReg++; return; }
    var c = cars[reg] = cars[reg] || { docs: {}, ev: false };
    c.docs[r.document_type] = true;
    if (r.is_electric === true) c.ev = true;
  });
  Object.keys(cars).sort().forEach(function (reg) {
    var c = cars[reg];
    var missing = Object.keys(QC_DOCS).filter(function (t) { return !c.docs[t] && !(t === 'emissions_test' && c.ev); });
    if (missing.length) out.push('QC vehicle ' + reg + ' is missing its ' + missing.map(function (t) { return QC_DOCS[t]; }).join(' and '));
  });
  if (noReg) out.push(noReg + ' QC page' + (noReg === 1 ? ' has' : 's have') + ' no readable registration');

  // Every checklist question answered, and a note on every NO.
  var cl = d.checklist || {}, state = cl.state || {}, notes = cl.notes || {}, blank = 0, noNote = 0;
  CHECKLIST_SIZES.forEach(function (n, ci) {
    for (var ii = 0; ii < n; ii++) {
      var k = ci + '-' + ii;
      if (state[k] !== 'yes' && state[k] !== 'no') blank++;
      else if (state[k] === 'no' && !String(notes[k] || '').trim()) noNote++;
    }
  });
  if (blank) out.push(blank + ' checklist question' + (blank === 1 ? ' is' : 's are') + ' not answered');
  if (noNote) out.push(noNote + ' checklist answer' + (noNote === 1 ? '' : 's') + ' marked NO ' + (noNote === 1 ? 'needs' : 'need') + ' a note');
  return out;
}

// A fingerprint of everything that goes into the report, so a change made
// while the PDF was being built and sent is noticed instead of filed.
function monthStamp_(d) {
  return sha256Hex_(JSON.stringify({
    q: d.qcPages.map(function (p) { return p.id + ':' + p.status; }),
    c: d.certPages.map(function (p) { return p.id + ':' + p.status; }),
    f: Object.keys(d.dvsaFiles).sort().map(function (k) { return k + ':' + d.dvsaFiles[k].fileId; }),
    r: d.revisions
  })).slice(0, 24);
}

function readUpload_(id) {
  if (!/^[a-f0-9]{32}$/.test(String(id || ''))) throw appError_('error', 'That upload is not recognised.');
  var raw = prop_(UPLOAD_PREFIX + id);
  return raw ? JSON.parse(raw) : null;
}

function signStart_(data) {
  var month = checkMonth_(data.month);
  var mode = data.mode === 'amend' ? 'amend' : 'sign';
  // Since v24 the page may start before the PDF is made (it is built from
  // what this returns) and give the size when it finishes.
  var bytes = data.bytes == null ? null : parseInt(data.bytes, 10);
  var pieces = data.pieces == null ? null : parseInt(data.pieces, 10);
  var signedBy = String(data.signedBy || '').replace(/\s+/g, ' ').trim();
  if (data.confirm !== true) throw appError_('error', 'Tick the box to confirm the record is complete and accurate.');
  if (signedBy.length < 3 || signedBy.length > 80) throw appError_('error', 'Type your full name to sign off.');
  checkReportSize_(bytes, pieces, true);
  return withLock_(function () {
    flushPages_(month);
    memo_ = {};
    var ctx = openMonth_(month, false);
    if (!ctx) throw appError_('missing', 'Nothing is filed for ' + formatMonthName_(month) + ' yet.');
    var d = ctx.details;
    if (d.status === 'signed') throw appError_('locked', formatMonthName_(month) + ' is already signed off.');
    if (mode === 'sign' && d.status !== 'draft') throw appError_('error', formatMonthName_(month) + ' is being amended: use Sign off amendment.');
    if (mode === 'amend' && d.status !== 'amending') throw appError_('error', formatMonthName_(month) + ' is not being amended.');
    var blockers = serverSignBlockers_(d);
    if (blockers.length) throw appError_('error', 'Not ready to sign off: ' + blockers.join('; ') + '.');
    // A new sign-off replaces any earlier unfinished one for this month, and
    // uploads abandoned more than a day ago are forgotten.
    var all = allProps_(true);
    Object.keys(all).forEach(function (k) {
      if (k.indexOf(UPLOAD_PREFIX) !== 0) return;
      try {
        var u = JSON.parse(all[k]);
        if (u.month === month || Date.now() - new Date(u.startedAt).getTime() > 86400000) dropProp_(k);
      } catch (e) { dropProp_(k); }
    });
    // The pieces arrive several at once. If the folder for them didn't exist
    // yet, each would make its own and the pieces would end up scattered, so
    // it is made (and remembered) here, before any piece is sent.
    uploadingFolder_(month);
    var id = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 32);
    var version = (d.signedVersion || 0) + 1;
    putProp_(UPLOAD_PREFIX + id, JSON.stringify({
      month: month, mode: mode, bytes: bytes, pieces: pieces, signedBy: signedBy,
      stamp: monthStamp_(d), version: version, startedAt: nowIso_()
    }));
    return { status: 'success', uploadId: id, version: version, details: publicDetails_(d) };
  });
}

function checkReportSize_(bytes, pieces, optional) {
  if (optional && bytes == null && pieces == null) return;
  if (!(bytes > 0 && bytes <= MAX_REPORT_BYTES)) throw appError_('error', 'The report is an unexpected size.');
  if (!(pieces >= 1 && pieces <= 100)) throw appError_('error', 'The report is an unexpected size.');
}

function pieceName_(id, i) { return id + '-' + ('00' + i).slice(-3) + '.b64'; }

function signPiece_(data) {
  var up = readUpload_(data.uploadId);
  if (!up) throw appError_('missing', 'That upload has expired. Press Sign off again.');
  var i = parseInt(data.index, 10);
  if (!(i >= 0 && i < (up.pieces || 100))) throw appError_('error', 'Unexpected piece of the report.');
  var text = String(data.data || '');
  if (!/^[A-Za-z0-9+/=]*$/.test(text) || !text) throw appError_('error', 'A piece of the report arrived damaged.');
  var folder = uploadingFolder_(up.month);
  var existing = childFile_(folder, pieceName_(data.uploadId, i));
  if (existing) existing.setContent(text); else folder.createFile(pieceName_(data.uploadId, i), text, 'text/plain');
  return { status: 'success', index: i };
}

function signFinish_(data) {
  var id = data.uploadId;
  var up = readUpload_(id);
  var month = checkMonth_(data.month);
  function alreadyFiled() {
    var ctx = openMonth_(month, false);
    var v = ctx && (ctx.details.versions || []).filter(function (x) { return x.uploadId === id; })[0];
    return v ? { status: 'success', version: publicVersion_(v), details: publicDetails_(ctx.details) } : null;
  }
  if (!up) {
    var done = alreadyFiled();
    if (done) return done;
    throw appError_('missing', 'That upload has expired. Press Sign off again.');
  }
  if (up.month !== month) throw appError_('error', 'That upload belongs to another month.');
  if (up.bytes == null) {
    up.bytes = parseInt(data.bytes, 10);
    up.pieces = parseInt(data.pieces, 10);
    checkReportSize_(up.bytes, up.pieces, false);
  }

  // 1. Join the pieces and check the result, outside the lock (slow).
  var folder = uploadingFolder_(month);
  var pieceFiles = [], text = '';
  for (var i = 0; i < up.pieces; i++) {
    var f = childFile_(folder, pieceName_(id, i));
    if (!f) throw appError_('missing', 'Part of the report did not arrive. Press Sign off again.');
    pieceFiles.push(f);
    text += f.getBlob().getDataAsString();
  }
  var bytes = Utilities.base64Decode(text);
  text = null;
  if (bytes.length !== up.bytes || bytes[0] !== 37 || bytes[1] !== 80 || bytes[2] !== 68 || bytes[3] !== 70) {
    throw appError_('error', 'The report arrived damaged (' + bytes.length + ' of ' + up.bytes + ' bytes). Nothing was signed. Press Sign off again.');
  }
  var date = nowIso_().slice(0, 10);
  var name = 'Mortlake DVSA report – ' + formatMonthName_(month) + ' – v' + up.version + ' – ' +
             (up.mode === 'amend' ? 'amended ' : 'signed ') + date + '.pdf';
  var pdf = signedFolder_(month).createFile(Utilities.newBlob(bytes, 'application/pdf', name));
  bytes = null;
  if (pdf.getSize() !== up.bytes) {
    pdf.setTrashed(true);
    throw appError_('error', 'The report could not be saved completely. Nothing was signed. Press Sign off again.');
  }

  // 2. Only now is the month marked as signed — and only if nothing changed.
  var out;
  try {
    out = withLock_(function () {
      flushPages_(month);
      memo_ = {};
      var ctx = openMonth_(month, false);
      var d = ctx.details;
      var dup = (d.versions || []).filter(function (x) { return x.uploadId === id; })[0];
      if (dup) return { duplicate: true, version: dup, details: d };
      var expected = up.mode === 'amend' ? 'amending' : 'draft';
      if (d.status !== expected) throw appError_('conflict', formatMonthName_(month) + ' changed while it was being signed off. Nothing was signed.');
      if (monthStamp_(d) !== up.stamp) throw appError_('conflict', 'Something in ' + formatMonthName_(month) + ' changed while the report was being made, so it was not signed. Press Sign off again.');
      var reason = up.mode === 'amend' && d.amendment ? d.amendment.reason : null;
      var v = {
        version: up.version, fileId: pdf.getId(), fileName: name, size: up.bytes, signedAt: nowIso_(),
        signedBy: up.signedBy, kind: up.mode, reason: reason, uploadId: id, url: pdf.getUrl(),
        pieceIds: pieceFiles.map(function (f) { return f.getId(); })
      };
      d.versions = (d.versions || []).concat([v]);
      d.signedVersion = up.version;
      d.status = 'signed';
      var eq = readEquipment_();
      d.calibrationSnapshot = eq ? eq.list : null;
      d.amendment = null;
      addHistory_(d, up.mode === 'amend'
        ? 'Amendment signed off by ' + up.signedBy + '. Reason: ' + reason
        : 'Signed off by ' + up.signedBy);
      saveMonth_(ctx);
      return { version: v, details: d };
    });
  } catch (e) {
    try { pdf.setTrashed(true); } catch (e2) {}   // never part of the records
    throw e;
  }
  if (out.duplicate) { try { pdf.setTrashed(true); } catch (e) {} }

  // 3. Keep this upload's pieces for opening the report later, and tidy
  //    away any left by earlier attempts that didn't finish.
  dropProp_(UPLOAD_PREFIX + id);
  if (!out.duplicate) {
    var keep = piecesFolder_(month);
    pieceFiles.forEach(function (f, i) {
      try { f.setName('v' + up.version + '-' + ('00' + i).slice(-3) + '.b64'); f.moveTo(keep); }
      catch (e) { logError_('signFinish', 'Could not keep piece ' + i + ': ' + e.message); }
    });
  }
  try {
    var it = folder.getFiles();
    while (it.hasNext()) {
      var pf = it.next();
      var owner = String(pf.getName()).slice(0, 32);
      if ((owner === id && out.duplicate) || (owner !== id && !prop_(UPLOAD_PREFIX + owner))) pf.setTrashed(true);
    }
  } catch (e) { logError_('signFinish', 'Could not tidy the upload pieces: ' + e.message); }
  return { status: 'success', version: publicVersion_(out.version), details: publicDetails_(out.details) };
}

function publicVersion_(v) {
  return { version: v.version, fileName: v.fileName, size: v.size, signedAt: v.signedAt,
           signedBy: v.signedBy, kind: v.kind, reason: v.reason || null, url: v.url || null };
}

function startAmend_(data) {
  var month = checkMonth_(data.month);
  var reason = String(data.reason || '').replace(/\s+/g, ' ').trim();
  if (data.confirm !== true) throw appError_('error', 'Tick the box to confirm you are amending this month.');
  if (reason.length < 10) throw appError_('error', 'Give a reason for the amendment (a few words at least).');
  if (reason.length > 500) reason = reason.slice(0, 500);
  return withLock_(function () {
    flushPages_(month);
    memo_ = {};
    var ctx = openMonth_(month, false);
    if (!ctx) throw appError_('missing', 'Nothing is filed for ' + formatMonthName_(month) + '.');
    var d = ctx.details;
    if (d.status === 'amending') throw appError_('error', formatMonthName_(month) + ' is already being amended.');
    if (d.status !== 'signed') throw appError_('error', formatMonthName_(month) + ' has not been signed off, so there is nothing to amend.');
    var v = d.signedVersion;
    // The month exactly as signed, kept so the amendment can be cancelled.
    writeJsonAt_('snap_' + month + '_' + v, ctx.folder, 'details-v' + v + '.json', d);
    d.status = 'amending';
    d.amendment = { reason: reason, startedAt: nowIso_(), fromVersion: v };
    addHistory_(d, 'Amendment started. Reason: ' + reason);
    saveMonth_(ctx);
    return { status: 'success', details: publicDetails_(d) };
  });
}

function cancelAmend_(data) {
  var month = checkMonth_(data.month);
  var moves = withLock_(function () {
    flushPages_(month);
    memo_ = {};
    var ctx = openMonth_(month, false);
    if (!ctx || ctx.details.status !== 'amending') throw appError_('error', formatMonthName_(month) + ' is not being amended.');
    var d = ctx.details;
    var v = d.amendment.fromVersion;
    var snap = readJsonAt_('snap_' + month + '_' + v, ctx.folder, 'details-v' + v + '.json');
    if (!snap) throw appError_('missing', 'The copy of ' + formatMonthName_(month) + ' as signed is missing, so the amendment cannot be cancelled.');

    function filesOf(x) {
      var list = [];
      x.qcPages.concat(x.certPages).forEach(function (p) { list.push({ fileId: p.fileId, kind: p.kind, name: p.fileName, page: p }); });
      Object.keys(x.dvsaFiles).forEach(function (k) {
        var e = x.dvsaFiles[k];
        var ext = (String(e.fileName).match(/\.[A-Za-z0-9]{1,5}$/) || ['.xlsx'])[0].toLowerCase();
        list.push({ fileId: e.fileId, kind: 'dvsa', name: DVSA_INPUTS[k].base + ext });
      });
      return list;
    }
    var now = filesOf(d), then = filesOf(snap);
    var ids = function (l) { var o = {}; l.forEach(function (x) { o[x.fileId] = true; }); return o; };
    var nowIds = ids(now), thenIds = ids(then);
    var toRemove = now.filter(function (x) { return !thenIds[x.fileId]; });
    var toRestore = then.filter(function (x) { return !nowIds[x.fileId]; });

    var back = JSON.parse(JSON.stringify(snap));
    back.status = 'signed';
    back.amendment = null;
    back.versions = d.versions;
    back.signedVersion = d.signedVersion;
    back.nextPageNo = Math.max(d.nextPageNo || 1, snap.nextPageNo || 1);
    // Revision numbers move on, so a save from a screen opened during the
    // amendment is refused rather than undoing the cancel.
    back.revisions = { checklist: (d.revisions.checklist || 0) + 1, dvsa: (d.revisions.dvsa || 0) + 1 };
    back.removedPages = (d.removedPages || []).concat(toRemove.filter(function (x) { return x.page; }).map(function (x) {
      var p = JSON.parse(JSON.stringify(x.page)); p.removedAt = nowIso_(); return p;
    }));
    back.history = d.history.slice();
    addHistory_(back, 'Amendment cancelled: back exactly as signed');

    // Quick storage is cleared, so details.json is the one true copy again.
    var all = allProps_(true);
    Object.keys(all).forEach(function (k) {
      if (k.indexOf('PG_' + month + '_') === 0 || k.indexOf('PGX_' + month + '_') === 0 ||
          k.indexOf('HB_' + month + '_') === 0) dropProp_(k);
    });
    ['PGDIRTY_', 'PGNEXT_', 'PGLIVE_'].forEach(function (k) { dropProp_(k + month); });
    ctx.details = back;
    saveMonth_(ctx);
    return { toRemove: toRemove, toRestore: toRestore, details: back, folder: ctx.folder };
  });

  // Moving files is Drive work, so it happens after the lock is released.
  var ctx = { folder: moves.folder, details: { month: month } };
  moves.toRemove.forEach(function (x) {
    try { moveToRemoved_(ctx, DriveApp.getFileById(x.fileId)); }
    catch (e) { logError_('cancelAmend', 'Could not move ' + x.name + ' to Removed: ' + e.message); }
  });
  moves.toRestore.forEach(function (x) {
    try {
      var f = DriveApp.getFileById(x.fileId);
      f.setName(x.name);
      f.moveTo(subFolder_(ctx, x.kind));
    } catch (e) { logError_('cancelAmend', 'Could not put back ' + x.name + ': ' + e.message); }
  });
  return { status: 'success', details: publicDetails_(moves.details) };
}

function getReport_(data) {
  var month = checkMonth_(data.month);
  var ctx = openMonth_(month, false);
  var versions = ctx ? ctx.details.versions || [] : [];
  if (!versions.length) throw appError_('missing', formatMonthName_(month) + ' has no signed report.');
  var want = parseInt(data.version, 10) || versions[versions.length - 1].version;
  var v = versions.filter(function (x) { return x.version === want; })[0];
  if (!v) throw appError_('missing', 'Version ' + want + ' of ' + formatMonthName_(month) + ' does not exist.');
  var file;
  try { file = DriveApp.getFileById(v.fileId); }
  catch (e) { throw appError_('missing', 'The signed report is missing from Google Drive: ' + v.fileName); }
  var ids = v.pieceIds;
  if (!ids || !ids.length || !piecesPresent_(ids)) ids = makePieces_(month, v, file);
  var i = parseInt(data.index, 10) || 0;
  if (i < 0 || i >= ids.length) throw appError_('error', 'Unexpected piece of the report.');
  var text = DriveApp.getFileById(ids[i]).getBlob().getDataAsString();
  // Since v25 the page asks for small bites of each piece: Google often
  // stalls for half a minute, or gives up, on answers of 2MB, but answers
  // of half a megabyte come back reliably in a second or two.
  var from = data.from == null ? 0 : parseInt(data.from, 10) || 0;
  var length = data.length == null ? text.length : Math.min(parseInt(data.length, 10) || 0, REPORT_BITE_CHARS);
  return {
    status: 'success', version: publicVersion_(v), pieces: ids.length, index: i,
    pieceLength: text.length, from: from,
    data: text.substr(from, length), url: file.getUrl()
  };
}
var REPORT_BITE_CHARS = 600000;

function piecesPresent_(ids) {
  try { return ids.every(function (id) { return !DriveApp.getFileById(id).isTrashed(); }); }
  catch (e) { return false; }
}

// For a report with no pieces kept (or if they were removed by hand), they
// are made once from the PDF and remembered.
function makePieces_(month, v, file) {
  var bytes = file.getBlob().getBytes();
  var step = REPORT_PIECE_CHARS / 4 * 3, folder = piecesFolder_(month), ids = [];
  for (var at = 0, n = 0; at < bytes.length; at += step, n++) {
    var text = Utilities.base64Encode(bytes.slice(at, at + step));
    ids.push(folder.createFile('v' + v.version + '-' + ('00' + n).slice(-3) + '.b64', text, 'text/plain').getId());
  }
  withLock_(function () {
    var ctx = openMonth_(month, false);
    (ctx.details.versions || []).forEach(function (x) { if (x.version === v.version) x.pieceIds = ids; });
    writeJsonAt_('d_' + month, ctx.folder, DETAILS_FILE, ctx.details);
  });
  return ids;
}
