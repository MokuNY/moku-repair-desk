// Repair partners: outside repairers a shop sends boards to (Keith for MOKU).

import { tx } from './db.js';
import { recordEvent } from './audit.js';
import { requirePermission } from './staff.js';
import { PermissionError } from './shops.js';

export function createPartner(db, shopId, actor, { name, phone = null }) {
  if (actor?.shop_id !== shopId) throw new PermissionError('Not allowed: settings.manage');
  requirePermission(actor, 'settings.manage');
  return tx(db, () => {
    const r = db.prepare('INSERT INTO repair_partners (shop_id, name, phone) VALUES (?, ?, ?)').run(shopId, name, phone);
    const id = Number(r.lastInsertRowid);
    recordEvent(db, shopId, { staffId: actor.id, action: 'partner.created', entityType: 'partner', entityId: id, detail: { name } });
    return getPartner(db, shopId, id);
  });
}

export function getPartner(db, shopId, partnerId) {
  return db.prepare('SELECT * FROM repair_partners WHERE shop_id = ? AND id = ?').get(shopId, partnerId) ?? null;
}

export function listPartners(db, shopId, { activeOnly = true } = {}) {
  return db
    .prepare(`SELECT * FROM repair_partners WHERE shop_id = ? ${activeOnly ? 'AND active = 1' : ''} ORDER BY name`)
    .all(shopId);
}
