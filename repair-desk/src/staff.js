// Staff accounts, roles and the shared-iPad quick PIN.

import crypto from 'node:crypto';
import { tx } from './db.js';
import { recordEvent } from './audit.js';
import { PermissionError } from './shops.js';

/** What each kind of staff member may do. */
export const PERMISSIONS = {
  'ticket.create': () => true,
  'ticket.update': () => true,
  'ticket.set_price': () => true, // all staff, per MOKU (Oct 17); every change is audited
  'ticket.complete': () => true,
  'payout.record': (s) => s.role === 'owner' || s.can_record_payouts === 1,
  'staff.manage': (s) => s.role === 'owner',
  'settings.manage': (s) => s.role === 'owner',
  'data.import': (s) => s.role === 'owner',
  'data.export': (s) => s.role === 'owner', // exports include customer phone numbers
  'archive.view': () => true, // look up an old repair at the counter
};

export function can(staff, permission) {
  const rule = PERMISSIONS[permission];
  if (!rule) throw new RangeError(`Unknown permission: ${permission}`);
  return Boolean(staff && staff.active === 1 && rule(staff));
}

export function requirePermission(staff, permission) {
  if (!can(staff, permission)) throw new PermissionError(`Not allowed: ${permission}`);
}

/** Create a staff member. The first staff member of a shop must be an owner. */
export function createStaff(db, shopId, actor, { name, email = null, role = 'staff', canRecordPayouts = false }) {
  return tx(db, () => {
    const count = db.prepare('SELECT COUNT(*) AS n FROM staff WHERE shop_id = ?').get(shopId).n;
    if (count === 0) {
      if (role !== 'owner') throw new RangeError('The first staff member must be an owner');
    } else {
      if (actor?.shop_id !== shopId) throw new PermissionError('Not allowed: staff.manage');
      requirePermission(actor, 'staff.manage');
    }
    const r = db
      .prepare('INSERT INTO staff (shop_id, name, email, role, can_record_payouts) VALUES (?, ?, ?, ?, ?)')
      .run(shopId, name, email, role, canRecordPayouts ? 1 : 0);
    const id = Number(r.lastInsertRowid);
    recordEvent(db, shopId, {
      staffId: count === 0 ? null : actor.id,
      action: 'staff.created',
      entityType: 'staff',
      entityId: id,
      detail: { name, role, canRecordPayouts: Boolean(canRecordPayouts) },
    });
    return getStaff(db, shopId, id);
  });
}

/** Look up staff only within the given shop. */
export function getStaff(db, shopId, staffId) {
  return db.prepare('SELECT * FROM staff WHERE shop_id = ? AND id = ?').get(shopId, staffId) ?? null;
}

export function listStaff(db, shopId) {
  return db.prepare('SELECT * FROM staff WHERE shop_id = ? ORDER BY name').all(shopId);
}

// ------------------------------------------------------------------- PIN

const PIN = /^\d{4,6}$/;

export function hashPin(pin) {
  if (!PIN.test(String(pin))) throw new RangeError('PIN must be 4–6 digits');
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pin), salt, 32);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function checkPin(pin, stored) {
  const [kind, salt, key] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !key || !PIN.test(String(pin))) return false;
  const want = Buffer.from(key, 'base64url');
  const got = crypto.scryptSync(String(pin), Buffer.from(salt, 'base64url'), want.length);
  return crypto.timingSafeEqual(got, want);
}

/** Staff set their own PIN; an owner may reset anyone's. */
export function setPin(db, shopId, actor, staffId, pin) {
  if (actor?.shop_id !== shopId || (actor.id !== staffId && !can(actor, 'staff.manage'))) {
    throw new PermissionError('Not allowed to set this PIN');
  }
  const r = db.prepare('UPDATE staff SET pin_hash = ? WHERE shop_id = ? AND id = ?').run(hashPin(pin), shopId, staffId);
  if (r.changes !== 1) throw new RangeError('No such staff member in this shop');
  recordEvent(db, shopId, { staffId: actor.id, action: 'staff.pin_set', entityType: 'staff', entityId: staffId });
}

/** Quick sign-in on the shared iPad. Returns the staff row or null. */
export function signInWithPin(db, shopId, staffId, pin) {
  const s = getStaff(db, shopId, staffId);
  if (!s || s.active !== 1 || !checkPin(pin, s.pin_hash)) return null;
  return s;
}
