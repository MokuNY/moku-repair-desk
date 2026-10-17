-- 001 Foundation: shops, staff, repair partners, append-only audit log.
--
-- Tenant rule: every table carries shop_id, and every reference between
-- shop-owned rows is a composite (shop_id, id) foreign key. A row in one shop
-- can therefore never point at a row in another shop, even through a bug.
-- Money is stored in whole cents (INTEGER). Times are ISO-8601 UTC text.

CREATE TABLE shops (
  id                       INTEGER PRIMARY KEY,
  name                     TEXT    NOT NULL,
  shopify_domain           TEXT    NOT NULL UNIQUE,      -- e.g. moku-surf-shop-ny.myshopify.com
  timezone                 TEXT    NOT NULL DEFAULT 'America/New_York',
  job_prefix               TEXT    NOT NULL CHECK (job_prefix GLOB '[A-Z]*' AND length(job_prefix) BETWEEN 2 AND 8),
  next_job_number          INTEGER NOT NULL DEFAULT 1 CHECK (next_job_number >= 1),
  default_shop_fee_cents   INTEGER NOT NULL DEFAULT 2000 CHECK (default_shop_fee_cents >= 0),
  ding_repair_product_gid  TEXT,                         -- Shopify product used at POS
  ding_repair_variant_gid  TEXT,
  default_partner_id       INTEGER,                      -- set after the partner row exists
  created_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (id, default_partner_id) REFERENCES repair_partners (shop_id, id)
);

CREATE TABLE repair_partners (
  id          INTEGER PRIMARY KEY,
  shop_id     INTEGER NOT NULL REFERENCES shops (id),
  name        TEXT    NOT NULL,
  phone       TEXT,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, name)
);

-- Roles: owner (everything), staff (day-to-day work).
-- can_record_payouts is separate from role: at MOKU, Carolyn records Keith payouts.
CREATE TABLE staff (
  id                  INTEGER PRIMARY KEY,
  shop_id             INTEGER NOT NULL REFERENCES shops (id),
  name                TEXT    NOT NULL,
  email               TEXT,
  role                TEXT    NOT NULL DEFAULT 'staff' CHECK (role IN ('owner', 'staff')),
  can_record_payouts  INTEGER NOT NULL DEFAULT 0 CHECK (can_record_payouts IN (0, 1)),
  pin_hash            TEXT,                              -- scrypt hash of the shared-iPad quick PIN
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, name)
);

-- Who did what, when. Rows can be added, never changed or removed.
CREATE TABLE audit_events (
  id           INTEGER PRIMARY KEY,
  shop_id      INTEGER NOT NULL REFERENCES shops (id),
  staff_id     INTEGER,                                  -- NULL = system (webhook, import)
  action       TEXT    NOT NULL,                         -- e.g. 'shop.settings_changed'
  entity_type  TEXT    NOT NULL,
  entity_id    INTEGER,
  detail       TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (shop_id, staff_id) REFERENCES staff (shop_id, id)
);
CREATE INDEX audit_events_by_entity ON audit_events (shop_id, entity_type, entity_id, id);

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
