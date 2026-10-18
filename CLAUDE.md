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
- **Login (v20, secure and never failing, agreed with Ediz 16 Oct 2026):**
  `verifyPassword` posts `checkDashboardPassword` once; Google answers with a
  **pass** (random token, 30 days) which is kept in localStorage
  (`PASS_KEY`). **The password itself is never stored in the browser**; an
  old saved one is wiped on load. Every request sends `token`. A computer
  with an unexpired pass goes straight in. A `forbidden` answer means the
  pass ran out or the password changed: `passRefused()` reloads to the lock
  screen with "Please type the password again". Logging in keeps trying for
  up to 2 minutes (`LOGIN_GIVE_UP_MS`, overlapping tries every
  `LOGIN_ATTEMPT_MS`, a late answer still counts), ignores a trailing space,
  doesn't autocapitalise, and warns about Caps Lock. Four answers that must
  never be confused: `ok`, `wrong` (the only one that may say "Incorrect
  password"), `paused` (too many guesses) and `noreply`. Tests enforce all
  of this. A **Log out** button ends this computer's pass.
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
  1560px on the long edge. **Read first, file in the background (v19):** each page is read by
  Claude in a quick request that saves nothing (`analyzeQcPage` /
  `analyzeCalibrationCert` without `month`, 3 at a time), and the result
  shows straight away as a "provisional" page. A separate queue
  (`fileQueue_`, 3 at a time) then files it with `filePage`, sending the
  `reading` (or `readError`) so Claude is never paid twice. Until filed,
  pages count as unsaved and block the report. If the quick read gets no
  answer, the page falls back to the one-trip filed-and-read request, then
  the two-step `filePage` → `readPage` route.
- **Tyre panel** (`#savingPanel`, `busyStart_`/`busyEnd_`/`renderTyre_`):
  shown bottom-right while pages or DVSA files are being saved: "Don't
  leave yet, we're saving stuff in the backend", with a tyre that fills as
  each is filed. (Ediz's wording and idea, 16 Oct 2026. The browser's own
  "leave page?" box can't show custom text.)
- **Every loading indicator is the tyre** (`tyreSvg_`, Ediz, 16 Oct 2026):
  the records cover (`#monthOverlay`), the sort/read progress (fills up as
  pages are read, `setTyreProgress_`), the small "Loading…/Reading…/Saving…"
  icons (`ICON_SPIN`), the login button, and a cover while the report fetches
  its pages. Use it for any new waiting state.
- **Stage B (built 17 Oct 2026):** Preview report (`handleGenerate`) and
  **Sign off** (`startSignOff` → `runSignOff_`). Sign off is greyed out until
  `signOffBlockers_()` is empty: everything Preview needs plus every QC
  vehicle's full set (`qcVehicleCheck_`), every page identified, every
  certificate read, and a note on every checklist NO. Required items carry a
  red `.req` asterisk. The PDF is made in the browser by `makeReportPdf_`
  (html2canvas + jsPDF in `assets/lib`, loaded only when signing): the report
  is laid out in a hidden frame and `planPdfPages_` cuts pages only between
  rows/blocks, repeating table headings; scans are placed directly; footer
  "Mortlake Station Garage · month · vN · page X of Y". `buildReportHTML(sign)`
  adds who signed, the amendment box and the history page. Signed months get
  a banner (`renderMonthState_`) and `body.month-locked`; Amend / Cancel
  amendment / Open report (`openSignedReport`, a PDF viewer overlay) work from
  it. `renderReminder_` nags from the 10th about last month if unsigned.
- **Speed (17 Oct 2026):** the browser keeps copies of filed files in
  IndexedDB (`cacheGet_`/`cachePut_`, database `mortlake_files`, `_TEST` for
  the test copy, emptied by Log out): DVSA files by Drive id, page images by
  month + page id, signed PDFs by month + version (`report:…`, stored at
  sign-off), all things that never change. A month is shown at once from
  this computer's last copy (`month:…`, refreshed by `rememberMonth_` when
  all is saved and on page close), read-only with "Checking with Google…"
  (`monthChecking_`, `body.month-checking`, blocks Preview/Sign off) until
  Google's copy arrives; it is redrawn only if `viewStamp_` differs. Reading
  scans runs 5 at a time (`READ_CONCURRENCY`); filing stays 3. Sign-off
  starts with `signStart` (no separate check) and sends pieces 6 at a time;
  the report viewer fetches pieces in parallel with retries.
- **Backend version check:** `EXPECTED_BACKEND_VERSION` (25 on this branch; the live page expects 20) must
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
| `checkDashboardPassword` | n/a | Login. Returns a 30-day pass (`token`). After 5 wrong passwords in a row, logging in is paused for 15 minutes (`paused`); computers with a pass carry on. |
| `logout` | yes | Ends this computer's pass. |
| `analyzeQcPage` | yes | Claude reads one QC page and returns category, document type, registration, make/model, whether it's an EV, tester, date, period, QC flag, rotation and confidence. |
| `analyzeCalibrationCert` | yes | Claude reads one calibration certificate and returns equipment, serial number, calibration and next-due dates, rotation and confidence. |
| `loadAppData` / `saveAppData` | yes | **Old storage, kept only so the current live page keeps working after v13 is deployed.** Script Properties under `DATA_calibration`, `DATA_month_YYYY-MM` and `DATA_tq_Mon-YY`. |
| `analyzeQcPage` / `analyzeCalibrationCert` **with `month`** | yes | Files the page in the month's Drive folder, then has Claude read it, outside the lock. A known fingerprint isn't filed or read again. A failed read is still filed, as `error`, and can be retried. |
| `openSession` | yes | Everything needed to start, in one request (see above). |
| `recordsStatus`, `migrateLegacy` | yes | Whether the old data has been moved across; moving it across once. It copies and never deletes, and also takes test-log totals that only lived in a browser. |
| `listMonths`, `loadMonth` | yes | The records index; one month's `details.json` (no Drive ids or images). |
| `saveMonthFields` | yes | Checklist only. Refused with `conflict` if `baseRevision` is stale. |
| `saveDvsaFile`, `getDvsaFile` | yes | File and fetch the original DVSA export. A replaced one goes to `Removed/`. |
| `filePage`, `readPage`, `getPage` | yes | **How the page sends scans (v15+):** file a page (a few seconds, safe to repeat), then have it read in a separate request, then check on it if the reading reply was lost. Since v19 `filePage` also takes `reading`/`readError`, so a page Claude already read is filed as read. No single request has to wait for Drive and Claude together, because long requests were being cut off at 30s. |
| `getPageImage`, `removePage`, `retryPage` | yes | Fetch a filed page; move a page to `Removed/`; read a page again (Retry). |
| `loadEquipment`, `saveEquipment` | yes | `equipment.json`, with the same revision protection. |
| `signStart`, `signPiece`, `signFinish` | yes | **Stage B (v21).** Sign off: checks the month (3 DVSA files, every page read, name, tick), receives the PDF in pieces, joins and size-checks it, files it in `Signed reports/`, and only then marks the month signed — and only if nothing changed since `signStart` (`monthStamp_`). Repeat-safe. |
| `startAmend`, `cancelAmend` | yes | Amend needs the tick and a reason; keeps `details-vN.json`. Cancel restores pages, DVSA files and checklist exactly as signed (files moved back from / to `Removed/`). |
| `getReport` | yes | A signed PDF, in pieces (latest version unless `version` given). Since v23 it hands back the pieces kept at sign-off (`Signed reports (pieces for the app)/`, ids in `versions[].pieceIds`) instead of converting the PDF, which took over 40s and failed on real Google; missing pieces are remade once. Since v25 the page asks for small bites (`from`, `length` ≤ 600,000 characters), four pieces at a time (`fetchSignedReport_`): real Google often stalls on 2MB answers but answers 0.5MB ones reliably. |

- **Secrets:** `DASHBOARD_PASSWORD` and `ANTHROPIC_API_KEY` are kept in
  Script Properties and must never be in `index.html`.
- **Passes (v20):** every request needs a pass (`token`) or, for the older
  live page only, the password. Passes are stored as `TOK_<sha256>` (never
  the pass itself) with an expiry and a fingerprint of the password, so
  **changing `DASHBOARD_PASSWORD` logs every computer out**. Wrong passwords
  are counted in `LOGIN_FAILS`. Once every page uses passes, accepting the
  password on every request can be removed. Other properties are
  `RECORDS_FOLDER_ID` (set automatically), `RECORDS_FOLDER_NAME` (TEST copy
  only) and `RECORDS_MIGRATED`.
- **Speed (v16):** saves run one at a time inside the lock, so the number of
  Drive calls per save sets the pace. Found folders and files are
  remembered by id in Script Properties (`ID_…`), and the records index lives
  in Script Properties (`IDX_YYYY-MM`) rather than a Drive file. The fake
  Google counts Drive calls, and a test caps them per action.
- **The queue (v17):** only one change at a time (`withLock_`). The lock
  waits 30s, except recording a finished Claude reading, which waits
  `RECORD_WAIT_MS` (2 minutes) so a paid-for reading is never lost. A page
  image is uploaded **outside** the lock, then named and filed inside it. A
  page left "reading" for 3 minutes (`READING_STALE_MS`) may be read again.
  Server errors are logged in the `ERRLOG` property; read them with
  `getErrors`.
- **Quick-storage page list (v18, decided 15 Oct 2026):** while a month is
  worked on, page records live in Script Properties (`PG_<month>_<id>`,
  plus `PGNEXT_`, `PGLIVE_`, `PGX_` for removals, `HB_` for history lines,
  `PGDIRTY_`, and `MST_` for the month's status). Filing and reading a page
  touches no Drive file while holding the lock. `flushPages_` writes it all
  into `details.json` when the month is opened (`loadMonth`); a month whose
  pages are settled and untouched for 35 days is cleared from quick storage,
  and `makeLive_` brings it back if needed. **Sign-off (stage B) must flush
  and set `MST_`**. Anything that changes a month's status must set `MST_`
  (`saveMonth_` does).
- **Records rules enforced on the server:**
  - Every change to a month runs inside `withLock_`.
  - A month with status `signed` refuses all changes (`assertEditable_`).
  - Nothing is deleted: removed files go to the month's `Removed/` folder.
  - Errors come back as `{ status, message }` (`appError_`): `locked`,
    `conflict`, `missing`, `busy` or `error`.
- **Claude calls:** they go straight to the Messages API using
  `CLAUDE_MODEL = 'claude-opus-5'` with `max_tokens: 8000` and
  `effort: 'low'`. 429, 500 and 529 errors are retried with backoff.
  **Which way up (v25):** Claude is asked `document_top` (which edge of the
  image the document's title is nearest to) and `withRotation_` turns that
  into the clockwise rotation (`ROTATION_FOR_TOP`); asking for "degrees
  clockwise" once gave 90 for a page needing 270, i.e. upside down.
  `tests/live-rotation.js` checks all four turns against real Claude.
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
npm test               # 32 back-office checks + 16 real-browser checks
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
   `test.html` needs to be on `main` to be reachable online. **B (sign-off,
   PDF, amend) built and accepted ✅ (17 Oct 2026, TEST back office v23):
   `tests/live-stageb.js` passed against real Google on 2026-07 — signed in
   46s (25 pages, 5.5MB), amended to v2 in 74s with the new figures and the
   amendment box, v1 unchanged byte for byte, a cancelled amendment left
   everything as signed, a second computer opened the report in 13s.**
   Real Google sometimes stalls 20–35s on a 2MB answer, so each report piece
   is asked for up to 3 times. TEST months 2025-01/02/04/08/12 and 2026-07
   now hold test data (2025-04, 2025-08, 2025-12, 2026-07 are signed).
   **18 Oct 2026, speed work measured on real Google (TEST v25):** sorting 9
   pages 12s (was 16s); another computer opens a month in 4.9s (was 8s);
   same computer: month on screen in 0.2s, confirmed in 2.7s; a signed report
   opens in 0.1s on the computer that signed it, 14–48s elsewhere (was
   13–55s, and failing on v24); sign-off 41–97s (Google's speed varies a
   lot); rotation 12/12 right (`tests/live-rotation.js`). TEST months
   2026-08/09/11/12 now hold test data (09 and 12 signed).
   Then C (the Records screen) → (5) a trial month, then go
   live.
   **Go-live plan (agreed with Ediz 18 Oct 2026):**
   1. Deploy this branch's `Code.gs` to the live back office ("Mortlake
      Garage Backend"), New version.
   2. **Move the website hosting from GitHub Pages to Cloudflare Pages** on
      Paul's own domain (e.g. `dvsa.mortlakegarage.co.uk`; test copy at
      `/test.html`), connected to this repo so pushes to `main` publish
      automatically. Paul already runs his domains on Cloudflare (his
      "Systems Guide", 18 Oct 2026). Optionally put his Cloudflare Access
      (emailed one-time code) in front.
   3. **Make the GitHub repo private** (Paul's rule: every repo private;
      no real data, passwords or keys in code). GitHub stays the code store
      only; Google stays the back office and records. History was checked on
      18 Oct 2026: no passwords or API keys, only the back-office URLs.
   4. Merge this branch into `main`; check the new address end to end
      (`tests/live-check.js` against it) before Paul is told.
   5. Forward the old address (mortlakemotreport.exposureboost.co.uk) to
      the new one, so bookmarks keep working. Paul logs in once more.
   6. Keep the previous version so the switch can be undone.
   Ediz or Paul does the Cloudflare/GitHub clicks (about 15 minutes); write
   them click-by-click steps first.
   **Do not merge this branch into `main` before go-live.** The new
   `index.html` needs the v13 back office. The live back office can be
   updated to v13 first without breaking the current page, because the old
   requests are kept. Go-live order: deploy v13 to the live back office,
   then merge.
   **Status on 13 Oct 2026 (read this first in a new session):**
   - The test copy is at https://mortlakemotreport.exposureboost.co.uk/test.html
     (orange TEST banner). Its back office is "Mortlake Garage Backend TEST"
     in Paul's Google account, and its URL is in `test.html`. Ediz has the
     test password; ask for it, never commit it.
   - **Test copy works against real Google** (checked 13 Oct 2026 with
     `tests/live-check.js`). The earlier "Could not reach the records" was
     one failed request, probably while the back office was being updated.
     Read-only requests are now retried once automatically. Real timings:
     opening takes 9s on a cold start and about 5s warm; a DVSA file save
     takes 7–13s (the back office's Drive work); a scan takes 15–20s
     (mostly Claude); a checklist save takes about 6s. All saves run in the
     background. Possible speed-up later: cache Drive folder and file ids
     in Script Properties, which would avoid the name searches on every
     save.
   - **15 Oct 2026: v18 passed the full made-up month** (`tests/live-month.js`,
     month 2025-09) against the real TEST back office: 3 DVSA files filed in
     about 20s; 9 scanned pages filed and read in 65s (172s and failing on
     v17); sideways page turned upright; second computer saw everything; the
     report built with all pages. TEST months 2025-09 to 2026-06 contain
     made-up test data.
   - **16 Oct 2026: v19 (read first, file in the background, tyre panel)
     passed the same month** (2025-03): 9 pages' results on screen in 16s
     (the old live app: 16s), all filed in Drive by 24s (v18: 52–65s).
     TEST months 2025-03, 2025-05 and 2025-07 now also hold made-up data;
     use an unused month (e.g. 2025-01) for the next run. The "offers to
     update the due date" check fails on a re-run because the brake tester
     date was already updated by an earlier run: a test artefact.
   - **How to work:** Ediz is not a coder and must not be used as the
     tester. Before asking him to try anything, run
     `TEST_PASSWORD=… node tests/live-check.js` (ask Ediz for the password;
     never commit it). It needs `script.google.com` and
     `script.googleusercontent.com` in the environment's allowed domains,
     which were added on 13 Oct. With curl, POST with `--data` and `-L` but
     **without** `-X POST`, or Google's redirect returns a "Page Not Found"
     page.
   - **Paul's real app** (`index.html` on `main`): **17 Oct 2026, the live
     back office is v20** (this branch's `Code.gs`) and the live page has
     the secure login (passes, patient retries, Log out), applied with
     `tools/patch-live-login.py` and tested against v20; nothing else on
     the live page changed. Paul types the password once more, then it
     lasts 30 days. Both back offices (live and TEST) must now be updated
     together whenever `Code.gs` changes, or the live one left alone if a
     change isn't safe for the old live page.
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
