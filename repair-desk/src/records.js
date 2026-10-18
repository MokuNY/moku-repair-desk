// Archive lookup and CSV export.
//
// Short export (default): the 13 columns of the old Repair Desk sheet, for
// anyone who wants a spreadsheet view. Full export (owner only): the 42 columns
// of the Moku Ding Repair Repairs table, so it reopens in Numbers next to the
// old file. Both include live tickets and the archive.

import { toCsv } from './csv.js';
import { COLUMNS } from './import.js';
import { customerPrice } from './pricing.js';
import { formatUsPhone, normalizeUsPhone } from './phone.js';
import { requirePermission } from './staff.js';
import { PermissionError } from './shops.js';
import { recordEvent } from './audit.js';

/** Find old repairs by job number, name, phone or board. Any staff member. */
export function searchArchive(db, shopId, actor, term, { limit = 25 } = {}) {
  if (actor?.shop_id !== shopId) throw new PermissionError('Not allowed: archive.view');
  requirePermission(actor, 'archive.view');
  const t = String(term ?? '').trim().toLowerCase();
  if (t.length < 2) return [];
  const phone = normalizeUsPhone(t);
  const rows = phone
    ? db.prepare('SELECT * FROM archived_repairs WHERE shop_id = ? AND (phone_e164 = ? OR search_text LIKE ?) ORDER BY job_number DESC LIMIT ?').all(shopId, phone, `%${phone.slice(2)}%`, limit)
    : db.prepare(`SELECT * FROM archived_repairs WHERE shop_id = ? AND ${t.split(/\s+/).slice(0, 4).map(() => "search_text LIKE ? ESCAPE '\\'").join(' AND ')} ORDER BY job_number DESC LIMIT ?`)
        .all(shopId, ...t.split(/\s+/).slice(0, 4).map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`), limit);
  return rows.map((r) => ({ ...r, raw: JSON.parse(r.raw) }));
}

export const SHORT_COLUMNS = ['Job #', 'Customer', 'Phone', 'Board', 'Repair needed', 'Received', 'Status', 'Keith estimate', 'Markup', 'Customer price', 'Payment', 'Picked up', 'Notes'];

const SHEET_STATUS = {
  received: 'Received',
  inspected: 'Received',
  awaiting_approval: 'Awaiting approval',
  at_partner: 'With Keith',
  back_from_partner: 'Back at Moku',
  ready_for_pickup: 'Customer notified',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/**
 * Build an export. Owner only (it contains customer phone numbers); logged.
 * @returns {{ csv: string, rows: number, totals: object }}
 */
export function exportRecords(db, shopId, actor, { full = false, includeArchive = true } = {}) {
  if (actor?.shop_id !== shopId) throw new PermissionError('Not allowed: data.export');
  requirePermission(actor, 'data.export');
  const live = liveRows(db, shopId);
  const archived = includeArchive ? db.prepare('SELECT * FROM archived_repairs WHERE shop_id = ? ORDER BY job_number').all(shopId) : [];
  const totals = { customerCharges: 0, receipts: 0, customerBalances: 0, pricedJobs: 0 };

  const rows = [];
  for (const a of archived) {
    const raw = JSON.parse(a.raw);
    tally(totals, a.customer_price_cents, a.paid_cents, raw['Customer balance'] === '' ? null : moneyOrNull(raw['Customer balance']));
    rows.push(full ? raw : {
      'Job #': a.job_number, Customer: raw['Customer'], Phone: raw['Phone'], Board: raw['Board description'], 'Repair needed': raw['Repair requested'],
      Received: raw['Received date'], Status: raw['Repair status'], 'Keith estimate': raw['Keith cost / estimate'], Markup: raw['Markup applied'] || raw['Markup override'],
      'Customer price': raw['Customer price'], Payment: raw['Customer payment'], 'Picked up': raw['Customer pickup'], Notes: raw['Notes / accessories'],
    });
  }
  for (const l of live) {
    tally(totals, l.price, l.paid, l.price === null ? null : l.price - l.paid);
    rows.push(full ? fullRow(l) : {
      'Job #': l.t.job_number, Customer: l.t.customer_name, Phone: formatUsPhone(l.t.customer_phone), Board: l.t.board_description, 'Repair needed': l.t.repair_requested,
      Received: sheetDate(l.t.received_at), Status: SHEET_STATUS[l.t.status], 'Keith estimate': dollars(l.t.partner_charge_cents), Markup: dollars(l.t.shop_fee_cents),
      'Customer price': dollars(l.price), Payment: l.paymentStatus, 'Picked up': sheetDate(l.t.completed_at), Notes: l.t.notes,
    });
  }
  rows.sort((a, b) => String(a[full ? 'Repair ID' : 'Job #']).localeCompare(String(b[full ? 'Repair ID' : 'Job #'])));
  recordEvent(db, shopId, { staffId: actor.id, action: 'data.exported', entityType: 'shop', entityId: shopId, detail: { full, includeArchive, rows: rows.length } });
  return { csv: toCsv(full ? COLUMNS : SHORT_COLUMNS, rows), rows: rows.length, totals };
}

function liveRows(db, shopId) {
  const tickets = db
    .prepare(
      `SELECT t.*, c.display_name AS customer_name, c.phone_e164 AS customer_phone, s.name AS created_by_name,
              (SELECT COALESCE(SUM(amount_cents), 0) FROM payments p WHERE p.shop_id = t.shop_id AND p.ticket_id = t.id) AS paid,
              (SELECT group_concat(note, char(10)) FROM call_logs cl WHERE cl.shop_id = t.shop_id AND cl.ticket_id = t.id) AS contact_log
       FROM tickets t
       JOIN customers c ON c.shop_id = t.shop_id AND c.id = t.customer_id
       JOIN staff s ON s.shop_id = t.shop_id AND s.id = t.created_by
       WHERE t.shop_id = ?`,
    )
    .all(shopId);
  return tickets.map((t) => {
    const price = customerPrice(t);
    const paid = t.paid;
    const paymentStatus = price === 0 ? 'No charge' : paid === 0 ? 'Unpaid' : price !== null && paid >= price ? 'Paid' : 'Partial';
    return { t, price, paid, paymentStatus };
  });
}

function fullRow({ t, price, paid, paymentStatus }) {
  const row = Object.fromEntries(COLUMNS.map((c) => [c, '']));
  Object.assign(row, {
    'Repair ID': t.job_number, Customer: t.customer_name, Phone: formatUsPhone(t.customer_phone), 'Board description': t.board_description,
    'Repair requested': t.repair_requested, 'Received date': sheetDate(t.received_at), 'Accepted by': t.accepted_by_text || t.created_by_name,
    'Repair status': SHEET_STATUS[t.status], 'Notes / accessories': t.notes, 'Keith cost / estimate': dollars(t.partner_charge_cents),
    'Markup override': dollars(t.shop_fee_cents), 'Agreed customer price': dollars(t.agreed_price_cents),
    'Pricing basis': t.agreed_price_cents !== null ? 'Agreed price' : 'Estimate + markup', 'Customer price': dollars(price),
    'Customer payment': paymentStatus, 'Customer paid amount': dollars(paid), 'Customer pickup': sheetDate(t.completed_at),
    'Contact log': t.contact_log || '', 'Customer balance': price === null ? '' : dollars(price - paid),
    'Moku gross margin': price === null || t.partner_charge_cents === null ? '' : dollars(price - t.partner_charge_cents),
    Attention: t.needs_review ? 'Review' : '', 'Review notes': t.review_note || '', 'Source records': t.source === 'import' ? 'Moku Ding Repair import' : 'Repair Desk',
  });
  return row;
}

function tally(totals, price, paid, balance) {
  if (price !== null && price !== undefined) { totals.customerCharges += price; totals.pricedJobs++; }
  if (paid !== null && paid !== undefined) totals.receipts += paid;
  if (balance !== null && balance !== undefined) totals.customerBalances += balance;
}

function moneyOrNull(s) {
  const m = /^(\()?\$?([\d,]+)(?:\.(\d{2}))?\)?$/.exec(String(s).trim());
  if (!m) return null;
  const c = Number(m[2].replace(/,/g, '')) * 100 + Number(m[3] || 0);
  return m[1] ? -c : c;
}

/** Sheet-style money: $1,250.00, ($80.00) for negative, '' for unknown. */
export function dollars(cents) {
  if (cents === null || cents === undefined) return '';
  const a = Math.abs(cents);
  const s = `$${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`;
  return cents < 0 ? `(${s})` : s;
}

/** ISO timestamp -> MM/DD/YY in New York time, as the sheet wrote dates. */
function sheetDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit', timeZone: 'America/New_York' });
}
