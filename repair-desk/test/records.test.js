// Import, archive, export and pricing. Fixture rows are invented (no real
// customer data) but shaped exactly like the Moku Ding Repair Repairs export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { openDb } from '../src/db.js';
import { createShop, getShop, updateShopSettings, takeJobNumber } from '../src/shops.js';
import { createStaff } from '../src/staff.js';
import { createPartner } from '../src/partners.js';
import { parseCsv, parseCsvRecords, toCsv } from '../src/csv.js';
import { parseSheetMoney } from '../src/money.js';
import { COLUMNS, previewImport, applyImport, parseSheetDate, ImportError } from '../src/import.js';
import { exportRecords, searchArchive, SHORT_COLUMNS } from '../src/records.js';
import { createTicket, listOpenTickets, ticketView, changeStatus, handOver, getTicketByJobNumber } from '../src/tickets.js';
import { customerPrice, money, setPrices, recordPayment, logCall } from '../src/pricing.js';

const row = (o) => Object.fromEntries(COLUMNS.map((c) => [c, o[c] ?? '']));

// 4 active + 4 archived, covering every case the real file has.
const FIXTURE = [
  row({ 'Repair ID': 'MOKU-0001', Customer: 'Pat Example', Phone: '516-555-0101', 'Board description': 'Test board 9\'0"', 'Repair requested': 'stringer', 'Received date': '06/14/23', 'Accepted by': 'Ca', 'Repair status': 'With Keith', 'Markup override': '$20.00', 'Pricing basis': 'Estimate + markup', 'Customer payment': 'Unpaid', 'Customer paid amount': '$0.00', 'Sent to Keith': '06/30/23', Attention: 'Review import notes', 'Review notes': 'Old open repair; confirm board location' }),
  row({ 'Repair ID': 'MOKU-0002', Customer: 'Sam Sample', Phone: '516-555-0102', 'Board description': 'Fish 5\'8', 'Repair requested': 'nose', 'Received date': '09/12/25', 'Repair status': 'With Keith', 'Markup override': '$20.00', 'Customer payment': 'Unpaid', 'Customer paid amount': '$0.00' }),
  row({ 'Repair ID': 'MOKU-0003', Customer: 'Sam Sampel', 'Board description': 'Log 9\'6', 'Repair requested': 'tail', 'Received date': '09/19/25', 'Repair status': 'With Keith', 'Markup override': '$20.00', 'Customer payment': 'Unknown', 'Contact log': 'LM 8/28/26 [row 25]\n"spoke", will pick up, Friday [row 26]', 'Review notes': 'Short source block\nOld open repair' }),
  row({ 'Repair ID': 'MOKU-0004', Customer: 'Pat Example', Phone: '516555-0101', 'Board description': 'Twin 6\'0', 'Repair requested': 'fin box', 'Repair status': 'Received', 'Keith cost / estimate': '$80.00', 'Markup override': '$20.00', 'Customer price': '$100.00', 'Customer payment': 'Partial', 'Customer paid amount': '$40.00', 'Payment method': 'Cash', 'Customer balance': '$60.00', 'Moku gross margin': '$20.00', 'Review notes': 'Missing received date' }),
  row({ 'Repair ID': 'MOKU-0009', Customer: 'Alex Archive', Phone: '516-555-0109', 'Board description': 'Town & Country', 'Repair requested': 'fin setup', 'Received date': '04/14/23', 'Accepted by': 'Dane', 'Repair status': 'Completed', 'Keith cost / estimate': '$55.00', 'Markup override': '$0.00', 'Agreed customer price': '$55.00', 'Customer price': '$55.00', 'Customer payment': 'Paid', 'Customer paid amount': '$55.00', 'Customer pickup': '06/14/23', 'Customer balance': '$0.00', 'Moku gross margin': '$0.00' }),
  row({ 'Repair ID': 'MOKU-0013', Customer: 'Nora Nocharge', Phone: '516-555-0113', 'Board description': 'Retro 6\'0', 'Repair requested': 'fin box', 'Repair status': 'Completed', 'Keith cost / estimate': '$80.00', 'Markup override': '($80.00)', 'Customer price': '$0.00', 'Customer payment': 'No charge', 'Customer paid amount': '$0.00', 'Customer balance': '$0.00', 'Moku gross margin': '($80.00)' }),
  row({ 'Repair ID': 'MOKU-0067', Customer: 'Shop Board', Phone: 'Shop', 'Board description': 'Pyzel 5\'8', 'Repair requested': 'belly ding', 'Repair status': 'Completed', 'Keith cost / estimate': '$60.00', 'Pricing basis': 'Unknown', 'Customer payment': 'Unpaid' }),
  row({ 'Repair ID': 'MOKU-0185', Customer: 'Lee Legacy', 'Board description': 'Wind & Sea', 'Repair status': 'Legacy review', 'Customer payment': 'Unknown', 'Review notes': 'Archive-only record; current disposition unknown' }),
];
const csvOf = (rows, header = COLUMNS) => '﻿' + toCsv(header, rows); // Numbers writes a BOM

function setup() {
  const db = openDb(':memory:');
  const shop = createShop(db, { name: 'MOKU', shopifyDomain: 'moku-repair-test.myshopify.com', jobPrefix: 'MOKU' });
  const tom = createStaff(db, shop.id, null, { name: 'Tom Gleason', role: 'owner' });
  const carolyn = createStaff(db, shop.id, tom, { name: 'Carolyn', canRecordPayouts: true });
  const emma = createStaff(db, shop.id, tom, { name: 'Emma' });
  const keith = createPartner(db, shop.id, tom, { name: 'Keith' });
  updateShopSettings(db, shop.id, tom, { defaultPartnerId: keith.id });
  const input = { fileName: 'Repairs-Repairs.csv', text: csvOf(FIXTURE), customerLinks: { 'MOKU-0003': 'MOKU-0002' } };
  return { db, shop, tom, carolyn, emma, keith, input };
}

// --------------------------------------------------------------- parsing

test('csv: quoted commas, quotes, line breaks, BOM, CRLF round-trip', () => {
  const text = '﻿a,b\r\n"x, y","he said ""hi"""\r\n"line1\nline2",\r\n';
  assert.deepEqual(parseCsv(text), [['a', 'b'], ['x, y', 'he said "hi"'], ['line1\nline2', '']]);
  const { header, records } = parseCsvRecords(toCsv(['a', 'b'], [{ a: 'x, y', b: 'line1\nline2' }]));
  assert.deepEqual(header, ['a', 'b']);
  assert.deepEqual(records, [{ a: 'x, y', b: 'line1\nline2' }]);
  assert.throws(() => parseCsv('"never closed'), /quoted cell/);
});

test('csv export never writes a cell a spreadsheet would run as a formula', () => {
  const out = toCsv(['n'], [{ n: '=HYPERLINK("x")' }, { n: '+1' }, { n: '@SUM' }, { n: '-cmd' }, { n: '-5' }]);
  assert.deepEqual(out.trim().split('\r\n').slice(1), ['"\'=HYPERLINK(""x"")"', "'+1", "'@SUM", "'-cmd", '-5']);
});

test('sheet money and dates', () => {
  assert.equal(parseSheetMoney('$1,250.00'), 125000);
  assert.equal(parseSheetMoney('($80.00)'), -8000);
  assert.equal(parseSheetMoney(''), null);
  assert.equal(parseSheetMoney('$0.00'), 0);
  assert.throws(() => parseSheetMoney('$12.345'));
  assert.throws(() => parseSheetMoney('($5.00'));
  assert.equal(parseSheetDate('06/14/23'), '2023-06-14');
  assert.equal(parseSheetDate('6/4/2024'), '2024-06-04');
  assert.equal(parseSheetDate(''), null);
  assert.equal(parseSheetDate('02/30/24'), undefined);
  assert.equal(parseSheetDate('45030'), undefined);
});

// ---------------------------------------------------------------- import

test('preview changes nothing and reports active, archive, totals, warnings', () => {
  const { db, shop, tom, input } = setup();
  const p = previewImport(db, shop.id, tom, input);
  assert.equal(p.rowCount, 8);
  assert.deepEqual(p.active.map((a) => a.jobNumber), ['MOKU-0001', 'MOKU-0002', 'MOKU-0003', 'MOKU-0004']);
  assert.deepEqual(p.archive.map((a) => a.jobNumber), ['MOKU-0009', 'MOKU-0013', 'MOKU-0067', 'MOKU-0185']);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.totals, { customerCharges: 15500, receipts: 9500, customerBalances: 6000, grossMargin: -6000, pricedJobs: 3 });
  assert.equal(p.nextJobNumber, 186);
  assert.ok(p.warnings.some((w) => w.jobNumber === 'MOKU-0067' && /left blank, not charged/.test(w.message)));
  assert.ok(p.warnings.some((w) => w.jobNumber === 'MOKU-0067' && /Phone "Shop"/.test(w.message)));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tickets').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM archived_repairs').get().n, 0);
});

test('apply: active jobs become live tickets with their history', () => {
  const { db, shop, tom, keith, input } = setup();
  const r = applyImport(db, shop.id, tom, input);
  assert.deepEqual([r.active, r.archived, r.skipped], [4, 4, 0]);
  assert.equal(getShop(db, shop.id).next_job_number, 186);

  const open = listOpenTickets(db, shop.id);
  // Oldest first; MOKU-0004 has no received date, so it uses the import time and sorts last.
  assert.deepEqual(open.map((t) => [t.job_number, t.status]), [['MOKU-0001', 'at_partner'], ['MOKU-0002', 'at_partner'], ['MOKU-0003', 'at_partner'], ['MOKU-0004', 'received']]);
  const t1 = getTicketByJobNumber(db, shop.id, 'MOKU-0001');
  assert.equal(t1.source, 'import');
  assert.equal(t1.partner_id, keith.id);
  assert.equal(t1.shop_fee_cents, 2000);
  assert.equal(t1.accepted_by_text, 'Ca');
  assert.equal(t1.needs_review, 1);
  assert.equal(t1.review_note, 'Old open repair; confirm board location');
  assert.equal(t1.received_at.slice(0, 10), '2023-06-14');
  const ev = ticketView(db, shop.id, t1.id).events.filter((e) => e.kind === 'status').map((e) => [e.to_status, e.created_at.slice(0, 10)]);
  assert.deepEqual(ev, [['received', '2023-06-14'], ['at_partner', '2023-06-30']]);

  // Review notes keep their line breaks as "; ". Contact log lines become call-log entries.
  const t3 = getTicketByJobNumber(db, shop.id, 'MOKU-0003');
  assert.equal(t3.review_note, 'Short source block; Old open repair');
  assert.deepEqual(db.prepare('SELECT note FROM call_logs WHERE ticket_id = ? ORDER BY id').all(t3.id).map((c) => c.note), ['LM 8/28/26', '"spoke", will pick up, Friday']);

  // MOKU-0004: missing received date flagged; its $40 deposit is a payment; price rule holds.
  const t4 = getTicketByJobNumber(db, shop.id, 'MOKU-0004');
  assert.equal(t4.needs_review, 1);
  assert.deepEqual(money(db, shop.id, t4.id), { price: 10000, paid: 4000, balance: 6000, status: 'partial', partnerCharge: 8000, shopFee: 2000, agreedPrice: null });
});

test('apply: one customer per phone; linked rows share a customer', () => {
  const { db, shop, tom, input } = setup();
  applyImport(db, shop.id, tom, input);
  const cust = (job) => db.prepare('SELECT c.* FROM tickets t JOIN customers c ON c.id = t.customer_id WHERE t.job_number = ?').get(job);
  assert.equal(cust('MOKU-0001').id, cust('MOKU-0004').id); // same phone, different formats
  assert.equal(cust('MOKU-0003').id, cust('MOKU-0002').id); // linked: no phone, misspelled name
  assert.equal(cust('MOKU-0003').display_name, 'Sam Sample');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers').get().n, 2);
  assert.equal(cust('MOKU-0001').shopify_customer_gid, null); // matched to Shopify later, not invented
});

test('archive: stored exactly as written, read-only, searchable', () => {
  const { db, shop, tom, emma, input } = setup();
  applyImport(db, shop.id, tom, input);
  const a = db.prepare(`SELECT * FROM archived_repairs WHERE job_number = 'MOKU-0013'`).get();
  assert.deepEqual(JSON.parse(a.raw), FIXTURE[5]); // all 42 columns, untouched
  assert.equal(a.customer_price_cents, 0);
  const unknown = db.prepare(`SELECT * FROM archived_repairs WHERE job_number = 'MOKU-0067'`).get();
  assert.equal(unknown.customer_price_cents, null); // unknown stays unknown, never $0
  assert.throws(() => db.prepare(`UPDATE archived_repairs SET status = 'x'`).run(), /read-only/);
  assert.throws(() => db.prepare('DELETE FROM archived_repairs').run(), /read-only/);
  // Any staff member can look up an old repair by name, phone (any format) or board.
  assert.deepEqual(searchArchive(db, shop.id, emma, 'alex').map((x) => x.job_number), ['MOKU-0009']);
  assert.deepEqual(searchArchive(db, shop.id, emma, '(516) 555-0109').map((x) => x.job_number), ['MOKU-0009']);
  assert.deepEqual(searchArchive(db, shop.id, emma, 'town & country').map((x) => x.job_number), ['MOKU-0009']);
  assert.deepEqual(searchArchive(db, shop.id, emma, '100%_').map((x) => x.job_number), []); // wildcards are literal
  assert.equal(listOpenTickets(db, shop.id).some((t) => t.job_number === 'MOKU-0009'), false); // not on the counter
});

// ------------------------------------------------------------- duplicates

test('the same file twice is refused; nothing changes', () => {
  const { db, shop, tom, input } = setup();
  applyImport(db, shop.id, tom, input);
  const before = db.prepare('SELECT (SELECT COUNT(*) FROM tickets) t, (SELECT COUNT(*) FROM archived_repairs) a').get();
  assert.throws(() => applyImport(db, shop.id, tom, input), (e) => e instanceof ImportError && /already imported/.test(e.message));
  assert.deepEqual(db.prepare('SELECT (SELECT COUNT(*) FROM tickets) t, (SELECT COUNT(*) FROM archived_repairs) a').get(), before);
});

test('a later file: identical rows skipped, new rows added, changed rows refused', () => {
  const { db, shop, tom, input } = setup();
  applyImport(db, shop.id, tom, input);
  const newer = [...FIXTURE, row({ 'Repair ID': 'MOKU-0186', Customer: 'New One', 'Repair status': 'Completed', 'Customer payment': 'Unknown' })];
  const ok = applyImport(db, shop.id, tom, { fileName: 'newer.csv', text: csvOf(newer) });
  assert.deepEqual([ok.archived, ok.active, ok.skipped], [1, 0, 8]);
  assert.equal(getShop(db, shop.id).next_job_number, 187);

  const changed = FIXTURE.map((r) => (r['Repair ID'] === 'MOKU-0009' ? { ...r, 'Customer price': '$999.00' } : r));
  assert.throws(() => applyImport(db, shop.id, tom, { fileName: 'edited.csv', text: csvOf(changed) }), (e) => e instanceof ImportError && e.plan.conflicts[0].jobNumber === 'MOKU-0009');
  assert.equal(JSON.parse(db.prepare(`SELECT raw FROM archived_repairs WHERE job_number = 'MOKU-0009'`).get().raw)['Customer price'], '$55.00');
});

test('bad files are refused whole: wrong columns, bad money, repeated or unknown jobs', () => {
  const { db, shop, tom } = setup();
  const attempt = (rows, header) => assert.throws(() => applyImport(db, shop.id, tom, { fileName: 'x.csv', text: csvOf(rows, header) }), ImportError);
  attempt(FIXTURE, SHORT_COLUMNS); // the old 13-column sheet is not this format
  attempt([...FIXTURE, row({ 'Repair ID': 'MOKU-0200', 'Repair status': 'Completed', 'Customer price': 'about $90' })]);
  attempt([...FIXTURE, FIXTURE[0]]);
  attempt([...FIXTURE, row({ 'Repair ID': 'MOKU-0201', 'Repair status': 'Lost at sea' })]);
  attempt([...FIXTURE, row({ 'Repair ID': 'HI-0001', 'Repair status': 'Completed' })]);
  attempt([row({ ...FIXTURE[1], 'Markup override': '($30.00)' })]); // negative markup on a live job
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tickets').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM archived_repairs').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM import_batches').get().n, 0);
});

test('only the owner can import or export; all staff can search the archive', () => {
  const { db, shop, carolyn, emma, input } = setup();
  assert.throws(() => previewImport(db, shop.id, carolyn, input), /data.import/);
  assert.throws(() => applyImport(db, shop.id, emma, input), /data.import/);
  assert.throws(() => exportRecords(db, shop.id, carolyn), /data.export/);
  assert.deepEqual(searchArchive(db, shop.id, emma, 'nothing yet'), []);
});

// -------------------------------------------------------- after the import

test('new tickets start at MOKU-0186 and skip any number already used', () => {
  const { db, shop, tom, emma, input } = setup();
  applyImport(db, shop.id, tom, input);
  const t = createTicket(db, shop.id, emma, {
    requestId: crypto.randomBytes(12).toString('base64url'),
    customer: { shopifyCustomerGid: 'gid://shopify/Customer/1', displayName: 'Walk In' },
    boardDescription: 'Board', repairRequested: 'ding',
  });
  assert.equal(t.ticket.job_number, 'MOKU-0186');
  // Even if the counter were wrong, an archived number is never reused.
  db.prepare('UPDATE shops SET next_job_number = 9').run();
  assert.equal(takeJobNumber(db, shop.id), 'MOKU-0010');
});

test('pricing: Keith charge + fee, agreed price wins, unknown stays unknown, every change logged', () => {
  const { db, shop, tom, emma, input } = setup();
  applyImport(db, shop.id, tom, input);
  const t = getTicketByJobNumber(db, shop.id, 'MOKU-0002');
  assert.equal(customerPrice(t), null);
  assert.equal(money(db, shop.id, t.id).balance, null);
  setPrices(db, shop.id, emma, t.id, { partnerChargeCents: 6500 });
  assert.equal(money(db, shop.id, t.id).price, 8500);
  setPrices(db, shop.id, emma, t.id, { agreedPriceCents: 8000 });
  assert.equal(money(db, shop.id, t.id).price, 8000);
  setPrices(db, shop.id, emma, t.id, { agreedPriceCents: null, shopFeeCents: 0 });
  assert.equal(money(db, shop.id, t.id).price, 6500);
  assert.throws(() => setPrices(db, shop.id, emma, t.id, { shopFeeCents: -3000 }), /between/);
  assert.throws(() => setPrices(db, shop.id, emma, t.id, { partnerChargeCents: 12.5 }), /whole cents/);
  const priceEvents = ticketView(db, shop.id, t.id).events.filter((e) => e.kind === 'price');
  assert.equal(priceEvents.length, 3);
  assert.deepEqual(priceEvents[0].detail.customerPrice, { from: null, to: 8500 });
});

test('payments are append-only and add up; calls are logged', () => {
  const { db, shop, tom, emma, input } = setup();
  applyImport(db, shop.id, tom, input);
  const t = getTicketByJobNumber(db, shop.id, 'MOKU-0004'); // $100, $40 paid
  recordPayment(db, shop.id, emma, t.id, { amountCents: 6000 });
  assert.equal(money(db, shop.id, t.id).status, 'paid');
  assert.throws(() => recordPayment(db, shop.id, emma, t.id, { amountCents: 0 }), /positive/);
  assert.throws(() => db.prepare('UPDATE payments SET amount_cents = 1').run(), /append-only/);
  logCall(db, shop.id, emma, t.id, { outcome: 'left_message', note: 'board ready' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM call_logs WHERE ticket_id = ?').get(t.id).n, 1);
  changeStatus(db, shop.id, emma, t.id, 'at_partner');
  changeStatus(db, shop.id, emma, t.id, 'back_from_partner');
  changeStatus(db, shop.id, emma, t.id, 'ready_for_pickup');
  handOver(db, shop.id, emma, t.id);
  assert.throws(() => setPrices(db, shop.id, emma, t.id, { partnerChargeCents: 1 }), /closed/);
});

// ----------------------------------------------------------------- export

test('export: short sheet view and full 42 columns, totals preserved', () => {
  const { db, shop, tom, input } = setup();
  applyImport(db, shop.id, tom, input);
  const short = exportRecords(db, shop.id, tom);
  const full = exportRecords(db, shop.id, tom, { full: true });
  assert.equal(short.rows, 8);
  assert.equal(full.rows, 8);
  const s = parseCsvRecords(short.csv);
  assert.deepEqual(s.header, SHORT_COLUMNS);
  assert.deepEqual(s.records.map((r) => r['Job #']), ['MOKU-0001', 'MOKU-0002', 'MOKU-0003', 'MOKU-0004', 'MOKU-0009', 'MOKU-0013', 'MOKU-0067', 'MOKU-0185']);
  const r4 = s.records[3];
  assert.deepEqual([r4.Phone, r4['Keith estimate'], r4.Markup, r4['Customer price'], r4.Payment], ['(516) 555-0101', '$80.00', '$20.00', '$100.00', 'Partial']);
  const f = parseCsvRecords(full.csv);
  assert.deepEqual(f.header, COLUMNS);
  assert.deepEqual(f.records.find((r) => r['Repair ID'] === 'MOKU-0013'), FIXTURE[5]); // archive row unchanged
  // Same money in, same money out (unknown prices excluded, never counted as $0).
  assert.deepEqual(full.totals, { customerCharges: 15500, receipts: 9500, customerBalances: 6000, pricedJobs: 3 });
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM audit_events WHERE action = 'data.exported'`).get().n, 2);
});

test('records survive closing and reopening the database file', () => {
  const file = `/tmp/repair-desk-test-${process.pid}-${Date.now()}.sqlite`;
  let db = openDb(file);
  const shop = createShop(db, { name: 'MOKU', shopifyDomain: 'moku-repair-test.myshopify.com', jobPrefix: 'MOKU' });
  const tom = createStaff(db, shop.id, null, { name: 'Tom Gleason', role: 'owner' });
  applyImport(db, shop.id, tom, { fileName: 'r.csv', text: csvOf(FIXTURE) });
  db.close();
  db = openDb(file); // as after a deploy or an app update: migrations re-run, data kept
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tickets').get().n, 4);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM archived_repairs').get().n, 4);
  assert.equal(getShop(db, shop.id).next_job_number, 186);
  db.close();
});

test('a database copy is written before new migrations run; data unchanged', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = fs.mkdtempSync('/tmp/repair-desk-mig-');
  const file = path.join(dir, 'desk.sqlite');
  let db = openDb(file);
  const shop = createShop(db, { name: 'MOKU', shopifyDomain: 'moku-repair-test.myshopify.com', jobPrefix: 'MOKU' });
  const tom = createStaff(db, shop.id, null, { name: 'Tom Gleason', role: 'owner' });
  applyImport(db, shop.id, tom, { fileName: 'r.csv', text: csvOf(FIXTURE) });
  db.prepare(`DELETE FROM schema_migrations WHERE name = '003_records.sql'`).run(); // pretend 003 is new
  db.close();
  // Re-applying 003 fails (its tables exist), which is the point: the copy must already be on disk.
  assert.throws(() => openDb(file));
  const backups = fs.readdirSync(dir).filter((f) => f.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^desk\.sqlite\.pre-003_records\./);
  const copy = new DatabaseSync(path.join(dir, backups[0]));
  assert.equal(copy.prepare('SELECT COUNT(*) n FROM archived_repairs').get().n, 4);
  assert.equal(copy.prepare('SELECT COUNT(*) n FROM tickets').get().n, 4);
  copy.close();
  fs.rmSync(dir, { recursive: true });
});
