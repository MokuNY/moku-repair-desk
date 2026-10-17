-- 002 Intake: customers, tickets, ticket timeline, label prints.

-- Shopify is the source of truth for customers. We keep the Shopify ID plus a
-- snapshot of name and phone as they were at intake, so a ticket still reads
-- correctly if the customer is later edited or deleted in Shopify.
CREATE TABLE customers (
  id                     INTEGER PRIMARY KEY,
  shop_id                INTEGER NOT NULL REFERENCES shops (id),
  shopify_customer_gid   TEXT,                           -- NULL only for imported history not yet matched
  display_name           TEXT    NOT NULL,
  first_name             TEXT,
  last_name              TEXT,
  phone_e164             TEXT,
  email                  TEXT,
  created_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, shopify_customer_gid)
);
CREATE INDEX customers_by_phone ON customers (shop_id, phone_e164);

-- Status flow (custody):
--   received -> inspected -> awaiting_approval -> at_partner -> back_from_partner
--   -> ready_for_pickup -> completed            (cancelled from any open state)
-- 'completed' is only reached by handing the board to the customer.
CREATE TABLE tickets (
  id                     INTEGER PRIMARY KEY,
  shop_id                INTEGER NOT NULL REFERENCES shops (id),
  job_number             TEXT    NOT NULL,
  customer_id            INTEGER NOT NULL,
  board_description      TEXT    NOT NULL,
  repair_requested       TEXT    NOT NULL,
  status                 TEXT    NOT NULL DEFAULT 'received' CHECK (status IN (
                           'received', 'inspected', 'awaiting_approval', 'at_partner',
                           'back_from_partner', 'ready_for_pickup', 'completed', 'cancelled')),
  partner_id             INTEGER,
  partner_charge_cents   INTEGER CHECK (partner_charge_cents IS NULL OR partner_charge_cents >= 0),
  shop_fee_cents         INTEGER NOT NULL CHECK (shop_fee_cents >= 0),
  notes                  TEXT    NOT NULL DEFAULT '',
  received_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at           TEXT,
  created_by             INTEGER NOT NULL,
  intake_request_id      TEXT    NOT NULL,                -- iPad-generated; a resubmitted form never makes a 2nd ticket
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, job_number),
  UNIQUE (shop_id, intake_request_id),
  FOREIGN KEY (shop_id, customer_id) REFERENCES customers (shop_id, id),
  FOREIGN KEY (shop_id, partner_id)  REFERENCES repair_partners (shop_id, id),
  FOREIGN KEY (shop_id, created_by)  REFERENCES staff (shop_id, id)
);
CREATE INDEX tickets_open ON tickets (shop_id, status, received_at);

-- Timeline of everything that happens to a ticket. Append-only.
CREATE TABLE ticket_events (
  id          INTEGER PRIMARY KEY,
  shop_id     INTEGER NOT NULL,
  ticket_id   INTEGER NOT NULL,
  staff_id    INTEGER,
  kind        TEXT    NOT NULL,          -- 'status', 'note', 'price', 'label', ...
  from_status TEXT,
  to_status   TEXT,
  detail      TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (shop_id, ticket_id) REFERENCES tickets (shop_id, id),
  FOREIGN KEY (shop_id, staff_id)  REFERENCES staff (shop_id, id)
);
CREATE INDEX ticket_events_by_ticket ON ticket_events (shop_id, ticket_id, id);
CREATE TRIGGER ticket_events_no_update BEFORE UPDATE ON ticket_events
BEGIN SELECT RAISE(ABORT, 'ticket_events is append-only'); END;
CREATE TRIGGER ticket_events_no_delete BEFORE DELETE ON ticket_events
BEGIN SELECT RAISE(ABORT, 'ticket_events is append-only'); END;

-- One row per label print request. The idempotency key makes a double tap or
-- a network retry print once. A reprint is a new row with kind = 'reprint'.
CREATE TABLE label_prints (
  id               INTEGER PRIMARY KEY,
  shop_id          INTEGER NOT NULL,
  ticket_id        INTEGER NOT NULL,
  idempotency_key  TEXT    NOT NULL,
  kind             TEXT    NOT NULL CHECK (kind IN ('intake', 'reprint')),
  status           TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  printer_name     TEXT,
  requested_by     INTEGER NOT NULL,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (shop_id, idempotency_key),
  FOREIGN KEY (shop_id, ticket_id)    REFERENCES tickets (shop_id, id),
  FOREIGN KEY (shop_id, requested_by) REFERENCES staff (shop_id, id)
);
CREATE INDEX label_prints_by_ticket ON label_prints (shop_id, ticket_id, id);
