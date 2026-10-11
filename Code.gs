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
var BACKEND_VERSION = 12;

// Rate limits are the main failure mode when a whole scan is sorted at once:
// a burst of requests can trip 429s, and UrlFetchApp does not retry for us
// the way the official SDKs do. Retry a few times with growing backoff.
var MAX_ATTEMPTS = 4;

function doPost(e) {
  var data = JSON.parse(e.postData.contents);

  // Deliberately needs no password — it exposes nothing sensitive and is
  // purely so the app can check the right code is live.
  if (data.action === 'getVersion') {
    return jsonResponse_({ status: 'success', version: BACKEND_VERSION });
  }

  if (data.action === 'checkDashboardPassword') {
    return jsonResponse_({ status: checkPassword_(data.password) ? 'success' : 'fail' });
  }

  if (data.action === 'analyzeQcPage') {
    if (!checkPassword_(data.password)) return jsonResponse_({ status: 'forbidden' });
    return jsonResponse_(analyzeQcPage_(data.imageBase64, data.mimeType));
  }

  if (data.action === 'analyzeCalibrationCert') {
    if (!checkPassword_(data.password)) return jsonResponse_({ status: 'forbidden' });
    return jsonResponse_(analyzeCalibrationCert_(data.imageBase64, data.mimeType));
  }

  if (data.action === 'loadAppData') {
    if (!checkPassword_(data.password)) return jsonResponse_({ status: 'forbidden' });
    return jsonResponse_(loadAppData_());
  }

  if (data.action === 'saveAppData') {
    if (!checkPassword_(data.password)) return jsonResponse_({ status: 'forbidden' });
    return jsonResponse_(saveAppData_(data.data));
  }

  return jsonResponse_({ status: 'error', message: 'Unknown action' });
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
