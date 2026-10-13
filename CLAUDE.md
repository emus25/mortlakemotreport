# Mortlake Garage — DVSA Compliance app

## How Ediz likes to work: measure twice, cut once

- **Logic first, then build.** Before writing code for anything non-trivial,
  agree the logic: what it does, where data lives, what happens when things
  go wrong. Write it down and get a yes before building.
- **Plain English.** Explain things as you would to a non-programmer. Say
  what changes for Paul, not just what changes in the code.

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
| `DEPLOY-TEST.md` | The same, for the TEST copy (its own back office and Drive folder). |
| `SPEC.md` | The agreed specification for Monthly Records. Build to it. |
| `tests/` | `fake-google.js` runs the real `Code.gs` on a pretend Google; `backend.test.js` and `e2e.test.js` (real browser) check it against `SPEC.md`; `serve.js` runs the app locally on the pretend Google; `fixtures.js` makes realistic DVSA files and scans. |
| `tools/make-test-copy.js` | Makes `test.html` (the TEST copy) from `index.html`. |
| `assets/lib/` | Vendored `xlsx.full.min.js` (SheetJS, reads the DVSA Excel exports) and `pdf.min.js` / `pdf.worker.min.js` (PDF.js, turns PDF pages into images). |
| `assets/mortlake-logo.png` | Logo used in the app and the printed report. |
| `CNAME` | GitHub Pages custom domain: `mortlakemotreport.exposureboost.co.uk`. |
| `pdf.min.js`, `pdf.worker.min.js`, `xlsx.full.min.js`, `mortlake-logo.png` (root) | Leftover duplicates of the `assets/` copies. Nothing references them. |

### Front end (`index.html`)

- **Navigation:** `switchTab('dashboard' | 'report' | 'checklist')`.
- **Login:** `verifyPassword` posts `checkDashboardPassword` and keeps the
  password in localStorage so later backend calls can send it.
- **Storage (Monthly Records, stage A):** the true copy of everything is in
  Paul's Google Drive, filed by the back office as he works. `store`
  (localStorage, `mortlake_report_v1`) is only a cache.
  - **Starting up:** `startRecords_()` runs after unlock and makes **one**
    request, `openSession`. That request moves old data across if needed,
    seeds the equipment list if none is filed, and returns the index, the
    equipment list and the current month. Each Apps Script request costs a
    second or more (far more on a cold start), so the start-up must stay at
    two round trips: the password check, then `openSession`. A test enforces
    this.
  - **Opening a month:** `openMonth_` loads `details.json`. A cover
    (`#monthOverlay`, with a seconds counter) blocks edits until the details
    have arrived. The filed DVSA files are then re-read behind the page
    (`dvsaLoading_`), so the full test lists come back; the report waits for
    them.
  - **Timings:** `api_` records every request's total time and the back
    office's own time (`ms` in every answer) in `recordsTimings`, and logs
    them to the browser console as `[records] …`.
  - **Changing month:** `changeMonth_` switches months. It asks first only if
    scans are waiting to be read.
  - **Saving:** every save goes through `trackSave_`, which drives the top
    indicator ("Saving… / All saved ✓ / N changes not saved · Retry") and keeps
    failed saves for Retry. `hasPendingSaves_()` blocks generating the report
    and warns on closing the tab while anything is unsaved.
  - **Checklist** (`scheduleChecklistSave_` / `flushChecklist_`) and
    **equipment** (`scheduleEquipmentSave_`) save 1.5s after the last change,
    one save at a time. They carry a revision number, so a change made on
    another computer is never overwritten (the save is refused and the latest
    copy is loaded).
  - **DVSA files** (`processDvsaFile_`): picker and drag-and-drop both come
    here. The file's own month is checked first (`fileMonth_`); a file for
    another month offers to switch rather than filing it in the wrong one.
    It is then filed with its parsed figures (`saveDvsaFile_`).
  - **Scans** (`runScan_('qc' | 'cert')`): each page is sent with the month
    and a fingerprint (SHA-256 of the file + page number). The back office
    files it and has Claude read it. `savedPages_` holds what is filed;
    `unsavedPages_` holds pages that couldn't be filed, for Retry. The screen
    and the report's evidence lists are rebuilt from `savedPages_`
    (`rebuildFromPages_`). Images are fetched only when the report needs
    them (`ensureEvidence_`), and are turned upright using the rotation
    Claude reported.
- **Page images:** `fileToPageImages_` turns files into JPEGs no larger than
  1560px on the long edge. Pages are sent 3 at a time (`SCAN_CONCURRENCY`).
- **Backend version check:** `EXPECTED_BACKEND_VERSION` (14 on this branch; the live site is still 12) must
  match `BACKEND_VERSION` in `Code.gs`. If the live backend is older, the app
  shows a warning.
- **Report:** `buildReportHTML()` is rendered into `#printReport`, shown in a
  preview overlay, and printed with `window.print()`.
- **Backend URL:** `SCRIPT_URL` near the top of the main `<script>`. If it's
  empty, the app runs locally with no login, saving or scanning, and the
  top of the page says "Not connected — nothing is being saved".
  `IS_TEST_COPY` shows the TEST banner (set by `tools/make-test-copy.js`).
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
| `loadAppData` / `saveAppData` | yes | **Old storage, kept only so the current live page keeps working after v13 is deployed.** Script Properties under `DATA_calibration`, `DATA_month_YYYY-MM` and `DATA_tq_Mon-YY`. |
| `analyzeQcPage` / `analyzeCalibrationCert` **with `month`** | yes | Files the page in the month's Drive folder, then has Claude read it, outside the lock. A known fingerprint isn't filed or read again. A failed read is still filed, as `error`, and can be retried. |
| `openSession` | yes | Everything needed to start, in one request (see above). |
| `recordsStatus`, `migrateLegacy` | yes | Whether the old data has been moved across; moving it across once. It copies and never deletes, and also takes test-log totals that only lived in a browser. |
| `listMonths`, `loadMonth` | yes | The records index; one month's `details.json` (no Drive ids or images). |
| `saveMonthFields` | yes | Checklist only. Refused with `conflict` if `baseRevision` is stale. |
| `saveDvsaFile`, `getDvsaFile` | yes | File and fetch the original DVSA export. A replaced one goes to `Removed/`. |
| `getPageImage`, `removePage`, `retryPage` | yes | Fetch a filed page; move a page to `Removed/`; read a page again. |
| `loadEquipment`, `saveEquipment` | yes | `equipment.json`, with the same revision protection. |

- **Secrets:** `DASHBOARD_PASSWORD` and `ANTHROPIC_API_KEY` are kept in
  Script Properties and must never be in `index.html`. Other properties are
  `RECORDS_FOLDER_ID` (set automatically), `RECORDS_FOLDER_NAME` (TEST copy
  only) and `RECORDS_MIGRATED`.
- **Records rules enforced on the server:**
  - Every change to a month runs inside `withLock_`.
  - A month with status `signed` refuses all changes (`assertEditable_`).
  - Nothing is deleted: removed files go to the month's `Removed/` folder.
  - Errors come back as `{ status, message }` (`appError_`): `locked`,
    `conflict`, `missing`, `busy` or `error`.
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

**Automated checks.** Run these before pushing any change to `index.html`
or `Code.gs`:

```
npm install            # once; installs Playwright (or use a global install)
npm test               # 19 back-office checks + 7 real-browser checks
```

- **Back office checks:** `tests/backend.test.js` runs the real `Code.gs` on
  a pretend Google (`tests/fake-google.js`).
- **Browser checks:** `tests/e2e.test.js` drives the real page in Chromium
  against it, including "another computer", failed saves with Retry,
  conflicts, moving old data across and the signed-month lock.
- **When something changes:** add a check whenever a rule in `SPEC.md` is
  added or changed.

**Trying the app by hand:** `npm run serve`, then open
http://localhost:8790 (password `pw`). It runs on the pretend Google, and
Claude's readings are made up.

**Previewing with no back office:** open `index.html` with `SCRIPT_URL` blank.

## Current work / to-do (as of Oct 2026)

From Ediz, in priority order:

1. **Monthly Records: keep every month's signed report** (replaces "save and
   reopen reports"). Plan with diagrams:
   https://claude.ai/artifact/Af71WTpVraWKUu4TQKVRBw
   **Decisions agreed (Oct 2026):**
   - **Storage:** everything for a month goes in a folder in **Paul's** Google
     Drive (the backend already runs under his account):
     `Mortlake Garage Records/YYYY-MM/`. It holds the DVSA files, the QC page
     images, the certificate images, a details file (what Claude read, the
     checklist, a snapshot of that month's calibration dates, and a history of
     changes) and the signed PDF(s). This reverses the old "process and
     discard" rule.
   - **Sign-off freezes the PDF.** A signed PDF is never changed or replaced.
   - **Amend regenerates the whole report** (decided 13 Oct 2026). Paul ticks
     "I am amending <month>" and must give a reason. The month then unlocks
     and he can change anything, including DVSA files. Signing off builds a
     full new report with the updated figures and an amendment box on
     page 1, filed as v2 next to v1, which is kept. A cancelled amendment
     restores the month exactly as it was signed.
   - **Each month moves through stages:** Draft → Ready → Signed off →
     (Amended). Signed months are locked.
   - **Logins:** Paul only. No tester logins for now.
   - **Retention:** keep everything, and never delete. Removed items go to
     the month's `Removed` folder, not Drive's bin, which Google empties
     after 30 days. Signed PDFs can't be removed from the app.
   - **No importing of old reports.** Paul's earlier months are on paper.
   - **Opening an old month shows its one signed PDF**, with everything in
     it (Ediz's idea, and the core of the design).
   - **PDF test result (12 Oct 2026):** a realistic month (240 tests, 26
     scanned pages) was tested two ways. The app can make the PDF itself
     (html2canvas + jsPDF) and it looks the same as the printed report:
     about 16s and about 19MB. Most of that size is the scans. Print → "Save as PDF"
     takes about 1s and about 16MB with searchable text, but Paul would have
     to save the file and drop it back in. Still to fix in the app-made
     version: page breaks currently cut through the middle of tables, and a
     file this big has to be sent to Google in pieces. Google's own PDF
     converter wasn't tested, because the report's charts and layout use
     things it handles badly. **Decided: the app makes the PDF itself**,
     so Paul never has to drop anything back in.
   - **Scan files are kept after sign-off**, even though the pages are also
     inside the PDF.
   - **Full specification:** `SPEC.md`. It's the source of truth for this
     feature, so build to it, and update it first if the logic changes.
   **Process:** (1) decisions ✅ → (2) test how to make the PDF
   automatically ✅ → (3) `SPEC.md` approved ✅ (13 Oct 2026) → (4) build in
   stages on a test copy: **A built and tested ✅** (13 Oct 2026). The TEST
   back office is deployed (its URL is in `test.html`, regenerate with
   `node tools/make-test-copy.js <url>` after every `index.html` change);
   `test.html` needs to be on `main` to be reachable online. B (sign-off,
   PDF, amend) next, then C (the Records screen) → (5) a trial month, then go
   live.
   **Do not merge this branch into `main` before go-live.** The new
   `index.html` needs the v13 back office. The live back office can be
   updated to v13 first without breaking the current page, because the old
   requests are kept. Go-live order: deploy v13 to the live back office,
   then merge.
2. **Records screen** (year → month → open report). This is stage C of item
   1 and replaces the "completed reports list".
3. ~~**Wrong report date.**~~ Done. The report is now headed with the month
   the data covers (`dataMonth_()`: the Test Quality period, otherwise the
   month most test-log dates fall in), plus the test date range. The
   generated time is a small secondary note. If the DVSA files don't match
   the month picker, generating is blocked, and the Fix button
   (`switchToDataMonth_`) switches month without clearing the uploads.
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
