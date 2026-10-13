# Setting up the TEST copy

The test copy is a complete second version of the app for trying out new
features. It has its own back office and its own folder in Google Drive,
**"Mortlake Garage Records (TEST)"**, so nothing you do in it can touch Paul's
real records. Every screen shows an orange **TEST COPY** banner.

It takes about 10 minutes. You only do it once; later updates are just "paste
the new code, New version, Deploy" (see the bottom of this page).

**Before you start:** be logged into **Paul's** Google account in your
browser. The test folder will be created in his Drive, next to the real one,
so everything stays in the business's account.

---

## 1. Create the test back office

1. Go to **script.google.com** and click **New project**.
2. Rename it (top left, "Untitled project") to **Mortlake Garage Backend TEST**.
3. Delete everything in the editor, paste in the whole of `Code.gs` from this
   repository, and press **Cmd+S** (or Ctrl+S).

## 2. Give it its settings

Click the **gear icon** (Project Settings) → **Script Properties** → **Add
script property**, and add these three:

| Property | Value |
|---|---|
| `DASHBOARD_PASSWORD` | A password for the test copy. Use a **different** one from the real app. |
| `ANTHROPIC_API_KEY` | The same `sk-ant-…` key the real back office uses |
| `RECORDS_FOLDER_NAME` | `Mortlake Garage Records (TEST)` (exactly like this) |

Click **Save script properties**.

> The third one matters: it's what keeps the test copy's files in a separate
> folder. Without it, the test folder would have the same name as the real one,
> which would be confusing.

## 3. Deploy it

1. Click **Deploy → New deployment**, then the gear next to "Select type" →
   **Web app**.
2. Description: `test`. Execute as: **Me**. Who has access: **Anyone**.
3. Click **Deploy**. Google will ask for permission. This time it will
   include **Google Drive**, because the new back office files the records
   there. Click through: **Advanced → Go to Mortlake Garage Backend TEST
   (unsafe)** if you see a warning, then **Allow**.
4. Copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`).

## 4. Send the URL to Claude

Claude will make `test.html` from the latest app and tell you how it goes
online. You then open `…/test.html` (not the normal address), log in with the
**test** password, and try it.

---

## Updating the test back office later

Open the same project at script.google.com, paste in the new `Code.gs`, save,
then **Deploy → Manage deployments → edit (pencil) → Version: New version →
Deploy**. The URL stays the same.

## Things to know

- The test copy and the real app never share anything: different back
  office, different Drive folder, and a separate saved password in the browser.
- To start the test copy again from scratch, delete the **Mortlake Garage
  Records (TEST)** folder in Drive. The next login creates a fresh one.
- **Never** put the test back office URL into `index.html`, or the real app's
  address would start using the test records.
