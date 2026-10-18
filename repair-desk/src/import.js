// Import the "Moku Ding Repair" Numbers tracker (Repairs table exported as CSV).
//
//   previewImport(...)  reads the file, checks everything, changes nothing.
//   applyImport(...)    re-checks inside one transaction and writes it all, or nothing.
//
// Active jobs become live tickets. Completed, Cancelled and Legacy review jobs go
// into the read-only archive exactly as written. The same file can be imported
// once (fingerprint); a job number already in the app is skipped when the row is
// identical and reported as a conflict when it differs: never overwritten.

import crypto from 'node:crypto';
import { tx } from './db.js';
import { parseCsvRecords } from './csv.js';
import { parseSheetMoney } from './money.js';
import { normalizeUsPhone } from './phone.js';
import { getShop, PermissionError } from './shops.js';
import { requirePermission } from './staff.js';
import { addEvent } from './tickets.js';
import { recordEvent } from './audit.js';

export const FORMAT = 'moku-ding-repair-v1';

export const COLUMNS = [
  'Repair ID', 'Customer', 'Phone', 'Board description', 'Repair requested', 'Received date', 'Accepted by',
  'Repair status', 'Notes / accessories', 'Keith cost / estimate', 'Markup override', 'Agreed customer price',
  'Pricing basis', 'Customer price', 'Customer payment', 'Customer paid amount', 'Payment method',
  'Customer payment date', 'Keith payment', 'Keith paid amount', 'Keith payment date', 'Sent to Keith',
  'Back at Moku', 'Customer notified', 'Customer pickup', 'Target return date', 'Quote approval', 'Contact log',
  'Photo link', 'Markup applied', 'Customer balance', 'Keith balance', 'Moku gross margin', 'Days open',
  'Repair turnaround days', 'Pickup wait days', 'Total turnaround days', 'Attention', 'Review notes',
  'Source records', 'Original status', 'Original price / payment',
];

/** Sheet status -> live ticket status. Anything else listed in ARCHIVED goes to the archive. */
export const ACTIVE_STATUS = {
  Received: 'received',
  'With Keith': 'at_partner',
  'In repair': 'at_partner',
  'Awaiting approval': 'awaiting_approval',
  'Back at Moku': 'back_from_partner',
  'Customer notified': 'ready_for_pickup',
};
export const ARCHIVED_STATUS = ['Completed', 'Cancelled', 'Legacy review'];

const MONEY_COLS = ['Keith cost / estimate', 'Markup override', 'Agreed customer price', 'Customer price', 'Customer paid amount', 'Keith paid amount', 'Markup applied', 'Customer balance', 'Keith balance', 'Moku gross margin'];

/**
 * Check a file without changing anything.
 * @param {{ fileName: string, text: string, customerLinks?: Record<string,string> }} input
 *        customerLinks: { 'MOKU-0004': 'MOKU-0003' } = same customer as that job.
 */
export function previewImport(db, shopId, actor, input) {
  authorize(shopId, actor);
  return analyze(db, shopId, input);
}

/** Write the import. Re-checks everything; refuses if there are errors or conflicts. */
export function applyImport(db, shopId, actor, input, { evidenceText = null } = {}) {
  authorize(shopId, actor);
  return tx(db, () => {
    const plan = analyze(db, shopId, input);
    if (plan.alreadyImported) throw new ImportError(`This file was already imported on ${plan.alreadyImported.imported_at.slice(0, 10)}.`, plan);
    if (plan.errors.length) throw new ImportError(`The file has ${plan.errors.length} problem(s); nothing was imported.`, plan);
    if (plan.conflicts.length) throw new ImportError(`${plan.conflicts.length} job number(s) already exist with different details; nothing was imported.`, plan);

    const shop = getShop(db, shopId);
    const batchId = Number(
      db.prepare(
        `INSERT INTO import_batches (shop_id, file_sha256, file_name, format, imported_by, row_count, active_count, archived_count, totals, evidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(shopId, plan.sha256, plan.fileName, FORMAT, actor.id, plan.rowCount, plan.active.length, plan.archive.length, JSON.stringify(plan.totals), evidenceText).lastInsertRowid,
    );

    const insArchive = db.prepare(
      `INSERT INTO archived_repairs (shop_id, import_batch_id, job_number, customer_name, phone_e164, board, repair, status,
         received_on, picked_up_on, customer_price_cents, paid_cents, keith_cost_cents, raw, search_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const a of plan.archive) {
      insArchive.run(shopId, batchId, a.jobNumber, a.customer, a.phone, a.board, a.repair, a.status, a.receivedOn, a.pickedUpOn,
        a.money['Customer price'], a.money['Customer paid amount'], a.money['Keith cost / estimate'], JSON.stringify(a.raw), a.searchText);
    }

    const customerIds = new Map(); // job number -> customer id
    for (const t of plan.active) {
      const customerId = resolveCustomer(db, shopId, t, plan, customerIds);
      customerIds.set(t.jobNumber, customerId);
      const receivedAt = t.receivedOn ? `${t.receivedOn}T12:00:00.000Z` : new Date().toISOString();
      const id = Number(
        db.prepare(
          `INSERT INTO tickets (shop_id, job_number, customer_id, board_description, repair_requested, status, partner_id,
             partner_charge_cents, shop_fee_cents, agreed_price_cents, notes, received_at, created_by, intake_request_id,
             source, accepted_by_text, needs_review, review_note, import_batch_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, ?, ?)`,
        ).run(shopId, t.jobNumber, customerId, t.board, t.repair, t.status, shop.default_partner_id,
          t.money['Keith cost / estimate'], t.shopFee, t.money['Agreed customer price'], t.notes, receivedAt, actor.id,
          `import_${plan.sha256.slice(0, 16)}_${t.jobNumber}`, t.acceptedBy || null, t.reviewNote ? 1 : 0, t.reviewNote || null, batchId).lastInsertRowid,
      );
      insertEventAt(db, shopId, id, { kind: 'status', toStatus: 'received', at: receivedAt, detail: { imported: true } });
      if (t.status !== 'received') {
        const at = t.sentToKeithOn ? `${t.sentToKeithOn}T12:00:00.000Z` : new Date().toISOString();
        insertEventAt(db, shopId, id, { kind: 'status', fromStatus: 'received', toStatus: t.status, at, detail: { imported: true } });
      }
      for (const line of t.contactLines) {
        db.prepare(`INSERT INTO call_logs (shop_id, ticket_id, staff_id, outcome, note) VALUES (?, ?, NULL, 'note', ?)`).run(shopId, id, line);
      }
      const paid = t.money['Customer paid amount'];
      if (paid > 0) {
        db.prepare(`INSERT INTO payments (shop_id, ticket_id, amount_cents, method, note) VALUES (?, ?, ?, ?, 'Imported from Moku Ding Repair')`)
          .run(shopId, id, paid, t.paymentMethod);
      }
      addEvent(db, shopId, id, actor.id, { kind: 'import', detail: { batchId, jobNumber: t.jobNumber } });
    }

    // New job numbers continue after the highest imported one.
    db.prepare('UPDATE shops SET next_job_number = MAX(next_job_number, ?) WHERE id = ?').run(plan.nextJobNumber, shopId);
    recordEvent(db, shopId, {
      staffId: actor.id,
      action: 'data.imported',
      entityType: 'import_batch',
      entityId: batchId,
      detail: { file: plan.fileName, sha256: plan.sha256, active: plan.active.length, archived: plan.archive.length, skipped: plan.unchanged.length, totals: plan.totals },
    });
    return { batchId, active: plan.active.length, archived: plan.archive.length, skipped: plan.unchanged.length, totals: plan.totals, warnings: plan.warnings, nextJobNumber: plan.nextJobNumber };
  });
}

export class ImportError extends Error {
  constructor(message, plan) {
    super(message);
    this.plan = plan;
  }
}

// ---------------------------------------------------------------- analysis

function authorize(shopId, actor) {
  if (actor?.shop_id !== shopId) throw new PermissionError('Not allowed: data.import');
  requirePermission(actor, 'data.import');
}

function analyze(db, shopId, { fileName, text, customerLinks = {} }) {
  const shop = getShop(db, shopId);
  if (!shop) throw new RangeError('No such shop');
  const sha256 = crypto.createHash('sha256').update(String(text)).digest('hex');
  const alreadyImported = db.prepare('SELECT * FROM import_batches WHERE shop_id = ? AND file_sha256 = ?').get(shopId, sha256) ?? null;

  const { header, records } = parseCsvRecords(text);
  const plan = { fileName: String(fileName || 'import.csv').slice(0, 200), sha256, alreadyImported, rowCount: records.length, active: [], archive: [], unchanged: [], conflicts: [], errors: [], warnings: [], totals: null, nextJobNumber: shop.next_job_number };

  if (header.length !== COLUMNS.length || header.some((h, i) => h !== COLUMNS[i])) {
    const missing = COLUMNS.filter((c) => !header.includes(c));
    plan.errors.push({ row: 1, message: `This isn't the Repairs table from Moku Ding Repair (${header.length} columns${missing.length ? `; missing ${missing.slice(0, 3).join(', ')}` : ''}).` });
    return plan;
  }

  const seen = new Set();
  const jobPattern = new RegExp(`^${shop.job_prefix}-(\\d{4,6})$`);
  const totals = { customerCharges: 0, receipts: 0, customerBalances: 0, grossMargin: 0, pricedJobs: 0 };
  let maxJob = 0;

  records.forEach((r, i) => {
    const rowNo = i + 2;
    const jobNumber = r['Repair ID'].trim().toUpperCase();
    const m = jobPattern.exec(jobNumber);
    if (!m) return plan.errors.push({ row: rowNo, message: `Repair ID "${r['Repair ID']}" isn't like ${shop.job_prefix}-0001.` });
    if (seen.has(jobNumber)) return plan.errors.push({ row: rowNo, jobNumber, message: `${jobNumber} appears twice in the file.` });
    seen.add(jobNumber);
    maxJob = Math.max(maxJob, Number(m[1]));

    const money = {};
    for (const c of MONEY_COLS) {
      try {
        money[c] = parseSheetMoney(r[c]);
      } catch {
        plan.errors.push({ row: rowNo, jobNumber, message: `${c} "${r[c]}" isn't a dollar amount.` });
        return;
      }
    }

    // Same price rule as the sheet: agreed price, else Keith cost + markup ($20 when blank).
    const expected = money['Agreed customer price'] ?? (money['Keith cost / estimate'] === null ? null : money['Keith cost / estimate'] + (money['Markup override'] ?? 2000));
    if (expected !== money['Customer price']) {
      plan.warnings.push({
        row: rowNo,
        jobNumber,
        message: money['Customer price'] === null
          ? `No customer price in the sheet (Keith cost + markup would be ${fmt(expected)}); left blank, not charged.`
          : `Customer price ${fmt(money['Customer price'])} differs from the price rule (${fmt(expected)}); the sheet's value is kept.`,
      });
    }
    if (money['Customer price'] !== null) { totals.customerCharges += money['Customer price']; totals.pricedJobs++; }
    if (money['Customer paid amount'] !== null) totals.receipts += money['Customer paid amount'];
    if (money['Customer balance'] !== null) totals.customerBalances += money['Customer balance'];
    if (money['Moku gross margin'] !== null) totals.grossMargin += money['Moku gross margin'];

    const dates = {};
    for (const c of ['Received date', 'Sent to Keith', 'Customer pickup']) {
      dates[c] = parseSheetDate(r[c]);
      if (dates[c] === undefined) { plan.warnings.push({ row: rowNo, jobNumber, message: `${c} "${r[c]}" isn't a date; left blank.` }); dates[c] = null; }
    }

    const raw = Object.fromEntries(COLUMNS.map((c) => [c, r[c]]));
    const phone = normalizeUsPhone(r['Phone']);
    if (r['Phone'].trim() && !phone) plan.warnings.push({ row: rowNo, jobNumber, message: `Phone "${r['Phone']}" isn't a valid US number; kept as text only.` });
    const base = {
      row: rowNo, jobNumber, raw, money, phone,
      customer: clean(r['Customer'], 120), board: clean(r['Board description'], 200), repair: clean(r['Repair requested'], 1000),
      receivedOn: dates['Received date'], sentToKeithOn: dates['Sent to Keith'], pickedUpOn: dates['Customer pickup'],
    };

    const status = r['Repair status'].trim();
    const existing = findExisting(db, shopId, jobNumber);
    if (ARCHIVED_STATUS.includes(status)) {
      if (existing) return classifyExisting(plan, existing, base, raw);
      plan.archive.push({ ...base, status, searchText: searchText(base) });
    } else if (ACTIVE_STATUS[status]) {
      if (existing) return classifyExisting(plan, existing, base, raw);
      const markup = money['Markup override'];
      if (markup !== null && markup < 0) plan.errors.push({ row: rowNo, jobNumber, message: `Active job has a negative markup (${fmt(markup)}); set an agreed price instead.` });
      const link = customerLinks[jobNumber];
      if (link && !records.some((x) => x['Repair ID'].trim().toUpperCase() === link)) plan.errors.push({ row: rowNo, jobNumber, message: `Linked job ${link} isn't in the file.` });
      plan.active.push({
        ...base,
        status: ACTIVE_STATUS[status],
        sheetStatus: status,
        shopFee: markup ?? shop.default_shop_fee_cents,
        notes: clean(r['Notes / accessories'], 2000),
        acceptedBy: clean(r['Accepted by'], 40),
        reviewNote: clean([r['Review notes'], r['Attention'] && !r['Review notes'] ? r['Attention'] : ''].filter(Boolean).join('; ').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).join('; '), 500),
        contactLines: r['Contact log'].split(/\r?\n/).map((l) => clean(l.replace(/\s*\[row \d+\]\s*$/, ''), 300)).filter(Boolean),
        paymentMethod: { Cash: 'cash', Card: 'card' }[r['Payment method'].trim()] || 'other',
        linkTo: link || null,
      });
    } else {
      plan.errors.push({ row: rowNo, jobNumber, message: `Status "${status}" isn't one the import knows.` });
    }
  });

  plan.totals = totals;
  plan.nextJobNumber = Math.max(shop.next_job_number, maxJob + 1);
  return plan;
}

function findExisting(db, shopId, jobNumber) {
  const archived = db.prepare('SELECT raw FROM archived_repairs WHERE shop_id = ? AND job_number = ?').get(shopId, jobNumber);
  if (archived) return { kind: 'archive', raw: archived.raw };
  const ticket = db.prepare('SELECT id, source FROM tickets WHERE shop_id = ? AND job_number = ?').get(shopId, jobNumber);
  return ticket ? { kind: 'ticket', ticket } : null;
}

function classifyExisting(plan, existing, base, raw) {
  if (existing.kind === 'archive' && existing.raw === JSON.stringify(raw)) return plan.unchanged.push({ jobNumber: base.jobNumber });
  if (existing.kind === 'ticket' && existing.ticket.source === 'import') {
    // A live ticket now owns this job; the app is the source of truth from here on.
    return plan.unchanged.push({ jobNumber: base.jobNumber, note: 'already a live ticket' });
  }
  plan.conflicts.push({ row: base.row, jobNumber: base.jobNumber, message: `${base.jobNumber} already exists in the app with different details.` });
}

/** One customer per phone number; customerLinks join rows without a phone. */
function resolveCustomer(db, shopId, t, plan, customerIds) {
  if (t.linkTo && customerIds.has(t.linkTo)) {
    const id = customerIds.get(t.linkTo);
    if (t.phone) db.prepare('UPDATE customers SET phone_e164 = COALESCE(phone_e164, ?) WHERE shop_id = ? AND id = ?').run(t.phone, shopId, id);
    return id;
  }
  if (t.phone) {
    const found = db.prepare('SELECT id FROM customers WHERE shop_id = ? AND phone_e164 = ? ORDER BY id LIMIT 1').get(shopId, t.phone);
    if (found) return found.id;
  }
  const name = t.customer || 'Unknown customer';
  const [first, ...rest] = name.split(' ');
  return Number(
    db.prepare('INSERT INTO customers (shop_id, shopify_customer_gid, display_name, first_name, last_name, phone_e164) VALUES (?, NULL, ?, ?, ?, ?)')
      .run(shopId, name, first || null, rest.join(' ') || null, t.phone).lastInsertRowid,
  );
}

function insertEventAt(db, shopId, ticketId, { kind, fromStatus = null, toStatus = null, at, detail }) {
  db.prepare(`INSERT INTO ticket_events (shop_id, ticket_id, staff_id, kind, from_status, to_status, detail, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`)
    .run(shopId, ticketId, kind, fromStatus, toStatus, JSON.stringify(detail), at);
}

/** "06/14/23" or "06/14/2023" -> "2023-06-14"; "" -> null; anything else -> undefined. */
export function parseSheetDate(s) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t);
  if (!m) return undefined;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const mo = Number(m[1]);
  const d = Number(m[2]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function searchText(b) {
  return [b.jobNumber, b.customer, b.phone?.replace(/\D/g, ''), b.raw['Phone'].replace(/\D/g, ''), b.board, b.repair].filter(Boolean).join(' ').toLowerCase();
}

const fmt = (c) => (c === null ? 'blank' : `$${(c / 100).toFixed(2)}`);
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
