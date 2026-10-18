# Monthly Records: specification

**Status:** draft for review by Ediz and Paul. Nothing in here is built yet.
**Last changed:** 13 Oct 2026. Amend now regenerates the whole report;
removed items are kept in a `Removed` folder.
**Diagrams:** https://claude.ai/artifact/Af71WTpVraWKUu4TQKVRBw

---

## 1. The goal in one paragraph

Every month's DVSA quality record is kept, finished and signed, inside the
app. If a DVSA examiner says "show me July last year", Paul opens
**Records → 2025 → July → Open report**. The PDF he signed opens in about 10
seconds, with every scanned page in it. Nothing he files can be lost, quietly
changed or deleted by accident.

## 2. What's in this release, and what isn't

**In:**
- **Saving as you go.** Everything Paul adds for a month is saved to his
  Google Drive straight away.
- **Picking up where he left off.** Reopening a month, on any computer,
  brings back everything he'd added.
- **Sign-off.** It makes the one PDF, files it and locks the month.
- **Amend.** He can reopen a signed month, change anything, and produce a
  new report with the updated figures. The original signed version is kept.
- **A Records screen** to find and open any month's report.
- **Moving across what's saved today,** so nothing already saved is lost.

**Not in this release** (possible later):
- Logins for testers
- Reminders by email
- The notice-board summary
- A one-click inspector pack
- Importing old months (Paul's earlier months are on paper)
- Locking the app after a period of inactivity

## 3. Words used in this document

| Word | Meaning |
|---|---|
| **Month** | One reporting month, such as September 2026, and everything that belongs to it. |
| **Pieces** | What goes into a month: the 3 DVSA files, scanned QC pages, scanned calibration certificates, checklist answers, and what Claude read on each page. |
| **Report PDF** | The finished report as one PDF, made at sign-off. |
| **Filing cabinet** | The `Mortlake Garage Records` folder in Paul's Google Drive. |
| **Back office** | The Google Apps Script (`Code.gs`). It is the only thing that touches the filing cabinet. |
| **Details file** | A small file in each month's folder listing what's in the month, what Claude read, the checklist, and the history of changes. |

## 4. Where everything lives

**Rule: the filing cabinet is the single true copy.** The browser only keeps
a temporary copy for speed. If the two ever disagree, the filing cabinet
wins.

| What | Where | Notes |
|---|---|---|
| Password and Claude key | Back office settings (Script Properties) | Same as today. These are the only things left there. |
| Everything about a month | `Mortlake Garage Records/YYYY-MM/` in Drive | See section 5. |
| Page list while a month is being worked on | The back office's quick storage (Script Properties) | Decided 15 Oct 2026, for speed. Each page's details (what Claude read, its status) are kept here as Paul works, because rewriting `details.json` in Drive for every page made batches of scans queue and fail. The page **images** still go straight into Drive. The full list is written into `details.json` whenever the month is opened, and at sign-off. Months untouched for 35 days are cleared from quick storage; their pages live in `details.json` and come back automatically if the month is worked on again. |
| Equipment list (current calibration dates) | `Mortlake Garage Records/equipment.json` | Shared by all months. Each month keeps its own snapshot at sign-off. |
| Records index | `Mortlake Garage Records/records-index.json` | One line per month: status, version, headline figures. It powers the Records screen and the dashboard trend without opening every folder. |
| Browser storage | Paul's browser | A temporary copy only. Losing it loses nothing. |

**Nothing is ever deleted by the app.** Removed items go to the month's
`Removed` folder. Drive's bin isn't used, because Google empties it after 30
days.

**Who can see the files:** only Paul's Google account. The folder is not
shared. The app reaches it through the back office, which checks the
password on every request.

## 5. A month's folder

```
Mortlake Garage Records/
├── equipment.json
├── records-index.json
└── 2026-09/
    ├── details.json
    ├── DVSA files/
    │   ├── test-log-by-date.xlsx
    │   ├── test-log-by-duration.xlsx
    │   └── test-quality.xlsx
    ├── QC paperwork/
    │   ├── page-001.jpg
    │   └── …
    ├── Calibration certificates/
    │   └── cert-001.jpg
    ├── Removed/                       (anything Paul removed; never deleted)
    ├── details-v1.json                (snapshot taken when an amendment starts)
    └── Signed reports/
        ├── Mortlake DVSA report – September 2026 – v1 – signed 2026-10-04.pdf
        └── Mortlake DVSA report – September 2026 – v2 – amended 2026-10-14.pdf
```

`details.json` holds:
- **Status:** `draft`, `signed` or `amending`, plus the latest signed
  version number and, during an amendment, its reason.
- **Pages:** for each QC page and certificate, its file name, what Claude
  read (registration, document type, tester, date, rotation, confidence), a
  fingerprint used to spot duplicates, and whether it has been read yet.
- **Checklist:** the answers and notes.
- **DVSA figures:** the parsed Test Quality figures and test-log totals for
  the month.
- **Calibration snapshot:** the equipment list as it stood at sign-off.
- **Versions:** for each signed PDF, its date, file name, size and the reason
  for any amendment.
- **History:** a dated line for every change, such as "14 Oct 10:42 – added
  QC page 27 (AB12CDE, VT20)".
- **Revision numbers** for the parts Paul edits by hand (the checklist; the
  equipment list has its own). Each goes up by one on every save of that
  part. Section 11 explains why. Pages need no revision number: adding a
  page can't undo anyone else's change.

## 6. The life of a month

```
Not started ──first thing added──▶ Draft ──all checks pass──▶ Ready
                                     ▲                          │
                                     └──something removed───────┘
                                                                │ Sign off
                                                                ▼
              ┌──────────────────────────────────────▶ Signed off (v1)
              │                                                 │ Amend (tick + reason)
              │ Sign off amendment → v2 filed                   ▼
              └──────────────────────────────────────── Amending (unlocked)
                                      Cancel amendment → back to v1, unchanged
```

| Status | How it gets there | What Paul can do |
|---|---|---|
| **Not started** | Nothing saved for the month yet | Start it by adding anything |
| **Draft** | Something has been added | Add, remove or re-read pages; answer the checklist; replace DVSA files |
| **Ready** | Worked out automatically, never stored: all the checks below pass | Everything in Draft, plus **Sign off** |
| **Signed off** | Paul signs off; the PDF is made and filed | Open the report; **Amend** |
| **Amending** | Paul clicks Amend, ticks "I am amending September 2026" and gives a reason | Everything in Draft, plus **Sign off amendment** or **Cancel amendment** |
| **Amended** | An amendment is signed off. It's shown as "Signed off · v2". | Open any version (the latest is shown first); amend again |

**Checks that make a month "Ready"** (agreed 17 Oct 2026: nothing can be
signed off with anything missing). Every required item is marked with a red
**\*** on screen, and Sign off lists exactly what is still missing, each with
a "Go there" link:
1. All 3 DVSA files are in, and they're for this month.
2. At least one QC page is in; every page has been read, saved and
   identified (a page with no readable registration must be removed or
   rescanned).
3. **Every QC vehicle has its full set:** VT20, inspection sheet, and an
   emissions test unless it's electric.
4. Every checklist question is answered, and **every NO has a note**
   saying what needs fixing.
5. Any calibration certificate added has been read. (Certificates stay
   optional.)
6. Nothing is still saving or waiting for Retry.

The back office checks what it can itself (the DVSA files are in and every
page is read) and refuses a sign-off that fails, whatever the page says.

**Locked means locked.** Once a month is signed off, the back office itself
refuses any change to its pieces unless an amendment has been opened, with
a reason, first. The app greys out the controls, but the real protection is
on the back office, so a bug in the page can't get round it.

**Signed PDFs are never changed or deleted.** An amendment always files a
new version alongside them. There is no "un-sign".

## 7. Screens

### 7.1 Records (new tab, built 18 Oct 2026)

- **Where:** the second tab: Dashboard · Records · Monthly Report · Checklist.
- **Year buttons** along the top. The year being worked on is selected.
  There is no "download the whole year" button (Ediz, 18 Oct 2026).
- **12 month tiles,** each showing its status:
  - Signed off: green, "Signed 04 Oct"
  - Amended: purple, "Amended 14 Oct" (by date, never by number)
  - Amendment in progress: orange, "Being amended"
  - Draft: amber, "N things left" (or "Ready to sign off")
  - Not started: plain, "Not started"
  - Months still to come: faded, and can't be picked
  - Signed and draft tiles also show how many vehicles were QC'd.
- **Clicking a month** shows a short panel:
  - Signed or amended: who signed it and when (and the reason, for an
    amendment), plus **Open report**, **Amend** (or **Continue
    amendment**), **Open folder in Google Drive**, and the earlier reports
    by date ("original report of 04 Oct 2026").
  - Draft: the list of what's still needed, and **Continue**, which goes
    to the Monthly Report tab for that month.
  - Not started: **Start**, which does the same.
- **Speed:** the screen draws at once from the records index this computer
  already has, then asks Google for the latest index (one quick request,
  no month folders opened) and redraws.
- **Signed reports kept on Paul's computer:** they never change, so the
  computer quietly fetches a copy of each month's latest signed report,
  one at a time, newest first, and only while nothing is being saved or
  signed. Opening one is then instant. Log out empties these copies.

### 7.2 Monthly Report tab (today's screen, changed)

- **Choosing a month loads its saved pieces.** It no longer clears the
  uploads.
- **Each file and page shows where it is:** "Saving…", then "Saved ✓", or "Not
  saved – Retry" if something went wrong.
- **Wrong month:** a DVSA file for a different month is never filed in this
  one. As soon as it's added, Paul is asked "This file is for September 2026,
  but you're working on October 2026. Switch to September and file it there?".
- **Signed month:** a banner at the top says "September 2026 is signed off.
  Open report · Amend". All controls are read-only.
- **Generate report** becomes **Preview report.** It shows the report and
  saves nothing, and can be printed as today. Next to it is **Sign off**,
  greyed out until the month is Ready; pressing it while greyed out shows
  what is still missing.
- **Reminder** (agreed 17 Oct 2026): from the 10th of the month, if last
  month isn't signed off, a note at the top says so with a button to open
  it. A month with an amendment in progress is also mentioned.

### 7.3 Sign off

1. **Paul clicks Sign off.** A confirmation screen shows the month, the counts, and
   "I confirm this is a complete and accurate record for September 2026", with a
   tick box \*, **his full name** \* (printed on page 1 as "Signed off by …"),
   and the button **Sign off and file**, which stays greyed out until both are
   filled in.
2. **The app makes the PDF,** with a progress bar ("Making page 12 of 41…").
   This takes about 15–20 seconds.
3. **The PDF is sent to the back office in pieces of about 5MB.** The progress bar shows
   this too.
4. **The back office joins the pieces, saves the PDF and checks its size**
   against what was sent.
5. **Only after that check passes** are the month's status and the Records index updated to
   "Signed off", the calibration snapshot taken, and a line added to the history.
6. **The app says** "Filed. September 2026 is signed off." and offers **Open
   report**.

**If anything fails partway** (lost internet, a closed laptop, a Google
error), the month stays Ready. Nothing is half-signed: a PDF that wasn't
fully saved and checked is thrown away, and Paul just clicks Sign off again.

### 7.4 Amend

An amendment produces a **whole new report with the updated figures**. It is
not a patch on the end of the old one.

1. **Paul opens a signed month and clicks Amend.** A screen asks for:
   - a tick box: **"I am amending September 2026 (signed off 04 Oct 2026,
     v1)"**
   - **Reason** (required, at least a few words), for example "Missing
     inspection sheet for AB12CDE; corrected test log export".

   Amend can't be confirmed without both. Before unlocking, the app takes a
   snapshot of the month as signed (`details-v1.json`), so the amendment
   can be cancelled.
2. **The month unlocks.** A banner stays on every screen until he's done:
   "You are amending September 2026. Reason: … · Sign off amendment ·
   Cancel amendment". He can change anything, exactly as in Draft:
   - add or remove pages
   - replace a DVSA file
   - change checklist answers

   Every change goes into the history as usual.
3. **He clicks Sign off amendment.** The same Ready checks apply. The app
   builds a full new report from the month as it now stands, so every
   figure, chart and page is up to date. Page 1 carries a clear box:
   > **Amended report, version 2.** This replaces version 1, signed
   > 04 Oct 2026. Amended 14 Oct 2026. Reason: *Missing inspection sheet
   > for AB12CDE…* Changes since version 1: added QC pages 27–28 (AB12CDE);
   > replaced test log (by date); checklist item 14 changed YES → NO.

   The list of changes is taken from the history automatically, so Paul
   doesn't have to write it.
4. **It's filed as v2** the same way as in 7.3, with the same "nothing
   half-signed" rule. **v1 stays in the folder, untouched**, so an examiner
   can still see what was originally signed. Records shows v2 first, with
   "Older versions" listing v1.

**Cancel amendment** puts the month back exactly as it was at v1, using the
snapshot. Any pages removed during the amendment are restored, and new ones
move to the `Removed` folder. The history records "Amendment cancelled".

**If Paul leaves an amendment half-finished,** the month shows "Signed off ·
amendment in progress" on Records. v1 remains the official report, and Open
report shows v1 until the amendment is signed off.

### 7.5 Open report

- **The app fetches the PDF** through the back office, in pieces, and opens
  it in the browser's own PDF viewer. This works on any computer with only
  the app password, with no Google login needed.
- **There's also a link** to the file in Google Drive, for when Paul is
  logged in to Google.

### 7.6 Dashboard

This mostly stays the same. The month-by-month trend reads from
`records-index.json`, so it covers every month, on any computer.

## 8. Saving as you go: the rules

| Paul does | What gets saved | When |
|---|---|---|
| Adds a DVSA file | The original file, plus the parsed figures in `details.json` | Straight away |
| Adds QC scans and clicks Sort | Claude reads each page first, in a quick request that saves nothing, and the result shows straight away. The page is then filed in the background with what Claude read, so it is never read (or paid for) twice. Until every page is filed, a panel says "Don't leave yet, we're saving stuff in the backend" with a tyre that fills up, the report can't be generated, and closing the tab asks first. A page that can't be filed is listed as "Not saved" with Retry, which files it without reading it again. *(Changed 16 Oct 2026, for speed.)* | Read: page by page. Filed: a few seconds later |
| A page can't be read | The image is still saved, marked "not read" with the reason, and can be retried later | Straight away |
| Adds the same scan twice | Detected by the page fingerprint: "Page already filed (page 7)". It isn't stored again. | Straight away |
| Removes a page (Draft or Amending only) | It's moved to the month's `Removed` folder, not deleted, and the history records it | Straight away |
| Answers a checklist question | `details.json` | About 1.5s after the last change, as today |
| Adds a calibration certificate | The image, plus the reading in `details.json`; the matched equipment date is updated in `equipment.json` | Straight away |

**Pages already read are never sent to Claude again,** even after the month
is reopened.

**Reopening a month** loads `details.json` and the DVSA files (which are read
again in the browser, so the full test lists come back). Page images are only
downloaded when they're needed: for the preview, at sign-off, or when Paul
looks at one. That keeps opening a month quick.

## 9. The report PDF

- **How it's made:** in the browser, the way that was tested on 12 Oct
  2026. The report's text pages are captured as images, and the scanned
  pages are placed in as they are, without being redrawn.
- **Page breaks** must fall between rows and sections, never through the
  middle of a table. The test version got this wrong, and it must be fixed.
- **Expected size** is roughly 10–20MB a month, depending on the scans. That's
  about 250MB a year, against 15GB of free Google storage.
- **The first page** says which month it covers, when it was signed and by
  whom, and every page carries "Mortlake Station Garage · September 2026 ·
  page X of Y".
- **No version numbers on the report** (Ediz, 18 Oct 2026: they mean nothing
  to DVSA). An amended report says "Amended report. This replaces the report
  signed off on 4 October 2026 by …" on page 1, and "amended 14 Oct 2026"
  in every page's footer. Only the file names in Google Drive carry v1/v2,
  so they sort in order.
- **Long tables** that run over a page repeat their column headings at the
  top of the next page.

## 10. History

Every change to a month adds a dated line to its history:
- each file added or removed
- each page read, and what was read
- each checklist answer changed
- sign-off and amendments

The history is printed on the last page of each signed PDF. Then the record
shows how it was put together, which helps if an examiner asks.

## 11. When things go wrong

| Situation | What happens |
|---|---|
| Internet drops while scanning | Pages already saved stay saved. The rest show "Not saved – Retry". Paul can't sign off until everything is saved. |
| Laptop closed halfway through a month | Nothing is lost except a page that was mid-upload. Reopening the month shows exactly what was saved. |
| App open on two computers | A checklist or equipment save carries the revision number it started from. If the other computer saved in between, the save is refused, Paul is told "changed on another computer", and the latest copy is loaded rather than overwritten. |
| Back office out of date | The version check that exists today stops the app and says the back office needs updating, instead of saving things in the wrong place. |
| Google is slow or down | Saves wait and retry a few times, then say clearly that they failed. Nothing is reported as saved unless it was. |
| Laptop lost or replaced | Nothing is lost. Paul logs in on the new computer and everything is there. |
| The app stops working altogether | Everything is plain files in Paul's Drive: PDFs, JPEGs and the original Excel files. He can open them without the app. |
| Something deleted from Drive by hand | The month shows "File missing: page-007.jpg". Signed PDFs are what matters, and Drive keeps deleted files in its bin for 30 days. |
| Paul starts an amendment and forgets about it | Records shows "Signed off · amendment in progress", and the dashboard reminds him. The last signed version stays the official report until he signs off or cancels. |

## 12. Moving across what's saved today

This is done once, automatically, the first time the new version runs:
1. **Create the folders.** The filing cabinet folder is created, plus a
   folder for each month that has saved data.
2. **Copy the saved data across.** Checklist answers, Test Quality figures
   and calibration dates are copied from the back office settings into the
   new files.
3. **Upload the test-log totals.** These were only ever kept in Paul's
   browser, so they're uploaded from there. (This also fixes the gap where
   they were never backed up.)
4. **Mark existing months as Draft.** Their scans were never kept, so they
   have no QC pages. Paul can carry on with the current month as normal.
5. **Leave the old saved data alone.** It stays as a backup until Ediz
   confirms the move worked, and is cleared later by hand.

## 13. Back office changes (`Code.gs`, version 13)

New requests the app can make, all password-checked:
- **Months:** list the months, load a month, save `details.json` (refused if
  the change counter is stale or the month is signed).
- **Files:** save a DVSA file; save a page or certificate image; fetch a
  page image; move a page to `Removed` (Draft or Amending only).
- **Amendments:** start an amendment (needs the reason; takes the
  snapshot and unlocks the month); cancel an amendment (restores the
  snapshot).
- **Reading pages:** the existing reading requests also take the month and
  save the page image and Claude's reading.
- **The report PDF:** receive it in pieces; finish a sign-off or amendment
  (join the pieces, check the size, update the status, the index and the
  history); fetch it in pieces.
- **Equipment:** load and save the equipment list.

**Two safety rules:**
- **One change at a time:** a lock ensures only one change to a month is
  made at a time. The app reads 3 pages at once, and without the lock two
  could overwrite each other's line in `details.json`.
- **Locked months:** every request that changes a month checks first that
  it's in Draft or Amending. Signed PDFs can never be overwritten or
  deleted by any request.

**Deploying it:** the first deploy asks Paul's Google account for
permission to use Drive.

## 14. How it's built and checked

| Stage | What it adds | Accepted when |
|---|---|---|
| **A** | Saving as you go; reopening a month; moving across today's data | Ediz adds pieces to a test month, closes the browser, opens it on another computer, and everything is there |
| **B** | Sign off, the report PDF, Amend (full regenerate), Cancel amendment, Open report | A test month is signed, then amended with a replaced DVSA file and an added page. v2 shows the new figures and the amendment box. v1 is unchanged byte for byte. A cancelled amendment leaves the month exactly as it was. |
| **C** | The Records screen, and the dashboard reading the index | The "show me July" test takes under 10 seconds |

- **Test copy:** all three stages are built on a test copy, with a separate
  test back office and test filing-cabinet folder, so Paul's live app and
  data aren't touched.
- **Automatic checks:** a set of checks runs before each stage is handed
  over. They use anonymised sample files and cover saving, reopening,
  locking, page breaks and the failure cases in section 11.
- **Going live:** after stage C, Paul does one real month on the test copy
  alongside his usual way. If it's right, the live app is switched over. The
  previous version is kept so the switch can be undone.
- **At go-live the app moves to Paul's own domain** (agreed 18 Oct 2026):
  the website is hosted on Cloudflare Pages (which Paul already uses), the
  code repository on GitHub is made private, and the records stay in
  Paul's Google Drive. The old address forwards to the new one.

## 15. Decided 17 Oct 2026

1. **Sign-off wording** stays as in 7.3, and Paul types his full name.
2. **History** is printed on the last page of each signed PDF.
3. **Preview report** replaces Generate; Sign off sits next to it.
4. **Reminder** for an unsigned month from the 10th of the next month.
5. **Nothing missing:** the stricter Ready checks in section 6, with red
   asterisks on every required item.
6. **The look of the app (UI redesign)** is done after stage C and before
   the trial month, so it isn't redone as new screens arrive, and the trial
   month tests the final look.
