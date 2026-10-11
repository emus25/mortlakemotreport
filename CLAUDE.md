# Mortlake Garage — DVSA Compliance app

## What it does

An internal web app for **Mortlake Station Garage** (MOT test station, VTS
number **22453**). Paul, who runs the garage, uses it each month to put
together the DVSA quality-assurance record:

- **Dashboard tab**: site performance against the national average, charts
  from the DVSA test logs (outcomes, tester workload, test durations), Test
  Quality Information by tester and failure category, a month-by-month trend,
  and equipment calibration due dates.
- **Monthly Report tab**: uploads for the month's evidence:
  - three DVSA Excel exports: test log by date, test log by duration, and Test
    Quality Information
  - **QC paperwork** scans (images or PDFs). "Smart scan" sends each page to
    Claude, which reads the registration, document type, tester, date and
    rotation, then groups the pages by vehicle and flags missing documents
    (an EV has no emissions test, so none is expected).
  - **Calibration certificates**: scanned the same way, matched to an
    equipment row by serial number, and used to update the next-due date.
- **Checklist tab**: the VTS Site Self Assessment, with YES/NO answers saved
  per month.
- **Generate report**: builds a printable report (print or save as PDF from
  the browser). Page 1 is a one-page summary, followed by DVSA performance,
  test logs, the checklist, equipment, and appendices of QC paperwork and
  calibration certificates. Generating is blocked until the DVSA files are
  uploaded, the QC paperwork is sorted and the checklist is complete
  (`reportBlockers_`). Calibration certificates are optional because
  equipment isn't calibrated every month.

The app is behind a password, and every backend call checks it.

## How it's built

There's no build step and no framework. The whole repo is static files plus
one Google Apps Script file.

| File | What it is |
|---|---|
| `index.html` | The entire front end: CSS, markup and all JS (ES5-style, global functions) in one file of about 4,400 lines. |
| `Code.gs` | The Apps Script backend. It is **not** served from this repo; it is pasted into script.google.com (see Deploy). |
| `DEPLOY.md` | Step-by-step, non-technical guide to setting up the backend. |
| `assets/lib/` | Vendored `xlsx.full.min.js` (SheetJS, reads the DVSA Excel exports) and `pdf.min.js` / `pdf.worker.min.js` (PDF.js, turns PDF pages into images). |
| `assets/mortlake-logo.png` | Logo used in the app and the printed report. |
| `CNAME` | GitHub Pages custom domain: `mortlakemotreport.exposureboost.co.uk`. |
| `pdf.min.js`, `pdf.worker.min.js`, `xlsx.full.min.js`, `mortlake-logo.png` (root) | Leftover duplicates of the `assets/` copies. Nothing references them. |

### Front end (`index.html`)

- **Navigation:** `switchTab('dashboard' | 'report' | 'checklist')`.
- **Login:** `verifyPassword` posts `checkDashboardPassword` and keeps the
  password in localStorage so later backend calls can send it.
- **Storage:** `store` is held in localStorage under `mortlake_report_v1` and
  is the working copy. `syncDown_` pulls the server copy once after unlock.
  `scheduleSyncUp_` / `syncUp_` push changes, debounced by 1.5s. Nothing is
  pushed until `syncDown_` has succeeded, so a fresh browser can't overwrite
  the server history with its seeded defaults.
  - What's saved: calibration rows, per-month checklist answers and figures
    (`store.months['YYYY-MM']`), and Test Quality data by DVSA period
    (`store.testQuality['Jul-26']`).
  - **What's never saved:** scanned paperwork and DVSA exports. They are
    processed and discarded by design, and only kept in memory
    (`pickedFiles`, `qcEvidencePages`, `qcSortResults`).
- **Smart scan** (`runSmartScan`, `runCertScan`): `fileToPageImages_` turns
  files into JPEGs no larger than 1560px on the long edge. Pages are sent 3
  at a time (`SCAN_CONCURRENCY`) to the backend, then rotated upright for
  the printed appendix (`rotateImageBase64_`).
- **Backend version check:** `EXPECTED_BACKEND_VERSION` (currently 12) must
  match `BACKEND_VERSION` in `Code.gs`. If the live backend is older, the app
  shows a warning.
- **Report:** `buildReportHTML()` is rendered into `#printReport`, shown in a
  preview overlay, and printed with `window.print()`.
- **Backend URL:** `SCRIPT_URL` near the top of the main `<script>`. If it's
  empty, the app runs locally with no login, sync or scanning.
- **Built-in data:** `DEFAULT_EQUIPMENT` (the garage's real equipment list,
  seeded once) and `CHECKLIST` (the self-assessment questions).

### Backend (`Code.gs`)

There is one `doPost` entry point. It reads JSON `{ action, password, ... }`
and replies with JSON `{ status: 'success' | 'fail' | 'forbidden' | 'error', ... }`.

| Action | Password needed? | Purpose |
|---|---|---|
| `getVersion` | no | Returns `BACKEND_VERSION`. |
| `checkDashboardPassword` | n/a | Login check. |
| `analyzeQcPage` | yes | Claude reads one QC page and returns category, document type, registration, make/model, whether it's an EV, tester, date, period, QC flag, rotation and confidence. |
| `analyzeCalibrationCert` | yes | Claude reads one calibration certificate and returns equipment, serial number, calibration and next-due dates, rotation and confidence. |
| `loadAppData` / `saveAppData` | yes | App data stored in Script Properties under `DATA_calibration`, `DATA_month_YYYY-MM` and `DATA_tq_Mon-YY`. Keys are checked with regexes so a save can't overwrite the secrets. |

- **Secrets:** `DASHBOARD_PASSWORD` and `ANTHROPIC_API_KEY` are kept in
  Script Properties and must never be in `index.html`.
- **Claude calls:** they go straight to the Messages API using
  `CLAUDE_MODEL = 'claude-opus-5'` with `max_tokens: 8000` and
  `effort: 'low'`. 429, 500 and 529 errors are retried with backoff.
  Responses are checked for `refusal`, the text blocks are collected (a
  thinking block can come first), and the JSON is parsed leniently.

### Conventions

- **Comments:** they explain *why*, often for a non-technical reader. Keep
  that style.
- **Wording:** user-facing text is plain English for Paul. Avoid jargon.
- **Versioning:** whenever `Code.gs` changes, bump `BACKEND_VERSION` **and**
  `EXPECTED_BACKEND_VERSION` in `index.html` together.

## Deploying

**Front end:** this is a GitHub Pages site. Pushing `index.html` and
`assets/` to the default branch of `emus25/mortlakemotreport` publishes
them to https://mortlakemotreport.exposureboost.co.uk. Until now, changes
have been uploaded through the GitHub web UI.

**Backend:** follow `DEPLOY.md`. In short:

1. At script.google.com, open the "Mortlake Garage Backend" project and
   paste in `Code.gs`.
2. Set the Script Properties `DASHBOARD_PASSWORD` and `ANTHROPIC_API_KEY`.
3. Deploy it as a web app: Execute as **Me**, access **Anyone**.
4. Put the `/exec` URL into `SCRIPT_URL` in `index.html` (only needed the
   first time).

To update the backend later, use **Deploy → Manage deployments → edit →
New version → Deploy**. The URL stays the same. If you skip "New version",
the old code keeps running, and the app's version warning will show it.

## Testing

There are no automated tests. To check a change, open `index.html` in a
browser or run a static server such as `python3 -m http.server`.

- Leave `SCRIPT_URL` blank to work offline.
- With the real URL set, scanning and sync need the password.

## Current work / to-do (as of Oct 2026)

From Ediz, in priority order:

1. **Save and reopen reports.** At the moment, nothing about a generated
   report is kept: scans and exports are discarded, and a report has to be
   rebuilt from scratch. Wanted: save each report so it can be reopened and
   added to as more evidence comes in, without starting the process again.
   - **Decision needed first:** this means storing the scanned paperwork.
     That goes against the agreed "process and discard" rule, and the files
     are too big for Script Properties (9KB per value, 500KB in total). It
     probably needs Drive or a Sheet behind `Code.gs`.
2. **Completed reports list on the dashboard**, where each report can be
   opened and added to as new evidence is collected.
3. **Wrong report date.** The report shows the date it was *generated*
   (`generated` in `buildReportHTML`) rather than the period the data
   covers.
   - The month heading also comes from the month picker (`currentMonth`,
     which defaults to today's month at boot), not from the DVSA period on
     the files (e.g. `Jul-26`).
   - Fix: base the report date on the data period, and keep the generated
     timestamp only as a secondary note.
4. **Drop-in section for calibration certificates, working like the QC
   section.** A first version is in this commit (`fileCalCerts`,
   `runCertScan`, cert cards, plus an appendix in the report). Check that it
   matches what was asked: certs should probably also be saved with the
   report from item 1.
5. **One-page summary for 2 notice boards.** The report already opens with
   a one-page summary (`summaryBlock` in `buildReportHTML`). The ask seems
   to be a separate, printable one-page notice (possibly printed twice, or
   two versions) that can be printed on its own without the full report.
   Confirm exactly what goes on it before building.
