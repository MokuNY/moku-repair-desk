-- 003 Records: replaces the Numbers tracker. Additive only: no existing
-- column or row is changed.

-- Live tickets: agreed price, where a ticket came from, review flag.
ALTER TABLE tickets ADD COLUMN agreed_price_cents INTEGER CHECK (agreed_price_cents IS NULL OR agreed_price_cents >= 0);
ALTER TABLE tickets ADD COLUMN source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'import'));
ALTER TABLE tickets ADD COLUMN accepted_by_text TEXT;           -- imported "Accepted by" initials
ALTER TABLE tickets ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1));
ALTER TABLE tickets ADD COLUMN review_note TEXT;
ALTER TABLE tickets ADD COLUMN import_batch_id INTEGER;

-- Each spreadsheet import. The file fingerprint makes the same file importable once.
CREATE TABLE import_batches (
  id              INTEGER PRIMARY KEY,
  shop_id         INTEGER NOT NULL REFERENCES shops (id),
  file_sha256     TEXT    NOT NULL,
  file_name       TEXT    NOT NULL,
  format          TEXT    NOT NULL,                      -- 'moku-ding-repair-v1'
  imported_by     INTEGER NOT NULL,
  row_count       INTEGER NOT NULL,
  active_count    INTEGER NOT NULL,
  archived_count  INTEGER NOT NULL,
  totals          TEXT    NOT NULL CHECK (json_valid(totals)),
  evidence        TEXT,                                  -- original "Source snapshot" CSV, kept verbatim
  imported_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, file_sha256),
  FOREIGN KEY (shop_id, imported_by) REFERENCES staff (shop_id, id)
);

-- Finished and legacy jobs from the old tracker. Read-only: kept exactly as
-- they were in the sheet (every column in `raw`), plus a few fields for search.
CREATE TABLE archived_repairs (
  id                    INTEGER PRIMARY KEY,
  shop_id               INTEGER NOT NULL REFERENCES shops (id),
  import_batch_id       INTEGER NOT NULL,
  job_number            TEXT    NOT NULL,
  customer_name         TEXT    NOT NULL DEFAULT '',
  phone_e164            TEXT,
  board                 TEXT    NOT NULL DEFAULT '',
  repair                TEXT    NOT NULL DEFAULT '',
  status                TEXT    NOT NULL,                -- as in the sheet: Completed, Legacy review, ...
  received_on           TEXT,                            -- YYYY-MM-DD or NULL
  picked_up_on          TEXT,
  customer_price_cents  INTEGER,                         -- NULL = unknown, never treated as 0
  paid_cents            INTEGER,
  keith_cost_cents      INTEGER,
  raw                   TEXT    NOT NULL CHECK (json_valid(raw)),
  search_text           TEXT    NOT NULL,                -- lower-case name, phone digits, board, repair, job
  UNIQUE (shop_id, job_number),
  FOREIGN KEY (shop_id, import_batch_id) REFERENCES import_batches (shop_id, id)
);
CREATE INDEX archived_repairs_by_phone ON archived_repairs (shop_id, phone_e164);
CREATE TRIGGER archived_repairs_no_update BEFORE UPDATE ON archived_repairs
BEGIN SELECT RAISE(ABORT, 'archived_repairs is read-only'); END;
CREATE TRIGGER archived_repairs_no_delete BEFORE DELETE ON archived_repairs
BEGIN SELECT RAISE(ABORT, 'archived_repairs is read-only'); END;

-- Phone calls and texts about a ticket.
CREATE TABLE call_logs (
  id          INTEGER PRIMARY KEY,
  shop_id     INTEGER NOT NULL,
  ticket_id   INTEGER NOT NULL,
  staff_id    INTEGER,                                   -- NULL = imported
  outcome     TEXT    NOT NULL CHECK (outcome IN ('left_message', 'spoke', 'texted', 'no_answer', 'note')),
  note        TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (shop_id, ticket_id) REFERENCES tickets (shop_id, id),
  FOREIGN KEY (shop_id, staff_id)  REFERENCES staff (shop_id, id)
);
CREATE INDEX call_logs_by_ticket ON call_logs (shop_id, ticket_id, id);

-- Customer payments toward a ticket (more than one allowed: deposits).
CREATE TABLE payments (
  id             INTEGER PRIMARY KEY,
  shop_id        INTEGER NOT NULL,
  ticket_id      INTEGER NOT NULL,
  amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
  method         TEXT    NOT NULL CHECK (method IN ('cash', 'card', 'other')),
  pos_order_gid  TEXT,                                   -- Shopify order, when matched (phase 4)
  recorded_by    INTEGER,
  note           TEXT    NOT NULL DEFAULT '',
  received_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (shop_id, ticket_id)   REFERENCES tickets (shop_id, id),
  FOREIGN KEY (shop_id, recorded_by) REFERENCES staff (shop_id, id)
);
CREATE INDEX payments_by_ticket ON payments (shop_id, ticket_id);
CREATE TRIGGER payments_no_update BEFORE UPDATE ON payments
BEGIN SELECT RAISE(ABORT, 'payments are append-only; record a correction instead'); END;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
BEGIN SELECT RAISE(ABORT, 'payments are append-only; record a correction instead'); END;
