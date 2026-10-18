// Ticket money: Keith's charge, the shop fee, an agreed price, payments.
//
// Customer price = agreed price when set, otherwise partner charge + shop fee.
// While Keith's charge is unknown the price is unknown (null), never $0 or
// just the fee. This is the same rule the Moku Ding Repair sheet used.

import { tx } from './db.js';
import { addEvent, getTicket } from './tickets.js';
import { recordEvent } from './audit.js';
import { requirePermission } from './staff.js';
import { PermissionError } from './shops.js';

/** @returns {number|null} cents */
export function customerPrice(t) {
  if (t.agreed_price_cents !== null && t.agreed_price_cents !== undefined) return t.agreed_price_cents;
  if (t.partner_charge_cents === null || t.partner_charge_cents === undefined) return null;
  return t.partner_charge_cents + t.shop_fee_cents;
}

export function paidCents(db, shopId, ticketId) {
  return db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS c FROM payments WHERE shop_id = ? AND ticket_id = ?').get(shopId, ticketId).c;
}

/** Price, paid, balance and a one-word payment status for a ticket. */
export function money(db, shopId, ticketId) {
  const t = getTicket(db, shopId, ticketId);
  if (!t) throw new RangeError('No such ticket in this shop');
  const price = customerPrice(t);
  const paid = paidCents(db, shopId, ticketId);
  const balance = price === null ? null : price - paid;
  const status = price === 0 ? 'no_charge' : paid === 0 ? 'unpaid' : balance !== null && balance <= 0 ? 'paid' : 'partial';
  return { price, paid, balance, status, partnerCharge: t.partner_charge_cents, shopFee: t.shop_fee_cents, agreedPrice: t.agreed_price_cents };
}

const FIELDS = {
  partnerChargeCents: 'partner_charge_cents',
  shopFeeCents: 'shop_fee_cents',
  agreedPriceCents: 'agreed_price_cents',
};

/**
 * Set Keith's charge, the shop fee, or an agreed price (null clears it).
 * Any staff member may do this; every change is on the ticket timeline and in the audit log.
 */
export function setPrices(db, shopId, actor, ticketId, changes) {
  if (actor?.shop_id !== shopId) throw new PermissionError('Not allowed: ticket.set_price');
  requirePermission(actor, 'ticket.set_price');
  const keys = Object.keys(changes);
  for (const k of keys) {
    if (!FIELDS[k]) throw new RangeError(`Not a price field: ${k}`);
    const v = changes[k];
    const nullable = k !== 'shopFeeCents';
    if (!(v === null && nullable) && !(Number.isInteger(v) && v >= 0 && v <= 10_000_00)) {
      throw new RangeError('Prices are whole cents between $0 and $10,000');
    }
  }
  return tx(db, () => {
    const before = getTicket(db, shopId, ticketId);
    if (!before) throw new RangeError('No such ticket in this shop');
    if (['completed', 'cancelled'].includes(before.status)) throw new RangeError('This ticket is closed; its price can no longer change');
    if (!keys.length) return before;
    db.prepare(`UPDATE tickets SET ${keys.map((k) => `${FIELDS[k]} = ?`).join(', ')} WHERE shop_id = ? AND id = ?`).run(...keys.map((k) => changes[k]), shopId, ticketId);
    const after = getTicket(db, shopId, ticketId);
    const diff = Object.fromEntries(keys.map((k) => [k, { from: before[FIELDS[k]], to: after[FIELDS[k]] }]));
    addEvent(db, shopId, ticketId, actor.id, { kind: 'price', detail: { ...diff, customerPrice: { from: customerPrice(before), to: customerPrice(after) } } });
    recordEvent(db, shopId, { staffId: actor.id, action: 'ticket.price_changed', entityType: 'ticket', entityId: ticketId, detail: diff });
    return after;
  });
}

/** Record a customer payment (cash by default). Append-only; corrections are new rows. */
export function recordPayment(db, shopId, actor, ticketId, { amountCents, method = 'cash', note = '', posOrderGid = null }) {
  if (actor?.shop_id !== shopId) throw new PermissionError('Not allowed: ticket.update');
  requirePermission(actor, 'ticket.update');
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new RangeError('Payment must be a positive whole number of cents');
  return tx(db, () => {
    if (!getTicket(db, shopId, ticketId)) throw new RangeError('No such ticket in this shop');
    const r = db
      .prepare('INSERT INTO payments (shop_id, ticket_id, amount_cents, method, pos_order_gid, recorded_by, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(shopId, ticketId, amountCents, method, posOrderGid, actor.id, String(note).slice(0, 300));
    addEvent(db, shopId, ticketId, actor.id, { kind: 'payment', detail: { amountCents, method } });
    return Number(r.lastInsertRowid);
  });
}

/** Log a call or text. Outcomes: left_message, spoke, texted, no_answer, note. */
export function logCall(db, shopId, actor, ticketId, { outcome, note = '' }) {
  if (actor?.shop_id !== shopId) throw new PermissionError('Not allowed: ticket.update');
  requirePermission(actor, 'ticket.update');
  return tx(db, () => {
    if (!getTicket(db, shopId, ticketId)) throw new RangeError('No such ticket in this shop');
    const r = db.prepare('INSERT INTO call_logs (shop_id, ticket_id, staff_id, outcome, note) VALUES (?, ?, ?, ?, ?)').run(shopId, ticketId, actor.id, outcome, String(note).slice(0, 500));
    return Number(r.lastInsertRowid);
  });
}
