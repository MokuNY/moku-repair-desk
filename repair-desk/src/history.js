// Finding repairs and a customer's repair history.
//
//   findTickets(...)      every app ticket, open or finished, by job number, name, phone or board
//   customerHistory(...)  all repairs for one customer: app tickets plus old spreadsheet jobs
//
// Old spreadsheet jobs (archived_repairs) are read-only and were never linked to
// a customer record, so they join a customer's history by phone number. Jobs in
// the sheet without a usable phone are still found by name in search; the import
// preview lists them (historyReport) so nothing is silently missed.

import { normalizeUsPhone } from './phone.js';
import { STATUS_LABELS } from './tickets.js';

const OPEN = "t.status NOT IN ('completed', 'cancelled')";

/**
 * Search all tickets. Open ones come first, then finished ones, newest first.
 * @returns {{ open: object[], done: object[] }} raw ticket rows with customer_name / customer_phone
 */
export function findTickets(db, shopId, term, { limit = 15 } = {}) {
  const q = String(term ?? '').trim();
  if (q.length < 2) return { open: [], done: [] };
  const phone = normalizeUsPhone(q);
  const words = q.toLowerCase().split(/\s+/).slice(0, 4).map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const textMatch = words.map(() => "lower(t.job_number || ' ' || c.display_name || ' ' || t.board_description || ' ' || t.repair_requested) LIKE ? ESCAPE '\\'").join(' AND ');
  const where = phone ? `(c.phone_e164 = ? OR (${textMatch}))` : `(${textMatch})`;
  const args = phone ? [phone, ...words] : words;
  const sql = (open) =>
    `SELECT t.*, c.display_name AS customer_name, c.phone_e164 AS customer_phone
     FROM tickets t JOIN customers c ON c.shop_id = t.shop_id AND c.id = t.customer_id
     WHERE t.shop_id = ? AND ${open ? OPEN : `NOT (${OPEN})`} AND ${where}
     ORDER BY ${open ? 't.received_at, t.id' : 'COALESCE(t.completed_at, t.received_at) DESC, t.id DESC'} LIMIT ?`;
  return {
    open: db.prepare(sql(true)).all(shopId, ...args, limit),
    done: db.prepare(sql(false)).all(shopId, ...args, limit),
  };
}

/**
 * Every repair for one customer, newest first: app tickets for that customer
 * (or any customer record with the same phone) plus old spreadsheet jobs with
 * the same phone.
 * @param {{ customerId?: number, shopifyCustomerGid?: string, phone?: string, excludeJob?: string }} who
 */
export function customerHistory(db, shopId, { customerId = null, shopifyCustomerGid = null, phone = null, excludeJob = null } = {}) {
  let e164 = phone ? normalizeUsPhone(phone) : null;
  const ids = new Set();
  if (customerId) ids.add(Number(customerId));
  if (shopifyCustomerGid) {
    const c = db.prepare('SELECT id, phone_e164 FROM customers WHERE shop_id = ? AND shopify_customer_gid = ?').get(shopId, String(shopifyCustomerGid));
    if (c) { ids.add(c.id); e164 ||= c.phone_e164; }
  }
  if (customerId && !e164) e164 = db.prepare('SELECT phone_e164 FROM customers WHERE shop_id = ? AND id = ?').get(shopId, Number(customerId))?.phone_e164 || null;
  if (e164) for (const r of db.prepare('SELECT id FROM customers WHERE shop_id = ? AND phone_e164 = ?').all(shopId, e164)) ids.add(r.id);

  const repairs = [];
  if (ids.size) {
    const list = [...ids];
    const rows = db
      .prepare(
        `SELECT t.job_number, t.board_description, t.repair_requested, t.status, t.received_at, t.completed_at,
                t.partner_charge_cents, t.shop_fee_cents, t.agreed_price_cents
         FROM tickets t WHERE t.shop_id = ? AND t.customer_id IN (${list.map(() => '?').join(',')})`,
      )
      .all(shopId, ...list);
    for (const t of rows) {
      const price = t.agreed_price_cents ?? (t.partner_charge_cents === null ? null : t.partner_charge_cents + t.shop_fee_cents);
      repairs.push({
        jobNumber: t.job_number, board: t.board_description, repair: t.repair_requested, status: STATUS_LABELS[t.status],
        open: !['completed', 'cancelled'].includes(t.status), receivedOn: t.received_at.slice(0, 10),
        pickedUpOn: t.completed_at ? t.completed_at.slice(0, 10) : null, price, source: 'app',
      });
    }
  }
  if (e164) {
    for (const a of db.prepare('SELECT * FROM archived_repairs WHERE shop_id = ? AND phone_e164 = ?').all(shopId, e164)) {
      repairs.push({
        jobNumber: a.job_number, board: a.board, repair: a.repair, status: a.status, open: false,
        receivedOn: a.received_on, pickedUpOn: a.picked_up_on, price: a.customer_price_cents, source: 'archive',
      });
    }
  }
  const out = repairs
    .filter((r) => r.jobNumber !== excludeJob)
    .sort((x, y) => String(y.receivedOn || '').localeCompare(String(x.receivedOn || '')) || y.jobNumber.localeCompare(x.jobNumber));
  const spent = out.reduce((s, r) => s + (r.open || r.price === null ? 0 : r.price), 0);
  return { repairs: out, count: out.length, lastOn: out.find((r) => r.receivedOn)?.receivedOn || null, spentCents: spent };
}

/**
 * For the import preview: how the old jobs will join customer histories.
 * Uses the plan from previewImport (archive + active rows).
 */
export function historyReport(plan) {
  const rows = [...plan.archive, ...plan.active];
  const byPhone = new Map();
  const noPhone = [];
  let linked = 0;
  for (const r of rows) {
    if (r.phone) {
      if (!byPhone.has(r.phone)) byPhone.set(r.phone, []);
      byPhone.get(r.phone).push(r);
    } else if (r.linkTo) linked++; // --link joins it to that job's customer
    else noPhone.push({ jobNumber: r.jobNumber, customer: r.customer || '(no name)', phoneText: r.raw?.['Phone'] || '' });
  }
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const sharedPhones = [];
  for (const [phone, list] of byPhone) {
    const names = [...new Set(list.map((r) => r.customer).filter(Boolean))];
    if (new Set(names.map(norm)).size > 1) sharedPhones.push({ phone, names, jobs: list.map((r) => r.jobNumber) });
  }
  const repeat = [...byPhone.values()].filter((l) => l.length > 1).length;
  return {
    linkedJobs: rows.length - noPhone.length - linked,
    linkedByHand: linked,
    customers: byPhone.size,
    repeatCustomers: repeat,
    noPhone: noPhone.sort((a, b) => a.jobNumber.localeCompare(b.jobNumber)),
    sharedPhones,
  };
}
