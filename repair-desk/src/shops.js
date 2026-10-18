// Shops (tenants), their settings, and per-shop job numbers.

import { tx } from './db.js';
import { recordEvent } from './audit.js';

const DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function createShop(db, { name, shopifyDomain, jobPrefix, nextJobNumber = 1, timezone, defaultShopFeeCents }) {
  if (!DOMAIN.test(shopifyDomain || '')) throw new RangeError(`Not a myshopify.com domain: ${shopifyDomain}`);
  return tx(db, () => {
    const r = db
      .prepare(
        `INSERT INTO shops (name, shopify_domain, job_prefix, next_job_number, timezone, default_shop_fee_cents)
         VALUES (?, ?, ?, ?, COALESCE(?, 'America/New_York'), COALESCE(?, 2000))`,
      )
      .run(name, shopifyDomain, jobPrefix, nextJobNumber, timezone ?? null, defaultShopFeeCents ?? null);
    const id = Number(r.lastInsertRowid);
    recordEvent(db, id, { action: 'shop.created', entityType: 'shop', entityId: id, detail: { name, shopifyDomain } });
    return getShop(db, id);
  });
}

export function getShop(db, shopId) {
  return db.prepare('SELECT * FROM shops WHERE id = ?').get(shopId) ?? null;
}

export function getShopByDomain(db, shopifyDomain) {
  return db.prepare('SELECT * FROM shops WHERE shopify_domain = ?').get(shopifyDomain) ?? null;
}

const EDITABLE = {
  defaultShopFeeCents: 'default_shop_fee_cents',
  dingRepairProductGid: 'ding_repair_product_gid',
  dingRepairVariantGid: 'ding_repair_variant_gid',
  defaultPartnerId: 'default_partner_id',
  timezone: 'timezone',
};

/** Change shop settings. Only an owner may do this; every change is audited. */
export function updateShopSettings(db, shopId, actor, changes) {
  if (actor?.shop_id !== shopId || actor.role !== 'owner') throw new PermissionError('Only an owner can change shop settings');
  const cols = Object.keys(changes).map((k) => {
    if (!EDITABLE[k]) throw new RangeError(`Not an editable setting: ${k}`);
    return k;
  });
  if (!cols.length) return getShop(db, shopId);
  return tx(db, () => {
    const before = getShop(db, shopId);
    const sets = cols.map((k) => `${EDITABLE[k]} = ?`).join(', ');
    db.prepare(`UPDATE shops SET ${sets} WHERE id = ?`).run(...cols.map((k) => changes[k]), shopId);
    const after = getShop(db, shopId);
    const diff = Object.fromEntries(cols.map((k) => [k, { from: before[EDITABLE[k]], to: after[EDITABLE[k]] }]));
    recordEvent(db, shopId, { staffId: actor.id, action: 'shop.settings_changed', entityType: 'shop', entityId: shopId, detail: diff });
    return after;
  });
}

/**
 * Take the next job number for a shop, e.g. "MOKU-0041". Atomic: two iPads
 * taking numbers at the same moment never get the same one.
 * Call inside the transaction that creates the ticket.
 */
export function takeJobNumber(db, shopId) {
  const take = db.prepare('UPDATE shops SET next_job_number = next_job_number + 1 WHERE id = ? RETURNING job_prefix, next_job_number - 1 AS n');
  const used = db.prepare(
    'SELECT 1 FROM archived_repairs WHERE shop_id = ? AND job_number = ? UNION ALL SELECT 1 FROM tickets WHERE shop_id = ? AND job_number = ?',
  );
  // Never hand out a number that already belongs to an archived or imported job.
  for (let i = 0; i < 10_000; i++) {
    const row = take.get(shopId);
    if (!row) throw new RangeError(`No shop ${shopId}`);
    const job = `${row.job_prefix}-${String(row.n).padStart(4, '0')}`;
    if (!used.get(shopId, job, shopId, job)) return job;
  }
  throw new RangeError('Could not find a free job number');
}

export class PermissionError extends Error {}
