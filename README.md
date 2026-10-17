# MOKU Repair Desk

Private repository for MOKU Surf Shop NY software.

| Folder | What it is | Status |
| --- | --- | --- |
| `label-printer/` | Zebra ZD411 price-label app: Shopify admin extensions + Weblink print server on Fly.io (`moku-labels-b228fd`) | Live in production. Imported as-is on 2026-10-17 |
| `repair-desk/` | Ding repair intake and management app (iPad web app) | Phase 0, in development |

Secrets (Shopify API secret, printer tokens) are never committed. They live in Fly.io secrets.

The audit report and approved plan are in the "MOKU Repair Desk — Audit Report v1" doc.
