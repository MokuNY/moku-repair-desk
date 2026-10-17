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
| `src/shops.js` | Shops, settings, per-shop job numbers (`MOKU-0041`…) |
| `src/staff.js` | Staff, permissions, hashed quick-PIN sign-in |
| `src/partners.js` | Repair partners (Keith) |
| `src/audit.js` | Append-only audit log |
| `src/money.js`, `src/phone.js` | Cents and US phone helpers |
| `scripts/seed-moku.js` | One-time MOKU setup; defaults to the dev store |

## Commands

```
npm test
node --no-warnings scripts/seed-moku.js data/dev.sqlite "Tom Gleason"
```

## Plan

| Phase | Delivers | Status |
| --- | --- | --- |
| 1. Foundation | Shops, staff, roles, partners, settings, audit log | In progress |
| 2. Intake | Customer lookup, ticket, QR label with safe retry/reprint | Next |
| 3. Repair work | Inspection, Keith's charge, fee, custody events, call log | |
| 4. Pickup | Ding Repair POS sale matched to the job, completion on handoff | |
| 5. Ledger and reports | Keith payable, payouts, dashboard, spreadsheet export | |
| 6. Import and go-live | 40 spreadsheet jobs, then live | |
