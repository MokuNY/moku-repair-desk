// Requests from the Shopify POS extension.
//
// The extension sends `Authorization: Bearer <session token>`. The token is an
// HS256 JWT signed with the app's client secret: checking the signature, the
// audience (our client ID), the time window and the shop proves the request
// comes from this app running in this shop's POS. The pinned-in staff member is
// sent alongside (X-Pos-Staff-Member) and used to say who did what; it is
// linked once to a Repair Desk staff record.

import crypto from 'node:crypto';
import { recordEvent } from './audit.js';
import { getStaff, listStaff } from './staff.js';

const LEEWAY_S = 10;

export class PosAuthError extends Error {
  constructor(message) {
    super(message);
    this.status = 401;
  }
}

/** @returns {{ shopDomain: string, userId: string|null }} */
export function verifyPosToken(header, { clientId, clientSecret, shopDomain, now = () => Date.now() }) {
  const m = /^Bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(header || '');
  if (!m) throw new PosAuthError('Missing POS session token');
  if (!clientId || !clientSecret) throw new PosAuthError('POS sign-in is not set up on this server');
  const [, h, p, sig] = m;
  const head = json(h);
  if (head?.alg !== 'HS256') throw new PosAuthError('Unexpected token algorithm');
  const want = crypto.createHmac('sha256', clientSecret).update(`${h}.${p}`).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new PosAuthError('Bad token signature');
  const c = json(p);
  if (!c) throw new PosAuthError('Unreadable token');
  const t = Math.floor(now() / 1000);
  if (!c.exp || t > c.exp + LEEWAY_S) throw new PosAuthError('Token expired');
  if (c.nbf && t < c.nbf - LEEWAY_S) throw new PosAuthError('Token not yet valid');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(clientId)) throw new PosAuthError('Token is for another app');
  let dest;
  try {
    dest = new URL(String(c.dest).startsWith('http') ? c.dest : `https://${c.dest}`).hostname;
  } catch {
    throw new PosAuthError('Token has no shop');
  }
  if (dest !== shopDomain) throw new PosAuthError('Token is for another shop');
  return { shopDomain: dest, userId: c.sub ? String(c.sub) : null };
}

/** The Repair Desk staff record linked to a POS staff member, or null. */
export function staffForPosMember(db, shopId, memberId) {
  const id = normalizeMember(memberId);
  if (!id) return null;
  return db.prepare('SELECT * FROM staff WHERE shop_id = ? AND shopify_staff_member_id = ?').get(shopId, id) ?? null;
}

/** Staff who aren't linked to a POS account yet (offered on first use). */
export function unlinkedStaff(db, shopId) {
  return listStaff(db, shopId).filter((s) => s.active === 1 && !s.shopify_staff_member_id).map((s) => ({ id: s.id, name: s.name }));
}

/**
 * First time a POS staff member opens the Repair Desk, they pick their name.
 * A name already linked to someone else can't be taken; an owner can undo a link.
 */
export function linkPosMember(db, shopId, memberId, staffId) {
  const id = normalizeMember(memberId);
  if (!id) throw new RangeError('POS did not say who is pinned in');
  if (staffForPosMember(db, shopId, id)) throw new RangeError('This POS staff member is already linked');
  const s = getStaff(db, shopId, Number(staffId));
  if (!s || s.active !== 1) throw new RangeError('Pick your name');
  if (s.shopify_staff_member_id) throw new RangeError(`${s.name} is already linked to another POS account. Ask Tom to reset it.`);
  db.prepare('UPDATE staff SET shopify_staff_member_id = ? WHERE shop_id = ? AND id = ?').run(id, shopId, s.id);
  recordEvent(db, shopId, { staffId: s.id, action: 'staff.pos_linked', entityType: 'staff', entityId: s.id, detail: { posStaffMemberId: id } });
  return getStaff(db, shopId, s.id);
}

/** Owner: undo a link (wrong name picked, or staff changes). */
export function unlinkPosMember(db, shopId, owner, staffId) {
  if (owner?.shop_id !== shopId || owner.role !== 'owner') throw Object.assign(new Error('Only an owner can reset a POS link'), { status: 403 });
  db.prepare('UPDATE staff SET shopify_staff_member_id = NULL WHERE shop_id = ? AND id = ?').run(shopId, Number(staffId));
  recordEvent(db, shopId, { staffId: owner.id, action: 'staff.pos_unlinked', entityType: 'staff', entityId: Number(staffId) });
}

/** A POS staff member undoes their own link (picked the wrong name). */
export function unlinkSelf(db, shopId, me) {
  db.prepare('UPDATE staff SET shopify_staff_member_id = NULL WHERE shop_id = ? AND id = ?').run(shopId, me.id);
  recordEvent(db, shopId, { staffId: me.id, action: 'staff.pos_unlinked_self', entityType: 'staff', entityId: me.id });
}

function normalizeMember(v) {
  const s = String(v ?? '').trim().replace(/^gid:\/\/shopify\/StaffMember\//, '');
  return /^\d{1,20}$/.test(s) ? s : null;
}

function json(s) {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
