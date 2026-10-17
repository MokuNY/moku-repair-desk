// Repair tickets: intake, status (custody) changes, timeline.

import { tx } from './db.js';
import { recordEvent } from './audit.js';
import { takeJobNumber, getShop, PermissionError } from './shops.js';
import { requirePermission } from './staff.js';
import { normalizeUsPhone } from './phone.js';

/** Allowed status moves. 'completed' has its own function: handOver(). */
export const TRANSITIONS = {
  received: ['inspected', 'awaiting_approval', 'at_partner', 'cancelled'],
  inspected: ['awaiting_approval', 'at_partner', 'ready_for_pickup', 'cancelled'],
  awaiting_approval: ['at_partner', 'ready_for_pickup', 'cancelled'],
  at_partner: ['back_from_partner'],
  back_from_partner: ['ready_for_pickup', 'at_partner'],
  ready_for_pickup: ['at_partner'], // sent back for more work
  completed: [],
  cancelled: [],
};

export const STATUS_LABELS = {
  received: 'Dropped off',
  inspected: 'Inspected',
  awaiting_approval: 'Waiting on customer OK',
  at_partner: 'With partner',
  back_from_partner: 'Back from partner',
  ready_for_pickup: 'Ready for pickup',
  completed: 'Picked up',
  cancelled: 'Cancelled',
};

/**
 * Save (or refresh) the local snapshot of a Shopify customer.
 * @returns customer row
 */
export function upsertCustomer(db, shopId, c) {
  if (!c?.shopifyCustomerGid) throw new RangeError('A Shopify customer is required');
  const phone = c.phoneE164 ? normalizeUsPhone(c.phoneE164) : null;
  db.prepare(
    `INSERT INTO customers (shop_id, shopify_customer_gid, display_name, first_name, last_name, phone_e164, email)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (shop_id, shopify_customer_gid) DO UPDATE SET
       display_name = excluded.display_name, first_name = excluded.first_name, last_name = excluded.last_name,
       phone_e164 = excluded.phone_e164, email = excluded.email,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(shopId, c.shopifyCustomerGid, c.displayName, c.firstName ?? null, c.lastName ?? null, phone, c.email ?? null);
  return db.prepare('SELECT * FROM customers WHERE shop_id = ? AND shopify_customer_gid = ?').get(shopId, c.shopifyCustomerGid);
}

/**
 * Check in a board. Safe to call twice with the same requestId (a double tap or
 * a retried request): the second call returns the first ticket unchanged.
 * @returns {{ ticket: object, created: boolean }}
 */
export function createTicket(db, shopId, actor, { requestId, customer, boardDescription, repairRequested, notes = '' }) {
  if (actor?.shop_id !== shopId) throw new PermissionError('Not allowed: ticket.create');
  requirePermission(actor, 'ticket.create');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(requestId || '')) throw new RangeError('requestId must be 16–64 letters, digits, _ or -');
  const board = clean(boardDescription, 200);
  const repair = clean(repairRequested, 1000);
  if (!board) throw new RangeError('Describe the board (e.g. 9\'0" Fish Stix)');
  if (!repair) throw new RangeError('Describe the repair needed');

  return tx(db, () => {
    const existing = db.prepare('SELECT * FROM tickets WHERE shop_id = ? AND intake_request_id = ?').get(shopId, requestId);
    if (existing) return { ticket: existing, created: false };

    const shop = getShop(db, shopId);
    const cust = upsertCustomer(db, shopId, customer);
    const jobNumber = takeJobNumber(db, shopId);
    const r = db
      .prepare(
        `INSERT INTO tickets (shop_id, job_number, customer_id, board_description, repair_requested,
                              partner_id, shop_fee_cents, notes, created_by, intake_request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(shopId, jobNumber, cust.id, board, repair, shop.default_partner_id, shop.default_shop_fee_cents, clean(notes, 2000), actor.id, requestId);
    const id = Number(r.lastInsertRowid);
    addEvent(db, shopId, id, actor.id, { kind: 'status', toStatus: 'received', detail: { jobNumber } });
    recordEvent(db, shopId, { staffId: actor.id, action: 'ticket.created', entityType: 'ticket', entityId: id, detail: { jobNumber } });
    return { ticket: getTicket(db, shopId, id), created: true };
  });
}

/** Move a ticket to another status (not 'completed': see handOver). */
export function changeStatus(db, shopId, actor, ticketId, toStatus, { note } = {}) {
  if (actor?.shop_id !== shopId) throw new PermissionError('Not allowed: ticket.update');
  requirePermission(actor, 'ticket.update');
  if (toStatus === 'completed') throw new RangeError('Use handOver() to complete a ticket: it needs the board in the customer\'s hands');
  return tx(db, () => {
    const t = mustGet(db, shopId, ticketId);
    if (!TRANSITIONS[t.status]?.includes(toStatus)) {
      throw new RangeError(`Can't go from "${STATUS_LABELS[t.status]}" to "${STATUS_LABELS[toStatus] ?? toStatus}"`);
    }
    db.prepare('UPDATE tickets SET status = ? WHERE shop_id = ? AND id = ?').run(toStatus, shopId, ticketId);
    addEvent(db, shopId, ticketId, actor.id, { kind: 'status', fromStatus: t.status, toStatus, detail: note ? { note: clean(note, 500) } : {} });
    return getTicket(db, shopId, ticketId);
  });
}

/**
 * The board is physically handed to the customer. Only from "Ready for pickup".
 * Payment rules are added in phase 4.
 */
export function handOver(db, shopId, actor, ticketId) {
  if (actor?.shop_id !== shopId) throw new PermissionError('Not allowed: ticket.complete');
  requirePermission(actor, 'ticket.complete');
  return tx(db, () => {
    const t = mustGet(db, shopId, ticketId);
    if (t.status !== 'ready_for_pickup') throw new RangeError(`Only a board that is ready for pickup can be handed over (this one is "${STATUS_LABELS[t.status]}")`);
    db.prepare(`UPDATE tickets SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE shop_id = ? AND id = ?`).run(shopId, ticketId);
    addEvent(db, shopId, ticketId, actor.id, { kind: 'status', fromStatus: t.status, toStatus: 'completed', detail: { handedTo: 'customer' } });
    return getTicket(db, shopId, ticketId);
  });
}

export function getTicket(db, shopId, ticketId) {
  return db.prepare('SELECT * FROM tickets WHERE shop_id = ? AND id = ?').get(shopId, ticketId) ?? null;
}

export function getTicketByJobNumber(db, shopId, jobNumber) {
  return db.prepare('SELECT * FROM tickets WHERE shop_id = ? AND job_number = ?').get(shopId, String(jobNumber).toUpperCase()) ?? null;
}

/** Everything a ticket screen or label needs, in one read. */
export function ticketView(db, shopId, ticketId) {
  const t = getTicket(db, shopId, ticketId);
  if (!t) return null;
  const customer = db.prepare('SELECT * FROM customers WHERE shop_id = ? AND id = ?').get(shopId, t.customer_id);
  const partner = t.partner_id ? db.prepare('SELECT * FROM repair_partners WHERE shop_id = ? AND id = ?').get(shopId, t.partner_id) : null;
  const events = db
    .prepare('SELECT * FROM ticket_events WHERE shop_id = ? AND ticket_id = ? ORDER BY id')
    .all(shopId, ticketId)
    .map((e) => ({ ...e, detail: JSON.parse(e.detail) }));
  return { ticket: t, customer, partner, events, statusLabel: STATUS_LABELS[t.status] };
}

export function listOpenTickets(db, shopId) {
  return db
    .prepare(
      `SELECT t.*, c.display_name AS customer_name, c.phone_e164 AS customer_phone
       FROM tickets t JOIN customers c ON c.shop_id = t.shop_id AND c.id = t.customer_id
       WHERE t.shop_id = ? AND t.status NOT IN ('completed', 'cancelled')
       ORDER BY t.received_at, t.id`,
    )
    .all(shopId);
}

export function addEvent(db, shopId, ticketId, staffId, { kind, fromStatus = null, toStatus = null, detail = {} }) {
  db.prepare(
    `INSERT INTO ticket_events (shop_id, ticket_id, staff_id, kind, from_status, to_status, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(shopId, ticketId, staffId, kind, fromStatus, toStatus, JSON.stringify(detail));
}

function mustGet(db, shopId, ticketId) {
  const t = getTicket(db, shopId, ticketId);
  if (!t) throw new RangeError('No such ticket in this shop');
  return t;
}

function clean(s, max) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
