# Repair Desk go-live

**Cutover: Tuesday, November 10, 2026** (shop closed). Wednesday the 11th is the
spare day. Staff use the Repair Desk from Thursday the 12th.

Everything before "Tuesday" can be done any time and changes nothing staff
see: the production server starts empty and the POS tile isn't released yet.

---

## Before Tuesday (about 30 minutes, Tom)

### 1. Make the GitHub repository private
GitHub → `MokuNY/moku-repair-desk` → Settings → General → Danger Zone →
Change visibility → Private. This must be done before any real data is
involved: the repository was public, and old test files had phone numbers in them.

### 2. Create the production Shopify app
1. Shopify Dev Dashboard → Apps → **Create app** → name it `Repair Desk`.
2. Distribution: custom, for `moku-surf-shop-ny.myshopify.com`.
3. Install it on the live store and **approve** the access it asks for:
   customers (read and write), orders (read), products (read). This is approval A3.
4. From the app's Settings page, copy: **Client ID**, **Client secret**, and
   create an **App Automation Token**.

### 3. Make a key for the iPad's nightly copy
Make a random password of at least 40 characters (Passwords app → New
Password, or any password manager). Save it in your password manager as
"Repair Desk nightly copy". You'll paste it in two places: GitHub (next step)
and the iPad Shortcut (step 9).

### 4. Add the settings to GitHub
Repository → Settings → Secrets and variables → Actions:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `PROD_SHOPIFY_CLIENT_ID` | Client ID from step 2 |
| Secret | `PROD_SHOPIFY_CLIENT_SECRET` | Client secret from step 2 |
| Secret | `PROD_SHOPIFY_APP_AUTOMATION_TOKEN` | App Automation Token from step 2 |
| Secret | `PROD_EXPORT_KEY` | The key from step 3 |

### 5. Start the production server
Actions → **Repair Desk production** → Run workflow → tick **confirm**, leave
**POS tile** unticked. The first run creates the server, its storage and the
backup bucket (about 5 minutes). It finishes green only if the server answers
and the backup is running.

---

## Tuesday, November 10 (about 1½ hours)

### 6. Freeze and export the spreadsheet
1. Tell staff: nobody writes in **Moku Ding Repair** from now on.
2. Numbers → Moku Ding Repair → Repairs table → File → Export To → CSV.
   Name it `Repairs.csv`.

### 7. Import (Tom's Mac, Terminal)
```sh
fly ssh sftp put Repairs.csv /data/import.csv -a moku-repair-desk -u node
fly ssh console -a moku-repair-desk -u node -C "node --no-warnings /app/scripts/import.js /data/repair-desk.sqlite /data/import.csv --link MOKU-0004=MOKU-0003"
```
That is a **preview**: nothing is written. Check it shows:

- 8 live tickets (MOKU-0001 to 0008) and 177 archived jobs
- next job **MOKU-0186**
- totals: charged **$17,780.00**, received **$15,270.00**, balances **$1,595.00**, margin **$3,410.00**
  (if the sheet changed since Oct 16 these will differ; they must match the sheet's Dashboard)
- the list of jobs with no usable phone, and phones shared by different names.
  Those jobs still turn up when you search by name; they just won't appear on
  that customer's history. Nothing to fix unless something looks wrong.

If it's right, run the same command with `--apply` at the end. A full copy of
the database is taken first. Then delete the CSV from the server:
```sh
fly ssh console -a moku-repair-desk -u node -C "rm /data/import.csv"
```

### 8. Labels and the POS tile
1. Actions → **Connect label printer** → target **production**, tick confirm.
   (The test server stops printing; that's expected.)
2. Actions → **Repair Desk production** → tick **confirm** and **POS tile**.
3. On the iPad: Shopify POS → add the **Repair Desk** tile to the home screen.
4. Each staff member signs into POS, opens the tile once and picks their name.
   Carolyn's account has payout access.
5. Print one real label: open one of the 8 imported boards (say MOKU-0003),
   tap **Reprint label**, stick the label on that board, then scan it with the
   POS camera and check it opens the ticket. Do one for each of the 8 boards
   while you're at it: they came from the sheet and have no QR label yet.

### 9. The nightly copy on the iPad
This puts a fresh copy of every repair (old and new, 13 columns like the old
sheet) in the iPad's Files each night. Open it in Numbers any time.

1. Files app → iCloud Drive → make a folder **Repair Desk**.
2. Shortcuts app → **Automation** → New → **Time of Day** → 11:00 PM, Daily →
   **Run Immediately** (turn off "Notify When Run").
3. Add actions:
   - **Get Contents of URL**: `https://moku-repair-desk.fly.dev/export/repairs.csv`
     - Method: GET
     - Headers → Add: `X-Export-Key` = the key from step 3
   - **Save File**: Save to `Repair Desk` folder, **Ask Where to Save** off,
     **Overwrite If File Exists** on. Before Save File, add **Set Name** →
     `Moku Repair Desk.csv`.
4. Tap the play button once to test. `Moku Repair Desk.csv` appears in Files;
   tap it and it opens in Numbers.

Each night's file replaces the last one. Numbers opens the CSV as a new
spreadsheet: read it, sort it or print it, but make changes in the Repair Desk,
not in the copy.

### 10. Retire the old sheet
Rename it **Moku Ding Repair (archived Nov 10)** and lock it (Numbers →
File → Lock). Keep it; don't delete it.

---

## After go-live

- **Printer token rotation (A8)**: the old ZD411 token was exposed during the
  audit. Rotate it on a quiet morning: new `PRINTERS` secret on the label server, then re-send the
  printer config. Price labels stop for a few minutes.
- **Backups**: Litestream copies every change off the server within seconds.
  The server also keeps a full copy before every update (newest 5), and the
  iPad has last night's spreadsheet.
- **Restore drill** (once, after a week):
  `fly ssh console -a moku-repair-desk -u node -C "litestream restore -config /app/litestream.yml -o /tmp/check.sqlite /data/repair-desk.sqlite"`
  then check `/tmp/check.sqlite` opens and has today's jobs.
