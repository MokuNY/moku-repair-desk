# Repair Desk

Ding repair intake and management for MOKU Surf Shop: intake on the iPad, QR label on the ZD411, Keith's work and payouts, pickup paid through Shopify POS.

**Status:** phase 1 foundation. Code and tests only. Nothing is deployed.

## Design rules

- **No npm dependencies.** Node built-ins only (`node:sqlite`, `node:crypto`, `node:http`), the same approach as the label printer server. Needs Node 22.13 or newer.
- **One SQLite file per shop deployment**, backed up continuously off the machine (hosting option B).
- **Every row belongs to a shop.** Links between rows are composite `(shop_id, id)` foreign keys, so the database itself refuses a link from one shop's row to another's.
- **Money is whole cents.** Customer price = partner charge + shop fee (default $20).
- **The audit log is append-only.** The database rejects edits and deletes.
- **Permissions:** owners can do everything. Staff do day-to-day work. Recording a partner payout needs an owner or the payout permission (Carolyn at MOKU).

## Layout

| Path | What it is |
| --- | --- |
| `migrations/` | Numbered SQL files, applied once each, in order |
| `src/db.js` | Open, migrate, transactions |
| `src/shops.js` | Shops, settings, per-shop job numbers (continue after the highest imported job: `MOKU-0186`) |
| `src/staff.js` | Staff, permissions, hashed quick-PIN sign-in |
| `src/partners.js` | Repair partners (Keith) |
| `src/audit.js` | Append-only audit log |
| `src/money.js`, `src/phone.js` | Cents and US phone helpers |
| `src/pricing.js` | Customer price (agreed price, else Keith charge + fee), payments, call log |
| `src/import.js` | Import the Moku Ding Repair Repairs CSV: preview, then all-or-nothing apply |
| `src/records.js` | Archive search, short (13-column) and full (42-column) CSV export |
| `src/csv.js` | CSV read/write; exports can't carry spreadsheet formulas |
| `scripts/seed-moku.js` | One-time MOKU setup; defaults to the dev store |

## Replacing the Numbers tracker

The Repair Desk is the single source of truth. The **Moku Ding Repair** sheet (Repairs table, exported as CSV) is imported once:

- **Active jobs** (Received, With Keith, In repair, Awaiting approval, Back at Moku, Customer notified) become live tickets with their dates, notes, contact log and payments. Review notes are kept and flagged.
- **Completed, Cancelled and Legacy review jobs** go into a read-only archive, every column exactly as written. Staff can search it; it never appears on the counter screen or in active reports.
- **Duplicates:** the same file is refused the second time. A job number already in the app is skipped if identical and reported if different, never overwritten. Any error or conflict means nothing is imported.
- **Money:** unknown prices stay unknown, never $0. The import reports totals; for the Oct 16, 2026 export they are $17,780.00 charged, $15,270.00 received, $1,595.00 customer balances, $3,410.00 gross margin, and the export reproduces them.
- **Job numbers** continue after the highest imported job (MOKU-0186) and never reuse an archived number.
- **Persistence:** one SQLite file on a Fly volume (survives deploys and updates). Before any new migration runs, a full copy is written next to it (newest 5 kept). Continuous off-site backup is set up with the deployment.

Real customer data is never committed to this repository; tests use invented rows shaped like the export.

## Commands

```
npm test
node --no-warnings scripts/seed-moku.js data/dev.sqlite "Tom Gleason"
```

## Plan

| Phase | Delivers | Status |
| --- | --- | --- |
| 1. Foundation | Shops, staff, roles, partners, settings, audit log | Done |
| 2. Intake | Customer lookup, ticket, QR label with safe retry/reprint | In progress |
| 3. Repair work | Inspection, Keith's charge, fee, custody events, call log | |
| 4. Pickup | Shopify POS tile: scan the QR label, add the repair to the cart with the job number attached; sale matched to the job; completion on handoff | |
| 5. Ledger and reports | Keith payable, payouts, dashboard, spreadsheet export; Repair tickets panel in Shopify admin | |
| 6. Import and go-live | 40 spreadsheet jobs, then live | |
