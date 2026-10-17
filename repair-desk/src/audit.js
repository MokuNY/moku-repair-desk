// Append-only audit log. The database refuses updates and deletes (triggers).

export function recordEvent(db, shopId, { staffId = null, action, entityType, entityId = null, detail = {} }) {
  if (!action || !entityType) throw new TypeError('action and entityType are required');
  const r = db
    .prepare(
      `INSERT INTO audit_events (shop_id, staff_id, action, entity_type, entity_id, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(shopId, staffId, action, entityType, entityId, JSON.stringify(detail));
  return Number(r.lastInsertRowid);
}

export function listEvents(db, shopId, { entityType, entityId } = {}) {
  const rows = entityType
    ? db
        .prepare(
          `SELECT * FROM audit_events WHERE shop_id = ? AND entity_type = ? AND entity_id IS ? ORDER BY id`,
        )
        .all(shopId, entityType, entityId ?? null)
    : db.prepare('SELECT * FROM audit_events WHERE shop_id = ? ORDER BY id').all(shopId);
  return rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
}
