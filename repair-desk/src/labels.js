// Repair intake labels: request, send to the label server, record the outcome.
//
// Every request is a label_prints row with its own idempotency key. Sending
// the same row again (a retry after a network drop or a failed print) reuses
// that key, so the label server prints it at most once. A reprint is a new
// row with kind 'reprint': always a deliberate, logged action.

import crypto from 'node:crypto';
import { tx } from './db.js';
import { addEvent, ticketView } from './tickets.js';
import { requirePermission } from './staff.js';
import { PermissionError } from './shops.js';
import { lastFour } from './phone.js';

const MAX_ATTEMPTS = 3;

/** Create the label request for a ticket. Intake labels: one per ticket. */
export function requestLabel(db, shopId, actor, ticketId, { kind = 'intake' } = {}) {
  if (actor?.shop_id !== shopId) throw new PermissionError('Not allowed: ticket.update');
  requirePermission(actor, 'ticket.update');
  if (!['intake', 'reprint'].includes(kind)) throw new RangeError('kind must be intake or reprint');
  return tx(db, () => {
    const t = db.prepare('SELECT id, status FROM tickets WHERE shop_id = ? AND id = ?').get(shopId, ticketId);
    if (!t) throw new RangeError('No such ticket in this shop');
    if (kind === 'intake') {
      const existing = db.prepare(`SELECT * FROM label_prints WHERE shop_id = ? AND ticket_id = ? AND kind = 'intake'`).get(shopId, ticketId);
      if (existing) return existing;
    }
    const key = crypto.randomBytes(18).toString('base64url');
    const r = db
      .prepare(`INSERT INTO label_prints (shop_id, ticket_id, idempotency_key, kind, requested_by) VALUES (?, ?, ?, ?, ?)`)
      .run(shopId, ticketId, key, kind, actor.id);
    const id = Number(r.lastInsertRowid);
    addEvent(db, shopId, ticketId, actor.id, { kind: 'label', detail: { action: kind === 'reprint' ? 'reprint_requested' : 'requested', labelPrintId: id } });
    return getLabelPrint(db, shopId, id);
  });
}

export function getLabelPrint(db, shopId, id) {
  return db.prepare('SELECT * FROM label_prints WHERE shop_id = ? AND id = ?').get(shopId, id) ?? null;
}

/** The fields printed on the label, from the ticket as saved. */
export function labelFields(db, shopId, ticketId, { baseUrl, timezone = 'America/New_York' }) {
  const v = ticketView(db, shopId, ticketId);
  if (!v) throw new RangeError('No such ticket in this shop');
  const c = v.customer;
  const first = c.first_name || c.display_name.split(' ')[0];
  const lastInitial = (c.last_name || c.display_name.split(' ').slice(1).join(' ')).trim().charAt(0);
  return {
    jobNumber: v.ticket.job_number,
    customerName: lastInitial ? `${first} ${lastInitial.toUpperCase()}.` : first,
    board: v.ticket.board_description,
    received: new Date(v.ticket.received_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: timezone }),
    phoneLast4: lastFour(c.phone_e164),
    repair: v.ticket.repair_requested,
    url: `${baseUrl.replace(/\/$/, '')}/t/${encodeURIComponent(v.ticket.job_number)}`,
  };
}

/**
 * Send a label request to the label server and record the result.
 * Safe to call again for the same row: it reuses the row's idempotency key.
 * @param {{ send: (body: object) => Promise<{status:number, body:object}> }} printer  see labelServerClient()
 * @returns the updated label_prints row; status 'sent' or 'failed' (with last_error)
 */
export async function sendLabel(db, shopId, labelPrintId, printer, { baseUrl, timezone, printerName } = {}) {
  const lp = getLabelPrint(db, shopId, labelPrintId);
  if (!lp) throw new RangeError('No such label request in this shop');
  if (lp.status === 'sent') return lp;
  if (lp.attempts >= MAX_ATTEMPTS && lp.status === 'failed') {
    throw new RangeError('This label failed 3 times. Check the printer, then use Reprint.');
  }
  const label = labelFields(db, shopId, lp.ticket_id, { baseUrl, timezone });
  db.prepare(`UPDATE label_prints SET attempts = attempts + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE shop_id = ? AND id = ?`).run(shopId, lp.id);

  let outcome;
  try {
    const { status, body } = await printer.send({ idempotencyKey: lp.idempotency_key, printer: printerName, label });
    outcome = status === 200 && body?.ok
      ? { status: 'sent', error: null, printer: body.printer, warning: body.warning }
      : { status: 'failed', error: body?.error || `Label server answered ${status}` };
  } catch (err) {
    outcome = { status: 'failed', error: `Could not reach the label printer: ${err.message}` };
  }

  tx(db, () => {
    db.prepare(`UPDATE label_prints SET status = ?, last_error = ?, printer_name = COALESCE(?, printer_name), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE shop_id = ? AND id = ?`)
      .run(outcome.status, outcome.error, outcome.printer ?? null, shopId, lp.id);
    addEvent(db, shopId, lp.ticket_id, null, {
      kind: 'label',
      detail: { action: outcome.status, labelPrintId: lp.id, ...(outcome.error ? { error: outcome.error } : {}), ...(outcome.warning ? { warning: outcome.warning } : {}) },
    });
  });
  return { ...getLabelPrint(db, shopId, lp.id), warning: outcome.warning };
}

/** HTTP client for the label server's /api/repair-label route. */
export function labelServerClient({ url, token, fetch: f = fetch, timeoutMs = 20_000 }) {
  if (!/^https?:\/\//.test(url || '') || !token) throw new RangeError('Label server URL and token are required');
  return {
    async send(body) {
      const res = await f(`${url.replace(/\/$/, '')}/api/repair-label`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
  };
}
