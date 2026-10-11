# Deploying the Mortlake Garage backend

This turns on two things at once: the real password login, and the smart-scan
paperwork sorter. Follow these in order — it looks like a lot, but it's all
clicking, no coding.

**Before you start:** decide whose Google account this lives under. It's
Paul's business and Paul's data, so we'd recommend **Paul's own Google
account** (free, he owns it, nothing depends on anyone else). You just need
to be logged into that account in the browser tab you use for these steps.

---

## Part 1 — Get an Anthropic API key (needed for smart scan)

Skip this part if you only want the password login working for now — you can
come back and add this later without redoing anything else.

1. Go to **console.anthropic.com** and sign up / log in.
2. Add a payment method (it's pay-as-you-go — at Mortlake's volume of maybe
   20–40 scanned pages a month, this will cost pennies, not pounds).
3. Go to **API Keys** in the left sidebar → **Create Key** → give it any name
   (e.g. "Mortlake Garage") → copy the key it shows you. It looks like
   `sk-ant-...` — a long string of letters and numbers.
4. **Save that key somewhere safe right now** (e.g. a note on your phone) —
   most sites only show it to you once.

---

## Part 2 — Create the Apps Script project

1. Go to **script.google.com** (make sure you're logged into the right
   Google account first).
2. Click **New project** (top left).
3. You'll see a blank code editor with a file called `Code.gs` already open,
   containing a default `function myFunction() {}`.
4. Click on the project name at the top ("Untitled project") and rename it
   to something like **Mortlake Garage Backend**.

---

## Part 3 — Add the code

1. In the code editor, **select all the existing text and delete it**.
2. Open the file called `Code.gs` on your computer — it's sitting right next
   to `index.html` in the `mortlake-garage-report` folder on the Desktop.
3. Copy the **entire contents** of that file.
4. Paste it into the empty Apps Script editor.
5. Press **Cmd+S** (or the save icon) to save.

---

## Part 4 — Add the two secret values

These are the values the code reads privately — they never appear in any
file, so they stay hidden from anyone looking at the app itself.

1. In the left sidebar of the Apps Script editor, click the **gear icon**
   (⚙️ Project Settings).
2. Scroll down to **Script Properties** → click **Add script property**.
3. Add this one:
   - Property: `DASHBOARD_PASSWORD`
   - Value: *(whatever password you want Paul to log in with)*
4. Click **Add script property** again and add the second one (only if you
   did Part 1):
   - Property: `ANTHROPIC_API_KEY`
   - Value: *(the `sk-ant-...` key you copied earlier)*
5. Click **Save script properties**.

---

## Part 5 — Deploy it as a website the app can talk to

1. Back in the main editor, click **Deploy** (top right) → **New deployment**.
2. Click the gear icon next to "Select type" → choose **Web app**.
3. Fill in:
   - Description: `v1`
   - Execute as: **Me** *(your/Paul's account)*
   - Who has access: **Anyone**

   *(This sounds scarier than it is — "Anyone" just means anyone with the
   secret URL can send it a request; without the right password, every
   request it receives gets rejected. Nobody can guess the URL, and nobody
   can get in without the password.)*
4. Click **Deploy**.
5. It may ask you to **Authorize access** — click through, choose the
   Google account, click **Advanced** → **Go to Mortlake Garage Backend
   (unsafe)** if Google shows a warning screen (this warning appears for
   *any* personal Apps Script project, not because anything's wrong — it's
   just Google being cautious about scripts it hasn't reviewed).
6. Once deployed, you'll see a **Web app URL** — it looks like:
   `https://script.google.com/macros/s/AKfycb.../exec`
7. **Copy that whole URL.**

---

## Part 6 — Send it back

Send me that URL. I'll paste it into `index.html` (the `SCRIPT_URL` line),
and both the real password login and the smart scan go live at the same
time.

---

## If you ever need to change the code later

Go back to script.google.com, open this same project, paste in the updated
code, hit save, then **Deploy → Manage deployments → edit (pencil icon) →
New version → Deploy**. The URL stays exactly the same — nothing needs to
be re-copied.
